import { execSync } from 'node:child_process';
import path from 'node:path';
import { getRepoRoot, getTodayAndYesterday, isMainModule } from './_lib.mjs';

function usage() {
  console.log(
    `
pnpm memory:gate -- --base <ref>

Policy:
- If code changed, require at least one memory log update in the branch history,
  unless a commit includes the token "no-memory".

Notes:
- This gate is intentionally not date-sensitive (it accepts any memory/YYYY-MM-DD.md change),
  so it works reliably in CI and long-running PRs.
`.trim(),
  );
}

function run(cmd) {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
}

function tryRun(cmd) {
  try {
    return { ok: true, out: run(cmd) };
  } catch (err) {
    const e = err;
    const stderr =
      e && typeof e === 'object' && 'stderr' in e && e.stderr ? String(e.stderr).trim() : '';
    return { ok: false, out: stderr };
  }
}

function parseArgs(argv) {
  const out = { base: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    if (a === '--base') {
      out.base = argv[i + 1] ?? null;
      i += 1;
    }
  }
  return out;
}

function hasAny(paths, re) {
  return paths.some((p) => re.test(p));
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    process.exit(0);
  }
  if (!args.base) {
    console.error('memory:gate requires --base <ref>');
    usage();
    process.exit(2);
  }

  const baseOk = tryRun(`git rev-parse --verify ${args.base}^{commit}`);
  if (!baseOk.ok) {
    // In local hooks this can happen when the base ref isn't present; don't block pushes on that.
    console.log(`memory:gate skipped (base ref not found locally): ${args.base}`);
    process.exit(0);
  }

  const diff = run(`git diff --name-only ${args.base}...HEAD`);
  const changed = diff ? diff.split('\n').filter(Boolean) : [];

  if (changed.length === 0) {
    console.log('memory:gate ok (no changes)');
    return;
  }

  const CODE_CHANGED_RE =
    /^(apps\/|packages\/|supabase\/|scripts\/|tools\/|package\.json$|pnpm-lock\.yaml$|turbo\.json$|biome\.json|tsconfig.*\.json$|\.github\/workflows\/)/;
  const codeChanged = hasAny(changed, CODE_CHANGED_RE);

  if (!codeChanged) {
    console.log('memory:gate ok (no code changes)');
    return;
  }

  const tz = process.env.MEMORY_TZ ?? 'America/Panama';
  const repoRoot = getRepoRoot();
  const { today } = getTodayAndYesterday({ tz });
  const todayPath = normalize(path.join('memory', `${today}.md`));

  // Require *some* daily memory update for the branch.
  const memoryChanged = changed.some((p) => /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(p));

  const log = run(`git log --format=%s ${args.base}..HEAD`);
  const subjects = log ? log.split('\n').filter(Boolean) : [];
  const noMemory = subjects.some((s) => /\bno-memory\b/i.test(s));

  if (memoryChanged || noMemory) {
    console.log(`memory:gate ok (${memoryChanged ? 'memory updated' : 'no-memory override'})`);
    return;
  }

  console.error('memory:gate failed: code changed without any daily memory update.');
  console.error('');
  console.error('Fix by doing one of:');
  console.error(`- Append notes to \`${todayPath}\` and commit it`);
  console.error('- Or add "no-memory" to a commit subject (explicit override)');
  console.error('');
  console.error('Tip: create today/yesterday files with `pnpm memory:init`.');

  // Also helpfully print the repo root in case hooks run from elsewhere.
  console.error(`Repo: ${repoRoot}`);

  process.exit(1);
}

function normalize(p) {
  return p.replace(/\\/g, '/');
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(
      `memory:gate failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
