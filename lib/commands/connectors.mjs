// Third-party and MCP connectors: the catalog, connections, connecting (OAuth in this laptop's browser,
// or a key typed at a hidden prompt), removing, and what the agent may do with each without asking.
// Native connectors (Calendar, Photos, …) read the phone itself, so they are connected in the App.
import {fail, usage, request, print, table, when, everyPage, confirm, sleep, openBrowser, secretInput, requirePerson} from "../core.mjs";
import {findCreation} from "../creations.mjs";

async function everyCatalogPage(config) {
  const native = [], thirdParty = [];
  let cursor;
  do {
    const page = await request(config, "GET /v1/connectors", {query: {limit: 50, cursor}});
    native.push(...page.items);
    thirdParty.push(...(page.third_party ?? []));
    cursor = page.next_cursor;
  } while (cursor);
  return {native, thirdParty};
}

async function connections(config) {
  const items = [];
  let cursor;
  do {
    const page = await request(config, "GET /v1/agents/{agent_id}/third-party-connections", {query: {limit: 50, cursor}});
    items.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor);
  return items;
}

async function connection(config, ref) {
  if (!ref) usage("Name a connection by its id, connector id or name (rokku connector list)");
  const wanted = ref.toLowerCase();
  const matches = (await connections(config)).filter(c => c.connection_id === ref || c.connector_id.toLowerCase() === wanted || c.display_name.toLowerCase() === wanted);
  if (!matches.length) fail(`No connection matches "${ref}". Run: rokku connector list`);
  if (matches.length > 1) fail(`"${ref}" matches ${matches.length} connections; use the id: ${matches.map(c => c.connection_id).join(", ")}`);
  return matches[0];
}

// Waits for the browser half of an OAuth connect to finish.
export async function finishOAuth(config, attemptId) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const attempt = await request(config, "GET /v1/agents/{agent_id}/third-party-connections/oauth/{attempt_id}", {params: {attempt_id: attemptId}});
    if (attempt.install_url) process.stderr.write(`One more step in the browser: ${attempt.install_url}\n`);
    if (attempt.status === "completed") return attempt;
    if (attempt.status !== "pending") fail(`The connection was not made (${attempt.status})`);
  }
  await request(config, "POST /v1/agents/{agent_id}/third-party-connections/oauth/{attempt_id}/cancel", {params: {attempt_id: attemptId}});
  fail("Nobody finished signing in within 10 minutes; nothing was connected");
}

const placement = flags => flags.placement === undefined ? "connector" : ["connector", "memory_library"].includes(flags.placement) ? flags.placement :
  usage("--placement is connector or memory_library");

export async function connect(config, connectorId, flags) {
  if (flags["mcp-url"] !== undefined) {
    // A custom MCP server nobody at Rokku reviewed: the user says so with --unreviewed.
    if (!flags.unreviewed) usage("A custom MCP server is not reviewed by Rokku; pass --unreviewed to connect it anyway");
    const credential = flags.bearer ? {kind: "static_bearer", value: (await secretInput([{name: "value", label: "Bearer token"}])).value} : {kind: "none"};
    const made = await request(config, "POST /v1/agents/{agent_id}/third-party-connections", {body: {custom_mcp_url: String(flags["mcp-url"]),
      display_name: typeof flags.name === "string" ? flags.name : undefined, credential, acknowledged_unreviewed: true, placement: placement(flags)}});
    return print(`Connected ${made.display_name} (${made.connection_id}) with ${made.tools.length} tools.`);
  }
  if (!connectorId) usage("Usage: rokku connector connect <connector id> | --mcp-url URL --unreviewed [--bearer] [--name N]");
  const entry = (await everyCatalogPage(config)).thirdParty.find(item => item.connector_id === connectorId);
  if (!entry) fail(`"${connectorId}" is not in the catalog. Run: rokku connector catalog (native connectors are connected in the App)`);
  const methods = entry.auth_methods;
  const keyMethod = methods.find(method => method === "api_key" || method === "static_bearer");
  if (methods.includes("oauth") && !flags["api-key"] && entry.user_credential?.kind !== "oauth_client") {
    const started = await request(config, "POST /v1/agents/{agent_id}/third-party-connections/oauth",
      {body: {connector_id: connectorId, return_to: "web", placement: placement(flags)}});
    openBrowser(started.authorization_url, flags);
    // Without a browser here, someone else opens the link; don't hold a headless agent waiting for it.
    if (flags["no-browser"]) return print(`Sign in to ${entry.name} at that link; rokku connector list shows the connection once it is made.`);
    const done = await finishOAuth(config, started.attempt_id);
    return print(`Connected ${entry.name} (${done.connection_id}).`);
  }
  if (entry.user_credential?.kind === "oauth_client") fail(`${entry.name} needs your own OAuth app's client secret; enter it in the App`);
  let credential;
  if (methods.includes("user_fields") && entry.user_credential) {
    const fields = entry.user_credential.fields;
    process.stderr.write(`${entry.name} needs: ${fields.map(f => f.label).join(", ")} (from ${entry.user_credential.setup_url})\n`);
    credential = {kind: "user_fields", values: await secretInput(fields)};
  } else if (keyMethod) {
    credential = {kind: keyMethod, value: (await secretInput([{name: "value", label: `${entry.name} key`}])).value};
  } else fail(`${entry.name} connects with ${methods.join(", ")}, which the CLI can't do; use the App`);
  if (Object.values(credential.values ?? {value: credential.value}).some(value => !value)) fail("Empty value; nothing connected");
  const made = await request(config, "POST /v1/agents/{agent_id}/third-party-connections",
    {body: {connector_id: connectorId, credential, placement: placement(flags)}});
  print(`Connected ${made.display_name} (${made.connection_id}).`);
}

