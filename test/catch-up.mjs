// Commands added for the 11-28 API catch-up: chat search and delete, billing, memory stats, model mode
// and Key usage, and connector events.
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {fakeApi, CONVERSATION} from "./fake-api.mjs";

const M1 = randomUUID(), M2 = randomUUID(), GRANT = randomUUID(), ART = randomUUID();
let agent = {agent_version: 3, model_config: {kind: "hosted_default"}, provider_connection_id: null, byok_enabled: false};
let user = {settings_version: 1, model_mode: "light"};
const api = await fakeApi({
  "GET /v1/agents/{agent_id}/conversations/{conversation_id}/messages": () => ({messages: [
    {message: {message_id: M1, role: "user", created_at: "2026-11-28T01:00:00Z", content: [{type: "text", payload: {text: "blueberry pancakes"}}]}},
    {message: {message_id: M2, role: "agent", created_at: "2026-11-28T01:00:05Z", content: [{type: "text", payload: {text: "Sounds good"}}]}}]}),
  "GET /v1/agents/{agent_id}/conversations/{conversation_id}/search": r => ({hits: r.query.q === "none" ? [] : [
    {message_id: M1, message_seq: 9, role: "user", created_at: "2026-11-28T01:00:00Z", block_id: "b", match: "text", excerpt: "blueberry pancakes", image: null}],
    next_before_message_seq: r.query.before_message_seq ? null : 9}),
  "POST /v1/agents/{agent_id}/conversations/{conversation_id}/messages:delete": r => ({deleted: r.body.message_ids}),
  "GET /v1/billing": () => ({plan: "free", subscription: null, one_month: null, credits: {balance_micro_credits: 99_933_520, debt_micro_credits: 0,
    monthly: {granted_micro_credits: 100_000_000, remaining_micro_credits: 99_933_520, resets_at: "2026-12-27T17:14:02Z"},
    gifted: {remaining_micro_credits: 0}, purchased: {remaining_micro_credits: 0},
    usage: {period_start: "2026-11-27T17:14:02Z", charged_micro_credits: {model: 28_980, search: 37_500, sandbox: 0}, total_charged_micro_credits: 66_480}}}),
  "GET /v1/agents/{agent_id}/memory/stats": () => ({about_you: 12, relationship: 3, tree_revision: 40, updated_at: "2026-11-27T10:00:00Z"}),
  "GET /v1/agents/{agent_id}/settings": () => agent,
  "GET /v1/user/settings": () => user,
  "PATCH /v1/user/settings": r => (user = {...user, ...r.body, settings_version: user.settings_version + 1}),
  "GET /v1/provider-connections/{connection_id}/account-usage": () => ({checked_at: "2026-11-28T01:00:00Z",
    balance: {status: "available", scope: "account", amounts: [{amount: "12.50", currency: "USD"}]},
    today: {status: "unsupported", amounts: []}, month: {status: "available", amounts: [{amount: "3.20", currency: "USD"}]}}),
  "GET /v1/provider-connections/{connection_id}": () => ({connection_id: "c1", model: "gpt-6", status: "ready", endpoint: {provider_key: "openai"}}),
  "GET /v1/agents/{agent_id}/artifacts": () => ({items: [{artifact_id: ART, title: "Inbox Digest", latest_version: 2, app_url: "https://x.example"}], next_cursor: null}),
  "GET /v1/agents/{agent_id}/artifact-event-grants": r => ({agent_id: "a", next_cursor: null, items: [
    {id: GRANT, item_id: "gmail.new_email", label: "New emails", artifact_id: ART, artifact_title: "Inbox Digest", connector: "gmail", source: "creation_card", created_at: "2026-11-27T10:00:00Z", revoked_at: null},
    {id: randomUUID(), item_id: "x", label: "Old", artifact_id: ART, artifact_title: "Inbox Digest", connector: "gmail", source: "later_card", created_at: "2026-11-20T10:00:00Z", revoked_at: "2026-11-21T10:00:00Z"},
  ].filter(() => !r.query.artifact_id || r.query.artifact_id === ART)}),
  "DELETE /v1/agents/{agent_id}/artifact-event-grants/{grant_id}": () => null,
});
const {run, last, requests} = api;
const count = route => requests.filter(r => r.route === route).length;

