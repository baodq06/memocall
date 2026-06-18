/**
 * parser.ts — turn a Claude Code .jsonl transcript into clean Markdown, with several views:
 *
 *   compact (default): per turn → **[n] You:** … / ↳ tool-call summary / **Claude:** …
 *   full:              same, plus brief tool inputs
 *   outline:           just the numbered list of your prompts — a cheap map of a whole session
 *   turn-range:        only turns n..m (navigate a huge session in windows)
 *   search-in-session: only the turns matching a keyword
 *
 * Tool-result bodies are always elided. Abandoned/edited branches are dropped via
 * reconstructActiveThread. A token budget applies middle-out truncation as a safety net.
 *
 * CLI:  node dist/parser.js <file.jsonl> [--full|--outline] [--turns 10-20] [--search "kw"] [--max N] [--think]
 */
import {
  Entry,
  ToolUse,
  classifyUser,
  countHumanTurns,
  getAssistantParts,
  getCwd,
  getTitle,
  isMessageEntry,
  reconstructActiveThread,
  readEntries,
} from "./jsonl.js";
import { basename } from "node:path";

export interface ParseOptions {
  format?: "compact" | "full" | "outline";
  maxTokens?: number; // default 16000; budget is also hard-capped below the MCP output limit
  includeThinking?: boolean;
  turns?: string; // e.g. "300-340", "300-", "-50", "300" — 1-based, inclusive
  title?: string;
  cwd?: string;
  date?: string; // YYYY-MM-DD
}

interface Turn {
  index: number; // 1-based position in the active thread
  human?: string;
  toolUses: ToolUse[];
  texts: string[];
  thinking: string[];
}

// Conservative: dense code/markdown/JSON tokenizes well below 4 chars/token (~2.5–2.8 observed),
// so we must under-estimate chars-per-token or we overshoot Claude Code's real ~25k MCP output cap.
const CHARS_PER_TOKEN = 3;
const HARD_CHAR_CEILING = 50000; // backstop: ~17.5k–21.5k real tokens, safely under the 25k cap
const estimateTokens = (s: string) => Math.ceil(s.length / CHARS_PER_TOKEN);

/** Group the active thread into numbered, human-led turns. */
function buildTurns(thread: Entry[], includeThinking: boolean): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | undefined;
  const fresh = (): Turn => ({ index: turns.length + 1, toolUses: [], texts: [], thinking: [] });

  for (const e of thread) {
    if (e.type === "user") {
      const c = classifyUser(e);
      if (c.kind === "human" && c.text.trim()) {
        cur = fresh();
        cur.human = c.text.trim();
        turns.push(cur);
      }
    } else if (e.type === "assistant") {
      if (!cur) {
        cur = fresh();
        turns.push(cur);
      }
      const p = getAssistantParts(e);
      if (p.toolUses.length) cur.toolUses.push(...p.toolUses);
      if (p.text) cur.texts.push(p.text);
      if (includeThinking && p.thinking) cur.thinking.push(p.thinking);
    }
  }
  return turns;
}

function toolBreakdown(toolUses: ToolUse[]): string {
  const counts = new Map<string, number>();
  for (const t of toolUses) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const shown = parts.slice(0, 6).map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
  if (parts.length > 6) shown.push(`+${parts.length - 6} more`);
  return shown.join(", ");
}

