// Creations and their data: find a creation, open its Gateway session (ADR-0067), DATA records.
import {randomUUID} from "node:crypto";
import {EXIT, CliError, fail, usage, sleep, updateConfig, requireSecure, timed, nearExpiry, refresh, request} from "./core.mjs";

// ---------- creations ----------
export async function listCreations(config, {lifecycle = "active"} = {}) {
  const items = [];
  let cursor;
  do {
    const page = await request(config, "GET /v1/agents/{agent_id}/artifacts", {query: {lifecycle, versions_limit: 1, limit: 50, cursor}});
    items.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor);
  return items;
}

// Writes need an exact title or id, so a renamed creation never sends data to a look-alike.
export async function resolveCreation(config, ref, {exact = false} = {}) {
  const creation = await findCreation(config, ref, {exact});
  if (!creation.app_url) fail(`"${creation.title}" has no live app (not a deployed app creation yet)`);
  requireSecure(creation.app_url);
  return creation;
}

// Any creation, app or not, by id or title; `lifecycle: "trashed"` looks in the trash.
export async function findCreation(config, ref, {exact = false, lifecycle = "active"} = {}) {
  if (!ref) usage("Missing <creation> (an id or a title)");
  const items = await listCreations(config, {lifecycle});
  const title = item => (item.title ?? "").toLowerCase(), needle = ref.toLowerCase();
  const matches = items.filter(item => item.artifact_id === ref || title(item) === needle);
  const loose = matches.length || exact ? matches : items.filter(item => title(item).includes(needle));
  if (loose.length === 0) fail(`No ${lifecycle === "trashed" ? "trashed " : ""}creation ${exact ? "is exactly" : "matches"} "${ref}". ` +
    `Run: rokku creations${lifecycle === "trashed" ? " --trashed" : ""}`);
  if (loose.length > 1) fail(`"${ref}" matches ${loose.length} creations: ` +
    loose.map(item => `${item.title} (${item.artifact_id})`).join(", ") + ". Use the id.");
  return loose[0];
}

// ---------- creation origin: ADR-0067 account-Bearer opening ----------
export async function openCreation(config, creation) {
  const cached = config.sessions?.[creation.artifact_id];
  if (cached && cached.origin === creation.app_url && Date.parse(cached.expires_at) - Date.now() > 60_000) return cached;
  if (nearExpiry(config)) await refresh(config);
  const response = await timed(creation.app_url + "/", {
    method: "GET", redirect: "manual",
    headers: {Authorization: `Bearer ${config.access_token}`, Accept: "application/json"},
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = undefined; }
  const cookies = response.headers.getSetCookie().map(line => line.split(";", 1)[0]).filter(pair => /=./.test(pair));
  if (response.status === 401 && body?.kind === "reauthorize") {
    const error = new CliError(`Could not open "${creation.title}": your login was refused`);
    error.unauthorized = true;
    throw error;
  }
  if (!response.ok || !body?.csrf_token || !cookies.length)
    fail(`Could not open "${creation.title}": HTTP ${response.status} ${text.slice(0, 200)}`);
  const session = {origin: creation.app_url, cookie: cookies.join("; "), csrf: body.csrf_token, expires_at: body.expires_at};
  await updateConfig(config, fresh => { fresh.sessions = {...fresh.sessions, [creation.artifact_id]: session}; });
  return session;
}

export async function forgetSession(config, creation) {
  await updateConfig(config, fresh => { if (fresh.sessions) delete fresh.sessions[creation.artifact_id]; });
}

// Busy or rate-limited answers are retried only for requests that are safe to send twice: reads, and
// DATA mutations, which carry a mutationId that DATA deduplicates. A creation's own POST is sent once.
export async function call(config, creation, method, path, body, {idempotent = ["GET", "HEAD"].includes(method)} = {}) {
  if (body !== undefined && ["GET", "HEAD"].includes(method)) fail(`${method} requests cannot carry a body`);
  for (let attempt = 0; ; attempt++) {
    let session;
    try { session = await openCreation(config, creation); }
    catch (error) {
      if (!error.unauthorized || attempt) throw error;
      await refresh(config);
      continue;
    }
    const headers = {Cookie: session.cookie, Accept: "application/json", Origin: session.origin};
    if (!["GET", "HEAD"].includes(method)) headers["X-Rokku-CSRF"] = session.csrf;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let response;
    for (let busy = 0; ; busy++) {
      response = await timed(session.origin + path, {method, headers, redirect: "manual", body: payload});
      if (!idempotent || ![429, 502, 503, 504].includes(response.status) || busy === 5) break;
      const wait = Number(response.headers.get("Retry-After")) * 1000 || 1000 * 2 ** busy;
      await response.arrayBuffer();
      await sleep(Math.min(wait, 30_000));
    }
    const text = await response.text();
    // The Gateway answers an expired or missing creation session with 401 {kind:"reauthorize"}.
    if (response.status === 401 && attempt === 0) { await forgetSession(config, creation); continue; }
    let parsed = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* a business endpoint may return text */ }
    return {status: response.status, body: parsed};
  }
}

