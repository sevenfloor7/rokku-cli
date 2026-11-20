#!/usr/bin/env node
// rokku: let Claude Code / Codex on this laptop work with your Rokku account.
// Zero dependencies; Node 20.11+. Settings live in ~/.config/rokku/config.json (mode 0600); the login
// tokens live in the macOS keychain where there is one, otherwise in that file.
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {hostname} from "node:os";
import http from "node:http";
import {DEFAULT_API, EXIT, CliError, fail, usage, sleep, when, requirePerson, readConfig, moveTokensToKeychain, withLock, writeConfig, apiBase, publicPost, api, request, parseFlags, readStdin, jsonInput, seconds, matcher, validateId, prompt, print} from "../lib/core.mjs";
import {listCreations, resolveCreation, call, shown, listRecords, getRecord, writeRecord, deleteRecord} from "../lib/creations.mjs";
import {sourceCommand} from "../lib/source.mjs";
import {commands as creationCommands} from "../lib/commands/creations.mjs";
import {commands as homeCommands} from "../lib/commands/home.mjs";
import {commands as themeCommands} from "../lib/commands/themes.mjs";
import {commands as automationCommands} from "../lib/commands/automations.mjs";
import {commands as taskCommands} from "../lib/commands/tasks.mjs";
import {commands as connectorCommands} from "../lib/commands/connectors.mjs";
import {commands as keyCommands} from "../lib/commands/keys.mjs";
import {commands as modelCommands} from "../lib/commands/model.mjs";
import {commands as memoryCommands} from "../lib/commands/memory.mjs";
import {ask, commands as askCommands} from "../lib/commands/ask.mjs";
import {commands as cardCommands, reportCapabilities} from "../lib/cards.mjs";

// Routes whose writes are the user's own decision (cards, permissions, credentials, sessions, agent
// settings such as approval mode); rokku api sends them only for a person at a terminal who types yes.
const USER_DECISIONS = /\/interactions\/[^/]+\/responses|\/third-party-connections|\/connector-connections|\/artifact-action-policies|\/secrets\/|\/provider-(credentials|connections)|^\/v1\/auth\/|\/agents\/[^/]+\/settings|\/device-tool-executions|\/design-tokens\/current$/;

// Command groups in lib/commands: each entry is {usage, run(config, positional, flags)}.
const COMMANDS = {...creationCommands, ...homeCommands, ...themeCommands, ...automationCommands, ...taskCommands,
  ...connectorCommands, ...keyCommands, ...modelCommands, ...memoryCommands, ...askCommands, ...cardCommands};

// ---------- commands ----------
const HELP = `rokku — your Rokku account from Claude Code / Codex

  rokku login [--email you@x.com] [--api URL]   sign in this laptop as its own device
  rokku logout                                  revoke this laptop's session
  rokku mcp                                     run as an MCP server on stdio (for Claude Code, Codex and other agents)
  rokku whoami                                  check the login is still valid
  rokku creations [--trashed] [--raw]           list your creations ("app" = deployed app)
  rokku say "text" | --file prompt.md           send a message to your Rokku agent, as you, without waiting
  rokku chat [--last 6] [--full]                read the latest messages in your Rokku chat

  rokku data list   <creation> <collection> [--where f=v ...] [--raw]
  rokku data get    <creation> <collection> <id>
  rokku data put    <creation> <collection> [<id>] (--json '{...}' | --file f | stdin) [--stamp field] [--if-absent] [--sort KEY]
  rokku data patch  <creation> <collection> <id>   (--json | --file | stdin) [--stamp field]
  rokku data delete <creation> <collection> <id>
  rokku data import <creation> <collection> --file rows.jsonl [--if-absent]   lines of {"id","value","sort"}
  rokku data wait   <creation> <collection> <id> --until f=v [--timeout 240] [--interval 15]
  rokku data watch  <creation> <collection> [--where f=v] [--include-existing] [--once] [--timeout S] [--interval 20]
  rokku call <creation> <METHOD> <path> [--json '{...}' | --file f]   raw request to the creation's backend

  rokku create   <dir> --note "…" [--title T] [--description D --icon icon.png]   publish local source as a new creation (v1)
  rokku pull     <creation> <dir> [--version N] [--force]   download a version's source (page, Worker, Card.tsx, manifest.json)
  rokku check    <creation> [<dir>] [--note "…"] [--base N]   run the publication checks on local source, publish nothing
  rokku check    --new <dir> [--title T]             the same for a creation not created yet
  rokku push     <creation> [<dir>] --note "…" [--base N]   publish local source as the next version (same checks as the agent);
                                                     builds on the version the dir was pulled at, or --base N
  rokku versions <creation> [--raw]                  list every saved version
  rokku secret list | set NAME --host HOST [--header 'X-API-Key: {}'] [--creation A,B] [--sandbox] | delete NAME
  rokku secret set NAME --from "App Key" --creation A,B   link a model Key stored in Rokku (rokku key list lists them)
  rokku api [GET] </v1/...>                          raw Rokku API read; other methods need --write [--json '{...}' | --file f]

${Object.values(COMMANDS).map(command => `  ${command.usage}`).join("\n")}

--note says in a sentence or two what changed; Rokku keeps it with the version and tells your agent.
<creation> is an id or a title (reads also accept part of a title; writes need the exact title).
Records print as their fields plus "id". put replaces a record; patch merges fields.
--file - reads stdin. API defaults to ${DEFAULT_API} (override with --api on login, or ROKKU_API).
Exit codes: 0 ok, 1 error, 2 not yet (data wait/watch), 3 not logged in, 4 conflict (someone changed it first),
5 Rokku unreachable or busy (retry later), 6 publication checks failed, 64 bad arguments.`;

