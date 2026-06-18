#!/usr/bin/env node
/**
 * index.ts — the MCP server. Exposes three tools over stdio so Claude Code can recall
 * past conversations from ANY project: list_sessions, search_sessions, load_session.
 *
 * Read-only: it only reads ~/.claude/projects/*. It never writes transcripts.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  CwdGroup,
  SessionMeta,
  groupByCwd,
  isoDate,
  readSession,
  refreshIndex,
  resolveSession,
  searchSessions,
} from "./locator.js";
import { searchInSession, transcriptToMarkdown } from "./parser.js";

const MCP_TOKEN_CAP = 18000; // conservative; parser also enforces a hard char ceiling under the ~25k cap

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function sessionLine(m: SessionMeta): string {
  const title = m.title ?? m.firstHumanMessage?.slice(0, 60) ?? "(untitled)";
  return `- **${title}** · ${isoDate(m.mtimeMs)} · ${m.turnCount} turn${m.turnCount === 1 ? "" : "s"} · \`${m.id}\``;
}

/** Resolve a session by id or free-text; returns the meta or a ready-to-return error message. */
function locate(id?: string, query?: string): { meta?: SessionMeta; error?: string } {
  const { match, candidates } = resolveSession(refreshIndex(), { id, query });
  if (match) return { meta: match };
  if (!candidates || candidates.length === 0)
    return { error: `No session found for ${id ? `id "${id}"` : `query "${query}"`}.` };
  return { error: ["Multiple sessions match — specify one by `id`:\n", ...candidates.map(sessionLine)].join("\n") };
}

function renderGroups(groups: CwdGroup[], maxSessions: number): string {
  if (groups.length === 0) return "_No past sessions found._";
  const out: string[] = ["# Recent Claude Code sessions (across all projects)\n"];
  let shown = 0;
  for (const g of groups) {
    if (shown >= maxSessions) {
      out.push(`\n_…more projects omitted; raise \`limit\` or filter by \`cwd\`._`);
      break;
    }
    out.push(`\n## ${g.cwdBase}  \n\`${g.cwd}\``);
    for (const s of g.sessions) {
      if (shown >= maxSessions) break;
      out.push(sessionLine(s));
      shown++;
    }
  }
  return out.join("\n");
}

const server = new McpServer({ name: "memocall", version: "0.1.0" });

server.registerTool(
  "list_sessions",
  {
    title: "List recent Claude Code sessions",
    description:
      "List your recent Claude Code conversations across ALL projects, grouped by project directory. " +
      "Use this to answer 'what sessions have I worked on recently?' or to find a past session before loading it. " +
      "Returns each session's title, date, turn count, and id.",
    inputSchema: {
      cwd: z
        .string()
        .optional()
        .describe("Optional: only show sessions whose project path contains this substring."),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max sessions to list (default 40)."),
    },
  },
  async ({ cwd, limit }) => {
    try {
      let groups = groupByCwd(refreshIndex());
      if (cwd) {
        const q = cwd.toLowerCase();
        groups = groups.filter((g) => g.cwd.toLowerCase().includes(q));
      }
      return text(renderGroups(groups, limit ?? 40));
    } catch (e) {
      return text(`Error listing sessions: ${(e as Error).message}`);
    }
  },
);

server.registerTool(
  "search_sessions",
  {
    title: "Search past Claude Code sessions",
    description:
      "Search your past Claude Code conversations (across all projects) by keyword — matches session titles, " +
      "first messages, and project paths. Use when the user refers to a past conversation by topic " +
      "(e.g. 'the session where we set up the license system'). Returns matching sessions with their ids.",
    inputSchema: {
      query: z.string().describe("Keyword(s) to search for in titles / first messages / project paths."),
      limit: z.number().int().positive().optional().describe("Max results (default 20)."),
    },
  },
  async ({ query, limit }) => {
    try {
      const hits = searchSessions(refreshIndex(), query, limit ?? 20);
      if (hits.length === 0) return text(`No sessions match "${query}".`);
      const lines = [`# Sessions matching "${query}"\n`, ...hits.map((m) => `${sessionLine(m)}  _(${m.cwd ?? "?"})_`)];
      return text(lines.join("\n"));
    } catch (e) {
      return text(`Error searching sessions: ${(e as Error).message}`);
    }
  },
);