// ---------- DATA records (platform recordsWorker routes) ----------
export const recordsPath = (collection, suffix = "") => `/api/records/${encodeURIComponent(collection)}${suffix}`;
export const shown = record => ({...record.value, id: record.record_id});

export function dataError(what, result) {
  const kind = result.body?.kind ? ` (${result.body.kind})` : "";
  const text = typeof result.body === "string" ? ` ${result.body.slice(0, 200)}` : "";
  return new CliError(`${what}: HTTP ${result.status}${kind}${text}`, result.status === 409 ? EXIT.conflict :
    result.status === 401 ? EXIT.login : result.status === 429 || result.status >= 500 ? EXIT.unavailable : EXIT.error);
}

export async function listRecords(config, creation, collection) {
  for (let restart = 0; restart < 6; restart++) {
    // Concurrent writers change the data revision mid-listing; back off and read again from page one.
    if (restart) await sleep(500 * restart);
    const records = [];
    let after, restarted = false;
    do {
      const query = after === undefined ? "" : `?after=${encodeURIComponent(JSON.stringify(after))}`;
      const result = await call(config, creation, "GET", recordsPath(collection, query));
      if (result.status === 409 && result.body?.kind === "data_revision_changed") { restarted = true; break; }
      if (result.status !== 200) throw dataError(`list ${collection}`, result);
      records.push(...result.body.records);
      after = result.body.next ?? undefined;
    } while (after !== undefined);
    if (!restarted) return records.filter(record => !record.deleted);
  }
  fail(`list ${collection}: data kept changing; try again`);
}

export async function getRecord(config, creation, collection, id) {
  const result = await call(config, creation, "GET", recordsPath(collection, `/record?id=${encodeURIComponent(id)}`));
  if (result.status !== 200) throw dataError(`get ${collection}/${id}`, result);
  return result.body;
}

export async function writeRecord(config, creation, collection, id, makeValue, {retries = 3, sortKey, ifAbsent = false} = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const current = await getRecord(config, creation, collection, id);
    const live = current && !current.deleted ? current : null;
    if (ifAbsent && live) return {skipped: true, record: live};
    const value = makeValue(live?.value ?? null);
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail("A record value must be a JSON object");
    const mutation = {mutationId: randomUUID(), recordId: id, expectedRevision: current?.revision ?? 0, value,
      sortKey: sortKey ?? live?.sort_key ?? new Date().toISOString()};
    const result = await call(config, creation, "POST", recordsPath(collection), mutation, {idempotent: true});
    if (result.status === 200) return {record: {record_id: id, value}};
    if (result.status !== 409 || attempt === retries) throw dataError(`put ${collection}/${id}`, result);
  }
}

export async function deleteRecord(config, creation, collection, id) {
  const current = await getRecord(config, creation, collection, id);
  if (!current || current.deleted) fail(`${collection}/${id} does not exist`);
  const result = await call(config, creation, "DELETE", recordsPath(collection),
    {mutationId: randomUUID(), recordId: id, expectedRevision: current.revision}, {idempotent: true});
  if (result.status !== 200) throw dataError(`delete ${collection}/${id}`, result);
}