// Events from a connector (a new email, say) that a creation may receive, as the user allowed on a card.
async function events(config, ref, flags) {
  const artifactId = ref ? (await findCreation(config, ref)).artifact_id : undefined;
  const items = await everyPage(config, "GET /v1/agents/{agent_id}/artifact-event-grants", {query: {artifact_id: artifactId}, limit: 50});
  const active = items.filter(grant => !grant.revoked_at);
  if (flags.raw) return print(active);
  return print(table(active, [["creation", g => g.artifact_title], ["connector", g => g.connector], ["event", g => g.label],
    ["since", g => when(g.created_at)], ["id", g => g.id]]));
}

export const commands = {
  connector: {
    usage: "rokku connector [list | catalog | connect <connector> [--api-key] [--placement P] [--no-browser] | connect --mcp-url URL --unreviewed [--bearer] [--name N] | remove <c> | allow <c> view=allow|ask|deny manage=… | events [<creation>] | stop-event <grant id>]",
    async run(config, [verb = "list", ref, ...settings], flags) {
      if (verb === "catalog") {
        const {native, thirdParty} = await everyCatalogPage(config);
        if (flags.raw) return print({native, third_party: thirdParty});
        return print(table(thirdParty, [["connector", c => c.connector_id], ["name", c => c.name], ["kind", c => c.access_kind], ["sign-in", c => c.auth_methods.join(",")]]) +
          `\n\nIn the App only (they read the phone): ${native.map(c => c.name).join(", ") || "none"}`);
      }
      if (verb === "list") {
        const [items, native] = await Promise.all([connections(config),
          request(config, "GET /v1/agents/{agent_id}/connector-connections", {query: {limit: 50}})]);
        if (flags.raw) return print({third_party: items, native: native.items});
        return print(table(items, [["name", c => c.display_name], ["state", c => c.auth_state], ["on", c => c.use_enabled ? "yes" : "no"],
          ["allowed", c => c.items.map(i => `${i.item}=${i.policy}`).join(" ")], ["where", c => c.placement], ["id", c => c.connection_id]]) +
          (native.items.length ? `\n\nOn the phone: ${native.items.map(c => `${c.connector_id} (${c.effective_status})`).join(", ")}` : ""));
      }
      if (verb === "connect") {
        if (flags.unreviewed) await requirePerson(`Connecting ${flags["mcp-url"] ?? "a server"}, which Rokku has not reviewed`);
        return connect(config, ref, flags);
      }
      if (verb === "events") return events(config, ref, flags);
      if (verb === "stop-event") {
        if (!ref) usage("Usage: rokku connector stop-event <grant id>   (rokku connector events lists them)");
        await confirm(flags, "Stopping these events for that creation", "; it can ask you again later");
        await request(config, "DELETE /v1/agents/{agent_id}/artifact-event-grants/{grant_id}", {params: {grant_id: ref}});
        return print("Stopped. The creation no longer gets those events.");
      }
      const item = await connection(config, ref);
      if (verb === "remove") {
        await confirm(flags, `Disconnecting ${item.display_name}`);
        await request(config, "DELETE /v1/agents/{agent_id}/third-party-connections/{connection_id}", {params: {connection_id: item.connection_id}});
        return print(`Disconnected ${item.display_name}.`);
      }
      if (verb === "allow") {
        const items = settings.map(setting => {
          const [name, policy] = setting.split("=");
          if (!["view", "manage"].includes(name) || !["allow", "ask", "deny"].includes(policy)) usage("Usage: rokku connector allow <c> view=allow|ask|deny manage=allow|ask|deny");
          return {item: name, policy};
        });
        if (!items.length) usage("Usage: rokku connector allow <c> view=allow|ask|deny manage=allow|ask|deny");
        const granted = items.filter(change => change.policy === "allow").map(change => change.item);
        if (granted.length) await requirePerson(`Letting Rokku ${granted.join(" and ")} ${item.display_name} without asking you`);
        const updated = await request(config, "PATCH /v1/agents/{agent_id}/third-party-connections/{connection_id}/items",
          {params: {connection_id: item.connection_id}, body: {expected_revision: item.authority_revision, items}});
        return print(`${updated.display_name}: ${updated.items.map(i => `${i.item}=${i.policy}`).join(" ")}`);
      }
      usage(`Unknown connector verb "${verb}"`);
    },
  },
};
