// Automation and Task commands send what the routes expect.
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {CONVERSATION, fakeApi} from "./fake-api.mjs";

const NIGHTLY = {automation_id: randomUUID(), version: 5, enabled: true, trigger_summary: "Every day at 07:00", next_fire_at: null,
  definition: {name: "Nightly", trigger: {kind: "cron", cron: "0 7 * * *"}, action: {kind: "start_task"}}};
const TASK = {task_id: randomUUID(), title: "Summarize", state: "failed", version: 9, description: "d", updated_at: "2026-11-17T08:00:00Z",
  result: null, error: {summary: "model unavailable"}, actions: [{type: "retry_task"}]};
// a running Task too large for one response: the view is deferred and its JSON comes in fragments
const BIG = {task_id: randomUUID(), title: "Big report", state: "running", version: 2, description: "long", updated_at: "2026-11-17T08:00:00Z", actions: []};
const BIG_JSON = JSON.stringify(BIG);
const api = await fakeApi({
  "GET /v1/agents/{agent_id}/automations": () => ({items: [NIGHTLY], next_cursor: null}),
  "POST /v1/agents/{agent_id}/automations": r => ({...NIGHTLY, automation_id: randomUUID(), definition: r.body.definition}),
  "PATCH /v1/agents/{agent_id}/automations/{automation_id}": r => ({...NIGHTLY, definition: {...NIGHTLY.definition, ...r.body.patch}}),
  "DELETE /v1/agents/{agent_id}/automations/{automation_id}": () => null,
  "GET /v1/agents/{agent_id}/automations/{automation_id}/fires": r => r.query.cursor ? {items: [{state: "failed", failure_reason: "x", created_at: "2026-11-15T00:00:00Z"}], next_cursor: null}
    : {items: [{state: "completed", task_id: TASK.task_id, scheduled_for: "2026-11-16T23:00:00Z"}], next_cursor: "p2"},
  "GET /v1/agents/{agent_id}/tasks": () => ({items: [TASK], next_cursor: null}),
  "GET /v1/agents/{agent_id}/tasks/{task_id}": r => r.params.task_id === BIG.task_id ? {task_id: BIG.task_id, version: 2, content_cursor: "c1"} : TASK,
  "GET /v1/agents/{agent_id}/tasks/{task_id}/content": r => r.query.cursor === "c1" ? {fragment: BIG_JSON.slice(0, 20), next_cursor: "c2"} : {fragment: BIG_JSON.slice(20), next_cursor: null},
  "POST /v1/agents/{agent_id}/tasks/{task_id}/messages": () => ({}),
  "POST /v1/agents/{agent_id}/tasks/{task_id}/cancel": () => ({...TASK, state: "cancelled"}),
  "POST /v1/agents/{agent_id}/tasks/{task_id}/retry": () => ({task: {task_id: "t2"}, conversation_id: CONVERSATION, message_id: "m"}),
});
const {run, last} = api;

const definition = {schema_version: 2, name: "Weekly", trigger: {kind: "cron", cron: "0 9 * * 1"}, action: {kind: "start_task", title: "t", description: "d", instruction: "i"}};
assert.match((await run(["automation", "create"], JSON.stringify(definition))).stdout, /Created "Weekly"/);
assert.deepEqual(last("POST /v1/agents/{agent_id}/automations").body, {conversation_id: CONVERSATION, definition});
assert.equal((await run(["automation", "create", "--json", "[1]"])).code, 64);
assert.match((await run(["automation"])).stdout, /Nightly\s+yes\s+Every day at 07:00/);
await run(["automation", "off", "nightly"]);
assert.deepEqual(last("PATCH /v1/agents/{agent_id}/automations/{automation_id}").body, {expected_version: 5, patch: {enabled: false}});
await run(["automation", "edit", "Nightly", "--json", '{"name":"Nightly 2"}']);
assert.deepEqual(last("PATCH /v1/agents/{agent_id}/automations/{automation_id}").body.patch, {name: "Nightly 2"});
assert.equal((await run(["automation", "fires", "Nightly"])).stdout.split("\n").length, 3, "header + both pages");
assert.equal((await run(["automation", "delete", "Nightly"])).code, 64);
assert.equal(last("DELETE /v1/agents/{agent_id}/automations/{automation_id}"), undefined);
await run(["automation", "delete", "Nightly", "--yes"]);
assert.deepEqual(last("DELETE /v1/agents/{agent_id}/automations/{automation_id}").body, {expected_version: 5});
assert.equal((await run(["automation", "show", "Missing"])).code, 1);

assert.match((await run(["task", "list", "--state", "failed,waiting"])).stdout, /Summarize\s+failed/);
assert.equal(last("GET /v1/agents/{agent_id}/tasks").query.state, "failed,waiting");
assert.match((await run(["task", "show", TASK.task_id])).stdout, /Error: model unavailable/);
assert.match((await run(["task", "show", BIG.task_id])).stdout, /^Big report  \[running\]/, "a deferred task is read from its content cursor");
const finished = await run(["task", "message", TASK.task_id, "more"]);
assert.equal(finished.code, 1); assert.match(finished.stderr, /failed and takes no more messages/);
await run(["task", "message", BIG.task_id, "use", "the", "short", "version"]);
assert.deepEqual(last("POST /v1/agents/{agent_id}/tasks/{task_id}/messages").body, {instruction: "use the short version"});
const cancelled = (await run(["task", "cancel", TASK.task_id])).stdout;
assert.match(cancelled, /cancelled/); assert.doesNotMatch(cancelled, /retry/, "a cancelled task can't be retried");
assert.match((await run(["task", "retry", TASK.task_id])).stdout, /as task t2/);
assert.deepEqual(last("POST /v1/agents/{agent_id}/tasks/{task_id}/retry").body, {expected_version: 9});
const notFailed = await run(["task", "retry", BIG.task_id]);
assert.equal(notFailed.code, 1); assert.match(notFailed.stderr, /only a failed task can be retried/);
assert.equal((await run(["task", "show"])).code, 64);

api.close();
console.log("ok — automation and task commands");
