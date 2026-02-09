#!/usr/bin/env node
import { main as conversationsSearch } from './src/conversations/search.mjs';
import { main as memoryFlush } from './src/memory/flush.mjs';
import { main as memoryGate } from './src/memory/gate.mjs';
import { main as memoryInit } from './src/memory/init.mjs';
import { main as memorySearch } from './src/memory/search.mjs';

function usage() {
  process.stdout.write(
    `${[
      'Usage:',
      '  agent-notes <group> <command> [...args]',
      '',
      'Groups:',
      '  memory         repo memory utilities (MEMORY.md + memory/YYYY-MM-DD.md)',
      '  conversations  search local agent transcripts (Codex + Claude Code)',
      '',
      'Memory commands:',
      '  init',
      '  search',
      '  flush',
      '  gate',
      '',
      'Conversations commands:',
      '  search',
      '',
      'Examples:',
      '  agent-notes memory init',
      '  agent-notes memory search "inbound queue"',
      '  agent-notes conversations search "worktree" --since 2026-02-07',
    ].join('\n')}\n`,
  );
}

const argv = process.argv.slice(2);
const [group, command, ...rest] = argv;

if (!group || group === '--help' || group === '-h') {
  usage();
  process.exit(group ? 0 : 1);
}

const full = `${group}:${command ?? ''}`;

try {
  if (group === 'memory' && command === 'init') await memoryInit(rest);
  else if (group === 'memory' && command === 'search') await memorySearch(rest);
  else if (group === 'memory' && command === 'flush') await memoryFlush(rest);
  else if (group === 'memory' && command === 'gate') await memoryGate(rest);
  else if (group === 'conversations' && command === 'search') await conversationsSearch(rest);
  else {
    process.stderr.write(`agent-notes: unknown command: ${full}\n\n`);
    usage();
    process.exit(1);
  }
} catch (err) {
  process.stderr.write(`agent-notes failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
