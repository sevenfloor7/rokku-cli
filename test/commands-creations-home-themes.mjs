// Creation lifecycle, Home and theme commands send what the routes expect.
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fakeApi, failure} from "./fake-api.mjs";

const PING = {artifact_id: randomUUID(), title: "Ping", latest_version: 3, lifecycle_revision: 4, lifecycle_state: "active", app_url: null};
const OLD = {artifact_id: randomUUID(), title: "Old", latest_version: 1, lifecycle_revision: 2, lifecycle_state: "trashed", can_restore: true};
let home = {revision: 7, items: [
  {artifact_id: PING.artifact_id, title: "Ping", home_size: "m", artifact_version: 3, home_order: "grid-v1-00000005"},
  {artifact_id: randomUUID(), title: "Notes", home_size: "s", artifact_version: 1, home_order: "grid-v1-00000001"}]};
let tokens = {revision: 11, system_version: 2, theme: {kind: "saved", name: "Calm", version: 3}, updated_at: "2026-11-17T08:00:00Z"};
const themes = [{theme_id: randomUUID(), name: "Calm", created_at: "2026-11-01T00:00:00Z"}, {theme_id: randomUUID(), name: "Bright", created_at: "2026-11-02T00:00:00Z"}];
let publication = null, homeRefusal = null, linksOff = false, checkErrors = [];

const api = await fakeApi({
  "GET /v1/agents/{agent_id}/artifacts": r => ({items: r.query.lifecycle === "trashed" ? [OLD] : [PING], next_cursor: null}),
  "POST /v1/agents/{agent_id}/artifacts/{artifact_id}/restore-version": r => ({artifact_version: 4, deployment: {deployment_state: "pending"}}),
  "POST /v1/agents/{agent_id}/artifacts/{artifact_id}/trash": () => ({purge_after: "2026-12-17T00:00:00Z"}),
  "POST /v1/agents/{agent_id}/artifacts/{artifact_id}/restore": () => ({}),
  "GET /v1/agents/{agent_id}/artifacts/{artifact_id}/public-publication": () => linksOff
    ? {status: 404, body: {code: 1002, data: null, error: {message: "Not enabled", details: {reason: "feature_disabled"}}}}
    : publication ?? failure(404, 1002, "Artifact not found"),
  "PUT /v1/agents/{agent_id}/artifacts/{artifact_id}/public-publication": r => (publication = {revision: 1, state: r.body.state, public_url: "https://p.example/x", artifact_version: r.body.artifact_version}),
  "GET /v1/agents/{agent_id}/artifacts/{artifact_id}/usage": () => ({month_start: "2026-11-01", dimensions: [{dimension: "requests", owner: 3, public: 0, status: "ok"}]}),
  "GET /v1/home/artifacts": () => home,
  "PATCH /v1/home/artifacts/{artifact_id}": r => homeRefusal
    ? {status: 409, body: {code: 3001, data: null, error: {message: "Not on Home", details: {reason: homeRefusal}}}}
    : {revision: r.body.expected_revision + 1, artifact_id: r.params.artifact_id, item: null},
  "DELETE /v1/home/artifacts/{artifact_id}": r => ({revision: 8, artifact_id: r.params.artifact_id, item: null}),
  "GET /v1/design-tokens/current": () => tokens,
  "GET /v1/design-token-themes": () => ({items: themes, next_cursor: null}),
  "POST /v1/design-token-themes": r => ({theme_id: randomUUID(), name: r.body.name}),
  "POST /v1/design-token-themes/{theme_id}/apply": () => tokens,
  "POST /v1/design-tokens/current/undo": () => ({...tokens, theme: {kind: "system"}}),
  "POST /v1/design-tokens/current/reset": () => ({...tokens, theme: {kind: "saved", id: randomUUID(), version: null, is_modified: false}}),
  "DELETE /v1/design-token-themes/{theme_id}": () => null,
  "POST /v1/agents/{agent_id}/artifacts:check": () => ({errors: checkErrors, warnings: []}),
});
const {run, last} = api;

