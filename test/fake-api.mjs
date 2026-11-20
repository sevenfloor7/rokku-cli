// A fake Rokku API for command tests: a logged-in config, one agent, and per-route handlers.
// Every request is recorded as {route, params, query, body, headers}, where route is the OpenAPI
// "METHOD /path/{param}" key, so tests check what the CLI sent against the real route table.
import {execFile} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdtempSync, writeFileSync} from "node:fs";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {ROUTES} from "../lib/routes.generated.mjs";

export const AGENT = randomUUID(), CONVERSATION = randomUUID();
const CLI = resolve(import.meta.dirname, "../bin/rokku.mjs");
const TEMPLATES = Object.keys(ROUTES).map(key => {
  const [method, path] = key.split(" ");
  const names = [];
  const pattern = new RegExp("^" + path.replace(/[.*+?^$()|[\]\\]/g, "\\$&")
    .replace(/\{(\w+)\}/g, (_, name) => { names.push(name); return "([^/]+)"; }) + "$");
  return {key, method, pattern, names};
});

export const ok = data => ({code: 0, data, error: null, request_id: randomUUID()});
export const failure = (status, code, message) => ({status, body: {code, data: null, error: {message}}});

// handlers: {"METHOD /path/{param}": request => data | {status, body} | {raw: Buffer} | {stream(frame, end)} for SSE}
export async function fakeApi(handlers) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString(), url = new URL(request.url, "http://x");
    const match = TEMPLATES.map(t => ({t, m: request.method === t.method && t.pattern.exec(url.pathname)})).find(x => x.m);
    const send = (status, body) => { response.writeHead(status, {"Content-Type": "application/json"}); response.end(JSON.stringify(body)); };
    if (!match) return send(404, {code: 1002, data: null, error: {message: `no public route ${request.method} ${url.pathname}`}});
    const entry = {route: match.t.key, params: Object.fromEntries(match.t.names.map((name, i) => [name, decodeURIComponent(match.m[i + 1])])),
      query: Object.fromEntries(url.searchParams), body: raw ? JSON.parse(raw) : undefined, headers: request.headers};
    requests.push(entry);
    if (ROUTES[entry.route].idempotencyKey && !request.headers["idempotency-key"]) return send(400, {code: 1000, data: null, error: {message: "Idempotency-Key required"}});
    const handler = handlers[entry.route];
    if (!handler) return send(404, {code: 1002, data: null, error: {message: `no fake for ${entry.route}`}});
    const result = await handler(entry);
    if (result && typeof result === "object" && "status" in result && "body" in result) return send(result.status, result.body);
    if (result && typeof result === "object" && typeof result.stream === "function") {
      response.writeHead(200, {"Content-Type": "text/event-stream"});
      const frame = event => response.write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
      return result.stream(frame, () => response.end());
    }
    if (result && typeof result === "object" && Buffer.isBuffer(result.raw)) { response.writeHead(200, {"Content-Type": "application/x-tar"}); return response.end(result.raw); }
    send(200, ok(result ?? null));
  });
  const port = await new Promise(done => server.listen(0, "127.0.0.1", () => done(server.address().port)));
  const config = join(mkdtempSync(join(tmpdir(), "rokku-cmd-")), "config.json");
  writeFileSync(config, JSON.stringify({api: `http://127.0.0.1:${port}`, access_token: "a", refresh_token: "r",
    access_expires_at: new Date(Date.now() + 86400_000).toISOString(), agent_id: AGENT, conversation_id: CONVERSATION, sessions: {}}), {mode: 0o600});
  // The machine's proxy settings stay out of the tests; a test that needs a proxy passes its own.
  const env = Object.fromEntries(Object.entries({...process.env, ROKKU_CONFIG: config, ROKKU_TOKEN_STORE: "file", ROKKU_API: `http://127.0.0.1:${port}`})
    .filter(([name]) => !/^(https?|no|all)_proxy$/i.test(name)));
  const run = (args, input, extra = {}) => new Promise(done => {
    const child = execFile("node", [CLI, ...args], {env: {...env, ...extra}}, (error, stdout, stderr) => done({code: error ? error.code : 0, stdout: stdout.trim(), stderr: stderr.trim()}));
    child.stdin.end(input);
  });
  const last = route => requests.filter(r => r.route === route).at(-1);
  return {requests, run, last, env, close: () => server.close()};
}
