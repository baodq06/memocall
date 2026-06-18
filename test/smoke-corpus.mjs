// Opt-in regression check (run with `npm run smoke`, NOT part of `npm test`).
// Parses every real local session and asserts each rendered transcript stays under the
// output ceiling — the guard against the token-cap overflow bug. Reads your private
// ~/.claude data, so it only runs on your machine, never in CI.
import { listSessions, readSession, refreshIndex } from "../dist/locator.js";
import { transcriptToMarkdown } from "../dist/parser.js";

const CEILING = 50000; // must match HARD_CHAR_CEILING in src/parser.ts

const metas = listSessions(refreshIndex());
let max = 0;
let maxName = "";
let over = 0;

for (const m of metas) {
  const md = transcriptToMarkdown(readSession(m), { title: m.title, cwd: m.cwd });
  if (md.length > max) {
    max = md.length;
    maxName = m.title ?? m.id;
  }
  if (md.length > CEILING) {
    over++;
    console.error(`OVER CEILING: ${md.length} chars — "${m.title ?? m.id}" (${m.id})`);
  }
}

console.log(`sessions checked: ${metas.length}`);
console.log(`largest output:   ${max} chars (~${Math.round(max / 2.8)} real tokens) — "${maxName}"`);
console.log(`ceiling:          ${CEILING}  |  over: ${over}`);
process.exit(over > 0 ? 1 : 0);
