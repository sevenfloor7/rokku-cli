// Which model Rokku runs on: Rokku's own default, or one model through a Key the user brought (BYOK).
// Switching follows the App's order: Key → a connection for that one model → verified ready → agent
// settings, where the model and its connection are set together. A new Key is typed at a hidden prompt.
import {randomUUID} from "node:crypto";
import {fail, usage, request, print} from "../core.mjs";
import {key, addKey, endpointName} from "./keys.mjs";

const settings = config => request(config, "GET /v1/agents/{agent_id}/settings");

async function connections(config) {
  const items = [];
  for (let page = 1; ; page++) {
    const result = await request(config, "GET /v1/provider-connections", {query: {page_number: page, page_size: 100}});
    items.push(...(result.items ?? []));
    if (!result.items?.length || page >= (result.pagination?.total_pages ?? page)) return items;
  }
}

// A ready connection for this Key and model: reuse one that exists, otherwise create it, then verify.
async function readyConnection(config, credential, model) {
  let connection = (await connections(config)).find(c => c.credential_id === credential.credential_id && c.model === model && c.status !== "revoked")
    ?? await request(config, "POST /v1/provider-connections", {body: {client_connection_id: randomUUID(), credential_id: credential.credential_id, model}});
  if (connection.status !== "ready") {
    process.stderr.write(`Checking ${model} with that Key…\n`);
    connection = await request(config, "POST /v1/provider-connections/{connection_id}/verify",
      {params: {connection_id: connection.connection_id}, body: {expected_version: connection.version}, timeout: 120_000});
  }
  if (connection.status !== "ready") fail(`${model} did not work with that Key (${connection.status}); nothing was switched. rokku key models <key> lists what it reaches`);
  return connection;
}

async function choose(config, modelConfig, connectionId) {
  const now = await settings(config);
  return request(config, "PATCH /v1/agents/{agent_id}/settings",
    {body: {expected_agent_version: now.agent_version, model_config: modelConfig, provider_connection_id: connectionId}});
}

// The hosted model tier, cheapest first; it applies while Rokku runs on its own models, not on a Key.
const MODES = ["light", "balanced", "deep"];
const userSettings = config => request(config, "GET /v1/user/settings");

const money = figure => figure.status === "available" ? figure.amounts.map(m => `${m.amount} ${m.currency}`).join(" + ") || "0" :
  figure.status === "unsupported" ? "not reported by this provider" : "unavailable right now";

export const commands = {
  model: {
    usage: "rokku model [show | use <model> (--key <k> | --provider P | --base-url URL [--protocol P]) | default | mode [light|balanced|deep] | usage]   the model Rokku runs on",
    async run(config, [verb = "show", model], flags) {
      if (verb === "show") {
        const [now, user] = await Promise.all([settings(config), userSettings(config)]);
        if (flags.raw) return print({...now, model_mode: user.model_mode});
        if (now.model_config?.kind !== "byok") return print(`Rokku runs on its own models, in ${user.model_mode} mode (rokku model mode changes it).`);
        const connection = await request(config, "GET /v1/provider-connections/{connection_id}", {params: {connection_id: now.provider_connection_id}});
        return print(`Rokku runs on ${connection.model} with your Key for ${endpointName(connection.endpoint)} (${connection.status}).`);
      }
      if (verb === "mode") {
        if (model === undefined) return print((await userSettings(config)).model_mode);
        if (!MODES.includes(model)) usage(`The mode is one of ${MODES.join(", ")}`);
        await request(config, "PATCH /v1/user/settings", {body: {model_mode: model}});
        const now = await settings(config);
        return print(`Rokku's own models now run in ${model} mode.` +
          (now.model_config?.kind === "byok" ? " Rokku is on your Key right now, so this applies after rokku model default." : ""));
      }
      if (verb === "usage") {
        const now = await settings(config);
        if (now.model_config?.kind !== "byok") return print("Rokku runs on its own models; rokku billing shows your credits.");
        const report = await request(config, "GET /v1/provider-connections/{connection_id}/account-usage", {params: {connection_id: now.provider_connection_id}});
        if (flags.raw) return print(report);
        return print(`As your provider reports it (all apps using this Key, not only Rokku):\n` +
          `Balance${report.balance.scope === "key" ? " (this Key's limit)" : ""}: ${money(report.balance)}\nToday: ${money(report.today)}\nThis month: ${money(report.month)}`);
      }
      if (verb === "default") {
        await choose(config, {kind: "hosted_default"}, null);
        return print("Rokku runs on its own default model again. Your Keys are kept.");
      }
      if (verb === "use") {
        if (!model) usage("Usage: rokku model use <model> --key <label or id> | --provider P | --base-url URL");
        const sources = [flags.key !== undefined, flags.provider !== undefined, flags["base-url"] !== undefined].filter(Boolean).length;
        if (sources !== 1) usage("Say which Key: --key <a Key you added (rokku key list)>, or --provider P / --base-url URL to add one now");
        const credential = flags.key !== undefined ? await key(config, String(flags.key)) : await addKey(config, flags);
        const connection = await readyConnection(config, credential, model);
        await choose(config, {kind: "byok", model}, connection.connection_id);
        return print(`Rokku now runs on ${model} with your Key for ${endpointName(connection.endpoint)}. Switch back with: rokku model default`);
      }
      usage(`Unknown model verb "${verb}"`);
    },
  },
};
