// Model Keys the user brings (BYOK): list, add, relabel, rotate, remove, and what models a Key reaches.
// Values are typed at a hidden prompt or piped on stdin; Rokku shows only a masked hint afterwards.
import {randomUUID} from "node:crypto";
import {fail, usage, request, print, table, when, confirm, secretInput} from "../core.mjs";
import {providerKeys} from "../source.mjs";

export async function key(config, ref) {
  if (!ref) usage("Name a Key by its label or id (rokku key list)");
  const wanted = ref.toLowerCase();
  const matches = (await providerKeys(config)).filter(k => k.status === "active" && (k.credential_id === ref || (k.label ?? "").toLowerCase() === wanted));
  if (!matches.length) fail(`No active Key is labelled "${ref}". Run: rokku key list`);
  if (matches.length > 1) fail(`More than one Key is labelled "${ref}"; use its id: ${matches.map(k => k.credential_id).join(", ")}`);
  return matches[0];
}

export const endpointName = endpoint => endpoint.provider_key ?? endpoint.base_url;
const PROTOCOLS = ["openai_chat_completions", "openai_responses", "anthropic_messages", "gemini_generate_content", "bedrock_converse"];

function endpoint(flags) {
  if (typeof flags.provider === "string") return {kind: "catalog", provider_key: flags.provider};
  if (typeof flags["base-url"] !== "string") usage("Say where the Key works: --provider <key from rokku key providers> or --base-url URL [--protocol P]");
  if (flags.protocol === undefined) return {kind: "openai_compatible", base_url: flags["base-url"]};
  if (!PROTOCOLS.includes(flags.protocol)) usage(`--protocol is one of ${PROTOCOLS.join(", ")}`);
  return {kind: "custom", base_url: flags["base-url"], protocol: flags.protocol};
}

const newValue = async label => {
  const {value} = await secretInput([{name: "value", label}]);
  if (!value) fail("Empty value; nothing changed");
  return value;
};

// Stores a new Key typed at a hidden prompt (or piped on stdin) for --provider or --base-url.
export async function addKey(config, flags) {
  const where = endpoint(flags);
  const credential = await newValue(`Key for ${endpointName(where)}`);
  return request(config, "POST /v1/provider-credentials", {body: {client_credential_id: randomUUID(), endpoint: where, credential,
    label: typeof flags.label === "string" ? flags.label : null}});
}

export const commands = {
  key: {
    usage: "rokku key [list | providers | add (--provider P | --base-url URL [--protocol P]) [--label L] | label <k> <label> | rotate <k> | remove <k> | models <k>]",
    async run(config, [verb = "list", ref, label], flags) {
      if (verb === "list") {
        const keys = await providerKeys(config);
        return print(flags.raw ? keys : table(keys, [["label", k => k.label ?? "(no label)"], ["where", k => endpointName(k.endpoint)],
          ["key", k => k.masked_credential], ["status", k => k.status], ["added", k => when(k.created_at)], ["id", k => k.credential_id]]));
      }
      if (verb === "providers") {
        const catalog = await request(config, "GET /v1/provider-catalog");
        return print(table(catalog.items, [["provider", p => p.provider_key], ["name", p => p.display_name]]));
      }
      if (verb === "add") {
        const made = await addKey(config, flags);
        return print(`Added ${made.masked_credential ?? "the Key"} for ${endpointName(made.endpoint)} (${made.credential_id}).`);
      }
      const item = await key(config, ref);
      if (verb === "label") {
        if (!label) usage("Usage: rokku key label <key> <new label>");
        await request(config, "PATCH /v1/provider-credentials/{credential_id}", {params: {credential_id: item.credential_id}, body: {expected_version: item.version, label}});
        return print(`Relabelled as "${label}".`);
      }
      if (verb === "rotate") {
        const credential = await newValue(`New key for ${endpointName(item.endpoint)}`);
        const rotation = await request(config, "POST /v1/provider-credentials/{credential_id}/rotations", {params: {credential_id: item.credential_id},
          body: {expected_version: item.version, credential}});
        return print(`Rotation ${rotation.state ?? rotation.status ?? "started"}; Rokku switches over once the new key works.`);
      }
      if (verb === "remove") {
        await confirm(flags, `Removing the Key "${item.label ?? item.masked_credential}"`);
        await request(config, "DELETE /v1/provider-credentials/{credential_id}", {params: {credential_id: item.credential_id}, body: {expected_version: item.version}});
        return print("Removed. Anything that used it stops working until you add a new Key.");
      }
      if (verb === "models") {
        const page = await request(config, "POST /v1/provider-models/query", {body: {source: {kind: "credential", credential_id: item.credential_id}, limit: 100}})
          .catch(error => {
            if (error.details?.reason === "credential_rejected") fail(`${endpointName(item.endpoint)} rejected this Key, so its models can't be listed. Check the Key, or replace it with: rokku key rotate ${item.label ?? item.credential_id}`);
            throw error;
          });
        return print(flags.raw ? page : page.items.map(model => model.model ?? model.id ?? JSON.stringify(model)).join("\n") || "(no models listed)");
      }
      usage(`Unknown key verb "${verb}"`);
    },
  },
};
