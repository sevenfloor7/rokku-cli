// rokku model: show the model Rokku runs on, switch to one through a Key, switch back.
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {fakeApi} from "./fake-api.mjs";

const KEY = {credential_id: randomUUID(), label: "work", masked_credential: "sk-••••1234", status: "active", version: 1, endpoint: {kind: "catalog", provider_key: "anthropic"}};
let agent = {agent_version: 4, model_config: {kind: "hosted_default"}, provider_connection_id: null};
const conns = [];
let verifyResult = "ready";
const api = await fakeApi({
  "GET /v1/agents/{agent_id}/settings": () => agent,
  "GET /v1/user/settings": () => ({settings_version: 1, model_mode: "light"}),
  "PATCH /v1/agents/{agent_id}/settings": r => (agent = {...agent, agent_version: agent.agent_version + 1, model_config: r.body.model_config, provider_connection_id: r.body.provider_connection_id}),
  "GET /v1/provider-credentials": () => ({items: [KEY], pagination: {total_pages: 1}}),
  "POST /v1/provider-credentials": r => ({...KEY, credential_id: "k-new", endpoint: r.body.endpoint}),
  "GET /v1/provider-connections": () => ({items: conns, pagination: {total_pages: 1}}),
  "POST /v1/provider-connections": r => { const c = {connection_id: `c${conns.length + 1}`, credential_id: r.body.credential_id, model: r.body.model, status: "unverified", version: 1, endpoint: KEY.endpoint}; conns.push(c); return c; },
  "POST /v1/provider-connections/{connection_id}/verify": r => Object.assign(conns.find(c => c.connection_id === r.params.connection_id), {status: verifyResult, version: 2}),
  "GET /v1/provider-connections/{connection_id}": r => conns.find(c => c.connection_id === r.params.connection_id),
});
const {run, last, requests} = api;

assert.match((await run(["model"])).stdout, /own models, in light mode/);
const used = await run(["model", "use", "claude-sonnet-5", "--key", "work"]);
assert.equal(used.code, 0, used.stderr); assert.match(used.stdout, /now runs on claude-sonnet-5/);
assert.equal(last("POST /v1/provider-connections").body.credential_id, KEY.credential_id);
assert.deepEqual(last("PATCH /v1/agents/{agent_id}/settings").body,
  {expected_agent_version: 4, model_config: {kind: "byok", model: "claude-sonnet-5"}, provider_connection_id: "c1"}, "model and connection are set together");
assert.match((await run(["model"])).stdout, /runs on claude-sonnet-5 with your Key for anthropic \(ready\)/);
// the same Key and model reuses its ready connection
await run(["model", "use", "claude-sonnet-5", "--key", "work"]);
assert.equal(requests.filter(r => r.route === "POST /v1/provider-connections").length, 1);
// a model the Key can't run switches nothing
verifyResult = "invalid";
const patches = requests.filter(r => r.route === "PATCH /v1/agents/{agent_id}/settings").length;
const bad = await run(["model", "use", "nope-1", "--key", "work"]);
assert.equal(bad.code, 1); assert.match(bad.stderr, /nothing was switched/);
assert.equal(requests.filter(r => r.route === "PATCH /v1/agents/{agent_id}/settings").length, patches);
// a new Key comes only from stdin or a hidden prompt
verifyResult = "ready";
await run(["model", "use", "gpt-6", "--provider", "openai"], "sk-typed\n");
assert.equal(last("POST /v1/provider-credentials").body.credential, "sk-typed");
assert.equal((await run(["model", "use", "gpt-6"])).code, 64, "say which Key");
await run(["model", "default"]);
assert.deepEqual(last("PATCH /v1/agents/{agent_id}/settings").body, {expected_agent_version: agent.agent_version - 1, model_config: {kind: "hosted_default"}, provider_connection_id: null});

api.close();
console.log("ok — rokku model shows, switches through a ready connection, and switches back");