// creations
assert.match((await run(["restore-version", "Ping", "1"])).stdout, /v1 is restored as v4; deployment pending/);
assert.deepEqual(last("POST /v1/agents/{agent_id}/artifacts/{artifact_id}/restore-version").body, {source_version: 1, expected_latest_version: 3});
assert.equal((await run(["restore-version", "Ping", "x"])).code, 64);
assert.match((await run(["trash", "Ping"])).stdout, /in the trash until 2026-12-17/);
assert.deepEqual(last("POST /v1/agents/{agent_id}/artifacts/{artifact_id}/trash").body, {expected_lifecycle_revision: 4});
assert.match((await run(["untrash", "Old"])).stdout, /Old is back/);
assert.equal(last("POST /v1/agents/{agent_id}/artifacts/{artifact_id}/restore").params.artifact_id, OLD.artifact_id);
linksOff = true;
const off = await run(["link", "Ping", "--on"]);
assert.equal(off.code, 1); assert.match(off.stderr, /Public links are not turned on/);
assert.equal(last("PUT /v1/agents/{agent_id}/artifacts/{artifact_id}/public-publication"), undefined, "nothing is sent while the feature is off");
linksOff = false;
assert.match((await run(["link", "Ping"])).stdout, /no public link/);
assert.equal((await run(["link", "Ping", "--on", "--version", "2"])).code, 64, "a link can't be pinned to a version");
assert.match((await run(["link", "Ping", "--on"])).stdout, /Anyone with this link/);
assert.deepEqual(last("PUT /v1/agents/{agent_id}/artifacts/{artifact_id}/public-publication").body, {expected_revision: 0, state: "active"});
assert.match((await run(["link", "Ping", "--off"])).stdout, /link is off/);
assert.deepEqual(last("PUT /v1/agents/{agent_id}/artifacts/{artifact_id}/public-publication").body, {expected_revision: 1, state: "revoked"});
assert.match((await run(["usage", "Ping", "--month", "2026-10"])).stdout, /requests\s+3/);
assert.equal(last("GET /v1/agents/{agent_id}/artifacts/{artifact_id}/usage").query.month, "2026-10-01");

// home: listed in slot order, then patched against the Home revision
const listed = (await run(["home"])).stdout.split("\n");
assert.match(listed[1], /^Notes/); assert.match(listed[2], /^Ping/);
assert.match((await run(["home", "size", "Ping", "l"])).stdout, /is now l \(full width\) on your Home/);
assert.match((await run(["home", "list"])).stdout, /m \(card\)|l \(full width\)/, "sizes use the App's names");
assert.deepEqual(last("PATCH /v1/home/artifacts/{artifact_id}").body, {expected_revision: 7, home_size: "l"});
// moving asks Rokku to rank the item (home_position), in one PATCH
await run(["home", "move", "Ping", "--top"]);
assert.deepEqual(last("PATCH /v1/home/artifacts/{artifact_id}").body, {expected_revision: 7, home_position: "top"});
await run(["home", "move", "Ping", "--bottom"]);
assert.deepEqual(last("PATCH /v1/home/artifacts/{artifact_id}").body, {expected_revision: 7, home_position: "bottom"});
// Home order is Notes (1), Ping (5), Loose (no place): place 1 among the others is before Loose
home = {...home, items: [...home.items, {artifact_id: randomUUID(), title: "Loose", home_size: "s", artifact_version: 1, home_order: null}]};
await run(["home", "move", "Ping", "--slot", "1"]);
assert.deepEqual(last("PATCH /v1/home/artifacts/{artifact_id}").body.home_position, {relation: "before", artifact_id: home.items[2].artifact_id});
assert.doesNotMatch((await run(["home"])).stdout, /SLOT|99999999/);
assert.equal((await run(["home", "move", "Ping", "--top", "--bottom"])).code, 64);
await run(["home", "version", "Ping", "2"]);
assert.deepEqual(last("PATCH /v1/home/artifacts/{artifact_id}").body, {expected_revision: 7, artifact_version: 2});
assert.equal((await run(["home", "size", "Ping", "xl"])).code, 64);
const refused = await run(["home", "remove", "Ping"]);
assert.equal(refused.code, 64); assert.match(refused.stderr, /home add .* puts it back\); pass --yes/); assert.doesNotMatch(refused.stderr, /cannot be undone/);
assert.equal(last("DELETE /v1/home/artifacts/{artifact_id}"), undefined, "nothing removed without --yes");
assert.match((await run(["home", "remove", "Ping", "--yes"])).stdout, /put it back with: rokku home add/);
assert.equal(last("DELETE /v1/home/artifacts/{artifact_id}").query.expected_revision, "7");

