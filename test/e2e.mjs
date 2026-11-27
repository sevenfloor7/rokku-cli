// End-to-end check of the CLI against a fake Rokku API and a fake creation Gateway that runs the
// platform recordsWorker (a copy in test/fixtures) over an in-memory DATA with revision CAS.
// Run: node test/e2e.mjs [path/to/artifact_runtime_records_worker.mjs]
import assert from "node:assert/strict";
import {execFile, spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {createHash} from "node:crypto";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync} from "node:fs";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {promisify} from "node:util";

const WORKER = resolve(process.argv[2] ?? `${import.meta.dirname}/../skills/rokku/records-worker.mjs`);
const {recordsWorker} = await import(pathToFileURL(WORKER).href);
const CLI = resolve(import.meta.dirname, "../bin/rokku.mjs");

// In-memory DATA, page size 2 so the CLI must follow `next`.
import {memoryData} from "./memory-data.mjs";

// ---------- fake servers ----------
const listen = server => new Promise(done => server.listen(0, "127.0.0.1", () => done(server.address().port)));
const body = request => new Promise(done => { const parts = []; request.on("data", c => parts.push(c)); request.on("end", () => done(Buffer.concat(parts))); });
const json = (response, status, value, headers = {}) => { response.writeHead(status, {"Content-Type": "application/json", ...headers}); response.end(JSON.stringify(value)); };
const ok = data => ({code: 0, data, error: null, request_id: randomUUID()});

const state = {access: "access-1", refresh: "refresh-1", rejectAccessOnce: false, messages: [], sessions: new Map(), csrfByCookie: new Map(), opened: 0};
const DATA = memoryData();
const worker = recordsWorker({collections: ["decisions", "progress", "directives", "samples", "ui"]});

const gateway = createServer(async (request, response) => {
  const origin = `http://127.0.0.1:${gatewayPort}`, raw = await body(request);
  if (request.headers.authorization) {
    if (request.headers.authorization !== `Bearer ${state.access}`) return json(response, 401, {kind: "reauthorize", next: "renew_launch"});
    const cookie = randomUUID(), csrf = randomUUID();
    state.csrfByCookie.set(cookie, csrf); state.opened++;
    response.setHeader("Set-Cookie", [`__Host-rokku_artifact=${cookie}; Path=/; Secure; HttpOnly; SameSite=None`, `__Host-rokku_edge=e1; Path=/; Secure; HttpOnly`]);
    return json(response, 200, {csrf_token: csrf, expires_at: new Date(Date.now() + 3600_000).toISOString()});
  }
  const cookie = /__Host-rokku_artifact=([^;]+)/.exec(request.headers.cookie ?? "")?.[1];
  const csrf = cookie && state.csrfByCookie.get(cookie);
  if (!csrf) return json(response, 401, {kind: "reauthorize", next: "renew_launch"});
  if (request.headers.origin && request.headers.origin !== origin) return json(response, 401, {kind: "reauthorize"});
  if (!["GET", "HEAD"].includes(request.method) && (request.headers.origin !== origin || request.headers["x-rokku-csrf"] !== csrf))
    return json(response, 401, {kind: "reauthorize"});
  const forwarded = new Request(origin + request.url, {method: request.method,
    headers: {"X-Rokku-Viewer": "owner", "Content-Type": request.headers["content-type"] ?? "text/plain"},
    body: ["GET", "HEAD"].includes(request.method) ? undefined : raw});
  if (state.raceOnce && request.method === "POST") {
    // Another writer (the phone) lands between the CLI's read and its write.
    state.raceOnce = false;
    const {recordId} = JSON.parse(raw.toString()), current = await DATA.get("decisions", recordId);
    await DATA.putResult("decisions", {mutationId: randomUUID(), recordId, expectedRevision: current.revision,
      value: {...current.value, phone: "edited"}, sortKey: current.sort_key});
  }
  if (new URL(request.url, origin).pathname === "/api/busy") { state.busyHits = (state.busyHits ?? 0) + 1; return json(response, 503, {kind: "busy"}); }
  const env = {ASSETS: {fetch: async () => new Response("<html>app</html>", {headers: {"Content-Type": "text/html"}})}};
  const result = await worker.fetch(forwarded, env, {props: {DATA}});
  response.writeHead(result.status, Object.fromEntries(result.headers));
  response.end(Buffer.from(await result.arrayBuffer()));
});
const gatewayPort = await listen(gateway);