server.registerTool(
  "load_session",
  {
    title: "Load a past Claude Code conversation",
    description:
      "Load the context of a past Claude Code conversation as compact Markdown (human turns, collapsed " +
      "tool-call summaries, and assistant replies — tool outputs are elided). Provide either a session `id` " +
      "(from list_sessions/search_sessions) or a free-text `query` to find it. Use this to pull a previous " +
      "conversation's context into the current session. For a very large session, either pass `turns` to load " +
      "a specific window (turn numbers come from session_outline), or prefer session_outline / search_in_session.",
    inputSchema: {
      id: z.string().optional().describe("Session id (uuid) from list_sessions/search_sessions."),
      query: z.string().optional().describe("Free-text to locate the session if you don't have an id."),
      format: z
        .enum(["compact", "full"])
        .optional()
        .describe("compact (default): elide tool details. full: include brief tool inputs."),
      turns: z
        .string()
        .optional()
        .describe('Load only a turn range, 1-based inclusive: "300-340", "300-", "-50", or "300". Turn numbers come from session_outline.'),
      maxTokens: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Approx token budget for the returned transcript (default 16000, capped ~18000)."),
      includeThinking: z.boolean().optional().describe("Include a short trace of assistant thinking (default false)."),
    },
  },
  async ({ id, query, format, maxTokens, includeThinking, turns }) => {
    try {
      if (!id && !query) return text("Provide either `id` or `query` to identify a session.");
      const metas = refreshIndex();
      const { match, candidates } = resolveSession(metas, { id, query });

      if (!match) {
        if (!candidates || candidates.length === 0) {
          return text(`No session found for ${id ? `id "${id}"` : `query "${query}"`}.`);
        }
        const lines = [
          `Multiple sessions match — specify one by \`id\`:\n`,
          ...candidates.map((m) => sessionLine(m)),
        ];
        return text(lines.join("\n"));
      }

      const entries = readSession(match);
      const md = transcriptToMarkdown(entries, {
        format: format ?? "compact",
        maxTokens: Math.min(maxTokens ?? 16000, MCP_TOKEN_CAP),
        includeThinking: includeThinking ?? false,
        turns,
        title: match.title,
        cwd: match.cwd,
        date: isoDate(match.mtimeMs),
      });
      return text(md);
    } catch (e) {
      return text(`Error loading session: ${(e as Error).message}`);
    }
  },
);

server.registerTool(
  "session_outline",
  {
    title: "Outline a past conversation",
    description:
      "Get a quick MAP of a past Claude Code conversation: the numbered list of the user's prompts, one line each. " +
      "Very cheap even for huge sessions. Use this to see what a session covered, or to find which turn numbers to " +
      "then load with load_session's `turns`. Identify the session by `id` or free-text `query`.",
    inputSchema: {
      id: z.string().optional().describe("Session id from list_sessions/search_sessions."),
      query: z.string().optional().describe("Free-text to locate the session if you don't have an id."),
    },
  },
  async ({ id, query }) => {
    try {
      if (!id && !query) return text("Provide either `id` or `query`.");
      const { meta, error } = locate(id, query);
      if (error || !meta) return text(error!);
      return text(
        transcriptToMarkdown(readSession(meta), {
          format: "outline",
          title: meta.title,
          cwd: meta.cwd,
          date: isoDate(meta.mtimeMs),
        }),
      );
    } catch (e) {
      return text(`Error outlining session: ${(e as Error).message}`);
    }
  },
);

server.registerTool(
  "search_in_session",
  {
    title: "Search within a past conversation",
    description:
      "Find specific turns WITHIN one past Claude Code conversation by keyword — returns only the matching turns " +
      "(with their turn numbers). Use when the user asks what was decided or discussed about a topic inside a known " +
      "or large session (e.g. 'what did we decide about retries in that session'). Pick the session by `id` or " +
      "`session` (free-text); `query` is the keyword to find inside it.",
    inputSchema: {
      query: z.string().describe("Keyword(s) to find inside the session."),
      id: z.string().optional().describe("Session id from list_sessions/search_sessions."),
      session: z.string().optional().describe("Free-text to locate the session if you don't have an id."),
    },
  },
  async ({ query, id, session }) => {
    try {
      if (!id && !session) return text("Provide `id` or `session` to pick which conversation to search.");
      const { meta, error } = locate(id, session);
      if (error || !meta) return text(error!);
      return text(
        searchInSession(readSession(meta), query, {
          title: meta.title,
          cwd: meta.cwd,
          date: isoDate(meta.mtimeMs),
        }),
      );
    } catch (e) {
      return text(`Error searching in session: ${(e as Error).message}`);
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the protocol channel; log only to stderr.
  console.error("memocall MCP server running (stdio)");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
