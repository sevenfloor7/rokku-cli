// Connector, model Key, memory and export commands: what they send, and that secrets come only from stdin.
import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fakeApi} from "./fake-api.mjs";

const NOTION = {connection_id: randomUUID(), connector_id: "notion", display_name: "Notion", auth_state: "ok", use_enabled: true, placement: "connector",
  authority_revision: 4, items: [{item: "view", policy: "allow"}, {item: "manage", policy: "ask"}], tools: []};
const KEY = {credential_id: randomUUID(), label: "work", masked_credential: "sk-••••1234", status: "active", version: 2, endpoint: {kind: "catalog", provider_key: "openai"}};
const ARCHIVE = Buffer.from("export bytes");
let polls = 0;
const api = await fakeApi({
  "GET /v1/connectors": () => ({items: [{name: "Photos"}], next_cursor: null, third_party: [
    {connector_id: "notion", name: "Notion", access_kind: "remote_mcp", auth_methods: ["oauth"]},
    {connector_id: "acme", name: "Acme", access_kind: "reviewed_api", auth_methods: ["api_key"]},
    {connector_id: "ledger", name: "Ledger", access_kind: "reviewed_api", auth_methods: ["user_fields"],
      user_credential: {kind: "api_credentials", setup_url: "https://ledger.example/keys", fields: [{name: "account", label: "Account ID"}, {name: "token", label: "Token"}]}}]}),
  "GET /v1/agents/{agent_id}/third-party-connections": () => ({items: [NOTION], next_cursor: null}),
  "GET /v1/agents/{agent_id}/connector-connections": () => ({items: [], next_cursor: null}),
  "POST /v1/agents/{agent_id}/third-party-connections/oauth": () => ({attempt_id: "att-1", authorization_url: "https://auth.example/start"}),
  "GET /v1/agents/{agent_id}/third-party-connections/oauth/{attempt_id}": () => (++polls < 2 ? {status: "pending"} : {status: "completed", connection_id: "c-9"}),
  "POST /v1/agents/{agent_id}/third-party-connections": r => ({...NOTION, connection_id: "c-new", display_name: r.body.display_name ?? "Acme", tools: [{}]}),
  "DELETE /v1/agents/{agent_id}/third-party-connections/{connection_id}": () => null,
  "PATCH /v1/agents/{agent_id}/third-party-connections/{connection_id}/items": r => ({...NOTION, items: r.body.items}),
  "GET /v1/provider-credentials": () => ({items: [KEY], pagination: {total_pages: 1}}),
  "POST /v1/provider-credentials": r => ({...KEY, credential_id: "k-new", endpoint: r.body.endpoint}),
  "PATCH /v1/provider-credentials/{credential_id}": () => KEY,
  "POST /v1/provider-credentials/{credential_id}/rotations": () => ({state: "validating"}),
  "DELETE /v1/provider-credentials/{credential_id}": () => KEY,
  "GET /v1/agents/{agent_id}/memory": () => ({user_md: "- Prefers short answers\n- Lives in Lisbon", memory_md: "", tree_revision: 1}),
  "GET /v1/agents/{agent_id}/memory/tree": () => ({items: [{path: "people/ana.md", kind: "file", name: "ana.md"}], next_cursor: null}),
  "GET /v1/agents/{agent_id}/memory/file": r => r.query.cursor ? {content: " part two", next_cursor: null} : {content: "part one", next_cursor: "c2"},
  "POST /v1/account/exports": () => ({export_id: "e1", state: "queued"}),
  "GET /v1/account/exports/{export_id}": () => ({export_id: "e1", state: "ready", archive_size_bytes: ARCHIVE.length, archive_sha256: createHash("sha256").update(ARCHIVE).digest("hex")}),
  "GET /v1/account/exports/{export_id}/content": () => ({raw: ARCHIVE}),
});
const {run, last, requests} = api;

