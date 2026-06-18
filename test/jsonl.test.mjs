import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyUser,
  countHumanTurns,
  firstHumanMessage,
  getCwd,
  getTitle,
  reconstructActiveThread,
} from "../dist/jsonl.js";
import * as h from "./helpers.mjs";

test("classifyUser: real human message", () => {
  assert.equal(classifyUser(h.user("hello there")).kind, "human");
});

test("classifyUser: slash-command wrapper", () => {
  const c = classifyUser(h.user("<command-name>/effort</command-name>\n<command-args></command-args>"));
  assert.equal(c.kind, "command");
  assert.equal(c.commandName, "/effort");
});

test("classifyUser: harness/system injections are not human", () => {
  assert.equal(classifyUser(h.user("<task-notification>\n<task-id>x</task-id>")).kind, "system");
  assert.equal(classifyUser(h.user("<system_instruction>\nYou are working inside Conductor")).kind, "system");
  assert.equal(classifyUser(h.user("This session is being continued from a previous conversation...")).kind, "system");
});

test("classifyUser: tool_result entry is not human", () => {
  assert.equal(classifyUser(h.toolResult("tu1")).kind, "tool_result");
});

test("classifyUser: isMeta entry", () => {
  assert.equal(classifyUser(h.user("anything", null, { isMeta: true })).kind, "meta");
});

test("classifyUser: strips an appended system-reminder from human text", () => {
  const c = classifyUser(h.user("the real question\n<system-reminder>noise here</system-reminder>"));
  assert.equal(c.kind, "human");
  assert.equal(c.text, "the real question");
});

test("reconstructActiveThread follows the live branch and drops the abandoned one", () => {
  h.reset();
  const t1 = h.user("question 1");
  const a1 = h.assistant([h.text("answer 1")], t1.uuid);
  const t2dead = h.user("ABANDONED EDIT", a1.uuid);
  const a2dead = h.assistant([h.text("DEAD ANSWER")], t2dead.uuid);
  const t2live = h.user("LIVE EDIT", a1.uuid);
  const a2live = h.assistant([h.text("LIVE ANSWER")], t2live.uuid);
  // file order is chronological; the live branch was written last
  const thread = reconstructActiveThread([t1, a1, t2dead, a2dead, t2live, a2live]);

  assert.deepEqual(
    thread.map((e) => e.uuid),
    [t1.uuid, a1.uuid, t2live.uuid, a2live.uuid],
  );
  const joined = JSON.stringify(thread);
  assert.ok(joined.includes("LIVE EDIT") && joined.includes("LIVE ANSWER"));
  assert.ok(!joined.includes("ABANDONED") && !joined.includes("DEAD ANSWER"));
});

test("reconstructActiveThread on a linear thread returns it in order", () => {
  h.reset();
  const entries = h.chain([h.user("a"), h.assistant([h.text("b")]), h.user("c"), h.assistant([h.text("d")])]);
  const thread = reconstructActiveThread(entries);
  assert.equal(thread.length, 4);
  assert.deepEqual(thread.map((e) => e.uuid), entries.map((e) => e.uuid));
});

test("getTitle returns the LAST ai-title (titles are regenerated)", () => {
  assert.equal(getTitle([h.aiTitle("first"), h.user("hi"), h.aiTitle("second"), h.aiTitle("current")]), "current");
});

test("getCwd returns the cwd field", () => {
  assert.equal(getCwd([h.user("hi")]), "/tmp/proj");
});

test("firstHumanMessage skips injected; countHumanTurns counts only humans", () => {
  h.reset();
  const entries = [
    h.user("<system_instruction>\nsys prompt"),
    h.user("<command-name>/clear</command-name>"),
    h.user("the real first message"),
    h.assistant([h.text("ok")]),
    h.user("second human message"),
    h.toolResult("tu1"),
  ];
  assert.equal(firstHumanMessage(entries), "the real first message");
  assert.equal(countHumanTurns(entries), 2);
});