// chat: ids on request, search with paging, delete asks first and sends protocol 7
const chat = await run(["chat", "--ids"]);
assert.equal(chat.code, 0, chat.stderr);
assert.ok(chat.stdout.includes(M1) && chat.stdout.includes("── Rokku"), chat.stdout);
assert.ok(!(await run(["chat"])).stdout.includes(M1), "ids only with --ids");
const found = await run(["chat", "search", "blueberry", "pancakes"]);
assert.equal(last("GET /v1/agents/{agent_id}/conversations/{conversation_id}/search").query.q, "blueberry pancakes");
assert.ok(found.stdout.includes(M1) && /--before 9/.test(found.stdout), found.stdout);
await run(["chat", "search", "blueberry", "--before", "9"]);
assert.equal(last("GET /v1/agents/{agent_id}/conversations/{conversation_id}/search").query.before_message_seq, "9");
assert.match((await run(["chat", "search", "none"])).stdout, /nothing matches/);
assert.equal((await run(["chat", "search"])).code, 64);
// deleting messages is the user's own decision: refused without a person at a terminal, --yes or not
for (const args of [["chat", "delete", M1], ["chat", "delete", M1, M2, "--yes"]]) {
  const refused = await run(args);
  assert.equal(refused.code, 64); assert.match(refused.stderr, /your own decision/);
}
const viaMcp = await run(["chat", "delete", M1, "--yes"], "", {ROKKU_MCP: "1"});
assert.equal(viaMcp.code, 64); assert.match(viaMcp.stderr, /your own decision/);
assert.equal(count("POST /v1/agents/{agent_id}/conversations/{conversation_id}/messages:delete"), 0, "nothing deleted");
assert.equal((await run(["chat", "nope"])).code, 64);

// billing: credits in whole units, only the kinds that were charged
const billing = await run(["billing"]);
assert.match(billing.stdout, /Plan: free/);
assert.match(billing.stdout, /Credits left: 99\.93 \(monthly 99\.93 of 100\.00/);
assert.match(billing.stdout, /: 0\.07 \(model 0\.03, search 0\.04\)/);
assert.ok(!billing.stdout.includes("sandbox"));

// memory stats
assert.match((await run(["memory", "stats"])).stdout, /12 about you, 3 preferences and opinions/);

// model mode and show
assert.match((await run(["model"])).stdout, /own models, in Fast mode/);
assert.equal((await run(["model", "mode"])).stdout, "Fast");
assert.equal((await run(["model", "mode", "turbo"])).code, 64);
assert.match((await run(["model", "mode", "turbo"])).stderr, /one of fast, balanced, advanced/);
assert.match((await run(["model", "mode", "Advanced"])).stdout, /now run in Advanced mode\.$/);
assert.deepEqual(last("PATCH /v1/user/settings").body, {model_mode: "deep"});
assert.match((await run(["model", "mode", "light"])).stdout, /Fast mode/, "the API names are accepted too");
assert.deepEqual(last("PATCH /v1/user/settings").body, {model_mode: "light"});
assert.match((await run(["model", "usage"])).stdout, /rokku billing/);
agent = {...agent, model_config: {kind: "byok", model: "gpt-6"}, provider_connection_id: "c1", byok_enabled: true};
assert.match((await run(["model", "mode", "balanced"])).stdout, /applies after rokku model default/);
const keyUsage = await run(["model", "usage"]);
assert.match(keyUsage.stdout, /Balance: 12\.50 USD/); assert.match(keyUsage.stdout, /Today: not reported/); assert.match(keyUsage.stdout, /This month: 3\.20 USD/);

// connector events: active grants only, by creation, and stopping one asks first
const events = await run(["connector", "events"]);
assert.ok(events.stdout.includes(GRANT) && events.stdout.includes("New emails") && !events.stdout.includes("Old"), events.stdout);
await run(["connector", "events", "Inbox"]);
assert.equal(last("GET /v1/agents/{agent_id}/artifact-event-grants").query.artifact_id, ART);
assert.equal((await run(["connector", "stop-event", GRANT])).code, 64);
assert.equal(count("DELETE /v1/agents/{agent_id}/artifact-event-grants/{grant_id}"), 0);
await run(["connector", "stop-event", GRANT, "--yes"]);
assert.equal(last("DELETE /v1/agents/{agent_id}/artifact-event-grants/{grant_id}").params.grant_id, GRANT);

api.close();
console.log("ok — chat search, delete only by a person, billing, memory stats, model mode/usage and connector events");