async function login(flags) {
  const config = readConfig();
  const draft = {api: flags.api ?? config.api, client_instance_id: config.client_instance_id ?? `rokku-cli:${randomUUID()}`};
  const email = flags.email ?? await prompt("Rokku email: ");
  const challenge = await publicPost(draft, "POST /v1/auth/email/otp/request",
    {email, client_instance_id: draft.client_instance_id});
  const code = await prompt("Code from the email (or your usual code): ", {hidden: true});
  const tokens = await publicPost(draft, "POST /v1/auth/email/otp/verify", {
    challenge_id: challenge.challenge_id, code, client_instance_id: draft.client_instance_id,
    device_label: `Rokku CLI on ${hostname()}`.slice(0, 128), client_kind: "cli"});
  Object.assign(draft, {access_token: tokens.access_token, refresh_token: tokens.refresh_token,
    access_expires_at: tokens.access_expires_at, session_id: tokens.session_id, sessions: {}, client_kind: "cli"});
  const info = await request(draft, "GET /v1/user/info");
  const agent = info.agents?.[0];
  if (!agent) fail("This account has no active Rokku agent yet; open the app once, then retry");
  Object.assign(draft, {email: info.email, agent_id: agent.agent_id, conversation_id: agent.main_conversation_id});
  await withLock(async () => writeConfig(draft));
  await reportCapabilities(draft);
  print(`Logged in as ${info.email} on ${apiBase(draft)}. This laptop shows up in Rokku's device list as "Rokku CLI on ${hostname()}".`);
}

