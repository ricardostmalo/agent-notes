# AGENTS.md (template)

This is a template you can copy into a repo to make agent work reproducible.

## Every Session

1. Read `MEMORY.md`
2. Read `memory/YYYY-MM-DD.md` (today + yesterday)
3. Run a repo toolbox command (for example `pnpm tools:list`) to discover available scripts

## Memory

- Daily notes: `memory/YYYY-MM-DD.md`
- Long-term memory: `MEMORY.md`

Rule: if it matters later, write it down.

## Verification Discipline

Prefer scripts over manual checks. Before merging:

- `pnpm check`
- `pnpm test:run`
- `pnpm build`

## Safety

- Avoid destructive git commands unless explicitly asked.
- Use worktrees when multiple coding sessions run in parallel.

