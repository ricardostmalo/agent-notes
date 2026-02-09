import fs from 'node:fs';
import path from 'node:path';
import {
  base64FromFloat32Array,
  bm25Score,
  chunkMarkdown,
  cosineSimilarity,
  embedOpenAI,
  ensureDir,
  float32ArrayFromBase64,
  getRepoRoot,
  isMainModule,
  listMemoryFiles,
  loadEnvFromRepoRoot,
  parseArgs,
  readText,
  sanitizeForEmbeddings,
  sha256Hex,
  tokenize,
} from './_lib.mjs';

function usage() {
  process.stdout.write(
    `${[
      'Usage:',
      '  pnpm memory:search "<query>" [--k 10] [--semantic] [--reindex]',
      '',
      'Options:',
      '  --k <n>         number of results (default 10)',
      '  --semantic      combine keyword BM25 + semantic embeddings',
      '  --reindex       ignore embedding cache (recompute)',
      '  --provider <p>  embeddings provider (default: auto; supported: openai)',
      '  --model <m>     embeddings model (default: text-embedding-3-small)',
      '  --dimensions N  embeddings dimensions (optional)',
      '',
      'Env:',
      '  MEMORY_TZ=America/Panama',
      '  MEMORY_EMBEDDINGS_PROVIDER=openai',
      '  OPENAI_API_KEY=...',
    ].join('\n')}\n`,
  );
}

