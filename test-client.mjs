// Smoke test: drive the server exactly as Claude Code would, over stdio.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));
const out = (r) => r.content.map((c) => c.text).join("\n");
const call = (name, args) => client.callTool({ name, arguments: args });

const sel = "subagent model"; // a session to exercise the per-session tools against

console.log("\n# list_sessions");
console.log(out(await call("list_sessions", { limit: 3 })).split("\n").slice(0, 6).join("\n"));

console.log("\n# session_outline");
console.log(out(await call("session_outline", { query: sel })).split("\n").slice(0, 12).join("\n"));

console.log("\n# load_session (turns 5-6)");
console.log(out(await call("load_session", { query: sel, turns: "5-6" })).split("\n").slice(0, 6).join("\n"));

console.log("\n# search_in_session ('fallback')");
const s = out(await call("search_in_session", { session: sel, query: "fallback" }));
console.log(s.split("\n").slice(0, 6).join("\n"));

console.log("\n# load_session (full) — size stays under cap");
const full = out(await call("load_session", { query: sel }));
console.log(`[full load: ${full.length} chars / ~${Math.ceil(full.length / 2.8)} real tokens — cap 25000]`);

await client.close();