function taskDesc(t: ToolUse): string {
  const inp = t.input ?? {};
  const raw =
    (typeof inp.description === "string" && inp.description) ||
    (typeof inp.prompt === "string" && inp.prompt) ||
    "";
  const oneLine = String(raw).replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? oneLine.slice(0, 117) + "…" : oneLine;
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function renderTurn(turn: Turn, format: "compact" | "full"): string {
  const lines: string[] = [];
  const tag = `[${turn.index}]`;
  if (turn.human) lines.push(`**${tag} You:** ${turn.human}`);

  if (turn.thinking.length) lines.push(`_thinking:_ ${truncate(turn.thinking.join(" "), 500)}`);

  if (turn.toolUses.length) {
    lines.push(
      `↳ ${turn.toolUses.length} tool call${turn.toolUses.length > 1 ? "s" : ""} (${toolBreakdown(turn.toolUses)})`,
    );
    for (const t of turn.toolUses) {
      if (t.name === "Task" || t.name === "Agent") {
        const d = taskDesc(t);
        if (d) lines.push(`   ↳ Task: ${d}`);
      } else if (format === "full" && t.input) {
        const hint = t.input.command ?? t.input.file_path ?? t.input.pattern ?? t.input.path;
        if (typeof hint === "string") lines.push(`   • ${t.name}: ${truncate(hint, 120)}`);
      }
    }
  }

  if (turn.texts.length) lines.push(`**Claude:** ${turn.texts.join("\n\n")}`);
  // anonymous turn (assistant before any human) still gets its number
  if (!turn.human && lines.length) lines[0] = `${tag} ${lines[0]}`;
  return lines.join("\n");
}

function renderOutline(turn: Turn): string {
  if (turn.human) return `${turn.index}. ${truncate(turn.human, 140)}`;
  const tools = turn.toolUses.length ? ` _(${turn.toolUses.length} tool calls)_` : "";
  return `${turn.index}. _(no prompt — assistant)${tools}_`;
}

/** Parse "10-20" | "10-" | "-50" | "10" into a 1-based inclusive [start,end], clamped to [1,total]. */
function parseTurnRange(spec: string, total: number): { start: number; end: number } {
  const m = spec.trim().match(/^(\d+)?\s*-?\s*(\d+)?$/);
  let start = 1;
  let end = total;
  if (m) {
    const hasDash = spec.includes("-");
    if (!hasDash && m[1]) {
      start = end = Number(m[1]); // single turn
    } else {
      if (m[1]) start = Number(m[1]);
      if (m[2]) end = Number(m[2]);
    }
  }
  start = Math.max(1, Math.min(start, total));
  end = Math.max(start, Math.min(end, total));
  return { start, end };
}

function middleOut(turnStrings: string[], budgetChars: number): string[] {
  const total = turnStrings.reduce((n, s) => n + s.length + 2, 0);
  if (total <= budgetChars || turnStrings.length <= 2) return turnStrings;

  const half = budgetChars / 2;
  const head: string[] = [];
  let headLen = 0;
  let i = 0;
  for (; i < turnStrings.length; i++) {
    if (headLen + turnStrings[i].length > half) break;
    head.push(turnStrings[i]);
    headLen += turnStrings[i].length + 2;
  }
  const tail: string[] = [];
  let tailLen = 0;
  let j = turnStrings.length - 1;
  for (; j >= i; j--) {
    if (tailLen + turnStrings[j].length > half) break;
    tail.unshift(turnStrings[j]);
    tailLen += turnStrings[j].length + 2;
  }
  const omitted = j - i + 1;
  if (omitted <= 0) return turnStrings;
  return [
    ...head,
    `\n…[${omitted} turn${omitted > 1 ? "s" : ""} omitted to fit budget — load a turn range (e.g. \`turns: "${i + 1}-${j + 1}"\`) or use search_in_session]…\n`,
    ...tail,
  ];
}

function deriveDate(thread: Entry[]): string | undefined {
  let last: string | undefined;
  for (const e of thread) {
    if (typeof e.timestamp === "string" && (!last || e.timestamp > last)) last = e.timestamp;
  }
  return last ? last.slice(0, 10) : undefined;
}

interface Prepared {
  turns: Turn[];
  header: string;
  budgetChars: number;
  turnCount: number;
}

function prepare(entries: Entry[], opts: ParseOptions, headerNote = ""): Prepared | null {
  const thread = reconstructActiveThread(entries);
  if (thread.length === 0) return null;

  const title = opts.title ?? getTitle(entries) ?? "(untitled session)";
  const cwd = opts.cwd ?? getCwd(entries);
  const date = opts.date ?? deriveDate(thread);
  const turnCount = countHumanTurns(entries);

  const bits = [cwd ? basename(cwd) : undefined, date, `${turnCount} turn${turnCount === 1 ? "" : "s"}`]
    .filter(Boolean)
    .join(" · ");
  const header = `# ${title}${headerNote}\n\n_${bits}_${cwd ? `\n_${cwd}_` : ""}\n`;

  const maxTokens = opts.maxTokens ?? 16000;
  const budgetChars = Math.min(HARD_CHAR_CEILING, Math.max(2000, maxTokens * CHARS_PER_TOKEN - header.length));

  return { turns: buildTurns(thread, opts.includeThinking ?? false), header, budgetChars, turnCount };
}

export function transcriptToMarkdown(entries: Entry[], opts: ParseOptions = {}): string {
  const format = opts.format ?? "compact";

  // turn-range note in the header
  let note = "";
  const base = prepare(entries, opts);
  if (!base) return "_(empty or unreadable transcript)_";

  // OUTLINE: just the numbered prompts — cheap map of the whole session.
  if (format === "outline") {
    const lines = base.turns.map(renderOutline);
    const kept = middleOut(lines, base.budgetChars);
    return base.header + "\n## Outline (one line per turn)\n\n" + kept.join("\n");
  }

  // TURN RANGE: slice before rendering.
  let turns = base.turns;
  if (opts.turns) {
    const { start, end } = parseTurnRange(opts.turns, base.turns.length);
    turns = base.turns.filter((t) => t.index >= start && t.index <= end);
    note = ` — turns ${start}–${end} of ${base.turns.length}`;
  }

  const prepared = note ? prepare(entries, opts, note)! : base;
  const turnStrings = turns.map((t) => renderTurn(t, format === "full" ? "full" : "compact")).filter((s) => s.trim());
  const kept = middleOut(turnStrings, prepared.budgetChars);
  return prepared.header + "\n" + kept.join("\n\n");
}

/** Return only the turns whose text matches a keyword — for drilling into a big session. */
export function searchInSession(entries: Entry[], query: string, opts: ParseOptions = {}): string {
  const base = prepare(entries, opts, ` — matches for "${query}"`);
  if (!base) return "_(empty or unreadable transcript)_";
  const q = query.toLowerCase();
  const hits = base.turns.filter(
    (t) => (t.human ?? "").toLowerCase().includes(q) || t.texts.join("\n").toLowerCase().includes(q),
  );
  if (hits.length === 0) {
    return base.header + `\n_No turns in this session mention "${query}". Try \`session_outline\` to see what it covered._`;
  }
  const turnStrings = hits.map((t) => renderTurn(t, "compact"));
  const kept = middleOut(turnStrings, base.budgetChars);
  return (
    base.header +
    `\n_${hits.length} of ${base.turns.length} turns match. Load surrounding context with \`load_session\` + \`turns\`._\n\n` +
    kept.join("\n\n")
  );
}

// ---- CLI for direct testing -------------------------------------------------
function main(argv: string[]): void {
  const file = argv.find((a) => !a.startsWith("--") && !argv[argv.indexOf(a) - 1]?.match(/^--(turns|search|max)$/));
  if (!file) {
    console.error('usage: node dist/parser.js <file.jsonl> [--full|--outline] [--turns 10-20] [--search "kw"] [--max N] [--think]');
    process.exit(1);
  }
  const arg = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const format = argv.includes("--full") ? "full" : argv.includes("--outline") ? "outline" : "compact";
  const maxTokens = arg("--max") ? Number(arg("--max")) : undefined;
  const includeThinking = argv.includes("--think");
  const turns = arg("--turns");
  const search = arg("--search");

  const entries = readEntries(file);
  const out = search
    ? searchInSession(entries, search, { maxTokens, includeThinking })
    : transcriptToMarkdown(entries, { format, maxTokens, includeThinking, turns });
  const msgs = entries.filter(isMessageEntry).length;
  process.stderr.write(`[parsed ${entries.length} entries, ${msgs} messages → ${out.length} chars / ~${estimateTokens(out)} tokens]\n`);
  process.stdout.write(out + "\n");
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}

export { estimateTokens };