// adding to Home is the same PATCH, for a creation not on Home yet
const OTHER = {artifact_id: PING.artifact_id};
home = {...home, items: home.items.filter(i => i.artifact_id !== OTHER.artifact_id)};
assert.match((await run(["home", "add", "Ping", "--size", "s"])).stdout, /Ping v3 is on your Home \(icon\)/);
assert.deepEqual(last("PATCH /v1/home/artifacts/{artifact_id}").body, {expected_revision: 7, artifact_version: 3, home_size: "s"});
await run(["home", "add", "Ping", "--version", "2"]);
assert.deepEqual(last("PATCH /v1/home/artifacts/{artifact_id}").body, {expected_revision: 7, artifact_version: 2});
assert.equal((await run(["home", "add", "Ping", "--size", "xl"])).code, 64);
PING.active_version = 2;
await run(["home", "add", "Ping"]);
assert.equal(last("PATCH /v1/home/artifacts/{artifact_id}").body.artifact_version, 2, "Home gets the running version, not one still deploying");
homeRefusal = "version_not_live";
const deploying = await run(["home", "add", "Ping", "--version", "3"]);
assert.equal(deploying.code, 1); assert.match(deploying.stderr, /v3 is not live yet.*--version 2/);
delete PING.active_version;
homeRefusal = "home_card_required";
const cardless = await run(["home", "add", "Ping"]);
assert.equal(cardless.code, 1, "a version without a Home card is not a conflict"); assert.match(cardless.stderr, /has no Home card/);

// an unknown flag is refused, not ignored
const unknown = await run(["secret", "set", "TOKEN", "--host", "api.example.com", "--value", "abc"]);
assert.equal(unknown.code, 64); assert.match(unknown.stderr, /has no --value/);
assert.equal((await run(["home", "list", "--bogus"])).code, 64);
const trailing = await run(["creations", "--bogus"]);
assert.equal(trailing.code, 64); assert.match(trailing.stderr, /has no --bogus/, "a trailing unknown flag is unknown, not missing a value");

// themes: no per-colour edits; apply/undo carry the current revisions
assert.match((await run(["theme"])).stdout, /"Calm"/);
assert.match((await run(["theme", "list"])).stdout, /Bright/);
await run(["theme", "save", "Mine"]);
assert.deepEqual(last("POST /v1/design-token-themes").body, {name: "Mine", expected_revision: 11});
await run(["theme", "apply", "bright"]);
assert.equal(last("POST /v1/design-token-themes/{theme_id}/apply").params.theme_id, themes[1].theme_id);
assert.deepEqual(last("POST /v1/design-token-themes/{theme_id}/apply").body, {expected_revision: 11, expected_system_version: 2, expected_theme_version: 3});
assert.match((await run(["theme", "undo"])).stdout, /default theme/);
// reset clears edits and keeps the theme; a saved theme deleted while in use is the current look, unsaved
assert.match((await run(["theme", "reset"])).stdout, /^Cleared your edits; your Rokku is still on your current look \(not saved\)\.$/);
const missing = await run(["theme", "apply", "nope"]);
assert.equal(missing.code, 1); assert.match(missing.stderr, /Saved themes: "Calm", "Bright"/);
assert.equal((await run(["theme", "delete", "Calm"])).code, 64);
await run(["theme", "delete", "Calm", "--yes"]);
assert.equal(last("DELETE /v1/design-token-themes/{theme_id}").params.theme_id, themes[0].theme_id);
assert.equal((await run(["theme", "set", "color.primary", "#f00"])).code, 64, "no per-colour edits");
tokens = {...tokens, theme: {kind: "system", is_modified: true}};
assert.match((await run(["theme"])).stdout, /a theme your Rokku agent made, not saved yet/, "an agent-made theme is not called the default");
tokens = {...tokens, theme: {kind: "builtin", id: "dot", name: "dot", is_modified: true}};
assert.match((await run(["theme"])).stdout, /built-in theme dot, changed by your Rokku agent and not saved yet/, "an agent edit of a built-in theme is reported");

// checks for a creation not created yet
const draft = mkdtempSync(join(tmpdir(), "rokku-new-"));
writeFileSync(join(draft, "manifest.json"), JSON.stringify({schema_version: 2, mime_type: "text/html", entrypoint: "index.html", assets: ["index.html"]}));
writeFileSync(join(draft, "index.html"), "<p>hi</p>");
assert.match((await run(["check", "--new", draft, "--title", "Hello"])).stdout, /Hello: source passes/);
assert.deepEqual(Object.keys(last("POST /v1/agents/{agent_id}/artifacts:check").body.files), ["index.html"]);
checkErrors = [{path: "index.html", message: "needs the theme contract"}];
const failed = await run(["check", "--new", draft]);
assert.equal(failed.code, 6); assert.match(failed.stderr, /needs the theme contract/);

api.close();
console.log("ok — creation lifecycle, Home and theme commands");
