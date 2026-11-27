// The Rokku chat: read the latest messages, search it, and delete messages. Deleting cannot be undone and
// is the user's own decision, so it runs only for a person at a terminal, never through a coding agent or MCP.
import {usage, request, print, when, seconds, requirePerson} from "../core.mjs";

// Chat protocol 7 wraps each listed message as {message} and lets the newest page be read first.
const PROTOCOL = {"X-Rokku-Chat-Protocol": "7"};
const author = role => role === "user" ? "you" : "Rokku";

async function latest(config, flags) {
  const last = seconds(flags, "last", 6, 1);
  const page = await request(config, "GET /v1/agents/{agent_id}/conversations/{conversation_id}/messages", {
    params: {conversation_id: config.conversation_id}, query: {before_message_seq: Number.MAX_SAFE_INTEGER, limit: Math.min(50, last)},
    headers: PROTOCOL});
  const clip = body => flags.full || body.length <= 600 ? body : body.slice(0, 600) + " …(--full for all)";
  const text = message => message.content.map(block => block.payload?.text ?? block.fallback_text ??
    block.payload?.original?.title ?? `[${block.type}]`).join("\n");
  const messages = page.messages.map(entry => entry.message ?? entry).slice(-last);
  if (flags.raw) return print(messages);
  return print(messages.map(message =>
    `── ${author(message.role)} · ${when(message.created_at)}${flags.ids ? ` · ${message.message_id}` : ""}` +
    `${message.processing_state ? ` · ${message.processing_state}` : ""}` +
    `${message.processing_error ? ` (${message.processing_error.summary})` : ""}\n${clip(text(message))}`).join("\n\n") || "(no messages)");
}

async function search(config, words, flags) {
  const q = words.join(" ").trim();
  if (!q) usage("Usage: rokku chat search <text> [--before N]");
  const page = await request(config, "GET /v1/agents/{agent_id}/conversations/{conversation_id}/search", {
    params: {conversation_id: config.conversation_id}, query: {q, limit: 20, before_message_seq: seconds(flags, "before", undefined, 1)}});
  if (flags.raw) return print(page);
  const hits = page.hits.map(hit => `── ${author(hit.role)} · ${when(hit.created_at)} · ${hit.message_id}\n${hit.excerpt ?? (hit.image ? "[image]" : "")}`);
  const more = page.next_before_message_seq ? `\n\nOlder matches: rokku chat search ${JSON.stringify(q)} --before ${page.next_before_message_seq}` : "";
  return print((hits.join("\n\n") || "(nothing matches)") + more);
}

async function remove(config, ids, flags) {
  if (!ids.length) usage("Usage: rokku chat delete <message id>...   (rokku chat --ids or rokku chat search shows ids)");
  if (ids.length > 100) usage("Delete at most 100 messages at a time");
  await requirePerson(`Deleting ${ids.length} message${ids.length === 1 ? "" : "s"} from your Rokku chat (it cannot be undone)`);
  await request(config, "POST /v1/agents/{agent_id}/conversations/{conversation_id}/messages:delete", {
    params: {conversation_id: config.conversation_id}, body: {message_ids: ids}, headers: PROTOCOL});
  return print(`Deleted ${ids.length} message${ids.length === 1 ? "" : "s"}.`);
}

export const commands = {
  chat: {
    usage: "rokku chat [--last 6] [--full] [--ids] | search <text> [--before N] | delete <message id>...   read, search or delete messages in your Rokku chat",
    async run(config, [verb, ...rest], flags) {
      if (verb === undefined) return latest(config, flags);
      if (verb === "search") return search(config, rest, flags);
      if (verb === "delete") return remove(config, rest, flags);
      usage(`Unknown chat verb "${verb}"`);
    },
  },
};
