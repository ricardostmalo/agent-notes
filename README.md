# agent-notes

Lightweight tools for agentic engineering workflows:

- **Repo memory**: `MEMORY.md` + `memory/YYYY-MM-DD.md` with keyword (BM25) and optional semantic search.
- **Transcript search**: keyword search across local **Codex** + **Claude Code** JSONL transcripts.

The goal is to make agent work feel like normal engineering work: searchable, repeatable, and reviewable.

## Install

This repo is designed to work as either:
- a **CLI in a repo** (recommended: add as a dev dependency), or
- a **cloned utility repo** (run with `node`).

### Option A: Use as a dev dependency (recommended)

Add to your repo:

```bash
pnpm add -D github:ricardostmalo/agent-notes
```

Then add scripts:

```json
{
  "scripts": {
    "memory:init": "agent-notes memory init",
    "memory:flush": "agent-notes memory flush --auto",
    "memory:search": "agent-notes memory search",
    "conversations:search": "agent-notes conversations search"
  }
}
```

### Option B: Clone and run

```bash
git clone https://github.com/ricardostmalo/agent-notes.git
cd agent-notes
node cli.mjs --help
```

## Quickstart

Initialize memory files:

```bash
agent-notes memory init
```

Search memory (keyword BM25):

```bash
agent-notes memory search "inbound queue"
```

Search memory (hybrid keyword + embeddings):

```bash
agent-notes memory search "what did we decide about webhooks" --semantic
```

Search transcripts (Codex + Claude Code):

```bash
agent-notes conversations search "worktree" --since 2026-02-07 --source all
```

## Memory Layout (Reference)

- `MEMORY.md`: durable, curated decisions and lessons.
- `memory/YYYY-MM-DD.md`: daily raw session notes.

See `templates/` for a starting point you can copy into a repo.

## What Gets Indexed

Memory search indexes only:
- `MEMORY.md`
- `memory/*.md`

Transcript search reads local JSONL transcripts:
- Claude Code: `~/.claude/projects/**.jsonl`
- Codex: `~/.codex/sessions/**.jsonl` and `~/.codex/archived_sessions/**.jsonl`

## Configuration

Environment variables:
- `MEMORY_TZ` (default: `America/Panama`)
- `OPENAI_API_KEY` (required for semantic memory search)
- `AGENT_NOTES_CLAUDE_PROJECTS_DIR` (override Claude transcript root; default `~/.claude/projects`)
- `AGENT_NOTES_CODEX_DIR` (override Codex directory; default `~/.codex`)

## Privacy Notes

- Keyword search is local-only (no network).
- Semantic memory search sends chunk text to the embeddings provider. The tool prints a warning and applies best-effort secret redaction, but you should still avoid putting secrets in memory files.

## License

Apache-2.0. See `LICENSE`.

