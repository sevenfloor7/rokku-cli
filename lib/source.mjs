// Creation source (create, pull, check, push, versions) and owner secrets (ADR-0097).
import {createHash, randomUUID} from "node:crypto";
import {existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {basename, dirname, isAbsolute, join, normalize, resolve} from "node:path";
import {EXIT, fail, usage, sleep, apiBase, requireSecure, timed, transferTimeout, megabytes, request, secretInput, prompt, print, table, when, confirm} from "./core.mjs";
import {listCreations, findCreation, resolveCreation, forgetSession} from "./creations.mjs";

// ---------- creation source and secrets (ADR-0097) ----------
// Downloads one version's source into dir (made if missing); returns its files by path. `previous` is the
// directory's earlier pull record, whose files this version dropped are removed.
export async function pullTo(config, creation, version, dir, previous = null) {
  // The version view carries a signed content_url for its stored source tar, with its size and sha256.
  const view = await request(config, "GET /v1/agents/{agent_id}/artifacts/{artifact_id}/versions/{version}", {params: {...of(creation), version}});
  requireSecure(view.content_url);
  // The grant in the URL authorizes the download; the account token goes only to Rokku's own API origin.
  const sameOrigin = new URL(view.content_url).origin === new URL(apiBase(config)).origin;
  if (view.size_bytes > 1_048_576) process.stderr.write(`Downloading ${megabytes(view.size_bytes)}…\n`);
  const response = await timed(view.content_url, {headers: sameOrigin ? {Authorization: `Bearer ${config.access_token}`} : {}},
    transferTimeout(view.size_bytes ?? 0));
  if (!response.ok) fail(`pull ${creation.title} v${version}: HTTP ${response.status}`);
  const tar = Buffer.from(await response.arrayBuffer());
  if (view.size_bytes !== undefined && tar.length !== view.size_bytes) fail(`pull: the download is ${tar.length} bytes, Rokku said ${view.size_bytes}; try again`);
  if (view.sha256 && createHash("sha256").update(tar).digest("hex") !== view.sha256) fail("pull: the download does not match its sha256; try again");
  // The stored tar holds the manifest's files by their manifest paths, with no top-level folder.
  const entries = readTar(tar);
  // Rokku stores the manifest beside the source; write it so pull → edit → push needs nothing else.
  // The Home card's generation_bundle_digest names the phone app's card bundle at that push; Rokku fills in
  // the current one when it is absent, and a stale one fails the checks after an App update.
  if (view.manifest?.rn_card) delete view.manifest.rn_card.generation_bundle_digest;
  if (view.manifest) entries.set("manifest.json", Buffer.from(JSON.stringify(view.manifest, null, 2) + "\n"));
  mkdirSync(dir, {recursive: true});
  for (const stale of previous?.files ?? []) if (!entries.has(stale)) rmSync(safePath(dir, stale), {force: true});
  for (const [path, data] of entries) {
    const target = safePath(dir, path);
    mkdirSync(dirname(target), {recursive: true});
    writeFileSync(target, data);
  }
  return entries;
}

const of = creation => ({artifact_id: creation.artifact_id});
// The files a manifest names: the Worker modules, page assets, agent instructions and RN card.
export function readSource(dir) {
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) fail(`${dir} has no manifest.json (see the rokku skill for its shape)`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const paths = [...new Set([...(manifest.modules ?? []), ...(manifest.assets ?? []), manifest.agent_instructions, manifest.rn_source].filter(Boolean))];
  const files = {};
  for (const path of paths) {
    // Only regular files inside the directory: a symlink or "../" could publish ~/.aws/credentials.
    const full = safePath(dir, path);
    if (!existsSync(full) || !lstatSync(full).isFile()) fail(`manifest.json names ${path}, which is not a file in ${dir}`);
    files[path] = readFileSync(full).toString("base64");
  }
  return {manifest, files};
}
export const sourceFiles = source => [...Object.keys(source.files), "manifest.json"];
export function readPulled(dir) {
  const path = join(dir, ".rokku-pulled.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}
export const writePulled = (dir, value) => writeFileSync(join(dir, ".rokku-pulled.json"), JSON.stringify(value) + "\n");

// A path that stays inside its directory: relative, no "..", no NUL.
export function relativePath(path) {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\0") ||
    normalize(path).split(/[\\/]/).includes("..")) fail(`Refusing the path "${path}": it must stay inside the creation's directory`);
  return path;
}

// A relative path inside `dir` that no symlink redirects; anything else is refused.
export function safePath(dir, path) {
  relativePath(path);
  const root = resolve(dir), target = resolve(root, path);
  for (let at = target; at !== root; at = dirname(at)) {
    let stat;
    try { stat = lstatSync(at); } catch { continue; }
    if (stat.isSymbolicLink()) fail(`Refusing ${path}: ${at} is a symbolic link`);
  }
  return target;
}

// Regular files of an uncompressed tar (ustar or pax), by path. Links, devices and absolute paths are refused.
export function readTar(buffer) {
  const files = new Map(), text = (start, length) => buffer.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
  let pax = {};
  for (let at = 0; at + 512 <= buffer.length; ) {
    const header = buffer.subarray(at, at + 512);
    if (header.every(byte => byte === 0)) break;
    const size = parseInt(text(at + 124, 12).trim() || "0", 8), type = text(at + 156, 1) || "0";
    const prefix = text(at + 257, 6).startsWith("ustar") ? text(at + 345, 155) : "";
    const name = pax.path ?? (prefix ? `${prefix}/${text(at, 100)}` : text(at, 100));
    const data = buffer.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      // pax records: "<length> <key>=<value>\n"
      pax = Object.fromEntries(data.toString("utf8").split("\n").filter(Boolean).map(line => {
        const [key, ...rest] = line.slice(line.indexOf(" ") + 1).split("=");
        return [key, rest.join("=")];
      }));
      continue;
    }
    pax = {};
    if (type === "g" || type === "5") continue;
    if (type !== "0") fail(`pull: the stored source has an entry that is not a regular file (${name}); nothing was written`);
    files.set(relativePath(name.replace(/^\.\//, "")), Buffer.from(data));
  }
  return files;
}

// Rokku takes a 128x128 PNG icon of at most 32 KB.
export function readIcon(path) {
  const icon = readFileSync(path);
  if (icon.length > 32 * 1024) fail(`${path} is ${icon.length} bytes; the icon is a 128x128 PNG of at most 32 KB`);
  if (!icon.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) fail(`${path} is not a PNG`);
  return icon.toString("base64");
}

export function announceUpload(body) {
  const bytes = Object.values(body.files).reduce((sum, file) => sum + file.length * 3 / 4, 0);
  if (bytes > 1_048_576) process.stderr.write(`Uploading ${megabytes(bytes)} of source…\n`);
}

export function printProblems(result) {
  for (const item of result.errors ?? []) process.stderr.write(`error  ${item.path ?? ""} ${item.message}\n`);
  for (const item of result.warnings ?? []) process.stderr.write(`warn   ${item.path ?? ""} ${item.message}\n`);
}
// What the Rokku agent remembers, as lines (rokku memory --grep).
export async function memoryLines(config, pattern) {
  const memory = await request(config, "GET /v1/agents/{agent_id}/memory");
  return `${memory.user_md ?? ""}\n${memory.memory_md ?? ""}`.split("\n").map(line => line.trim())
    .filter(line => line.startsWith("- ") && pattern.test(line));
}
export const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Every create, push and check says in a sentence or two what changed. Rokku keeps it with the version
// and tells the main agent, so it knows what happened on the laptop before it next edits the creation.
// A static app has no deployment; a dynamic app's deployment finishes after the answer.
export const deployed = result => result.deployment ? `; deployment ${result.deployment.deployment_state ?? "requested"}` : "";

async function changeNote(flags, {optional = false} = {}) {
  let note = typeof flags.note === "string" ? flags.note.trim() : "";
  if (!note && optional) return "Publication check only";
  if (!note && process.stdin.isTTY && !process.env.ROKKU_MCP) note = (await prompt("What does this version change? ")).trim();
  if (!note || note.length > 500) usage('Say what changed with --note "…": one or two sentences (at most 500 characters) for your Rokku agent');
  return note;
}

export async function sourceCommand(config, command, positional, flags) {
  if (command === "create") {
    const [dir] = positional;
    if (!dir) usage("Usage: rokku create <dir> --note \"what it is\" [--title T] [--description D --icon icon.png]");
    if (existsSync(join(dir, ".rokku-pulled.json"))) fail(`${dir} already belongs to a creation; change it with rokku push`);
    const source = readSource(dir);
    // Rokku stores a description and an icon together or not at all.
    if ((flags.description === undefined) !== (flags.icon === undefined))
      fail("--description and --icon go together: a short line plus a 128x128 PNG (at most 32 KB)");
    const title = typeof flags.title === "string" ? flags.title : basename(resolve(dir));
    const presentation = flags.icon === undefined ? {} : {description: flags.description, icon: readIcon(flags.icon)};
    const body = {title, change_note: await changeNote(flags), ...presentation, ...source};
    // One key per source: a retry after a lost response, even from a new run after a crash, finishes the
    // same creation instead of making a second one. The key is kept beside the source until create succeeds.
    const creatingPath = join(dir, ".rokku-creating.json"), digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    let creating = null;
    try { creating = JSON.parse(readFileSync(creatingPath, "utf8")); } catch {}
    const key = creating?.digest === digest ? creating.key : randomUUID();
    writeFileSync(creatingPath, JSON.stringify({digest, key}) + "\n");
    announceUpload(body);
    let result;
    for (let attempt = 0; ; attempt++) {
      try { result = await request(config, "POST /v1/agents/{agent_id}/artifacts", {body, headers: {"Idempotency-Key": key}}); break; }
      catch (error) {
        if (error.details?.errors) { rmSync(creatingPath, {force: true}); printProblems(error.details); fail(`${title}: source failed the publication checks; nothing was created`, EXIT.checks); }
        if (attempt === 2 || error.code === 1001 || error.code === 3000) throw error;
        await sleep(2000 * (attempt + 1));
      }
    }
    rmSync(creatingPath, {force: true});
    // Later pushes from this directory build on version 1.
    writePulled(dir, {artifact_id: result.artifact_id, version: result.artifact_version, files: sourceFiles(source)});
    return print(`Created ${result.title} v${result.artifact_version} (${result.artifact_id})${deployed(result)}. ` +
      `Change it later with: rokku push ${result.artifact_id} ${dir} --note "…".` +
      (source.manifest.rn_source ? ` Its Home card goes on Home once the deployment is live (a few seconds); if rokku home list still lacks it after a minute, add it with: rokku home add ${result.artifact_id}` : ""));
  }
  if (command === "check" && flags.new) {
    // Source for a creation that doesn't exist yet: the same checks create runs, nothing is saved.
    const [dir = "."] = positional;
    const title = typeof flags.title === "string" ? flags.title : basename(resolve(dir));
    const result = await request(config, "POST /v1/agents/{agent_id}/artifacts:check",
      {body: {title, change_note: await changeNote(flags, {optional: true}), ...readSource(dir)}});
    printProblems(result);
    if (result.errors?.length) { process.exitCode = EXIT.checks; return; }
    return print(`${title}: source passes the publication checks. Publish it with: rokku create ${dir} --note "…"`);
  }
  if (command === "push" || command === "check") {
    const [ref, dir = "."] = positional;
    const creation = await findCreation(config, ref, {exact: true});
    const source = readSource(dir);
    // Build on the version this directory was pulled from, so a newer version (the agent's, or
    // another laptop's) is never silently replaced. A directory that was not pulled builds on latest.
    const pulledPath = join(dir, ".rokku-pulled.json");
    const pulled = existsSync(pulledPath) ? JSON.parse(readFileSync(pulledPath, "utf8")) : null;
    if (pulled && pulled.artifact_id !== creation.artifact_id) fail(`${dir} was pulled from another creation`);
    // A push must say which version it builds on. Taking "latest" for a directory that was never pulled
    // would silently replace a version made since (by the agent, or on another laptop).
    if (flags.base !== undefined && !(Number.isInteger(Number(flags.base)) && Number(flags.base) >= 1)) fail("--base takes a version number");
    const base = flags.base !== undefined ? Number(flags.base) : pulled?.version ?? (command === "check" ? creation.latest_version : undefined);
    if (base === undefined) fail(`${dir} was not pulled from ${creation.title}, so push can't tell which version your change builds on. ` +
      `Either pull it (rokku pull ${creation.artifact_id} <new dir>) and carry your change over, or pass --base N with the version ` +
      `you started from (rokku versions ${creation.artifact_id}); push is refused if the creation has moved past it.`);
    const body = {expected_latest_version: base, change_note: command === "check" ? await changeNote(flags, {optional: true}) : await changeNote(flags), ...source};
    if (command === "check") {
      const result = await request(config, "POST /v1/agents/{agent_id}/artifacts/{artifact_id}/versions:check", {params: of(creation), body});
      printProblems(result);
      if (result.errors?.length) { process.exitCode = EXIT.checks; return; }
      return print(`${creation.title}: source passes the publication checks.`);
    }
    // One key per push: a retry after a lost response or a failed deployment step finishes the same push.
    // A push refused while Rokku switches platform releases has already saved its version; the key is kept
    // beside the source so the next push of the same source deploys that version instead of adding another.
    const pendingPath = join(dir, ".rokku-pushing.json"), digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    let pending = null;
    try { pending = JSON.parse(readFileSync(pendingPath, "utf8")); } catch {}
    const key = pending?.artifact_id === creation.artifact_id && pending.digest === digest ? pending.key : randomUUID();
    // Keep the key before sending: if the response is lost (the test server restarts, the network drops),
    // the version may be saved without its deployment, and the next push of the same source must replay
    // this key so Rokku finishes that push instead of refusing it as a conflict.
    writeFileSync(pendingPath, JSON.stringify({artifact_id: creation.artifact_id, digest, key}) + "\n");
    announceUpload(body);
    let result;
    for (let attempt = 0; ; attempt++) {
      try { result = await request(config, "POST /v1/agents/{agent_id}/artifacts/{artifact_id}/versions", {params: of(creation), body, headers: {"Idempotency-Key": key}}); break; }
      catch (error) {
        const problems = error.details?.errors;
        if (problems) { rmSync(pendingPath, {force: true}); printProblems(error.details); fail(`${creation.title}: source failed the publication checks; nothing was published`, EXIT.checks); }
        if (error.details?.retryable) {
          writeFileSync(pendingPath, JSON.stringify({artifact_id: creation.artifact_id, digest, key}) + "\n");
          fail(`${creation.title}: Rokku is switching platform releases (${error.details.reason}), so nothing can deploy right now. ` +
            `Your version is saved; run the same rokku push again later and it deploys that version.`, EXIT.unavailable);
        }
        // A push saved during a release switch deploys when the switch ends. If this directory changed since,
        // its newer version is that saved push: say so instead of pointing at someone else's version.
        if (error.code === 3001 && pending?.artifact_id === creation.artifact_id && key !== pending.key)
          fail(`${creation.title}: the push you saved during the release switch was deployed as the newest version, and this directory changed since. ` +
            `Run rokku pull ${creation.title} <another dir>, carry over what changed after that push, then push from there`, EXIT.conflict);
        if (error.code === 3001) rmSync(pendingPath, {force: true});
        if (error.code === 3001 && key !== pending?.key) fail(`${creation.title} has a newer version than v${base} (the one ${flags.base !== undefined ? "you passed as --base" : "this directory last saw"}): ` +
          `rokku pull ${creation.title} <another dir>, carry your change over, then push from there`, EXIT.conflict);
        if (attempt === 2) throw error;
        await sleep(2000 * (attempt + 1));
      }
    }
    await forgetSession(config, creation);
    rmSync(pendingPath, {force: true});
    writePulled(dir, {artifact_id: creation.artifact_id, version: result.artifact_version, files: sourceFiles(source)});
    return print(`Pushed ${creation.title} v${result.artifact_version}${deployed(result)}. Your Rokku agent sees your note the next time it runs.`);
  }
  if (command === "pull") {
    const [ref, dir] = positional;
    if (!dir) usage("Usage: rokku pull <creation> <directory> [--version N] [--force]");
    const creation = await findCreation(config, ref);
    const version = Number(flags.version ?? creation.latest_version);
    if (!Number.isInteger(version) || version < 1) fail("--version takes a version number");
    const before = existsSync(dir) ? readdirSync(dir) : [];
    const previous = readPulled(dir);
    if (before.length && !flags.force) fail(`${dir} is not empty. Pull into a new directory, or pass --force to replace ` +
      `this creation's files there (files the creation does not name are kept; files an earlier pull wrote and this version dropped are removed)`);
    if (previous && previous.artifact_id !== creation.artifact_id) fail(`${dir} holds another creation (${previous.artifact_id}); pull into a new directory`);
    const entries = await pullTo(config, creation, version, dir, previous);
    writePulled(dir, {artifact_id: creation.artifact_id, version, files: [...entries.keys()]});
    return print(`Pulled ${creation.title} v${version} into ${dir}. Edit it, then: rokku push ${creation.artifact_id} ${dir} --note "what you changed"`);
  }
  if (command === "versions") {
    const creation = await findCreation(config, positional[0]);
    const items = [];
    let cursor;
    do {
      const page = await request(config, "GET /v1/agents/{agent_id}/artifacts/{artifact_id}/versions", {params: of(creation), query: {limit: 100, cursor}});
      items.push(...page.items);
      cursor = page.next_cursor;
    } while (cursor);
    if (flags.raw) return print(items);
    return print(table(items, [["version", v => `v${v.artifact_version}`], ["saved", v => when(v.created_at)], ["by", v => v.origin],
      ["", v => [v.artifact_version === creation.active_version && "live", v.is_on_home && "on Home"].filter(Boolean).join(", ")], ["note", v => v.change_note]]));
  }
  // secret list | set NAME (--host H | --from KEY) [--header 'X-API-Key: {}'] [--creation A,B] [--sandbox] | delete NAME
  // Secrets belong to your agent and are bound to one HTTPS host (ADR-0097). Rokku attaches the value
  // only on requests to that host: from the creations you name, and from the agent's sandbox with --sandbox.
  // --from links the secret to a Key already stored in the App (its label or id) instead of a new value:
  // Rokku sends that Key only to its own provider's host and follows it when it is rotated or revoked.
  const [action, name] = positional;
  if (!["list", "set", "delete"].includes(action))
    usage("Usage: rokku secret list | rokku secret set NAME (--host HOST | --from \"App Key\") [--header 'X-API-Key: {}'] [--creation A,B] [--sandbox] | rokku secret delete NAME");
  if (action === "list") {
    const [result, creations] = await Promise.all([request(config, "GET /v1/agents/{agent_id}/secrets"), listCreations(config)]);
    const titles = new Map(creations.map(c => [c.artifact_id, c.title]));
    return print(result.items.map(s => [s.name, s.host, s.header, s.provider_credential_id ? "linked to an App Key" : "", s.sandbox ? "sandbox" : "",
      (s.creations ?? []).map(id => titles.get(id) ?? id).join(","), `set ${when(s.updated_at)}`]
      .filter(Boolean).join("  ")).join("\n") || "(no secrets)");
  }
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name ?? "")) fail("Secret names are UPPER_SNAKE_CASE, e.g. TINKER_API_KEY");
  if (action === "delete") {
    await confirm(flags, `Deleting the secret ${name}`);
    await request(config, "DELETE /v1/agents/{agent_id}/secrets/{name}", {params: {name}});
    return print(`Deleted ${name}; nothing sends it any more.`);
  }
  const host = String(flags.host ?? "").replace(/^https:\/\//, "").replace(/\/.*$/, "");
  const linked = typeof flags.from === "string" ? await storedKey(config, flags.from) : null;
  if (flags.from !== undefined && !linked) fail("--from takes the label or id of a Key stored in the App (rokku key list lists them)");
  if (!host && !linked) fail("Say which host the key is for: --host api.example.com (it is sent nowhere else), or link a Key stored in the App with --from \"label\"");
  const header = typeof flags.header === "string" ? flags.header : "Authorization: Bearer {}";
  if ((header.match(/\{\}/g) ?? []).length !== 1 || !/^[A-Za-z0-9-]+:\s?\S/.test(header)) fail("--header looks like 'X-API-Key: {}' with one {} where the key goes");
  const refs = typeof flags.creation === "string" ? flags.creation.split(",").map(x => x.trim()).filter(Boolean) : [];
  const creations = [];
  for (const ref of refs) creations.push((await resolveCreation(config, ref, {exact: true})).artifact_id);
  if (!creations.length && !flags.sandbox) usage("Say where it may be used: --creation <title> and/or --sandbox (your agent's code runs)");
  let saved;
  if (linked) {
    saved = await request(config, "PUT /v1/agents/{agent_id}/secrets/{name}", {params: {name}, body: {provider_credential_id: linked.credential_id,
      ...(host ? {host} : {}), header, sandbox: !!flags.sandbox, creations}});
  } else {
    // The value comes from the terminal (hidden) or stdin, never from an argument or shell history.
    const {value} = await secretInput([{name: "value", label: `${name} (for ${host})`}]);
    if (!value) fail("Empty value; nothing set");
    saved = await request(config, "PUT /v1/agents/{agent_id}/secrets/{name}", {params: {name}, body: {value, host, header, sandbox: !!flags.sandbox, creations}});
  }
  const sentTo = saved?.host ?? host;
  const where = [...refs, ...(flags.sandbox ? ["your agent's sandbox"] : [])].join(" and ");
  return print((linked
    ? `Linked ${name} to your App Key "${linked.label ?? linked.masked_credential}" for ${sentTo}, used by ${where}. It follows that Key: rotate or revoke it in the App and this follows. `
    : `Set ${name} for ${sentTo}, used by ${where}. Nobody can read it back. `) +
    (flags.sandbox ? `Code your agent runs reaches ${sentTo} with the header attached. ` : "") +
    (creations.length ? `Creation code sends the placeholder rokku-secret:${name}; Rokku swaps in the value only on requests to that host.` : ""));
}

// Every Key stored in the App (Settings → model Key): labels, masked values, status, never the value.
export async function providerKeys(config) {
  const keys = [];
  for (let page = 1; ; page++) {
    const result = await request(config, "GET /v1/provider-credentials", {query: {page_number: page, page_size: 100}});
    keys.push(...(result.items ?? []));
    if (!result.items?.length || page >= (result.pagination?.total_pages ?? page)) return keys;
  }
}

// A Key stored in the App (Settings → model Key), by its label or id; only active Keys can be linked.
export async function storedKey(config, ref) {
  const keys = await providerKeys(config);
  const active = keys.filter(k => k.status === "active");
  const wanted = String(ref).trim().toLowerCase();
  const matches = active.filter(k => k.credential_id === ref || (k.label ?? "").trim().toLowerCase() === wanted);
  if (matches.length > 1) fail(`More than one App Key is labelled "${ref}"; use its id: ${matches.map(k => k.credential_id).join(", ")}`);
  return matches[0] ?? null;
}