async function dataCommand(config, positional, flags) {
  const [verb, ref, collection, id] = positional;
  if (!collection) usage("Usage: rokku data <list|get|put|patch|delete|wait|watch> <creation> <collection> ...");
  validateId(id);
  const writes = ["put", "patch", "delete", "import"].includes(verb);
  const creation = await resolveCreation(config, ref, {exact: writes});
  if (verb === "list") {
    const records = (await listRecords(config, creation, collection)).filter(matcher(flags.where));
    return print(flags.raw ? records : records.map(shown));
  }
  if (verb === "get" || verb === "wait") {
    if (!id) usage(`Usage: rokku data ${verb} <creation> <collection> <id>`);
    if (verb === "get") {
      const record = await getRecord(config, creation, collection, id);
      if (!record || record.deleted) fail(`${collection}/${id} does not exist`);
      return print({...shown(record), revision: record.revision});
    }
    // Returns as soon as the record matches, including when it already did.
    if (!flags.until) usage("Usage: rokku data wait <creation> <collection> <id> --until field=value");
    const done = matcher([flags.until]);
    const interval = seconds(flags, "interval", 15, 1) * 1000, deadline = Date.now() + seconds(flags, "timeout", 240, 1) * 1000;
    for (let failures = 0; ; ) {
      try {
        const record = await getRecord(config, creation, collection, id);
        if (!record || record.deleted) fail(`${collection}/${id} does not exist`);
        if (done(record)) return print(shown(record));
        failures = 0;
      } catch (error) {
        if (error instanceof CliError && /does not exist/.test(error.message)) throw error;
        if (++failures >= 5) throw error;
      }
      if (Date.now() + interval > deadline) { process.stderr.write(`rokku: not yet (${flags.until})\n`); process.exitCode = 2; return; }
      await sleep(interval);
    }
  }
  if (verb === "put" || verb === "patch") {
    if (verb === "patch" && !id) usage("Usage: rokku data patch <creation> <collection> <id> --json '{...}'");
    const input = await jsonInput(flags);
    const recordId = id ?? randomUUID();
    const saved = await writeRecord(config, creation, collection, recordId,
      existing => {
        if (verb === "patch" && existing === null) fail(`${collection}/${recordId} does not exist`);
        return verb === "patch" ? {...existing, ...input} : input;
      },
      {sortKey: flags.sort, retries: verb === "patch" ? 3 : 0, ifAbsent: flags["if-absent"] === true});
    if (saved.skipped) return print({...shown(saved.record), skipped: true});
    return print(shown(saved.record));
  }
  if (verb === "import") {
    // One JSON object per line: {"id": "...", "value": {...}, "sort": "..."}; id and sort are optional.
    const lines = (flags.file && flags.file !== "-" ? readFileSync(flags.file, "utf8") : await readStdin()).split("\n").filter(line => line.trim());
    const rows = lines.map((line, index) => {
      let row;
      try { row = JSON.parse(line); } catch { fail(`line ${index + 1} is not JSON`); }
      if (row?.value === null || typeof row?.value !== "object" || Array.isArray(row.value)) fail(`line ${index + 1} needs a "value" object`);
      validateId(row.id);
      return row;
    });
    let added = 0, skipped = 0, failed = 0;
    const queue = [...rows];
    await Promise.all(Array.from({length: 2}, async () => {
      for (let row; (row = queue.shift());) {
        try {
          const saved = await writeRecord(config, creation, collection, row.id ?? randomUUID(), () => row.value,
            {sortKey: row.sort, retries: 0, ifAbsent: flags["if-absent"] === true});
          saved.skipped ? skipped++ : added++;
        } catch (error) {
          failed++;
          process.stderr.write(`rokku: ${row.id ?? "(new)"}: ${error.message}\n`);
        }
      }
    }));
    print({added, skipped, failed});
    if (failed) process.exitCode = 1;
    return;
  }
  if (verb === "delete") {
    if (!id) usage("Usage: rokku data delete <creation> <collection> <id>");
    await deleteRecord(config, creation, collection, id);
    return print(`Deleted ${collection}/${id}`);
  }
  if (verb === "watch") {
    // Prints each new or changed matching record as one JSON line; deletions are not reported.
    const matches = matcher(flags.where);
    const interval = seconds(flags, "interval", 20, 1) * 1000;
    const deadline = flags.timeout === undefined ? Infinity : Date.now() + seconds(flags, "timeout", 0, 1) * 1000;
    const emit = records => {
      for (const record of records) process.stdout.write(JSON.stringify(shown(record)) + "\n");
      return records.length > 0;
    };
    const initial = (await listRecords(config, creation, collection)).filter(matches);
    const seen = new Map(initial.map(record => [record.record_id, record.revision]));
    if (flags["include-existing"] && emit(initial) && flags.once) return;
    for (let failures = 0; Date.now() < deadline; ) {
      await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
      let records;
      try { records = await listRecords(config, creation, collection); failures = 0; }
      catch (error) {
        if (++failures >= 5) throw error;
        if (flags.verbose) process.stderr.write(`rokku: retrying after ${error.message}\n`);
        await sleep(Math.min(60_000, 2 ** failures * 1000));
        continue;
      }
      const changed = records.filter(matches).filter(record => seen.get(record.record_id) !== record.revision);
      for (const record of changed) seen.set(record.record_id, record.revision);
      if (emit(changed) && flags.once) return;
    }
    if (flags.once) process.exitCode = 2;
    return;
  }
  fail(`Unknown data verb "${verb}"`);
}

