// Automations (scheduled and event-driven jobs): list, read, create and edit from a JSON definition,
// turn on/off, delete, and their fire history. The definition is the API's own shape, so whatever the
// App and the Agent can schedule, this can too.
import {readFileSync} from "node:fs";
import {fail, usage, request, print, table, when, confirm, everyPage, readStdin} from "../core.mjs";

const list = config => everyPage(config, "GET /v1/agents/{agent_id}/automations", {limit: 100});

async function automation(config, ref) {
  if (!ref) usage("Name an automation by its id or name (rokku automation list)");
  const matches = (await list(config)).filter(a => a.automation_id === ref || a.definition.name.toLowerCase() === ref.toLowerCase());
  if (!matches.length) fail(`No automation is called "${ref}". Run: rokku automation list`);
  if (matches.length > 1) fail(`More than one automation is called "${ref}"; use its id: ${matches.map(a => a.automation_id).join(", ")}`);
  return matches[0];
}

async function jsonObject(flags) {
  const raw = flags.json ?? (flags.file && flags.file !== "-" ? readFileSync(flags.file, "utf8") : await readStdin());
  let value;
  try { value = JSON.parse(raw); } catch { usage("Expected a JSON object (--json '{...}', --file path, or stdin)"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) usage("Expected a JSON object");
  return value;
}

const patch = (config, item, change) => request(config, "PATCH /v1/agents/{agent_id}/automations/{automation_id}", {
  params: {automation_id: item.automation_id}, body: {expected_version: item.version, patch: change}});

export const commands = {
  automation: {
    usage: "rokku automation [list | show <a> | create (--file def.json | --json '{…}' | stdin) | edit <a> (--file patch.json | --json '{…}' | stdin) | on <a> | off <a> | delete <a> | fires <a>]\n" +
      "    definition: {\"name\": \"…\", \"trigger\": {\"kind\": \"at\", \"at\": \"<ISO time>\"} | {\"kind\": \"cron\", \"cron\": \"0 9 * * *\", \"timezone\": \"<IANA zone>\"},\n" +
      "                 \"action\": {\"kind\": \"emit_timer_event\", \"instruction\": \"…\"} | {\"kind\": \"start_task\", \"title\": \"…\", \"description\": \"…\", \"instruction\": \"…\"}}\n" +
      "    (start_task needs \"schema_version\": 2 in the definition)",
    async run(config, [verb = "list", ref], flags) {
      if (verb === "list") {
        const items = await list(config);
        return print(flags.raw ? items : table(items, [["name", a => a.definition.name], ["on", a => a.enabled ? "yes" : "no"],
          ["when", a => a.trigger_summary], ["next", a => when(a.next_fire_at)], ["paused", a => a.paused_reason], ["id", a => a.automation_id]]));
      }
      if (verb === "create") {
        // The definition: {name, trigger, action, ...} as in the API (AutomationCreateDefinitionInput).
        const definition = await jsonObject(flags);
        const created = await request(config, "POST /v1/agents/{agent_id}/automations", {body: {conversation_id: config.conversation_id, definition}});
        return print(`Created "${created.definition.name}" (${created.automation_id}): ${created.trigger_summary}` +
          (created.next_fire_at ? `, next at ${when(created.next_fire_at)}` : ""));
      }
      const item = await automation(config, ref);
      if (verb === "show") return print(item);
      if (verb === "edit") {
        const updated = await patch(config, item, await jsonObject(flags));
        return print(`Updated "${updated.definition.name}": ${updated.trigger_summary}`);
      }
      if (verb === "on" || verb === "off") {
        await patch(config, item, {enabled: verb === "on"});
        return print(`"${item.definition.name}" is ${verb}.`);
      }
      if (verb === "delete") {
        await confirm(flags, `Deleting the automation "${item.definition.name}"`);
        await request(config, "DELETE /v1/agents/{agent_id}/automations/{automation_id}", {params: {automation_id: item.automation_id},
          body: {expected_version: item.version}});
        return print(`Deleted "${item.definition.name}".`);
      }
      if (verb === "fires") {
        const fires = await everyPage(config, "GET /v1/agents/{agent_id}/automations/{automation_id}/fires", {params: {automation_id: item.automation_id}, limit: 100});
        return print(flags.raw ? fires : table(fires, [["scheduled", f => when(f.scheduled_for ?? f.created_at)], ["state", f => f.state],
          ["why", f => f.failure_reason ?? f.skip_reason ?? f.waiting_reason], ["task", f => f.task_id]]));
      }
      usage(`Unknown automation verb "${verb}"`);
    },
  },
};
