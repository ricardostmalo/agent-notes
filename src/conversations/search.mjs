import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {
  bm25Score,
  getRepoRoot,
  isMainModule,
  parseArgs,
  sha256Hex,
  tokenize,
} from '../memory/_lib.mjs';

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB — skip monster transcripts

function usage() {
  process.stdout.write(
    `${[
      'Usage:',
      '  pnpm conversations:search "<query>" [options]',
      '',
      'Options:',
      '  --k <n>           Number of results (default 10)',
      '  --since <date>    Only search sessions after YYYY-MM-DD',
      '  --session <uuid>  Search within a specific session',
      '  --sessions        List sessions instead of searching',
      '  --verbose         Show full message text instead of snippet',
      '  --source <s>      Filter by source: claude, codex, or all (default: all)',
      '',
      'Examples:',
      '  pnpm conversations:search "eFactura billing"',
      '  pnpm conversations:search --sessions',
      '  pnpm conversations:search "worktree" --since 2026-02-07',
      '  pnpm conversations:search "connector" --source codex',
    ].join('\n')}\n`,
  );
}

// ---------------------------------------------------------------------------
// Repo name discovery
// ---------------------------------------------------------------------------

function getRepoName() {
  try {
    const url = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
    const match = url.match(/\/([^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  } catch {
    // No remote configured
  }
  const repoRoot = getRepoRoot();
  return path.basename(repoRoot);
}

// ---------------------------------------------------------------------------
// Claude Code session discovery
// ---------------------------------------------------------------------------

function discoverClaudeProjectDirs(repoName) {
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(claudeProjectsDir)) return [];

  return fs
    .readdirSync(claudeProjectsDir)
    .filter((e) => e.includes(repoName))
    .map((e) => path.join(claudeProjectsDir, e))
    .filter((p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
}

// ---------------------------------------------------------------------------
// Codex session discovery
// ---------------------------------------------------------------------------

function discoverCodexSessionFiles(repoName) {
  const files = [];
  const codexDir = path.join(os.homedir(), '.codex');

  // Load session index for thread names
  const indexPath = path.join(codexDir, 'session_index.jsonl');
  const threadNames = new Map();
  if (fs.existsSync(indexPath)) {
    try {
      const content = fs.readFileSync(indexPath, 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.id && entry.thread_name) {
            threadNames.set(entry.id, entry.thread_name);
          }
        } catch {}
      }
    } catch {}
  }

  // Scan active sessions (YYYY/MM/DD/*.jsonl)
  const sessionsDir = path.join(codexDir, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    collectCodexFiles(sessionsDir, files, repoName, threadNames);
  }

  // Scan archived sessions
  const archivedDir = path.join(codexDir, 'archived_sessions');
  if (fs.existsSync(archivedDir)) {
    collectCodexFiles(archivedDir, files, repoName, threadNames);
  }

  return files;
}

function collectCodexFiles(dir, files, _repoName, threadNames) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { recursive: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const e = typeof entry === 'string' ? entry : entry.toString();
    if (!e.endsWith('.jsonl')) continue;
    const fullPath = path.join(dir, e);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.size === 0) continue;
      if (stat.size > MAX_FILE_SIZE) {
        process.stderr.write(
          `conversations:search: skipping codex ${e} (${(stat.size / 1024 / 1024).toFixed(0)} MB > 500 MB limit)\n`,
        );
        continue;
      }

      // Extract session ID from filename: rollout-YYYY-MM-DDT...-<uuid>.jsonl
      const basename = path.basename(e, '.jsonl');
      const uuidMatch = basename.match(
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
      );
      const sessionId = uuidMatch ? uuidMatch[1] : basename;
      const threadName = threadNames.get(sessionId);

      files.push({
        path: fullPath,
        sessionId,
        size: stat.size,
        projectDir: 'codex',
        source: 'codex',
        threadName: threadName || null,
        // We'll filter by repo later when parsing (check cwd in session_meta)
      });
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Session file listing (Claude Code)
// ---------------------------------------------------------------------------

function listClaudeSessionFiles(projectDirs) {
  const files = [];
  for (const dir of projectDirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.endsWith('.jsonl')) continue;
      const fullPath = path.join(dir, e);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size === 0) continue;
        if (stat.size > MAX_FILE_SIZE) {
          process.stderr.write(
            `conversations:search: skipping ${e} (${(stat.size / 1024 / 1024).toFixed(0)} MB > 500 MB limit)\n`,
          );
          continue;
        }
        files.push({
          path: fullPath,
          sessionId: e.replace('.jsonl', ''),
          size: stat.size,
          projectDir: path.basename(dir),
          source: 'claude',
          threadName: null,
        });
      } catch {}
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

/** Extract text from a Claude Code message object */
function extractClaudeText(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/** Extract text from a Codex response_item payload */
function extractCodexText(payload) {
  if (!payload) return '';
  const content = payload.content;
  if (!Array.isArray(content)) return '';

  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    // Codex uses input_text (user/developer) and output_text (assistant) and text
    if (
      (block.type === 'input_text' || block.type === 'output_text' || block.type === 'text') &&
      typeof block.text === 'string'
    ) {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Session parsers (streaming)
// ---------------------------------------------------------------------------

async function* parseClaudeSession(filePath, { sinceDate }) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  let firstUserMessage = null;
  let sessionDate = null;

  for await (const line of rl) {
    if (!line.trim()) continue;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const type = obj.type;
    if (type !== 'user' && type !== 'assistant') continue;

    const timestamp = obj.timestamp;
    if (timestamp && !sessionDate) {
      sessionDate = timestamp.slice(0, 10);
      if (sinceDate && sessionDate < sinceDate) {
        rl.close();
        stream.destroy();
        return;
      }
    }

    const text = extractClaudeText(obj.message);
    if (!text.trim()) continue;

    if (type === 'user' && !firstUserMessage) {
      firstUserMessage = text.slice(0, 120).replace(/\s+/g, ' ').trim();
    }

    yield {
      type,
      text,
      timestamp: timestamp || null,
      sessionDate,
      firstUserMessage,
    };
  }
}

async function* parseCodexSession(filePath, { sinceDate, repoName }) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  let firstUserMessage = null;
  let sessionDate = null;
  let isRelevantRepo = false;

  for await (const line of rl) {
    if (!line.trim()) continue;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    // Check session_meta for cwd to filter by repo
    if (obj.type === 'session_meta') {
      const cwd = obj.payload?.cwd || '';
      if (cwd.includes(repoName)) {
        isRelevantRepo = true;
      }
      const ts = obj.payload?.timestamp || obj.timestamp;
      if (ts && !sessionDate) {
        sessionDate = ts.slice(0, 10);
        if (sinceDate && sessionDate < sinceDate) {
          rl.close();
          stream.destroy();
          return;
        }
      }
      continue;
    }

    if (!isRelevantRepo) continue;
    if (obj.type !== 'response_item') continue;

    const payload = obj.payload || {};
    const role = payload.role;
    // Skip developer (system) messages
    if (role !== 'user' && role !== 'assistant') continue;

    const timestamp = obj.timestamp || null;
    if (timestamp && !sessionDate) {
      sessionDate = timestamp.slice(0, 10);
    }

    const text = extractCodexText(payload);
    // Skip system/context messages that start with XML tags or AGENTS.md injections
    if (!text.trim() || text.startsWith('<') || text.startsWith('# AGENTS.md')) continue;

    if (role === 'user' && !firstUserMessage) {
      firstUserMessage = text.slice(0, 120).replace(/\s+/g, ' ').trim();
    }

    yield {
      type: role,
      text,
      timestamp,
      sessionDate,
      firstUserMessage,
    };
  }
}

// ---------------------------------------------------------------------------
// Session index builder (for --sessions)
// ---------------------------------------------------------------------------

async function buildSessionIndex(sessionFiles, repoName) {
  const sessions = [];

  for (const sf of sessionFiles) {
    let firstUserMessage = sf.threadName || null;
    let sessionDate = null;
    let messageCount = 0;
    let isRelevantRepo = sf.source === 'claude'; // Claude files are pre-filtered by dir

    const stream = fs.createReadStream(sf.path, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      if (sf.source === 'codex') {
        if (obj.type === 'session_meta') {
          const cwd = obj.payload?.cwd || '';
          if (cwd.includes(repoName)) isRelevantRepo = true;
          const ts = obj.payload?.timestamp || obj.timestamp;
          if (ts && !sessionDate) sessionDate = ts.slice(0, 10);
          continue;
        }
        if (!isRelevantRepo) continue;
        if (obj.type !== 'response_item') continue;
        const role = obj.payload?.role;
        if (role !== 'user' && role !== 'assistant') continue;
        messageCount++;
        if (!sessionDate && obj.timestamp) sessionDate = obj.timestamp.slice(0, 10);
        if (role === 'user' && !firstUserMessage) {
          const text = extractCodexText(obj.payload);
          if (text.trim() && !text.startsWith('<') && !text.startsWith('# AGENTS.md')) {
            firstUserMessage = text.slice(0, 120).replace(/\s+/g, ' ').trim();
          }
        }
      } else {
        // Claude Code format
        if (obj.type !== 'user' && obj.type !== 'assistant') continue;
        messageCount++;
        if (!sessionDate && obj.timestamp) sessionDate = obj.timestamp.slice(0, 10);
        if (obj.type === 'user' && !firstUserMessage) {
          const text = extractClaudeText(obj.message);
          if (text.trim()) {
            firstUserMessage = text.slice(0, 120).replace(/\s+/g, ' ').trim();
          }
        }
      }

      if (sessionDate && firstUserMessage) {
        rl.close();
        stream.destroy();
        break;
      }
    }

    if (!isRelevantRepo || messageCount === 0) continue;

    sessions.push({
      sessionId: sf.sessionId,
      date: sessionDate || 'unknown',
      firstMessage: firstUserMessage || '(empty)',
      size: sf.size,
      projectDir: sf.projectDir,
      source: sf.source,
      threadName: sf.threadName,
    });
  }

  return sessions.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  const rawArgv = argv;
  const myBooleans = new Set(['--sessions', '--verbose']);
  const listSessions = rawArgv.includes('--sessions');
  const verbose = rawArgv.includes('--verbose');
  const filteredArgv = rawArgv.filter((a) => !myBooleans.has(a));

  const { flags, positionals } = parseArgs(filteredArgv);
  const query = positionals.join(' ').trim();
  const k = Number.parseInt(flags.get('k') ?? '10', 10);
  const sinceDate = flags.get('since') ?? null;
  const sessionFilter = flags.get('session') ?? null;
  const sourceFilter = flags.get('source') ?? 'all';

  if (!query && !listSessions) {
    usage();
    process.exit(1);
  }

  const repoName = getRepoName();

  // Discover session files from both sources
  let sessionFiles = [];

  if (sourceFilter === 'all' || sourceFilter === 'claude') {
    const projectDirs = discoverClaudeProjectDirs(repoName);
    const claudeFiles = listClaudeSessionFiles(projectDirs);
    sessionFiles.push(...claudeFiles);
    process.stdout.write(
      `conversations:search: claude — ${projectDirs.length} project dir(s), ${claudeFiles.length} session(s)\n`,
    );
  }

  if (sourceFilter === 'all' || sourceFilter === 'codex') {
    const codexFiles = discoverCodexSessionFiles(repoName);
    sessionFiles.push(...codexFiles);
    process.stdout.write(
      `conversations:search: codex — ${codexFiles.length} session file(s) (filtering by repo at parse time)\n`,
    );
  }

  if (sessionFiles.length === 0) {
    process.stderr.write(`conversations:search: no session files found for "${repoName}"\n`);
    process.exit(1);
  }

  if (sessionFilter) {
    sessionFiles = sessionFiles.filter(
      (sf) => sf.sessionId === sessionFilter || sf.sessionId.startsWith(sessionFilter),
    );
    if (sessionFiles.length === 0) {
      process.stderr.write(`conversations:search: session "${sessionFilter}" not found\n`);
      process.exit(1);
    }
  }

  process.stdout.write(`conversations:search: ${sessionFiles.length} total session file(s)\n`);

  // --sessions mode
  if (listSessions) {
    const sessions = await buildSessionIndex(sessionFiles, repoName);
    const filtered = sinceDate ? sessions.filter((s) => s.date >= sinceDate) : sessions;
    process.stdout.write(`\nSessions: ${filtered.length}\n\n`);
    for (const s of filtered) {
      const sizeMB = (s.size / 1024 / 1024).toFixed(1);
      const src = s.source === 'codex' ? 'codex' : 'claude';
      const name = s.threadName ? ` [${s.threadName}]` : '';
      process.stdout.write(
        `  ${s.date}  ${sizeMB.padStart(6)} MB  ${src.padEnd(6)}  ${s.sessionId.slice(0, 8)}${name}  ${s.firstMessage}\n`,
      );
    }
    return;
  }

  // Search mode
  const docs = [];

  for (const sf of sessionFiles) {
    try {
      const parser =
        sf.source === 'codex'
          ? parseCodexSession(sf.path, { sinceDate, repoName })
          : parseClaudeSession(sf.path, { sinceDate });

      for await (const msg of parser) {
        docs.push({
          id: sha256Hex(`${sf.sessionId}\n${msg.timestamp}\n${msg.text.slice(0, 500)}`),
          sessionId: sf.sessionId,
          projectDir: sf.projectDir,
          source: sf.source,
          threadName: sf.threadName,
          role: msg.type,
          text: msg.text,
          timestamp: msg.timestamp,
          sessionDate: msg.sessionDate,
          firstUserMessage: msg.firstUserMessage,
        });
      }
    } catch (err) {
      process.stderr.write(`conversations:search: error reading ${sf.sessionId}: ${err.message}\n`);
    }
  }

  if (docs.length === 0) {
    process.stdout.write('conversations:search: no messages found\n');
    return;
  }

  process.stdout.write(`conversations:search: ${docs.length} messages indexed, ranking...\n`);

  // BM25 scoring
  const queryTokens = tokenize(query);
  const totalDocs = docs.length;

  const docFreqByTerm = new Map(queryTokens.map((t) => [t, 0]));
  let totalLen = 0;
  const docTokensById = new Map();

  for (const doc of docs) {
    const tokens = tokenize(doc.text);
    docTokensById.set(doc.id, tokens);
    totalLen += tokens.length;

    const unique = new Set(tokens);
    for (const term of docFreqByTerm.keys()) {
      if (unique.has(term)) docFreqByTerm.set(term, (docFreqByTerm.get(term) ?? 0) + 1);
    }
  }

  const avgDocLen = totalLen / totalDocs;

  for (const doc of docs) {
    const docTokens = docTokensById.get(doc.id) ?? [];
    doc.score = bm25Score({
      queryTokens,
      docTokens,
      avgDocLen: avgDocLen || 1,
      docFreqByTerm,
      totalDocs,
    });
  }

  docs.sort((a, b) => b.score - a.score);
  const top = docs.slice(0, Math.max(1, k));

  process.stdout.write('\n');
  for (let i = 0; i < top.length; i++) {
    const doc = top[i];
    if (doc.score === 0) continue;

    const snippet = verbose ? doc.text : doc.text.replace(/\s+/g, ' ').slice(0, 300);
    const label = doc.threadName || doc.firstUserMessage || '(no label)';
    const sessionShort = doc.sessionId.slice(0, 8);
    const src = doc.source === 'codex' ? 'codex' : 'claude';
    let location = doc.projectDir;
    if (doc.source === 'claude' && doc.projectDir === `-Users-ricardo-Github-${repoName}`) {
      location = 'main';
    }

    process.stdout.write(
      `${i + 1}. score=${doc.score.toFixed(3)}  ${doc.sessionDate || '?'}  [${doc.role}]  ${src}  session=${sessionShort} (${location})\n`,
    );
    process.stdout.write(`   label: ${label}\n`);
    process.stdout.write(`   ${snippet}\n\n`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(
      `conversations:search failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
