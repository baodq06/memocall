/**
 * locator.ts — find sessions across ALL projects and keep a cached metadata index.
 *
 * Facts: real sessions are `<configDir>/projects/<dir>/<uuid>.jsonl` (depth 1). Subagent
 * transcripts live under `<uuid>/subagents/` and are NOT sessions. The true project path is
 * the `cwd` field inside the file, not the (ambiguous) dash-encoded directory name.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import {
  Entry,
  countHumanTurns,
  firstHumanMessage,
  getCwd,
  getGitBranch,
  getTitle,
  readEntries,
} from "./jsonl.js";

export interface SessionMeta {
  id: string; // uuid (filename stem)
  file: string; // absolute path to the .jsonl
  cwd?: string; // true project path
  title?: string;
  firstHumanMessage?: string;
  turnCount: number;
  gitBranch?: string;
  mtimeMs: number;
}

export interface CwdGroup {
  cwd: string;
  cwdBase: string;
  sessions: SessionMeta[];
  latestMtimeMs: number;
}

const INDEX_VERSION = 1;

function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}
function projectsDir(): string {
  return join(configDir(), "projects");
}
function indexPath(): string {
  return join(configDir(), "memocall-index.json");
}

/** All top-level session files: <projects>/<dir>/<uuid>.jsonl (never subagents/). */
export function enumerateSessionFiles(): string[] {
  const root = projectsDir();
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const dir of readdirSync(root)) {
    const projPath = join(root, dir);
    let stat;
    try {
      stat = statSync(projPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const fn of readdirSync(projPath)) {
      if (!fn.endsWith(".jsonl")) continue;
      const full = join(projPath, fn);
      try {
        if (statSync(full).isFile()) files.push(full);
      } catch {
        /* ignore */
      }
    }
  }
  return files;
}

function extractMeta(file: string, mtimeMs: number): SessionMeta {
  const entries: Entry[] = readEntries(file);
  return {
    id: basename(file, ".jsonl"),
    file,
    cwd: getCwd(entries),
    title: getTitle(entries),
    firstHumanMessage: firstHumanMessage(entries),
    turnCount: countHumanTurns(entries),
    gitBranch: getGitBranch(entries),
    mtimeMs,
  };
}

interface IndexFile {
  version: number;
  entries: Record<string, { mtimeMs: number; meta: SessionMeta }>;
}

function loadIndex(): IndexFile {
  try {
    const data = JSON.parse(readFileSync(indexPath(), "utf8")) as IndexFile;
    if (data.version === INDEX_VERSION && data.entries) return data;
  } catch {
    /* missing or stale */
  }
  return { version: INDEX_VERSION, entries: {} };
}

function saveIndex(idx: IndexFile): void {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = indexPath() + `.tmp${process.pid}`;
  writeFileSync(tmp, JSON.stringify(idx), "utf8");
  renameSync(tmp, indexPath()); // atomic
}

/**
 * Refresh the cached index: re-read only files whose mtime changed, drop deleted files.
 * Returns metadata for every current session. First run reads all files (~seconds); after
 * that it is near-instant.
 */
export function refreshIndex(): SessionMeta[] {
  const idx = loadIndex();
  const files = enumerateSessionFiles();
  const present = new Set(files);
  let changed = false;

  const metas: SessionMeta[] = [];
  for (const file of files) {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    const cached = idx.entries[file];
    if (cached && cached.mtimeMs === mtimeMs) {
      metas.push(cached.meta);
    } else {
      const meta = extractMeta(file, mtimeMs);
      idx.entries[file] = { mtimeMs, meta };
      metas.push(meta);
      changed = true;
    }
  }
  // prune deleted files
  for (const key of Object.keys(idx.entries)) {
    if (!present.has(key)) {
      delete idx.entries[key];
      changed = true;
    }
  }
  if (changed) {
    try {
      saveIndex(idx);
    } catch {
      /* index is a cache; ignore write failures */
    }
  }
  return metas;
}

/** Only sessions with real human turns, most-recent first. */
export function listSessions(metas: SessionMeta[]): SessionMeta[] {
  return metas.filter((m) => m.turnCount > 0).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Group sessions by their project cwd, groups ordered by most-recent activity. */
export function groupByCwd(metas: SessionMeta[]): CwdGroup[] {
  const groups = new Map<string, SessionMeta[]>();
  for (const m of listSessions(metas)) {
    const key = m.cwd || "(unknown)";
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(m);
  }
  const out: CwdGroup[] = [];
  for (const [cwd, sessions] of groups) {
    out.push({
      cwd,
      cwdBase: cwd === "(unknown)" ? cwd : basename(cwd),
      sessions,
      latestMtimeMs: Math.max(...sessions.map((s) => s.mtimeMs)),
    });
  }
  return out.sort((a, b) => b.latestMtimeMs - a.latestMtimeMs);
}

function matches(m: SessionMeta, q: string): boolean {
  const hay = `${m.title ?? ""}\n${m.firstHumanMessage ?? ""}\n${m.cwd ?? ""}`.toLowerCase();
  return hay.includes(q.toLowerCase());
}

export function searchSessions(metas: SessionMeta[], query: string, limit = 20): SessionMeta[] {
  return listSessions(metas)
    .filter((m) => matches(m, query))
    .slice(0, limit);
}

/** Resolve a session by exact id or by free-text query. Reports ambiguity. */
export function resolveSession(
  metas: SessionMeta[],
  opts: { id?: string; query?: string },
): { match?: SessionMeta; candidates?: SessionMeta[] } {
  if (opts.id) {
    const m = metas.find((x) => x.id === opts.id);
    return m ? { match: m } : { candidates: [] };
  }
  if (opts.query) {
    const hits = searchSessions(metas, opts.query, 10);
    if (hits.length === 1) return { match: hits[0] };
    if (hits.length === 0) return { candidates: [] };
    // Multiple: if the top hit is clearly the most recent, still return candidates for safety.
    return { candidates: hits };
  }
  return { candidates: [] };
}

/**
 * In-memory content cache: parsed Entry[] keyed by file path, invalidated by mtime.
 * The MCP server is one long-lived process per Claude Code session, so this persists across
 * tool calls (outline → search_in_session → load_session all hit the same file) and is freed
 * when the session ends. Bounded to avoid unbounded memory on big sessions.
 */
const CONTENT_CACHE_MAX = 5;
const contentCache = new Map<string, { mtimeMs: number; entries: Entry[] }>();

export function readSession(meta: SessionMeta): Entry[] {
  const file = meta.file;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return readEntries(file); // file vanished mid-session; best-effort, don't cache
  }

  const hit = contentCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.entries; // no diff → serve cache

  const entries = readEntries(file); // changed or uncached → (re)parse
  contentCache.set(file, { mtimeMs, entries });
  if (contentCache.size > CONTENT_CACHE_MAX) {
    const oldest = contentCache.keys().next().value; // FIFO eviction
    if (oldest !== undefined) contentCache.delete(oldest);
  }
  return entries;
}

export function isoDate(mtimeMs: number): string {
  return new Date(mtimeMs).toISOString().slice(0, 10);
}
