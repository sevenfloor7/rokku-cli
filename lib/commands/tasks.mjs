// Tasks the Rokku agent runs: list, read (with the full result), send an instruction, cancel, retry.
import {readFileSync} from "node:fs";
import {fail, usage, request, print, table, when, everyPage, readStdin} from "../core.mjs";

const params = id => ({task_id: id});
// A Task too large for one response comes back as {task_id, version, content_cursor}; its full JSON is
// then read in fragments from that cursor.
async function get(config, id) {
  const task = await request(config, "GET /v1/agents/{agent_id}/tasks/{task_id}", {params: params(id)});
  if (!task.content_cursor) return task;
  let text = "";
  for (let cursor = task.content_cursor, page = 0; cursor; page++) {
    if (page >= 1000) fail("Task content did not end; try again");
    const part = await request(config, "GET /v1/agents/{agent_id}/tasks/{task_id}/content", {params: params(id), query: {cursor}});
    text += part.fragment;
    cursor = part.next_cursor;
  }
  return JSON.parse(text);
}

const FINISHED = ["completed", "cancelled", "failed"];

export const commands = {
  task: {
    usage: "rokku task [list [--state running,waiting] | show <id> | message <id> \"text\" | --file f | cancel <id> | retry <id>]",
    async run(config, [verb = "list", id, ...words], flags) {
      if (verb === "list") {
        const state = flags.state === undefined ? undefined : String(flags.state);
        const items = await everyPage(config, "GET /v1/agents/{agent_id}/tasks", {query: {state}, limit: 100});
        return print(flags.raw ? items : table(items, [["title", t => t.title], ["state", t => t.state], ["updated", t => when(t.updated_at)], ["id", t => t.task_id]]));
      }
      if (!id) usage(`Usage: rokku task ${verb} <task id>`);
      if (verb === "show") {
        const task = await get(config, id);
        if (flags.raw) return print(task);
        const lines = [`${task.title}  [${task.state}${task.waiting_reason ? `: ${task.waiting_reason}` : ""}]  updated ${when(task.updated_at)}`,
          task.description, task.result?.summary && task.result.summary !== task.description && `Result: ${task.result.summary}`, task.progress?.summary && `Progress: ${task.progress.summary}`,
          task.error && `Error: ${task.error.summary ?? task.error.code ?? JSON.stringify(task.error)}`];
        return print(lines.filter(Boolean).join("\n"));
      }
      if (verb === "message") {
        const instruction = flags.file ? readFileSync(flags.file === "-" ? 0 : flags.file, "utf8") : words.join(" ") || await readStdin();
        if (!instruction.trim()) usage("Usage: rokku task message <id> \"what to change\"");
        const task = await get(config, id);
        if (FINISHED.includes(task.state)) fail(`${task.title} is ${task.state} and takes no more messages. To change what it did, ask Rokku: rokku ask "…"`);
        await request(config, "POST /v1/agents/{agent_id}/tasks/{task_id}/messages", {params: params(id), body: {instruction}});
        return print("Sent to the task.");
      }
      if (verb === "cancel") {
        const task = await request(config, "POST /v1/agents/{agent_id}/tasks/{task_id}/cancel", {params: params(id), body: {}});
        return print(`${task.title}: ${task.state}. To do it again, ask Rokku: rokku ask "…"`);
      }
      if (verb === "retry") {
        const task = await get(config, id);
        if (task.state !== "failed" || !task.actions?.some(action => action.type === "retry_task"))
          fail(`${task.title} is ${task.state}; only a failed task can be retried. To do it again, ask Rokku: rokku ask "…"`);
        const result = await request(config, "POST /v1/agents/{agent_id}/tasks/{task_id}/retry", {params: params(id), body: {expected_version: task.version}});
        const next = result.task?.task_id;
        return print(next ? `Retrying ${task.title} as task ${next}.` : `Retrying ${task.title}.`);
      }
      usage(`Unknown task verb "${verb}"`);
    },
  },
};
