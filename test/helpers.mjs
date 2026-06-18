// Synthetic transcript builders for tests — no private data, no hand-written JSON.
// Mirrors the real Claude Code .jsonl entry shapes that src/jsonl.ts understands.
import { writeFileSync } from "node:fs";

let _id = 0;
let _clock = 0;
export function reset() {
  _id = 0;
  _clock = 0;
}
const nextId = () => `id${++_id}`;
const nextTs = () =>
  `2026-06-18T10:${String(Math.floor(_clock / 60) % 60).padStart(2, "0")}:${String(_clock++ % 60).padStart(2, "0")}.000Z`;

// content blocks
export const text = (t) => ({ type: "text", text: t });
export const thinking = (t) => ({ type: "thinking", thinking: t });
export const tool = (name, input = {}) => ({ type: "tool_use", name, input, id: nextId() });

// entries
export function user(content, parentUuid = null, extra = {}) {
  return {
    type: "user",
    uuid: nextId(),
    parentUuid,
    message: { role: "user", content },
    cwd: "/tmp/proj",
    timestamp: nextTs(),
    ...extra,
  };
}
export function assistant(content, parentUuid = null, extra = {}) {
  return {
    type: "assistant",
    uuid: nextId(),
    parentUuid,
    message: { role: "assistant", content },
    cwd: "/tmp/proj",
    timestamp: nextTs(),
    ...extra,
  };
}
export function toolResult(toolUseId, parentUuid = null, body = "TOOL_OUTPUT_BODY") {
  return {
    type: "user",
    uuid: nextId(),
    parentUuid,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: body }] },
    cwd: "/tmp/proj",
    timestamp: nextTs(),
  };
}
export const aiTitle = (t) => ({ type: "ai-title", aiTitle: t });

/** Auto-chain message entries: each one's parentUuid = previous entry's uuid. */
export function chain(entries) {
  let parent = null;
  for (const e of entries) {
    if (e.uuid) {
      e.parentUuid = parent;
      parent = e.uuid;
    }
  }
  return entries;
}

export function writeJsonl(path, entries) {
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
}
