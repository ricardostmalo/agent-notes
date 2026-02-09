import { execSync } from 'node:child_process';
import path from 'node:path';
import {
  appendText,
  ensureDir,
  getRepoRoot,
  getTodayAndYesterday,
  isMainModule,
  parseArgs,
} from './_lib.mjs';

function safeGit(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { flags } = parseArgs(argv);
  const repoRoot = getRepoRoot();
  const tz = process.env.MEMORY_TZ ?? 'America/Panama';
  const { today } = getTodayAndYesterday({ tz });

  const memoryDir = path.join(repoRoot, 'memory');
  ensureDir(memoryDir);
  const todayPath = path.join(memoryDir, `${today}.md`);

  const now = new Date();
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
  }).format(now);

  const auto = flags.get('auto') === 'true';
  const branch = safeGit('git branch --show-current');
  const status = auto ? safeGit('git status -sb') : null;
  const changed = auto ? safeGit('git diff --name-only') : null;

  const lines = [];
  lines.push('');
  lines.push(`## Wrap-Up (${today} ${time} ${tz})`);

  if (branch) lines.push(`- Branch: \`${branch}\``);

  lines.push('- What changed:');
  if (auto && changed) {
    lines.push('  - Files:');
    for (const f of changed.split('\n').filter(Boolean).slice(0, 50)) {
      lines.push(`    - \`${f}\``);
    }
    if (changed.split('\n').filter(Boolean).length > 50) {
      lines.push('    - (more...)');
    }
  } else {
    lines.push('  - <fill>');
  }

  lines.push('- Why:');
  lines.push('  - <fill>');

  lines.push('- Verification:');
  lines.push('  - `pnpm check`: <fill>');
  lines.push('  - `pnpm test:run`: <fill>');
  lines.push('  - `pnpm build`: <fill>');

  lines.push('- Next:');
  lines.push('  - <fill>');

  lines.push('- Durable memory update (`MEMORY.md`):');
  lines.push('  - <yes/no + what>');

  if (auto && status) {
    lines.push('');
    lines.push('### Git Status');
    lines.push('```text');
    lines.push(status);
    lines.push('```');
  }

  appendText(todayPath, `${lines.join('\n')}\n`);
  process.stdout.write(`memory:flush ok -> ${todayPath}\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(
      `memory:flush failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
