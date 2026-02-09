import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function fileExists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

export function writeText(p, content) {
  fs.writeFileSync(p, content, 'utf8');
}

export function appendText(p, content) {
  fs.appendFileSync(p, content, 'utf8');
}

export function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function getRepoRoot() {
  // Use git if available; fall back to cwd.
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

export function isMainModule(importMetaUrl) {
  // ESM equivalent of `require.main === module`
  const self = path.resolve(fileURLToPath(importMetaUrl));
  const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return invoked === self;
}

function formatDateYYYYMMDD(date, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function getTodayAndYesterday({ tz }) {
  const now = new Date();
  const today = formatDateYYYYMMDD(now, tz);
  const yesterdayDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterday = formatDateYYYYMMDD(yesterdayDate, tz);
  return { today, yesterday };
}

export function listMemoryFiles({ repoRoot }) {
  const files = [];
  const memoryDir = path.join(repoRoot, 'memory');
  const daily = fileExists(memoryDir)
    ? fs
        .readdirSync(memoryDir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => path.join('memory', f))
    : [];

  for (const p of daily) files.push(p);
  if (fileExists(path.join(repoRoot, 'MEMORY.md'))) files.push('MEMORY.md');

  // Deterministic order: MEMORY first, then daily ascending (oldest to newest).
  const memory = files.includes('MEMORY.md') ? ['MEMORY.md'] : [];
  const rest = files.filter((p) => p !== 'MEMORY.md').sort((a, b) => a.localeCompare(b));

  return [...memory, ...rest];
}

function stripFencedCodeBlocks(content) {
  return content.replace(/```[\s\S]*?```/g, '');
}

function normalizeWhitespace(s) {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

export function chunkMarkdown({ filePath, content, maxChars = 1200, minChars = 200 }) {
  // Chunk by paragraphs; merge small ones; split large ones.
  const cleaned = normalizeWhitespace(stripFencedCodeBlocks(content));
  if (cleaned.length === 0) return [];

  const paragraphs = cleaned.split(/\n{2,}/g);
  const chunks = [];
  let buf = '';

  const pushBuf = () => {
    const text = buf.trim();
    if (text.length > 0) {
      chunks.push(text);
    }
    buf = '';
  };

  for (const p of paragraphs) {
    const para = p.trim();
    if (!para) continue;

    if (para.length > maxChars) {
      // Flush current buffer then split this paragraph into segments.
      pushBuf();
      for (let i = 0; i < para.length; i += maxChars) {
        chunks.push(para.slice(i, i + maxChars));
      }
      continue;
    }

    if (buf.length === 0) {
      buf = para;
      continue;
    }

    // If buffer is small, keep merging; otherwise flush.
    if (buf.length < minChars || buf.length + 2 + para.length <= maxChars) {
      buf = `${buf}\n\n${para}`;
    } else {
      pushBuf();
      buf = para;
    }
  }

  pushBuf();

  return chunks.map((text, idx) => {
    const id = sha256Hex(`${filePath}\n${idx}\n${text}`);
    return { id, filePath, idx, text };
  });
}

export function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .trim()
    .split(/\s+/g)
    .filter(Boolean);
}

export function bm25Score({
  queryTokens,
  docTokens,
  avgDocLen,
  docFreqByTerm,
  totalDocs,
  k1 = 1.2,
  b = 0.75,
}) {
  if (docTokens.length === 0) return 0;

  const tf = new Map();
  for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);

  const docLen = docTokens.length;
  let score = 0;
  for (const term of queryTokens) {
    const termTf = tf.get(term) ?? 0;
    if (termTf === 0) continue;

    const df = docFreqByTerm.get(term) ?? 0;
    // Standard BM25 idf with +1 inside log for stability.
    const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));

    const denom = termTf + k1 * (1 - b + b * (docLen / avgDocLen));
    score += idf * ((termTf * (k1 + 1)) / denom);
  }

  return score;
}

export function base64FromFloat32Array(arr) {
  const buf = Buffer.from(new Float32Array(arr).buffer);
  return buf.toString('base64');
}

export function float32ArrayFromBase64(b64) {
  const buf = Buffer.from(b64, 'base64');
  // Copy to avoid referencing the underlying Buffer memory in unexpected ways.
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

export function cosineSimilarity(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i += 1) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function parseDotEnvFile(envPath) {
  if (!fileExists(envPath)) return {};
  const out = {};
  const lines = readText(envPath).split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (!key) continue;
    if (!(key in out)) out[key] = value;
  }
  return out;
}

export function loadEnvFromRepoRoot(repoRoot) {
  const env = parseDotEnvFile(path.join(repoRoot, '.env'));
  for (const [k, v] of Object.entries(env)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

export function sanitizeForEmbeddings(text) {
  // Best-effort redaction; memory should still avoid secrets, but this helps reduce accidental leakage.
  return (
    text
      // OpenAI-style keys (best effort)
      .replace(/\bsk-[A-Za-z0-9]{20,}\b/g, 'sk-REDACTED')
      // Notion token prefix used in this repo
      .replace(/\bntn_[A-Za-z0-9]+\b/g, 'ntn_REDACTED')
      // Generic bearer tokens
      .replace(/\bBearer\s+[A-Za-z0-9._-]{20,}\b/g, 'Bearer REDACTED')
  );
}

export async function embedOpenAI({ apiKey, model, dimensions, inputs }) {
  const body = {
    model,
    input: inputs,
    encoding_format: 'float',
  };
  if (dimensions) body.dimensions = dimensions;

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI embeddings error: HTTP ${res.status} ${text.slice(0, 300)}`);
  }

  const json = await res.json();
  const data = Array.isArray(json.data) ? json.data : [];
  return data.map((d) => d.embedding);
}

export function parseArgs(argv) {
  const flags = new Map();
  const positionals = [];

  const takeValue = (i) => {
    if (i + 1 >= argv.length) return { value: null, next: i + 1 };
    return { value: argv[i + 1], next: i + 2 };
  };

  for (let i = 0; i < argv.length; ) {
    const a = argv[i];
    if (a === '--') {
      // pnpm may forward a literal "--" sentinel; ignore it.
      i += 1;
      continue;
    }
    if (!a.startsWith('--')) {
      positionals.push(a);
      i += 1;
      continue;
    }

    const eq = a.indexOf('=');
    if (eq !== -1) {
      flags.set(a.slice(2, eq), a.slice(eq + 1));
      i += 1;
      continue;
    }

    const name = a.slice(2);
    // boolean flags
    if (name === 'semantic' || name === 'reindex' || name === 'auto') {
      flags.set(name, 'true');
      i += 1;
      continue;
    }

    const { value, next } = takeValue(i);
    if (value === null) {
      flags.set(name, 'true');
      i = next;
      continue;
    }
    flags.set(name, value);
    i = next;
  }

  return { flags, positionals };
}
