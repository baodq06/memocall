import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, utimesSync } from "node:fs";
import { readSession } from "../dist/locator.js";
import * as h from "./helpers.mjs";

test("readSession caches by mtime and invalidates when the file changes", () => {
  h.reset();
  const file = join(tmpdir(), `memocall-cache-test-${process.pid}.jsonl`);
  h.writeJsonl(file, [h.aiTitle("t"), h.user("hi"), h.assistant([h.text("yo")])]);
  const meta = { file }; // readSession only uses meta.file

  try {
    const a = readSession(meta);
    const b = readSession(meta);
    assert.strictEqual(a, b, "same mtime → same cached array instance (no re-parse)");

    // simulate new messages appended: bump mtime into the future
    const future = Date.now() / 1000 + 120;
    utimesSync(file, future, future);

    const c = readSession(meta);
    assert.notStrictEqual(a, c, "changed mtime → fresh parse");
    assert.deepEqual(
      c.map((e) => e.uuid),
      a.map((e) => e.uuid),
      "content is equivalent after re-parse",
    );
  } finally {
    rmSync(file, { force: true });
  }
});
