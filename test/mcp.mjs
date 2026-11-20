// rokku mcp speaks MCP over stdio: lists a tool per command and runs them; secrets never come from the model.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {resolve} from "node:path";
import {fakeApi} from "./fake-api.mjs";

const api = await fakeApi({
  "GET /v1/agents/{agent_id}/artifacts": () => ({items: [{artifact_id: "a1", title: "Ping", latest_version: 2, app_url: null}], next_cursor: null}),
  "GET /v1/agents/{agent_id}/secrets": () => ({items: []}),
  "DELETE /v1/agents/{agent_id}/secrets/{name}": () => null,
});
const server = spawn(process.execPath, [resolve(import.meta.dirname, "../bin/rokku.mjs"), "mcp"], {env: api.env});
const replies = new Map();
let buffer = "";
server.stdout.on("data", chunk => {
  buffer += chunk;
  for (let end; (end = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(end + 1)) {
    const message = JSON.parse(buffer.slice(0, end));
    replies.get(message.id)?.(message);
  }
});
let next = 0;
const call = (method, params) => new Promise(done => {
  const id = ++next;
  replies.set(id, done);
  server.stdin.write(JSON.stringify({jsonrpc: "2.0", id, method, params}) + "\n");
});

const init = await call("initialize", {protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {name: "test", version: "1"}});
assert.equal(init.result.serverInfo.name, "rokku");
server.stdin.write(JSON.stringify({jsonrpc: "2.0", method: "notifications/initialized"}) + "\n");
const {tools} = (await call("tools/list")).result;
assert.ok(tools.some(tool => tool.name === "rokku_ask") && tools.some(tool => tool.name === "rokku_restore_version"));
assert.ok(!tools.some(tool => /login|api|mcp/.test(tool.name)), "login, raw api and mcp are not tools");
const listed = (await call("tools/call", {name: "rokku_creations", arguments: {args: []}})).result;
assert.equal(listed.isError, false); assert.match(listed.content[0].text, /Ping/);
const secret = (await call("tools/call", {name: "rokku_secret", arguments: {args: ["set", "X_KEY", "--host", "a.example", "--sandbox"], stdin: "sk-from-model"}})).result;
assert.equal(secret.isError, true); assert.match(secret.content[0].text, /typed by the user/);
assert.ok(!api.requests.some(r => r.route.startsWith("PUT")), "nothing was set");
assert.ok(tools.every(tool => tool.inputSchema.properties.yes), "every tool takes yes");
const refused = (await call("tools/call", {name: "rokku_secret", arguments: {args: ["delete", "OLD_KEY"]}})).result;
assert.equal(refused.isError, true); assert.match(refused.content[0].text, /pass --yes/);
const deleted = (await call("tools/call", {name: "rokku_secret", arguments: {args: ["delete", "OLD_KEY"], yes: true}})).result;
assert.equal(deleted.isError, false, deleted.content[0].text);
assert.equal(api.requests.at(-1).route, "DELETE /v1/agents/{agent_id}/secrets/{name}");
assert.equal((await call("tools/call", {name: "rokku_nope", arguments: {}})).error.code, -32602);
assert.equal((await call("nope")).error.code, -32601);

server.stdin.end(); api.close();
console.log("ok — rokku mcp lists and runs the commands, and refuses secrets from the model");
