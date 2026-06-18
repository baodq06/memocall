import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, searchInSession, transcriptToMarkdown } from "../dist/parser.js";
import * as h from "./helpers.mjs";

// A small session: turn 1 makes several tool calls (incl. a Task) with a tool_result
// whose body must never leak; turn 2 is a plain Q&A.
function sampleSession() {
  h.reset();
  const t1 = h.user("set up the thing");
  const a1 = h.assistant(
    [
      h.text("Sure, working on it."),
      h.tool("Bash", { command: "ls" }),
      h.tool("Read", { file_path: "/x" }),
      h.tool("Task", { description: "explore the repo" }),
    ],
    t1.uuid,
  );
  const r1 = h.toolResult("tu", a1.uuid, "SECRET_TOOL_OUTPUT_SHOULD_NOT_LEAK");
  const a1b = h.assistant([h.text("Done, here is the result.")], r1.uuid);
  const t2 = h.user("now explain it", a1b.uuid);
  const a2 = h.assistant([h.text("Here is the explanation.")], t2.uuid);
  return [h.aiTitle("Sample session"), t1, a1, r1, a1b, t2, a2];
}

test("compact render: structure, tool-call collapse, Task line, no tool-output leak", () => {
  const md = transcriptToMarkdown(sampleSession());
  assert.match(md, /\*\*\[1\] You:\*\* set up the thing/);
  assert.match(md, /\*\*Claude:\*\*/);
  assert.match(md, /↳ 3 tool calls \(/); // collapsed, not dumped
  assert.match(md, /Task: explore the repo/);
  assert.ok(!md.includes("SECRET_TOOL_OUTPUT_SHOULD_NOT_LEAK"), "tool_result body must not leak");
});

test("outline: one numbered line per turn, no assistant prose", () => {
  const md = transcriptToMarkdown(sampleSession(), { format: "outline" });
  assert.match(md, /## Outline/);
  assert.match(md, /^1\. set up the thing/m);
  assert.match(md, /^2\. now explain it/m);
  assert.ok(!md.includes("Here is the explanation."), "outline should not include assistant text");
});

test("turn range returns only the requested turns", () => {
  const md = transcriptToMarkdown(sampleSession(), { turns: "2-2" });
  assert.match(md, /turns 2.2 of/); // en-dash between 2 and 2
  assert.match(md, /now explain it/);
  assert.ok(!md.includes("set up the thing"), "turn 1 should be excluded");
});

test("searchInSession returns only matching turns", () => {
  const md = searchInSession(sampleSession(), "explain");
  assert.match(md, /matches for "explain"/);
  assert.match(md, /now explain it/);
  assert.ok(!md.includes("set up the thing"), "non-matching turn excluded");
});

test("searchInSession reports no matches cleanly", () => {
  const md = searchInSession(sampleSession(), "zzzznotpresent");
  assert.match(md, /No turns in this session mention/);
});

test("truncation: large session stays under the ceiling and marks omission", () => {
  h.reset();
  const entries = [h.aiTitle("Big session")];
  const filler = "x".repeat(3000);
  let parent = null;
  for (let i = 0; i < 100; i++) {
    const u = h.user(`prompt ${i} ${filler}`, parent);
    parent = u.uuid;
    const a = h.assistant([h.text(`response ${i} ${filler}`)], parent);
    parent = a.uuid;
    entries.push(u, a);
  }
  const md = transcriptToMarkdown(entries, { maxTokens: 16000 });
  assert.ok(md.length <= 50000, `output ${md.length} chars must be <= 50000 ceiling`);
  assert.match(md, /omitted to fit budget/);
  assert.ok(estimateTokens(md) < 25000, "estimated tokens must stay under the MCP cap");
});

test("empty/unreadable transcript is handled", () => {
  assert.match(transcriptToMarkdown([{ type: "mode" }]), /empty or unreadable/);
});
