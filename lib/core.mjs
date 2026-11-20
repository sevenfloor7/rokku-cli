// Shared core: config and login tokens, the Rokku API client, arguments and output.
import {createHash, randomUUID} from "node:crypto";
import {chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from "node:fs";
import {homedir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {createInterface} from "node:readline";
import {spawnSync} from "node:child_process";
import {ROUTES} from "./routes.generated.mjs";

export const CONFIG = process.env.ROKKU_CONFIG ?? join(homedir(), ".config", "rokku", "config.json");
export const LOCK = `${CONFIG}.lock`;
export const DEFAULT_API = "https://api.rokku.ai";
export const FETCH_TIMEOUT_MS = 30_000;
export const BOOLEAN_FLAGS = new Set(["once", "verbose", "raw", "include-existing", "if-absent", "help", "full", "sandbox", "force", "write",
  "yes", "trashed", "on", "off", "top", "bottom", "content", "unreviewed", "no-browser", "api-key", "bearer", "no-wait", "new"]);
export const REPEATABLE_FLAGS = new Set(["where", "stamp", "session"]);

// Exit codes, so scripts can tell what went wrong. 2 is "not yet" (data wait / watch --once).
export const EXIT = {error: 1, notYet: 2, login: 3, conflict: 4, unavailable: 5, checks: 6, usage: 64};
export class CliError extends Error {
  constructor(message, exit = EXIT.error) { super(message); this.exit = exit; }
}
export const fail = (message, exit) => { throw new CliError(message, exit); };
export const usage = message => fail(message, EXIT.usage);
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------- login tokens: the keychain on macOS, else the 0600 config file ----------
// The tokens are the whole account (the same session the App has), so they stay out of the config file
// when the system has a keychain. ROKKU_TOKEN_STORE=file keeps them in the file (tests, CI, Linux).
// Per-creation Gateway sessions stay in the 0600 file: they are short-lived, scoped to one creation,
// and grow with every creation opened, while one keychain write must fit one `security -i` line.
export const SECRET_KEYS = ["access_token", "refresh_token"];
export const TOKEN_STORE = process.env.ROKKU_TOKEN_STORE ?? (process.platform === "darwin" && existsSync("/usr/bin/security") ? "keychain" : "file");
export const KEYCHAIN = {service: "rokku-cli", account: createHash("sha256").update(resolve(CONFIG)).digest("hex").slice(0, 32)};

export function keychainRead() {
  const result = spawnSync("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN.service, "-a", KEYCHAIN.account, "-w"], {encoding: "utf8"});
  if (result.status === 44) return {};
  if (result.status !== 0) fail(`Could not read your Rokku login from the keychain (${result.stderr.trim()})`);
  try { return JSON.parse(result.stdout.trim()); } catch { return {}; }
}

export function keychainWrite(secrets) {
  if (!Object.keys(secrets).length) {
    spawnSync("/usr/bin/security", ["delete-generic-password", "-s", KEYCHAIN.service, "-a", KEYCHAIN.account]);
    return;
  }
  const result = spawnSync("/usr/bin/security", ["-i"], {encoding: "utf8", input: keychainCommand(secrets)});
  if (result.status !== 0) fail(`Could not save your Rokku login in the keychain (${result.stderr.trim()})`);
}

// `security -i` takes the command on stdin, so the tokens never show up in a process listing. It reads
// at most 4095 bytes a line; a longer one would be cut and fail, so it is refused before anything is sent.
export const KEYCHAIN_LINE_BYTES = 4095;
export function keychainCommand(secrets) {
  const hex = Buffer.from(JSON.stringify(secrets)).toString("hex");
  const line = `add-generic-password -U -s ${KEYCHAIN.service} -a ${KEYCHAIN.account} -l rokku-cli -X ${hex}\n`;
  if (Buffer.byteLength(line) > KEYCHAIN_LINE_BYTES)
    fail(`Your Rokku login is too long for one keychain write (${line.length} bytes); run with ROKKU_TOKEN_STORE=file and tell the Rokku team`);
  return line;
}

// Gateway sessions that have expired are of no use; each write drops them so the file stays small.
export function withoutExpiredSessions(sessions, now = Date.now()) {
  return Object.fromEntries(Object.entries(sessions ?? {}).filter(([, session]) => Date.parse(session?.expires_at) > now));
}

// ---------- config: every write re-reads the file under a lock and changes only its own keys ----------
export function readConfig() {
  let config = {};
  if (existsSync(CONFIG)) {
    try { config = JSON.parse(readFileSync(CONFIG, "utf8")); }
    catch { fail(`${CONFIG} is unreadable; delete it and run: rokku login`); }
  }
  if (TOKEN_STORE !== "keychain") return config;
  return {...keychainRead(), ...config};
}

// Tokens an older CLI (or ROKKU_TOKEN_STORE=file) left in the config file move into the keychain.
export async function moveTokensToKeychain() {
  if (TOKEN_STORE !== "keychain" || !existsSync(CONFIG)) return;
  let file;
  try { file = JSON.parse(readFileSync(CONFIG, "utf8")); } catch { return; }
  if (SECRET_KEYS.some(key => key in file)) await withLock(async () => writeConfig(readConfig()));
}

export async function withLock(action) {
  mkdirSync(dirname(CONFIG), {recursive: true, mode: 0o700});
  for (let waited = 0; ; waited += 50) {
    try { mkdirSync(LOCK); writeFileSync(join(LOCK, "pid"), String(process.pid)); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (lockIsStale()) rmSync(LOCK, {recursive: true, force: true});
      if (waited > 120_000) fail(`Timed out waiting for ${LOCK}; if no other rokku command is running, delete it`);
      await sleep(50);
    }
  }
  try { return await action(); } finally { rmSync(LOCK, {recursive: true, force: true}); }
}

// The lock belongs to a crashed process only if that process is gone. Going by age alone let a second
// process take the lock from one still waiting on a slow refresh, and both spent the same refresh token.
export function lockIsStale() {
  let pid;
  try { pid = Number(readFileSync(join(LOCK, "pid"), "utf8")); }
  catch {
    // No pid yet: the holder is between mkdir and writing it, or crashed right there.
    try { return Date.now() - statSync(LOCK).mtimeMs > 10_000; } catch { return false; }
  }
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
}

export function writeConfig(config) {
  if (config.sessions) config.sessions = withoutExpiredSessions(config.sessions);
  let settings = config;
  if (TOKEN_STORE === "keychain") {
    settings = {};
    const secrets = {};
    for (const [key, value] of Object.entries(config)) (SECRET_KEYS.includes(key) ? secrets : settings)[key] = value;
    keychainWrite(secrets);
  }
  const temporary = `${CONFIG}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(settings, null, 2) + "\n", {mode: 0o600});
  chmodSync(temporary, 0o600);
  renameSync(temporary, CONFIG);
}

// Applies `change` to the freshest config on disk and mirrors the result into `config`.
export async function updateConfig(config, change) {
  return withLock(async () => {
    const fresh = readConfig();
    const result = await change(fresh);
    writeConfig(fresh);
    for (const key of Object.keys(config)) delete config[key];
    Object.assign(config, fresh);
    return result;
  });
}

export function apiBase(config) {
  const base = (process.env.ROKKU_API ?? config.api ?? DEFAULT_API).replace(/\/$/, "");
  requireSecure(base);
  return base;
}

export function requireSecure(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname))
    fail(`Refusing to send your Rokku token over plain HTTP to ${parsed.origin}`);
}

export const timed = (url, options, timeout = FETCH_TIMEOUT_MS) => fetch(url, {...options, signal: AbortSignal.timeout(timeout)});
// Uploads and downloads get 30 s plus a second for every 128 KB, up to 10 minutes.
export const transferTimeout = bytes => Math.min(600_000, FETCH_TIMEOUT_MS + Math.ceil(bytes / 131_072) * 1000);
export const megabytes = bytes => `${(bytes / 1_048_576).toFixed(1)} MB`;

// ---------- Rokku account API ----------
export async function envelope(response, what) {
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); }
  catch { fail(`${what}: HTTP ${response.status} ${text.slice(0, 200)}`, response.status >= 500 ? EXIT.unavailable : EXIT.error); }
  if (!response.ok || body.code !== 0) {
    const error = new CliError(`${what}: ${body.error?.message ?? `HTTP ${response.status}`}` +
      (body.error?.details ? ` ${JSON.stringify(body.error.details)}` : ""));
    error.unauthorized = response.status === 401 || body.code === 2000;
    error.exit = error.unauthorized ? EXIT.login : response.status === 409 ? EXIT.conflict :
      response.status === 429 || response.status >= 500 ? EXIT.unavailable : EXIT.error;
    error.code = body.code;
    error.details = body.error?.details;
    throw error;
  }
  return body.data;
}

export async function publicPost(config, route, body) {
  const {path} = routePath(config, route);
  const response = await timed(apiBase(config) + path, {
    method: "POST",
    headers: {"Content-Type": "application/json", "Idempotency-Key": randomUUID()},
    body: JSON.stringify(body),
  });
  return envelope(response, `POST ${path}`);
}

export const nearExpiry = config => config.access_expires_at && Date.parse(config.access_expires_at) - Date.now() < 3600_000;

// Refresh tokens rotate: only one process may spend the current one, the others adopt its result.
export async function refresh(config) {
  const used = config.refresh_token;
  await updateConfig(config, async fresh => {
    if (!fresh.refresh_token) fail("Not logged in. Run: rokku login", EXIT.login);
    if (fresh.refresh_token !== used && !nearExpiry(fresh)) return;
    const tokens = await publicPost(fresh, "POST /v1/auth/refresh", {refresh_token: fresh.refresh_token});
    Object.assign(fresh, {access_token: tokens.access_token, refresh_token: tokens.refresh_token,
      access_expires_at: tokens.access_expires_at, session_id: tokens.session_id ?? fresh.session_id});
  });
}

// ---------- routes: every request goes to a route the backend's OpenAPI lists (lib/routes.generated.mjs) ----------
// `route` is "METHOD /path/{param}". agent_id defaults to the logged-in agent.
export function routePath(config, route, params = {}, query = {}) {
  const spec = ROUTES[route];
  if (!spec) throw new Error(`Not a public Rokku route: ${route}; regenerate lib/routes.generated.mjs`);
  const [method, template] = route.split(" ");
  const path = template.replace(/\{(\w+)\}/g, (_, name) => {
    const value = params[name] ?? (name === "agent_id" ? config.agent_id : undefined);
    if (value === undefined || value === "") throw new Error(`${route}: missing ${name}`);
    return encodeURIComponent(value);
  });
  const unknown = Object.keys(query).filter(name => !spec.query.includes(name));
  if (unknown.length) throw new Error(`${route}: no query parameter ${unknown.join(", ")}`);
  const search = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => [name, String(value)]));
  return {spec, method, path: path + (search.size ? `?${search}` : "")};
}

// Sends a request to a public route. Adds an Idempotency-Key where the route requires one (pass your
// own to make retries finish the same request) and checks the body's required fields before sending.
export async function request(config, route, {params, query, body, headers = {}, timeout} = {}) {
  const {spec, method, path} = routePath(config, route, params, query);
  const missing = spec.body && body !== undefined ? spec.body.filter(name => body[name] === undefined) : [];
  if (missing.length) fail(`${route} needs ${missing.join(", ")}`, EXIT.usage);
  const extra = {...headers};
  if (spec.idempotencyKey && !extra["Idempotency-Key"]) extra["Idempotency-Key"] = randomUUID();
  return api(config, method, path, body, extra, {timeout});
}

export async function api(config, method, path, body, extraHeaders = {}, {timeout} = {}) {
  if (!config.access_token) fail("Not logged in. Run: rokku login", EXIT.login);
  if (nearExpiry(config)) await refresh(config);
  for (let attempt = 0; ; attempt++) {
    const headers = {Authorization: `Bearer ${config.access_token}`, ...extraHeaders};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const response = await timed(apiBase(config) + path, {method, headers, body: payload},
      timeout ?? (payload ? transferTimeout(payload.length) : FETCH_TIMEOUT_MS));
    try { return await envelope(response, `${method} ${path}`); }
    catch (error) {
      if (!error.unauthorized || attempt) throw error;
      await refresh(config);
    }
  }
}

// ---------- arguments ----------
export function parseFlags(argv) {
  const positional = [], flags = {}, missing = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") { positional.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith("--") || arg === "--") { positional.push(arg); continue; }
    const [key, inline] = arg.slice(2).split(/=(.*)/s, 2);
    let value;
    if (BOOLEAN_FLAGS.has(key)) value = true;
    else if (inline !== undefined) value = inline;
    else if (i + 1 < argv.length) value = argv[++i];
    else { missing.push(key); continue; }
    if (REPEATABLE_FLAGS.has(key)) (flags[key] ??= []).push(value);
    else flags[key] = value;
  }
  return {positional, flags, missing};
}

export async function readStdin() {
  if (process.stdin.isTTY) fail("Expected input on stdin (or pass --json / --file)");
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export async function jsonInput(flags) {
  const raw = flags.json ?? (flags.file && flags.file !== "-" ? readFileSync(flags.file, "utf8") : await readStdin());
  let value;
  try { value = JSON.parse(raw); } catch { fail("Expected a JSON object (--json '{...}', --file path, or stdin)"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("A record value must be a JSON object");
  // --stamp created_at sets that field to the current UTC time, so callers needn't build dates in shell.
  for (const field of flags.stamp ?? []) {
    const path = field.split("."), leaf = path.pop();
    const parent = path.reduce((node, key) => (node[key] = node[key] && typeof node[key] === "object" ? node[key] : {}), value);
    parent[leaf] = new Date().toISOString();
  }
  return value;
}

export function seconds(flags, name, fallback, minimum) {
  if (flags[name] === undefined) return fallback;
  const value = Number(flags[name]);
  if (!Number.isFinite(value) || value < minimum) fail(`--${name} must be a number ≥ ${minimum}`);
  return value;
}

export function matcher(where) {
  const clauses = (where ?? []).map(clause => {
    const match = /^([^=!]+)(!?=)(.*)$/.exec(clause);
    if (!match) fail(`Bad --where "${clause}" (use field=value or field!=value)`);
    return match;
  });
  const read = (value, path) => path.split(".").reduce((node, key) => node?.[key], value);
  return record => clauses.every(([, field, op, expected]) =>
    (String(read(record.value, field) ?? "") === expected) === (op === "="));
}

export function validateId(id) {
  if (id !== undefined && /^[[{]/.test(id)) fail(`"${id.slice(0, 20)}…" looks like JSON; pass the value with --json or --file`);
}

export function prompt(question, {hidden = false} = {}) {
  process.stderr.write(question);
  if (hidden && process.stdin.isTTY) {
    // Raw mode reads keystrokes without the terminal echoing them.
    return new Promise(resolve => {
      let answer = "";
      process.stdin.setRawMode(true);
      process.stdin.resume();
      const onData = chunk => {
        for (const char of chunk.toString("utf8")) {
          if (char === "\u0003") { process.stdin.setRawMode(false); process.exit(130); }
          if (char === "\r" || char === "\n") {
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdin.off("data", onData);
            process.stderr.write("\n");
            return resolve(answer.trim());
          }
          answer = char === "\u007f" ? answer.slice(0, -1) : answer + char;
        }
      };
      process.stdin.on("data", onData);
    });
  }
  // Input that ends before a line is no answer: fail, so a closed stdin never looks like success.
  return new Promise((resolve, reject) => {
    const rl = createInterface({input: process.stdin, terminal: false});
    rl.once("line", line => { resolve(line.trim()); rl.close(); });
    rl.once("close", () => reject(new CliError("No answer (the input ended); nothing changed")));
  });
}

// Decisions that are the user's own (answering the agent's cards, letting Rokku act without asking,
// trusting an unreviewed server) need a person at an interactive terminal who types yes; under
// `rokku mcp` or without a terminal they are refused. This stops a coding agent from deciding by
// accident or habit. It is not a security boundary: a process can fake a terminal, and anything with
// the login token can call the API. The server is what enforces who may answer what.
export const personAtTerminal = () => Boolean(process.stdin.isTTY) && !process.env.ROKKU_MCP;
export async function requirePerson(what) {
  if (!personAtTerminal()) usage(`${what} is your own decision: run this rokku command yourself, in a terminal (not through a coding agent or MCP)`);
  const answer = await prompt(`${what}. Type yes if you want this: `);
  if (answer.toLowerCase() !== "yes") fail("Nothing changed");
}

// Changes that cannot be undone ask first; `note` says otherwise for one that can. --yes answers for
// scripts; without a terminal and without --yes, nothing happens.
export async function confirm(flags, what, note = " cannot be undone") {
  if (flags.yes) return;
  if (!process.stdin.isTTY) usage(`${what}${note}; pass --yes to do it`);
  const answer = await prompt(`${what}${note}. Type yes to go ahead: `);
  if (answer.toLowerCase() !== "yes") fail("Nothing changed");
}

// Secret values come only from a hidden terminal prompt or stdin, never from arguments, so they stay out
// of shell history, process listings and a coding agent's transcript. `fields` is [{name, label}]; with
// stdin, one field reads the whole input and several read a JSON object keyed by name.
export async function secretInput(fields) {
  // Under `rokku mcp` the input would come from the model; secrets must come from the person.
  if (process.env.ROKKU_MCP) fail("This needs a secret value typed by the user; ask them to run this rokku command in their own terminal");
  if (!process.stdin.isTTY) {
    const raw = (await readStdin()).trim();
    if (fields.length === 1) return {[fields[0].name]: raw};
    let values;
    try { values = JSON.parse(raw); } catch { usage(`Pipe a JSON object with ${fields.map(f => f.name).join(", ")} on stdin`); }
    return values;
  }
  const values = {};
  for (const field of fields) values[field.name] = await prompt(`${field.label}: `, {hidden: true});
  return values;
}

// Opens a URL in the user's browser; prints it as well, for terminals without one.
export function openBrowser(url, flags = {}) {
  process.stderr.write(`Open this link to continue:\n  ${url}\n`);
  if (flags["no-browser"]) return;
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawnSync(opener, [url], {stdio: "ignore"});
}

// A table with one row per item; columns are [header, value(item)] and empty columns are dropped.
export function table(items, columns) {
  if (!items.length) return "(none)";
  const cells = items.map(item => columns.map(([, value]) => String(value(item) ?? "")));
  const kept = columns.map((_, i) => i).filter(i => cells.some(row => row[i] !== ""));
  const rows = [columns.map(([header]) => header.toUpperCase()), ...cells].map(row => kept.map(i => row[i]));
  const width = kept.map((_, j) => Math.max(...rows.map(row => row[j].length)));
  return rows.map(row => row.map((cell, j) => j === row.length - 1 ? cell : cell.padEnd(width[j])).join("  ")).join("\n");
}

// Follows next_cursor through every page of a cursor-paged list route.
export async function everyPage(config, route, {params, query = {}, limit = 100} = {}) {
  const items = [];
  let cursor;
  do {
    const page = await request(config, route, {params, query: {...query, limit, cursor}});
    items.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor);
  return items;
}

// A time in the laptop's own time zone, to the minute.
export const when = time => time ? new Date(time).toLocaleString("sv-SE", {hour12: false}).slice(0, 16) : "";

export const print = value => process.stdout.write((typeof value === "string" ? value : JSON.stringify(value, null, 2)) + "\n");

