// `rokku secret set NAME --from "App Key"` against a fake Rokku API: it links the Key by label, sends no
// value and no host (the Host fills in the Key's provider host), and refuses unknown or ambiguous labels.
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdtempSync, writeFileSync} from "node:fs";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";

const CLI = resolve(import.meta.dirname, "../bin/rokku.mjs");
const AGENT = randomUUID(), KEY = randomUUID(), TWIN_A = randomUUID(), TWIN_B = randomUUID();
const keys = [
  {credential_id: KEY, label: "official ds", masked_credential: "sk-eae••••abc6", status: "active", endpoint: {kind: "catalog", provider_key: "deepseek"}},
  {credential_id: randomUUID(), label: "old ds", masked_credential: "sk-old••••0000", status: "revoked", endpoint: {kind: "catalog", provider_key: "deepseek"}},
  {credential_id: TWIN_A, label: "twin", masked_credential: "sk-a••••", status: "active", endpoint: {kind: "catalog", provider_key: "openai"}},
  {credential_id: TWIN_B, label: "Twin", masked_credential: "sk-b••••", status: "active", endpoint: {kind: "catalog", provider_key: "openai"}},
];
const puts = [];
const ok = data => JSON.stringify({code: 0, data, error: null, request_id: randomUUID()});
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://x");
  const parts = []; for await (const chunk of request) parts.push(chunk);
  response.setHeader("Content-Type", "application/json");
  if (request.method === "GET" && url.pathname === "/v1/provider-credentials") return response.end(ok({items: keys, pagination: {page_number: 1, page_size: 100, total_items: keys.length, total_pages: 1}}));
  const put = url.pathname.match(new RegExp(`^/v1/agents/${AGENT}/secrets/([A-Z_]+)$`));
  if (request.method === "PUT" && put) {
    const body = JSON.parse(Buffer.concat(parts).toString());
    puts.push({name: put[1], body});
    return response.end(ok({name: put[1], host: body.host ?? "api.deepseek.com", header: body.header, sandbox: body.sandbox,
      creations: body.creations, provider_credential_id: body.provider_credential_id ?? null, created_at: "2026-11-15T00:00:00Z", updated_at: "2026-11-15T00:00:00Z"}));
  }
  response.statusCode = 404; response.end(JSON.stringify({code: 3000, data: null, error: {message: "not found"}}));
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const dir = mkdtempSync(join(tmpdir(), "rokku-secret-from-"));
writeFileSync(join(dir, "config.json"), JSON.stringify({access_token: "t", access_expires_at: new Date(Date.now() + 86400_000).toISOString(),
  refresh_token: "r", agent_id: AGENT, email: "x@example.com"}));
const env = {...process.env, ROKKU_TOKEN_STORE: "file", ROKKU_CONFIG: join(dir, "config.json"), ROKKU_API: `http://127.0.0.1:${server.address().port}`};
const run = args => new Promise(done => execFile("node", [CLI, ...args], {env}, (error, stdout, stderr) => done({code: error ? 1 : 0, stdout, stderr})));

const linked = await run(["secret", "set", "DEEPSEEK_API_KEY", "--from", "Official DS", "--sandbox"]);
assert.equal(linked.code, 0, linked.stderr);
assert.deepEqual(puts.at(-1), {name: "DEEPSEEK_API_KEY", body: {provider_credential_id: KEY, header: "Authorization: Bearer {}", sandbox: true, creations: []}},
  "links by label (case-insensitive), sends no value and no host");
assert.match(linked.stdout, /Linked DEEPSEEK_API_KEY to your App Key "official ds" for api\.deepseek\.com/);

const byId = await run(["secret", "set", "K", "--from", KEY, "--host", "api.deepseek.com", "--sandbox"]);
assert.equal(byId.code, 0, byId.stderr);
assert.equal(puts.at(-1).body.host, "api.deepseek.com", "an explicit --host is passed through for the Host to check");

for (const [ref, message] of [["old ds", /--from takes the label or id of a Key stored in the App/], ["nope", /--from takes the label/], ["twin", /More than one App Key is labelled "twin"/]]) {
  const refused = await run(["secret", "set", "K", "--from", ref, "--sandbox"]);
  assert.equal(refused.code, 1); assert.match(refused.stderr, message);
}
const listed = await run(["key", "list"]);
assert.match(listed.stdout, /official ds\s+deepseek\s+sk-eae••••abc6\s+active/);
assert.ok(!/abc6[0-9a-z]/.test(listed.stdout), "only masked values are shown");
server.close();
console.log("ok — secret set --from links an App Key by label or id, never sends a value");
