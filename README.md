# MemoCall

An MCP server that lets Claude Code **recall the context of your past conversations — from any project — on demand.**

Claude Code can *resume* a session, but getting *another* conversation's context into the one you're in is a chore — copy-pasting exports or digging through raw transcript files by hand — and resume only sees the current directory anyway. **MemoCall** turns it into a single ask: *"what was I working on?"* or *"load the session where we set up X"*, and it pulls that transcript in as clean, compact Markdown — even from a totally different project.

It's **read-only**. Claude Code already records every session to `~/.claude/projects/<project>/<id>.jsonl`; this server just reads those files, strips the noise, collapses tool calls, and hands back a readable transcript. It never writes, hooks, or touches a live session.

## What you get

Five tools, available in **every** session once installed. Claude picks the right one from the request:

| Tool | What it does |
|------|--------------|
| `list_sessions` | Your recent conversations across all projects, **grouped by directory**. "What was I working on?" |
| `search_sessions` | Find a past conversation by keyword (matches titles + first messages + paths). |
| `load_session` | Load one conversation as compact Markdown — by `id` or `query`. Optionally a turn window via `turns`. |
| `session_outline` | A cheap **map** of one conversation: the numbered list of your prompts. Great for huge sessions. |
| `search_in_session` | Return only the turns **within** one conversation that match a keyword. |

You don't call these directly — you talk normally and Claude reaches for them:

```
You:  what sessions have i worked on recently?
You:  load the one where we set up the license invitation system
You:  which session did we debug the keychain SIGKILL thing in?
```

## How the transcript is rendered

Raw transcripts are a verbose event log (one big file hit 11 MB). `memocall` reduces each turn to the essentials, Conductor-style:

```
**You:** right now i need to set up a system to invite prospects...
↳ 12 tool calls (Bash ×5, Read ×4, Edit ×3)
**Claude:** I've set up the invitation flow. Key decisions: ...
```

Tool-call *outputs* are elided (the big token win, and a privacy win — see below). Abandoned/edited message branches are dropped so you get the conversation as it actually played out. A token budget keeps even an 11 MB session well under Claude Code's MCP output cap via middle-out truncation.

### Navigating large sessions

A single response can't hold a 1,000-turn session, so for big ones you don't dump — you navigate:

1. `session_outline` → a numbered map of every prompt (tiny, fits any session).
2. `search_in_session` → jump straight to the turns about a topic, **or** `load_session` with `turns: "300-340"` to pull an exact window (turn numbers come from the outline).

So you never lose access to the middle of a huge conversation — `load_session` alone would middle-out-truncate it, but the outline + range/search tools let Claude reach any part on demand.

## Install

Requires Node 18+ and the Claude Code CLI.

```bash
git clone https://github.com/baodq06/memocall.git
cd memocall
npm install
npm run build
claude mcp add --scope user memocall -- node "$(pwd)/dist/index.js"
```

`--scope user` makes it available in every session, in every directory. Restart Claude Code (or open a new session) and ask it to list your sessions. Verify with `claude mcp list` — you should see `memocall: … ✔ Connected`.

## Privacy & security

- **Local only.** No network, no auth, no telemetry. It reads files under `~/.claude/projects/` and nothing else.
- **Compact mode elides tool outputs**, which is where secrets (tokens, keys, env) usually live — so the default output is much safer than the raw transcript.
- **`format: "full"` includes brief tool inputs** and may surface sensitive strings. Use it deliberately.
- Transcripts can contain secrets regardless; treat loaded context as you would the original conversation.

## Limitations

- Recall is best-effort: Claude Code deletes transcripts after `cleanupPeriodDays` (default 30).
- Forked sessions may only contain post-fork turns.
- The transcript format is undocumented and can change between Claude Code versions; all format knowledge is isolated in `src/jsonl.ts` so it's a one-file patch if it does.

## Development

```bash
npm run build           # compile TypeScript -> dist/
npm test                # unit suite (node:test) on synthetic fixtures
npm run smoke           # optional: checks all YOUR real sessions stay under the output cap
node dist/parser.js <file.jsonl> [--full|--outline] [--turns 10-20] [--search "kw"] [--max N] [--think]   # test the parser
node test-client.mjs    # drive the server over stdio like Claude Code does
npm run inspect         # open the MCP Inspector UI
```

Layout:

- `src/jsonl.ts` — all knowledge of the transcript format (helpers, ordering, classification).
- `src/parser.ts` — JSONL → compact Markdown (the core transform).
- `src/locator.ts` — session enumeration + cached metadata index.
- `src/index.ts` — the MCP server wiring the three tools.

## License

MIT
