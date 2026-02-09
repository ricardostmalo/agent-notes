import path from 'node:path';
import {
  appendText,
  ensureDir,
  fileExists,
  getRepoRoot,
  getTodayAndYesterday,
  isMainModule,
  writeText,
} from './_lib.mjs';

export async function main(_argv = process.argv.slice(2)) {
  const repoRoot = getRepoRoot();
  const tz = process.env.MEMORY_TZ ?? 'America/Panama';

  const { today, yesterday } = getTodayAndYesterday({ tz });

  const memoryDir = path.join(repoRoot, 'memory');
  ensureDir(memoryDir);

  function ensureDailyFile(dateStr) {
    const p = path.join(memoryDir, `${dateStr}.md`);
    if (!fileExists(p)) {
      writeText(p, `# ${dateStr}\n\n`);
    } else {
      // Ensure it ends with newline to make appends safe.
      appendText(p, '');
    }
    return p;
  }

  const todayPath = ensureDailyFile(today);
  const yesterdayPath = ensureDailyFile(yesterday);

  process.stdout.write(
    `${[
      `memory:init ok`,
      `- tz: ${tz}`,
      `- today: ${todayPath}`,
      `- yesterday: ${yesterdayPath}`,
    ].join('\n')}\n`,
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(
      `memory:init failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