function clamp01(x) {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function normalizeScores(items, getScore) {
  let min = Infinity;
  let max = -Infinity;
  for (const it of items) {
    const s = getScore(it);
    if (s < min) min = s;
    if (s > max) max = s;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return new Map(items.map((it) => [it.id, 0]));
  }
  const out = new Map();
  for (const it of items) {
    const s = getScore(it);
    out.set(it.id, clamp01((s - min) / (max - min)));
  }
  return out;
}

function readJsonIfExists(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(p, obj) {
  fs.writeFileSync(p, `${JSON.stringify(obj)}\n`, 'utf8');
}

async function getEmbeddingsForChunks({ chunks, cachePath, provider, model, dimensions, reindex }) {
  const cache = reindex ? {} : (readJsonIfExists(cachePath) ?? {});
  const missing = [];

  for (const c of chunks) {
    const sanitized = sanitizeForEmbeddings(c.text);
    const key = sha256Hex(`${provider}\n${model}\n${dimensions ?? ''}\n${sanitized}`);
    c.embeddingKey = key;
    if (!cache[key]) missing.push({ key, text: sanitized });
  }

  if (missing.length === 0) return { cache, updated: false };

  if (provider !== 'openai') {
    throw new Error(`Unsupported embeddings provider: ${provider}`);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for --semantic (provider=openai).');
  }

  process.stdout.write(
    `memory:search semantic: embedding ${missing.length} chunk(s) via OpenAI (${model})\n`,
  );
  process.stdout.write(
    `memory:search semantic: note: content is sent to the embeddings provider (best-effort secret redaction is applied)\n`,
  );

  const batchSize = 96;
  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);
    const vectors = await embedOpenAI({
      apiKey,
      model,
      dimensions,
      inputs: batch.map((b) => b.text),
    });
    for (let j = 0; j < batch.length; j += 1) {
      cache[batch[j].key] = {
        model,
        dimensions: dimensions ?? null,
        b64: base64FromFloat32Array(vectors[j]),
      };
    }
  }

  writeJson(cachePath, cache);
  return { cache, updated: true };
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, positionals } = parseArgs(argv);
  const query = positionals.join(' ').trim();
  if (!query) {
    usage();
    process.exit(1);
  }

  const k = Number.parseInt(flags.get('k') ?? '10', 10);
  const useSemantic = flags.get('semantic') === 'true';
  const reindex = flags.get('reindex') === 'true';
  const model =
    flags.get('model') ?? process.env.MEMORY_EMBEDDINGS_MODEL ?? 'text-embedding-3-small';
  const dimensionsRaw = flags.get('dimensions') ?? process.env.MEMORY_EMBEDDING_DIMENSIONS ?? '';
  const dimensions = dimensionsRaw ? Number.parseInt(dimensionsRaw, 10) : null;

  const repoRoot = getRepoRoot();
  loadEnvFromRepoRoot(repoRoot);

  const provider =
    flags.get('provider') ??
    process.env.MEMORY_EMBEDDINGS_PROVIDER ??
    (process.env.OPENAI_API_KEY ? 'openai' : 'openai');

  const files = listMemoryFiles({ repoRoot });
  const chunks = [];

  for (const rel of files) {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) continue;
    const content = readText(abs);
    const fileChunks = chunkMarkdown({ filePath: rel, content });
    for (const c of fileChunks) {
      chunks.push(c);
    }
  }

  if (chunks.length === 0) {
    process.stdout.write('memory:search: no memory chunks found\n');
    process.exit(0);
  }

  const queryTokens = tokenize(query);
  const totalDocs = chunks.length;

  // Precompute DF for query terms only (fast).
  const docFreqByTerm = new Map(queryTokens.map((t) => [t, 0]));
  let totalLen = 0;
  const docTokensById = new Map();

  for (const c of chunks) {
    const tokens = tokenize(c.text);
    docTokensById.set(c.id, tokens);
    totalLen += tokens.length;

    const unique = new Set(tokens);
    for (const term of docFreqByTerm.keys()) {
      if (unique.has(term)) docFreqByTerm.set(term, (docFreqByTerm.get(term) ?? 0) + 1);
    }
  }

  const avgDocLen = totalLen / totalDocs;
  for (const c of chunks) {
    const docTokens = docTokensById.get(c.id) ?? [];
    c.bm25 = bm25Score({
      queryTokens,
      docTokens,
      avgDocLen: avgDocLen || 1,
      docFreqByTerm,
      totalDocs,
    });
  }

  const keywordSorted = [...chunks].sort((a, b) => (b.bm25 ?? 0) - (a.bm25 ?? 0));

  if (!useSemantic) {
    const top = keywordSorted.slice(0, Math.max(1, k));
    process.stdout.write(`memory:search keyword ok (chunks=${chunks.length})\n`);
    for (let i = 0; i < top.length; i += 1) {
      const c = top[i];
      const snippet = c.text.replace(/\s+/g, ' ').slice(0, 220);
      process.stdout.write(
        `${i + 1}. score=${(c.bm25 ?? 0).toFixed(3)} file=${c.filePath} chunk=${c.idx}\n   ${snippet}\n`,
      );
    }
    return;
  }

  const cacheDir = path.join(repoRoot, '.cache', 'memory');
  ensureDir(cacheDir);
  const cachePath = path.join(
    cacheDir,
    `embeddings.${provider}.${model}.${dimensions ?? 'default'}.json`,
  );

  const { cache } = await getEmbeddingsForChunks({
    chunks,
    cachePath,
    provider,
    model,
    dimensions,
    reindex,
  });

  // Query embedding.
  const queryKey = sha256Hex(
    `${provider}\n${model}\n${dimensions ?? ''}\nQUERY\n${sanitizeForEmbeddings(query)}`,
  );
  if (!cache[queryKey]) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is required for --semantic (provider=openai).');
    const vec = await embedOpenAI({
      apiKey,
      model,
      dimensions,
      inputs: [sanitizeForEmbeddings(query)],
    });
    cache[queryKey] = {
      model,
      dimensions: dimensions ?? null,
      b64: base64FromFloat32Array(vec[0]),
    };
    writeJson(cachePath, cache);
  }
  const queryVec = float32ArrayFromBase64(cache[queryKey].b64);

  for (const c of chunks) {
    const entry = cache[c.embeddingKey];
    if (!entry) {
      c.cosine = 0;
      continue;
    }
    const v = float32ArrayFromBase64(entry.b64);
    c.cosine = cosineSimilarity(queryVec, v);
  }

  // Candidate union: top from each signal then combine.
  const topKeyword = keywordSorted.slice(0, 80);
  const topSemantic = [...chunks].sort((a, b) => (b.cosine ?? 0) - (a.cosine ?? 0)).slice(0, 80);
  const byId = new Map();
  for (const c of [...topKeyword, ...topSemantic]) byId.set(c.id, c);
  const candidates = [...byId.values()];

  const normBm25 = normalizeScores(candidates, (c) => c.bm25 ?? 0);
  const normCos = normalizeScores(candidates, (c) => c.cosine ?? 0);

  for (const c of candidates) {
    const bm = normBm25.get(c.id) ?? 0;
    const cs = normCos.get(c.id) ?? 0;
    c.combined = 0.45 * bm + 0.55 * cs;
  }

  candidates.sort((a, b) => (b.combined ?? 0) - (a.combined ?? 0));
  const top = candidates.slice(0, Math.max(1, k));

  process.stdout.write(
    `memory:search semantic ok (chunks=${chunks.length}, candidates=${candidates.length})\n`,
  );
  for (let i = 0; i < top.length; i += 1) {
    const c = top[i];
    const snippet = c.text.replace(/\s+/g, ' ').slice(0, 220);
    process.stdout.write(
      `${i + 1}. score=${(c.combined ?? 0).toFixed(3)} bm25=${(c.bm25 ?? 0).toFixed(3)} cos=${(c.cosine ?? 0).toFixed(3)} file=${c.filePath} chunk=${c.idx}\n   ${snippet}\n`,
    );
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(
      `memory:search failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
