# Agent Notes (Ricky internal package)

This package contains the reference implementation for Ricky's repo memory system and local transcript search tooling.

It is designed to be:
- fast to run (pure Node.js, no database)
- deterministic (git-tracked notes; cached embeddings)
- safe by default (keyword search is local-only; semantic search warns before sending text to a provider)

## Commands

These are typically invoked via `pnpm` scripts in the repo root:

```bash
pnpm memory:init
pnpm memory:flush -- --auto
pnpm memory:search "query"
pnpm memory:search "query" -- --semantic

pnpm conversations:search "query" -- --source all --since 2026-02-07
```

You can also invoke the CLI directly:

```bash
pnpm agent-notes memory init
pnpm agent-notes conversations search "worktree" --since 2026-02-07
```

## What Gets Indexed

Memory search indexes only:
- `MEMORY.md`
- `memory/*.md`

Conversation search reads local JSONL transcripts:
- Claude Code: `~/.claude/projects/**.jsonl`
- Codex: `~/.codex/sessions/**.jsonl` (and `~/.codex/archived_sessions/**.jsonl` when present)

## Configuration

Environment variables:
- `MEMORY_TZ` (default: `America/Panama`)
- `OPENAI_API_KEY` (required for `pnpm memory:search -- --semantic`)
- `AGENT_NOTES_CLAUDE_PROJECTS_DIR` (override Claude transcript root; default `~/.claude/projects`)
- `AGENT_NOTES_CODEX_DIR` (override Codex directory; default `~/.codex`)

## Privacy Notes

- Keyword search is local-only (no network).
- Semantic memory search sends chunk text to the embeddings provider. The tool prints a warning and applies best-effort secret redaction, but you should still avoid putting secrets in memory files.