// --no-browser prints the link and returns at once, so a headless agent is not left waiting
const oauth = await run(["connector", "connect", "notion", "--no-browser"]);
assert.equal(oauth.code, 0); assert.match(oauth.stderr, /https:\/\/auth\.example\/start/); assert.match(oauth.stdout, /rokku connector list shows the connection/);
assert.equal(polls, 0, "the attempt is not polled");
assert.deepEqual(last("POST /v1/agents/{agent_id}/third-party-connections/oauth").body, {connector_id: "notion", return_to: "web", placement: "connector"});
// keys and fields come from stdin, never arguments
await run(["connector", "connect", "acme"], "acme-secret\n");
assert.deepEqual(last("POST /v1/agents/{agent_id}/third-party-connections").body.credential, {kind: "api_key", value: "acme-secret"});
await run(["connector", "connect", "ledger"], JSON.stringify({account: "42", token: "t"}));
assert.deepEqual(last("POST /v1/agents/{agent_id}/third-party-connections").body.credential, {kind: "user_fields", values: {account: "42", token: "t"}});
assert.equal((await run(["connector", "connect", "--mcp-url", "https://mcp.example/sse"])).code, 64, "custom MCP needs --unreviewed");
// trusting an unreviewed server and letting Rokku act without asking are the user's own decisions
const unreviewed = await run(["connector", "connect", "--mcp-url", "https://mcp.example/sse", "--unreviewed", "--name", "Mine"]);
assert.equal(unreviewed.code, 64); assert.match(unreviewed.stderr, /your own decision/);
assert.ok(!api.requests.some(r => r.body?.custom_mcp_url), "nothing connected without a person at a terminal");
assert.match((await run(["connector"])).stdout, /Notion\s+ok\s+yes\s+view=allow manage=ask/);
assert.equal((await run(["connector", "allow", "notion", "manage=allow"])).code, 64, "allow needs a person at a terminal");
assert.equal(last("PATCH /v1/agents/{agent_id}/third-party-connections/{connection_id}/items"), undefined);
await run(["connector", "allow", "notion", "manage=ask", "view=deny"]);
assert.deepEqual(last("PATCH /v1/agents/{agent_id}/third-party-connections/{connection_id}/items").body,
  {expected_revision: 4, items: [{item: "manage", policy: "ask"}, {item: "view", policy: "deny"}]}, "tightening needs no prompt");
assert.equal((await run(["connector", "allow", "notion", "manage=sometimes"])).code, 64);
assert.equal((await run(["connector", "remove", "notion"])).code, 64);
await run(["connector", "remove", "notion", "--yes"]);
assert.equal(last("DELETE /v1/agents/{agent_id}/third-party-connections/{connection_id}").params.connection_id, NOTION.connection_id);

// model Keys
await run(["key", "add", "--base-url", "https://llm.example/v1", "--label", "lab"], "sk-new\n");
const added = last("POST /v1/provider-credentials").body;
assert.deepEqual({...added, client_credential_id: undefined}, {client_credential_id: undefined, endpoint: {kind: "openai_compatible", base_url: "https://llm.example/v1"}, credential: "sk-new", label: "lab"});
assert.equal((await run(["key", "add", "--provider", "openai"], "")).code, 1, "an empty value changes nothing");
await run(["key", "label", "work", "personal"]);
assert.deepEqual(last("PATCH /v1/provider-credentials/{credential_id}").body, {expected_version: 2, label: "personal"});
await run(["key", "rotate", "work"], "sk-rotated\n");
assert.deepEqual(last("POST /v1/provider-credentials/{credential_id}/rotations").body, {expected_version: 2, credential: "sk-rotated"});
await run(["key", "remove", "work", "--yes"]);
assert.deepEqual(last("DELETE /v1/provider-credentials/{credential_id}").body, {expected_version: 2});
assert.ok(!requests.some(r => JSON.stringify(r.query).includes("sk-")), "no key value in a URL");

// memory is read-only; export downloads and checks the archive
assert.match((await run(["memory", "--grep", "lisbon"])).stdout, /^- Lives in Lisbon$/);
assert.match((await run(["memory", "files"])).stdout, /people\/ana\.md/);
assert.equal((await run(["memory", "read", "people/ana.md"])).stdout, "part one part two");
assert.equal((await run(["memory", "write", "x"])).code, 64, "no memory writes");
const out = join(tmpdir(), `rokku-export-${randomUUID()}.tar`);
assert.match((await run(["export", "--out", out])).stdout, /Saved your Rokku export/);
assert.equal(readFileSync(out, "utf8"), "export bytes");

api.close();
console.log("ok — connector, model Key, memory and export commands");