const AGENT = randomUUID(), CONV = randomUUID(), BOARD = randomUUID(), S_TITLE = "Team Decisions";
const b64 = text => Buffer.from(text).toString("base64");
state.latest = 3;
state.stored = {3: {manifest: {schema_version: 2, entrypoint: "worker.mjs", modules: ["worker.mjs"], assets: ["index.html", "old.css"]},
  files: {"worker.mjs": b64("export default {}"), "index.html": b64("<html>v3</html>"), "old.css": b64("p{}")}}};
// A plain ustar archive of {path: base64}, the way Rokku stores a version's source (no top-level folder).
function tarOf(files) {
  const blocks = [];
  for (const [name, data] of Object.entries(files)) {
    const bytes = Buffer.from(data, "base64"), header = Buffer.alloc(512);
    header.write(name, 0); header.write("0000644\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124); header.write("00000000000\0", 136);
    header.write("        ", 148); header.write("0", 156); header.write("ustar\0", 257); header.write("00", 263);
    let sum = 0; for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
const apiServer = createServer(async (request, response) => {
  const raw = (await body(request)).toString();
  const input = raw ? JSON.parse(raw) : undefined, url = new URL(request.url, "http://x");
  if (request.method === "POST" && url.pathname.startsWith("/v1/auth/") && !request.headers["idempotency-key"])
    return json(response, 400, {code: 1000, data: null, error: {message: "Idempotency-Key required"}});
  if (url.pathname === "/v1/auth/email/otp/request") {
    assert.match(input.client_instance_id, /^[A-Za-z0-9._:-]{1,128}$/);
    return json(response, 200, ok({challenge_id: randomUUID(), accepted: true, retry_after_seconds: 0}));
  }
  if (url.pathname === "/v1/auth/email/otp/verify") {
    if (input.code !== "123456") return json(response, 200, {code: 2000, data: null, error: {message: "Invalid code"}});
    state.deviceLabel = input.device_label; state.clientKind = input.client_kind;
    return json(response, 200, ok({session_id: "s1", access_token: state.access, refresh_token: state.refresh,
      access_expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(), refresh_expires_at: new Date().toISOString()}));
  }
  if (url.pathname === "/v1/auth/refresh") {
    if (input.refresh_token !== state.refresh) return json(response, 401, {code: 2000, data: null, error: {message: "bad refresh"}});
    state.access = `access-${randomUUID()}`; state.refresh = `refresh-${randomUUID()}`; state.refreshed = true;
    return json(response, 200, ok({session_id: "s1", access_token: state.access, refresh_token: state.refresh,
      access_expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(), refresh_expires_at: new Date().toISOString()}));
  }
  if (request.headers.authorization !== `Bearer ${state.access}` || state.rejectAccessOnce) {
    state.rejectAccessOnce = false;
    return json(response, 401, {code: 2000, data: null, error: {message: "Unauthorized"}});
  }
  if (url.pathname === "/v1/auth/sessions/current/client-capabilities") { state.capabilities = input; return json(response, 200, ok({})); }
  if (url.pathname === "/v1/user/info")
    return json(response, 200, ok({email: "x@example.com", agents: [{agent_id: AGENT, main_conversation_id: CONV}]}));
  if (url.pathname === `/v1/agents/${AGENT}/artifacts` && request.method === "POST") {
    assert.ok(request.headers["idempotency-key"]);
    (state.createKeys ??= new Set()).add(request.headers["idempotency-key"]);
    if (state.createDown > 0) { state.createDown--; return json(response, 503, {code: 5000, data: null, error: {message: "lost"}}); }
    assert.equal(input.change_note, "test change");
    state.created = input;
    return json(response, 200, ok({artifact_id: "new-1", artifact_version: 1, title: input.title,
      deployment: {deployment_state: "prepared"}}));
  }
  const versionsPath = `/v1/agents/${AGENT}/artifacts/${BOARD}/versions`;
  if (url.pathname === `${versionsPath}:check`) return json(response, 200, ok({errors: [], warnings: []}));
  if (url.pathname === versionsPath && request.method === "GET") {
    const all = Array.from({length: state.latest}, (_, i) => ({artifact_version: state.latest - i, title: S_TITLE, description: null,
      icon_url: null, created_at: "2026-11-17T08:00:00Z", is_on_home: i === 0})), from = Number(url.searchParams.get("cursor") ?? 0);
    return json(response, 200, ok({items: all.slice(from, from + 2), next_cursor: from + 2 < all.length ? String(from + 2) : null}));
  }
  if (url.pathname === versionsPath && request.method === "POST") {
    if (input.expected_latest_version !== state.latest)
      return json(response, 409, {code: 3001, data: null, error: {message: "Artifact version conflict"}});
    assert.equal(input.change_note, "test change");
    state.pushed = input; state.latest++;
    state.stored[state.latest] = {files: input.files, manifest: input.manifest};
    return json(response, 200, ok({artifact_id: BOARD, artifact_version: state.latest, title: S_TITLE, deployment: {deployment_state: "prepared"}}));
  }
  const version = new RegExp(`^${versionsPath}/(\\d+)(/content)?$`).exec(url.pathname);
  if (version) {
    const stored = state.stored[version[1]], tar = tarOf(stored.files);
    if (version[2]) { response.writeHead(200, {"Content-Type": "application/x-tar"}); return response.end(state.corrupt ? Buffer.concat([tar.subarray(0, -1), Buffer.from("x")]) : tar); }
    return json(response, 200, ok({artifact_version: Number(version[1]), manifest: stored.manifest, size_bytes: tar.length,
      sha256: createHash("sha256").update(tar).digest("hex"), content_url: `http://127.0.0.1:${apiPort}${url.pathname}/content?grant=g`}));
  }
  if (url.pathname === `/v1/agents/${AGENT}/memory`) return json(response, 200, ok({user_md: "", memory_md: ""}));
  if (url.pathname === `/v1/agents/${AGENT}/widgets` && request.method === "POST") { state.wrote = true; return json(response, 200, ok({})); }
  if (url.pathname === `/v1/agents/${AGENT}/artifacts`)
    return json(response, 200, ok({items: [
      {artifact_id: BOARD, title: S_TITLE, artifact_type: "html_app", latest_version: state.latest, app_url: `http://127.0.0.1:${gatewayPort}`},
      {artifact_id: randomUUID(), title: "Notes PDF", artifact_type: "pdf", latest_version: 1, app_url: null},
    ], next_cursor: null}));
  if (url.pathname === `/v1/agents/${AGENT}/conversations/${CONV}/messages` && request.method === "POST") {
    assert.ok(request.headers["idempotency-key"]);
    // chat protocol 7: typed blocks with their own id
    assert.equal(request.headers["x-rokku-chat-protocol"], "7");
    assert.equal(input.content[0].type, "text"); assert.ok(input.content[0].id);
    state.messages.push(input.content[0].payload.text);
    return json(response, 200, ok({message_id: "m1"}));
  }
  if (url.pathname === "/v1/auth/sessions/s1" && request.method === "DELETE") { state.loggedOut = true; return json(response, 200, ok(null)); }
  json(response, 404, {code: 1002, data: null, error: {message: `no route ${request.method} ${url.pathname}`}});
});
const apiPort = await listen(apiServer);

// ---------- drive the CLI ----------
const env = {...process.env, ROKKU_TOKEN_STORE: "file", ROKKU_CONFIG: join(mkdtempSync(join(tmpdir(), "rokku-cli-")), "config.json"), ROKKU_API: `http://127.0.0.1:${apiPort}`};
const exec = (args, input) => new Promise((done, reject) => {
  const child = execFile("node", [CLI, ...args], {env}, (error, stdout, stderr) =>
    error ? reject(Object.assign(error, {stderr})) : done({stdout, stderr, code: 0}));
  if (input !== undefined) child.stdin.end(input); else child.stdin.end();
});
const run = async (...args) => (await exec(args)).stdout.trim();
const runJson = async (...args) => JSON.parse(await run(...args));
const fails = async (pattern, ...args) => {
  await assert.rejects(exec(args), error => pattern.test(error.stderr) || assert.fail(`stderr was: ${error.stderr}`));
};
const failsWith = async (code, pattern, ...args) => {
  await assert.rejects(exec(args), error => (error.code === code && pattern.test(error.stderr)) ||
    assert.fail(`exit ${error.code}, stderr was: ${error.stderr}`));
};
const S = S_TITLE;

await assert.rejects(exec(["login", "--email", "x@example.com"], "000000\n"), error => /Invalid code/.test(error.stderr));
assert.match((await exec(["login", "--email", "x@example.com"], "123456\n")).stdout, /Logged in as x@example.com/);
assert.match(state.deviceLabel, /^Rokku CLI on /);
assert.equal(state.clientKind, "cli", "logs in as a CLI session");
assert.deepEqual(state.capabilities, {schema_version: 2, client_revision: 1, device_tool_methods: [],
  interaction_protocols: ["choice.v1", "confirmation.generic.v1", "connector.approval.v1", "connector.unreviewed_oauth.v1", "home.artifact_place.v1"]});
assert.match(await run("creations"), /Team Decisions .* app/);
assert.equal((await runJson("creations", "--raw")).length, 2, "--raw is a boolean and does not eat arguments");
assert.equal((await runJson("whoami")).email, "x@example.com");
await fails(/no live app/, "data", "list", "Notes", "decisions");
await fails(/No creation matches/, "data", "list", "nope", "decisions");
await fails(/is exactly/, "data", "put", "team", "decisions", "d1", "--json", "{}");

// create, read, list across pages, filter, patch, delete
const created = await runJson("data", "put", S, "decisions", "d1", "--json",
  JSON.stringify({title: "Don't merge #859 yet?", options: ["now", "wait"], status: "pending"}), "--stamp", "created_at");
assert.equal(created.id, "d1");
assert.match(created.created_at, /^\d{4}-\d\d-\d\dT/);
for (const n of [2, 3, 4]) await run("data", "put", S, "decisions", `d${n}`, "--json", JSON.stringify({title: `q${n}`, status: n === 4 ? "answered" : "pending", project: n === 3 ? "rokku" : "team"}));
const fromStdin = await exec(["data", "put", S, "decisions", "d5", "--file", "-"], JSON.stringify({title: "it's from stdin; $(touch /tmp/x)", status: "withdrawn"}));
assert.equal(JSON.parse(fromStdin.stdout).title, "it's from stdin; $(touch /tmp/x)");
const all = await runJson("data", "list", "team", "decisions");
assert.equal(all.length, 5, "follows next across pages");
assert.deepEqual((await runJson("data", "list", "team", "decisions", "--where", "status=pending")).map(r => r.id).sort(), ["d1", "d2", "d3"]);
assert.deepEqual((await runJson("data", "list", "team", "decisions", "--where", "status=pending", "--where", "project=rokku")).map(r => r.id), ["d3"], "--where repeats");
assert.equal((await runJson("data", "list", "team", "decisions", "--raw"))[0].revision >= 1, true);
const patched = await runJson("data", "patch", S, "decisions", "d1", "--json", JSON.stringify({status: "answered", answer: {option: "wait"}}));
assert.equal(patched.title, "Don't merge #859 yet?");
assert.equal(patched.status, "answered");
const got = await runJson("data", "get", "team", "decisions", "d1");
assert.equal(got.answer.option, "wait");
assert.equal(got.revision, 2, "one write so far");
state.raceOnce = true;
const merged = await runJson("data", "patch", S, "decisions", "d1", "--json", JSON.stringify({seen: true}));
assert.equal(merged.phone, "edited", "patch retries on conflict and keeps the other writer's fields");
assert.equal(merged.seen, true);
state.raceOnce = true;
await fails(/conflict/, "data", "put", S, "decisions", "d1", "--json", JSON.stringify({title: "replace"}));
const kept = await runJson("data", "put", S, "decisions", "d1", "--if-absent", "--json", JSON.stringify({title: "seed again"}));
assert.equal(kept.skipped, true);
assert.equal((await runJson("data", "get", "team", "decisions", "d1")).seen, true, "--if-absent never overwrites");
await fails(/does not exist/, "data", "patch", S, "decisions", "missing", "--json", "{\"a\":1}");
await fails(/JSON object/, "data", "put", S, "decisions", "x", "--json", "[1,2]");
await fails(/looks like JSON/, "data", "put", S, "decisions", "{\"title\":1}");
await fails(/needs a value/, "data", "list", "team", "decisions", "--where");
await fails(/must be a number/, "data", "watch", "team", "decisions", "--interval", "abc");
assert.match(await run("data", "delete", S, "decisions", "d2"), /Deleted/);
assert.equal((await runJson("data", "list", "team", "decisions")).length, 4, "tombstones are hidden");
const auto = await runJson("data", "put", S, "progress", "--json", JSON.stringify({session: "wiper", status: "working"}));
assert.match(auto.id, /^[0-9a-f-]{36}$/);

// creation session expiry is renewed transparently; account token refresh on 401
state.csrfByCookie.clear();
assert.equal((await runJson("data", "list", "team", "decisions")).length, 4);
state.rejectAccessOnce = true;
assert.match(await run("creations"), /Team Decisions/);
assert.ok(state.refreshed, "refreshed after 401");
state.csrfByCookie.clear();
assert.equal((await runJson("data", "list", "team", "decisions")).length, 4, "re-opens with the refreshed token");

// parallel writers share one config without losing the rotated refresh token
state.csrfByCookie.clear();
await Promise.all([...Array(6).keys()].map(n => run("data", "put", S, "progress", `p${n}`, "--json", JSON.stringify({n}))));
state.rejectAccessOnce = true;
assert.match(await run("creations"), /Team Decisions/, "the stored refresh token is still the live one");

// wait returns at once when the answer already arrived
assert.equal((await runJson("data", "wait", "team", "decisions", "d1", "--until", "status=answered", "--timeout", "5")).id, "d1");
const notYet = await exec(["data", "wait", "team", "decisions", "d3", "--until", "status=answered", "--timeout", "1", "--interval", "1"]).catch(error => error);
assert.equal(notYet.code, 2, "wait exits 2 when the record never matches");
assert.match(notYet.stderr, /not yet/);

// watch --once sees a record written by someone else (the phone)
const watcher = spawn("node", [CLI, "data", "watch", "team", "decisions", "--where", "status=answered", "--interval", "1", "--once", "--timeout", "15"], {env});
let watched = "";
watcher.stdout.on("data", chunk => { watched += chunk; });
await new Promise(done => setTimeout(done, 1500));
const d3 = await DATA.get("decisions", "d3");
await DATA.putResult("decisions", {mutationId: randomUUID(), recordId: "d3", expectedRevision: d3.revision,
  value: {title: "q3", status: "answered", answer: {text: "go"}}, sortKey: "z"});
const code = await new Promise(done => watcher.on("exit", done));
assert.equal(code, 0);
assert.deepEqual(JSON.parse(watched.trim()), {title: "q3", status: "answered", answer: {text: "go"}, id: "d3"});
const existing = (await run("data", "watch", "team", "decisions", "--where", "status=answered", "--include-existing", "--once")).split("\n");
assert.ok(existing.length >= 2, "--include-existing reports answers that arrived earlier");

// nested --stamp
const acked = await runJson("data", "put", S, "progress", "r1", "--stamp", "ack.at", "--json", JSON.stringify({status: "acked", ack: {by: "t"}}));
assert.equal(acked.ack.by, "t");
assert.match(acked.ack.at, /^\d{4}-/);

// create: manifest + the files it names; the directory then pushes on top of v1
const source = mkdtempSync(join(tmpdir(), "rokku-create-"));
writeFileSync(join(source, "manifest.json"), JSON.stringify({schema_version: 2, entrypoint: "worker.mjs", modules: ["worker.mjs"], assets: ["index.html"]}));
writeFileSync(join(source, "worker.mjs"), "export default {}");
writeFileSync(join(source, "index.html"), "<html></html>");
writeFileSync(join(source, "notes.txt"), "not named by the manifest");
await failsWith(64, /--note/, "create", source, "--title", "Laptop app");
await fails(/go together/, "create", source, "--description", "only text", "--note", "test change");
assert.match(await run("create", source, "--title", "Laptop app", "--note", "test change"), /Created Laptop app v1 \(new-1\)/);
assert.equal(state.created.title, "Laptop app");
assert.deepEqual(Object.keys(state.created.files).sort(), ["index.html", "worker.mjs"]);
assert.equal(Buffer.from(state.created.files["worker.mjs"], "base64").toString(), "export default {}");
assert.deepEqual(JSON.parse(readFileSync(join(source, ".rokku-pulled.json"), "utf8")), {artifact_id: "new-1", version: 1, files: ["worker.mjs", "index.html", "manifest.json"]});
await fails(/already belongs to a creation/, "create", source, "--note", "test change");
// a create whose answers are lost keeps its key, so the next run finishes the same creation
const retried = mkdtempSync(join(tmpdir(), "rokku-create-"));
for (const name of ["manifest.json", "worker.mjs", "index.html"]) writeFileSync(join(retried, name), readFileSync(join(source, name)));
state.createKeys = new Set(); state.createDown = 3;
await failsWith(5, /lost/, "create", retried, "--title", "Retried", "--note", "test change");
assert.match(await run("create", retried, "--title", "Retried", "--note", "test change"), /Created Retried v1/);
assert.equal(state.createKeys.size, 1, "one Idempotency-Key across runs");
assert.equal(existsSync(join(retried, ".rokku-creating.json")), false);
writeFileSync(join(retried, "icon.png"), "not a png");
const iconless = mkdtempSync(join(tmpdir(), "rokku-create-"));
for (const name of ["manifest.json", "worker.mjs", "index.html"]) writeFileSync(join(iconless, name), readFileSync(join(source, name)));
await fails(/not a PNG/, "create", iconless, "--description", "d", "--icon", join(retried, "icon.png"), "--note", "test change");

// pull → edit → push builds on the pulled version; a never-pulled directory must say its base
const pulledDir = join(mkdtempSync(join(tmpdir(), "rokku-pull-")), "team");
assert.match(await run("pull", "team", pulledDir), /Pulled Team Decisions v3/);
assert.equal(readFileSync(join(pulledDir, "index.html"), "utf8"), "<html>v3</html>");
assert.equal(JSON.parse(readFileSync(join(pulledDir, "manifest.json"), "utf8")).entrypoint, "worker.mjs");
assert.equal(statSync(join(pulledDir, "worker.mjs")).isFile(), true, "the stored tar has no top-level folder");
await fails(/not empty/, "pull", "team", pulledDir);
writeFileSync(join(pulledDir, "index.html"), "<html>v4</html>");
writeFileSync(join(pulledDir, "notes.txt"), "mine, not the creation's");
const m = JSON.parse(readFileSync(join(pulledDir, "manifest.json"), "utf8"));
m.assets = ["index.html"]; writeFileSync(join(pulledDir, "manifest.json"), JSON.stringify(m));
assert.match(await run("push", S, pulledDir, "--note", "test change"), /Pushed Team Decisions v4/);
assert.equal(state.pushed.expected_latest_version, 3);
assert.deepEqual(Object.keys(state.pushed.files).sort(), ["index.html", "worker.mjs"]);
await failsWith(4, /newer version than v3/, "push", S, pulledDir, "--base", "3", "--note", "test change");
const fresh = mkdtempSync(join(tmpdir(), "rokku-fresh-"));
for (const name of ["manifest.json", "worker.mjs", "index.html"]) writeFileSync(join(fresh, name), readFileSync(join(pulledDir, name)));
await fails(/was not pulled from Team Decisions/, "push", S, fresh, "--note", "test change");
assert.match(await run("check", S, fresh), /passes the publication checks/, "check needs no base and no note");
assert.match(await run("push", S, fresh, "--base", "4", "--note", "test change"), /Pushed Team Decisions v5/);
// --force replaces the creation's files, drops the ones this version no longer has, keeps the user's own
assert.match(await run("pull", "team", pulledDir, "--version", "3", "--force"), /v3/);
assert.equal(existsSync(join(pulledDir, "old.css")), true);
assert.match(await run("pull", "team", pulledDir, "--force"), /v5/);
assert.equal(existsSync(join(pulledDir, "old.css")), false, "stale files from an earlier pull are removed");
assert.equal(readFileSync(join(pulledDir, "notes.txt"), "utf8"), "mine, not the creation's");
state.corrupt = true;
await fails(/does not match its sha256|bytes/, "pull", "team", join(fresh, "corrupt"));
state.corrupt = false;
// a manifest path that leaves the directory, or a symlink inside it, is never read
const escaping = mkdtempSync(join(tmpdir(), "rokku-escape-"));
writeFileSync(join(escaping, "manifest.json"), JSON.stringify({schema_version: 2, entrypoint: "worker.mjs", modules: ["worker.mjs"], assets: ["../secret.txt"]}));
writeFileSync(join(escaping, "worker.mjs"), "export default {}");
await fails(/Refusing the path/, "check", S, escaping, "--note", "test change");
writeFileSync(join(escaping, "manifest.json"), JSON.stringify({schema_version: 2, entrypoint: "worker.mjs", modules: ["worker.mjs"], assets: ["linked.txt"]}));
symlinkSync("/etc/hosts", join(escaping, "linked.txt"));
await fails(/symbolic link/, "check", S, escaping, "--note", "test change");

// versions follows every page
assert.deepEqual((await runJson("versions", "team", "--raw")).map(v => v.artifact_version), [5, 4, 3, 2, 1]);
assert.match((await run("versions", "team")).split("\n")[1], /^v5 .*on Home/);

// rokku api reads unless told to write
await fails(/only reads unless you pass --write/, "api", "POST", "/v1/agents/{agent}/widgets");
await run("api", "POST", "/v1/agents/{agent}/widgets", "--write", "--json", "{}");
assert.ok(state.wrote);
assert.equal((await runJson("api", "/v1/user/info")).email, "x@example.com", "GET is the default method");
for (const path of ["/v1/agents/{agent}/conversations/c/interactions/i/responses", "/v1/agents/{agent}/third-party-connections/x/items", "/v1/agents/{agent}/settings"])
  await failsWith(64, /your own decision/, "api", "POST", path, "--write", "--json", "{}");

// raw call, say, logout
const raw = await runJson("call", "team", "GET", "/api/records/directives");
assert.equal(raw.status, 200);
assert.deepEqual(raw.body.records, []);
await fails(/is exactly/, "call", "team", "POST", "/api/records/directives", "--json", "{}");
// a creation's own POST is sent once even when the creation is busy; a read is retried
state.busyHits = 0;
assert.equal((await exec(["call", S, "POST", "/api/busy", "--json", "{}"]).catch(error => error)).code, 1);
assert.equal(state.busyHits, 1, "non-idempotent call is not retried");
await failsWith(64, /Usage: rokku call/, "call", S, "POST");
assert.match(await run("say", "--fix", "this", "please"), /Sent to your Rokku agent/);
assert.equal(state.messages.at(-1), "--fix this please");
assert.match(await run("logout"), /revoked/);
assert.ok(state.loggedOut);
await failsWith(3, /Not logged in/, "creations");

gateway.close(); apiServer.close();
console.log(`ok — all CLI checks passed against the recordsWorker in ${WORKER}`);