// A command takes the flags its lines in HELP name, plus these. An unknown flag is refused rather than
// ignored: a value passed as `--value x` must not be dropped silently while the command waits on stdin.
const COMMON_FLAGS = ["help", "raw", "yes", "verbose"];
function checkFlags(command, flags) {
  const lines = HELP.split("\n").map(line => line.trim()).filter(line => line === `rokku ${command}` || line.startsWith(`rokku ${command} `));
  if (!lines.length) return;
  const known = new Set([...COMMON_FLAGS, ...lines.flatMap(line => [...line.matchAll(/--([a-z][a-z-]*)/g)].map(match => match[1]))]);
  const unknown = Object.keys(flags).filter(name => !known.has(name));
  if (unknown.length) usage(`rokku ${command} has no ${unknown.map(name => `--${name}`).join(", ")}. Run: rokku help`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") return print(HELP);
  // `say` takes its text verbatim, even if it starts with "--".
  const {positional, flags, missing = []} = command === "say" && rest[0] !== "--file" ? {positional: rest, flags: {}} : parseFlags(rest);
  if (flags.help) return print(HELP);
  // An unknown flag is reported as unknown even when it is the last argument.
  checkFlags(command, {...flags, ...Object.fromEntries(missing.map(key => [key, true]))});
  if (missing.length) usage(`--${missing[0]} needs a value`);
  if (command === "login") return login(flags);
  if (command === "mcp") return (await import("../lib/mcp.mjs")).serve();
  await moveTokensToKeychain();
  const config = readConfig();
  if (command === "logout") {
    if (config.session_id && config.access_token) {
      try { await request(config, "DELETE /v1/auth/sessions/{session_id}", {params: {session_id: config.session_id}}); }
      catch (error) { if (!error.unauthorized) throw error; }
    }
    await withLock(async () => writeConfig({api: config.api, client_instance_id: config.client_instance_id}));
    return print("Logged out; this laptop's Rokku session is revoked.");
  }
  if (!config.agent_id) fail("Not logged in. Run: rokku login", EXIT.login);
  if (command === "whoami") {
    const info = await request(config, "GET /v1/user/info");
    return print({email: info.email, api: apiBase(config), agent_id: config.agent_id});
  }
  if (command === "creations") {
    const items = (await listCreations(config, {lifecycle: flags.trashed ? "trashed" : "active"})).map(item => ({title: item.title, id: item.artifact_id,
      type: item.artifact_type, version: item.latest_version, live: item.active_version ?? null, app: item.app_url ?? null}));
    if (flags.raw) return print(items);
    return print(items.map(item => `${item.title}  ${item.id}  v${item.version}${item.live && item.live !== item.version ? ` (v${item.live} live)` : ""}${item.app ? "  app" : ""}`).join("\n") || "(no creations)");
  }
  if (command === "say") {
    // The older name for `rokku ask --no-wait`; its text is taken verbatim, even words starting with "--".
    const text = flags.file ? readFileSync(flags.file === "-" ? 0 : flags.file, "utf8") : positional.join(" ") || await readStdin();
    if (!text.trim()) usage("Nothing to say");
    const accepted = await ask(config, text, {wait: false});
    return print(`Sent to your Rokku agent (message ${accepted.message_id}). Read the reply with: rokku chat, or use rokku ask to wait for it.`);
  }
  if (command === "chat") {
    const last = seconds(flags, "last", 6, 1);
    // Reading the newest messages first needs chat protocol 7 (entries wrap each message as {message}).
    const page = await request(config, "GET /v1/agents/{agent_id}/conversations/{conversation_id}/messages", {
      params: {conversation_id: config.conversation_id}, query: {before_message_seq: Number.MAX_SAFE_INTEGER, limit: Math.min(50, last)},
      headers: {"X-Rokku-Chat-Protocol": "7"}});
    const clip = body => flags.full || body.length <= 600 ? body : body.slice(0, 600) + " …(--full for all)";
    const text = message => message.content.map(block => block.payload?.text ?? block.fallback_text ??
      block.payload?.original?.title ?? `[${block.type}]`).join("\n");
    return print(page.messages.map(entry => entry.message ?? entry).slice(-last).map(message =>
      `── ${message.role === "user" ? "you" : "Rokku"} · ${when(message.created_at)}` +
      `${message.processing_state ? ` · ${message.processing_state}` : ""}` +
      `${message.processing_error ? ` (${message.processing_error.summary})` : ""}\n${clip(text(message))}`).join("\n\n") || "(no messages)");
  }
  if (command === "call") {
    const [ref, method, path] = positional;
    if (!method || !path?.startsWith("/")) usage("Usage: rokku call <creation> <METHOD> </path> [--json '{...}']");
    const verb = method.toUpperCase();
    const creation = await resolveCreation(config, ref, {exact: !["GET", "HEAD"].includes(verb)});
    const body = flags.json !== undefined || flags.file !== undefined ? JSON.parse(flags.json ?? readFileSync(flags.file, "utf8")) : undefined;
    const result = await call(config, creation, verb, path, body);
    print(result);
    if (result.status >= 400) process.exitCode = 1;
    return;
  }
  if (command === "data") return dataCommand(config, positional, flags);
  if (Object.hasOwn(COMMANDS, command)) return COMMANDS[command].run(config, positional, flags);
  if (["create", "push", "check", "pull", "secret", "versions"].includes(command)) {
    await sourceCommand(config, command, positional, flags);
    return;
  }
  if (command === "api") {
    // Raw Rokku API request, for debugging. {agent} expands to your agent id. Reads by default:
    // anything but GET changes the account and needs --write.
    const [method, path] = positional.length === 1 ? ["GET", positional[0]] : positional;
    if (!path?.startsWith("/")) usage("Usage: rokku api [GET] </v1/...>  |  rokku api <METHOD> </v1/...> --write [--json '{...}' | --file f]");
    const verb = method.toUpperCase();
    if (verb !== "GET" && !flags.write) fail(`rokku api only reads unless you pass --write; ${verb} ${path} would change your account`);
    const body = flags.json !== undefined || flags.file !== undefined ? JSON.parse(flags.json ?? readFileSync(flags.file === "-" ? 0 : flags.file, "utf8")) : undefined;
    if (verb === "GET" && body !== undefined) fail("GET requests cannot carry a body");
    // Answering the agent's cards and changing what Rokku may do are the user's own decisions.
    if (verb !== "GET" && USER_DECISIONS.test(path)) await requirePerson(`${verb} ${path} answers a card or changes what Rokku may do`);
    return print(await api(config, verb, path.replaceAll("{agent}", config.agent_id), body,
      {"X-Rokku-Chat-Protocol": "7", ...(verb === "GET" ? {} : {"Idempotency-Key": randomUUID()})}));
  }
  fail(`Unknown command "${command}". Run: rokku help`);
}

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 11)) {
  process.stderr.write(`rokku: needs Node 20.11 or newer (this is ${process.versions.node})\n`);
  process.exit(EXIT.error);
}

// Node's fetch ignores HTTPS_PROXY and friends unless told to use them; Node 22.21+ and 24+ can.
const proxied = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].some(name => process.env[name]);
const proxyHint = proxied && !http.setGlobalProxyFromEnv ? `; HTTPS_PROXY is set, but Node ${process.versions.node} can't use it from here (use Node 24 or newer)` : "";
if (proxied && http.setGlobalProxyFromEnv) http.setGlobalProxyFromEnv();

main().catch(error => {
  const network = error?.name === "TimeoutError" || error?.message === "fetch failed";
  const message = error instanceof CliError ? error.message :
    error?.name === "TimeoutError" ? "Rokku did not answer in time; try again" :
    error?.message === "fetch failed" ? `Could not reach Rokku (${error.cause?.code ?? "network error"}): check this laptop's network${proxied ? " and proxy" : ""}${proxyHint}` :
    error?.stack ?? String(error);
  process.stderr.write(`rokku: ${message}\n`);
  process.exitCode = error?.exit ?? (network ? EXIT.unavailable : EXIT.error);
});
