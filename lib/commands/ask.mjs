// rokku ask: send a message to the user's main Rokku conversation and stream the reply here.
// The conversation's SSE stream (chat protocol 7) is opened and caught up before the message is sent,
// so nothing the agent says in reply is missed. Text streams as it is written; cards (creations, tasks,
// approvals) print as one line each. The command ends when the run the message started ends.
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {EXIT, fail, usage, sleep, request, routePath, apiBase, readStdin, seconds, personAtTerminal} from "../core.mjs";
import {answerCard, answerableHere, getCard, reportCapabilities} from "../cards.mjs";

const CHAT = {"X-Rokku-Chat-Protocol": "7"};
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
// Runs that owe the user a reply: a message, or an answer to a card. A missing trigger counts as one.
const USER_RUNS = new Set(["user_message", "user_action"]);
const out = text => process.stdout.write(text);

// Frames of an SSE body: blank-line separated, "event:" names the kind, "data:" lines carry JSON.
async function* frames(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, {stream: true});
    for (let end; (end = buffer.search(/\r?\n\r?\n/)) >= 0; ) {
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
      const data = raw.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
      if (data) yield JSON.parse(data);
    }
  }
}

const blockText = block => block.type === "text" ? block.payload?.text ?? "" : `[${block.fallback_text ?? block.type}]`;

// Cards. A person at this terminal answers the ones a terminal can; anyone else (a coding agent, an MCP
// client) is told the command that lets the person answer. Cards only the phone can do (device and
// phone permissions) are pointed to the phone. Either way the reply goes on after the card, so ask
// keeps waiting: `cards` counts the cards shown, `pending` holds the ones nobody has answered yet.
async function show(config, block, cards, pending) {
  if (block.type !== "interaction_ref") return out(`${blockText(block)}\n`);
  const id = block.payload?.interaction_id, label = block.fallback_text ?? "Rokku is asking you something";
  let card = null;
  try { card = await getCard(config, id); } catch { /* shown below as a card to answer */ }
  if (card && card.state !== "pending") return out(`[${label}: ${card.state}]\n`);
  cards.count++;
  if (card && !answerableHere(card)) { pending.add(id); return out(`\n[${label}: finish this on your phone, in the Rokku app]\n`); }
  if (!personAtTerminal() || config.client_kind !== "cli") {
    pending.add(id);
    return out(`\n[${label}: the user answers with \`rokku answer ${id}\` in a terminal, or in the Rokku app]\n`);
  }
  try { out(`${await answerCard(config, id)}\n`); }
  catch (error) { pending.add(id); out(`[${label}: ${error.message}]\n`); }
}

// The stream can drop while a card waits for its answer (a laptop on flaky Wi-Fi, a server restart).
// It is reopened after the last durable event, up to RECONNECTS times; text deltas are not replayed,
// so what was missed arrives with the committed message.
const RECONNECTS = 5;
const dropped = error => ["fetch failed", "terminated"].includes(error?.message) || /^(UND_ERR|ECONN|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN)/.test(error?.cause?.code ?? error?.code ?? "");

// Text is compared without whitespace: the Host splits a reply into messages after streaming it,
// so the committed messages carry the streamed text with different blank lines and new ids.
const squeeze = text => text.replace(/\s+/g, "");
// The part of `text` after its first `count` non-whitespace characters.
function after(text, count) {
  let i = 0;
  for (; i < text.length && count > 0; i++) if (!/\s/.test(text[i])) count--;
  return text.slice(i);
}

export async function ask(config, text, {wait = true, timeout = 600} = {}) {
  await reportCapabilities(config);
  if (config.client_kind !== "cli") process.stderr.write("(This login predates CLI cards; run rokku login again to answer Rokku's cards in the terminal.)\n");
  // Read the stream position first, then subscribe and wait until replay is done, then send.
  const info = await request(config, "GET /v1/user/info");
  const agent = info.agents.find(a => a.agent_id === config.agent_id) ?? fail("This login's agent is gone; run rokku login again");
  const send = () => request(config, "POST /v1/agents/{agent_id}/conversations/{conversation_id}/messages", {
    params: {conversation_id: config.conversation_id}, headers: CHAT,
    body: {content: [{id: randomUUID(), type: "text", payload: {text}}]}});
  if (!wait) return send();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  let cursor = agent.initial_stream_cursor || undefined;
  const open = async () => {
    const {path} = routePath(config, "GET /v1/agents/{agent_id}/conversations/{conversation_id}/stream",
      {conversation_id: config.conversation_id}, {after_cursor: cursor});
    const response = await fetch(apiBase(config) + path, {signal: controller.signal,
      headers: {Authorization: `Bearer ${config.access_token}`, Accept: "text/event-stream", ...CHAT}});
    if (!response.ok || !(response.headers.get("content-type") ?? "").startsWith("text/event-stream"))
      fail(`Could not open the conversation stream: HTTP ${response.status}`, response.status === 401 ? EXIT.login : EXIT.unavailable);
    return response;
  };

  // A run that was already going when we sent belongs to an earlier message; its end is not ours.
  const earlier = agent.foreground_run?.run_id;
  let accepted = null, run = null, replied = false;
  const cards = {count: 0}, pending = new Set(), shown = new Set(), seen = new Set();
  // Streamed text, without whitespace, and how much of it committed messages have accounted for.
  let streamed = "", used = 0, last = "\n";
  const write = chunk => { if (chunk) { out(chunk); last = chunk.at(-1); } };
  const endLine = () => { if (last !== "\n") write("\n"); };
  // A newer revision of a streamed message restarts it; the terminal can't take text back, so
  // streaming of that message stops there and its committed text fills in what was not printed.
  const revisions = new Map(), stopped = new Set();
  const live = event => {
    if (!revisions.has(event.message_id)) revisions.set(event.message_id, event.revision);
    if (revisions.get(event.message_id) !== event.revision) stopped.add(event.message_id);
    return !stopped.has(event.message_id);
  };
  const showBlock = async block => {
    if (block.id && shown.has(block.id)) return;
    if (block.id) shown.add(block.id);
    endLine();
    await show(config, block, cards, pending);
    last = "\n";
  };
  // Prints what streaming did not: the text not streamed yet, then cards not shown yet.
  const commit = async message => {
    const body = message.content.filter(block => block.type === "text").map(block => block.payload?.text ?? "").join("");
    const want = squeeze(body), left = streamed.slice(used);
    if (want && left.startsWith(want)) used += want.length;
    else {
      const rest = left && want.startsWith(left) ? after(body, left.length) : body;
      if (rest === body) endLine();
      write(/\s/.test(last) ? rest.trimStart() : rest);
      used = streamed.length;
    }
    if (used === streamed.length) endLine();
    for (const block of message.content) if (block.type !== "text") await showBlock(block);
  };

  try {
    let response = await open();
    for (let reconnects = 0; ; ) {
      try {
        if (response) for await (const event of frames(response.body)) {
          if (event.cursor) cursor = event.cursor;
          if (event.kind === "stream.caught_up" && !accepted) { accepted = await send(); continue; }
          if (!accepted) continue;
          if (event.kind === "assistant.text_delta") {
            if (live(event)) { streamed += squeeze(event.text_delta); write(event.text_delta); }
          } else if (event.kind === "assistant.block_ready") {
            if (live(event)) await showBlock(event.block);
          } else if (event.kind === "message.created") {
            let message = event.delivery.message;
            const seq = message?.message_seq ?? event.delivery.message_seq;
            if (seq <= accepted.message_seq) continue;
            message ??= await request(config, "GET /v1/agents/{agent_id}/conversations/{conversation_id}/messages/{message_id}",
              {params: {conversation_id: config.conversation_id, message_id: event.delivery.message_id}, headers: CHAT});
            if (message.role !== "assistant" || seen.has(message.message_id)) continue;
            seen.add(message.message_id);
            replied = true;
            await commit(message);
          } else if (event.kind === "interaction.updated" && pending.has(event.interaction_id)) {
            if ((await getCard(config, event.interaction_id)).state !== "pending") pending.delete(event.interaction_id);
          } else if (event.kind === "run.status_changed" && USER_RUNS.has(event.trigger ?? "user_message") && event.run_id !== earlier) {
            run ??= event.run_id;
            if (event.run_id === run && TERMINAL.has(event.state)) {
              endLine();
              if (event.state !== "completed") { process.stderr.write(`rokku: the reply ${event.state}\n`); process.exitCode = EXIT.error; return accepted; }
              // A card was shown: the answer starts a new run (user_action) that carries the reply on.
              if (cards.count) {
                cards.count = 0; run = null;
                if (pending.size) process.stderr.write("(Waiting for the card to be answered…)\n");
                continue;
              }
              if (!replied) process.stderr.write("(Rokku chose not to reply)\n");
              return accepted;
            }
          }
        }
        if (!accepted) break;
      } catch (error) {
        if (error.name === "AbortError" || !accepted || !dropped(error)) throw error;
      }
      if (++reconnects > RECONNECTS) break;
      process.stderr.write("(The connection to Rokku dropped; reconnecting…)\n");
      await sleep(Math.min(16, 2 ** reconnects) * 1000);
      try { response = await open(); }
      catch (error) { if (error.name === "AbortError" || !dropped(error)) throw error; response = null; }
    }
    fail("The conversation stream closed before Rokku finished; read the rest with: rokku chat", EXIT.unavailable);
  } catch (error) {
    if (error.name === "AbortError") {
      process.stderr.write(pending.size ? `rokku: the card is still waiting for an answer after ${timeout}s; the reply will follow in the app (rokku chat shows it)\n`
        : `rokku: no end of the reply within ${timeout}s; it keeps going in the app (rokku chat shows it)\n`);
      process.exitCode = EXIT.notYet;
      return accepted;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

const words = async (positional, flags) => {
  const text = flags.file ? readFileSync(flags.file === "-" ? 0 : flags.file, "utf8") : positional.join(" ") || await readStdin();
  if (!text.trim()) usage("Usage: rokku ask \"text\" | --file prompt.md | stdin   [--no-wait] [--timeout 600]");
  return text;
};

export const commands = {
  ask: {
    usage: "rokku ask \"text\" | --file f | stdin [--no-wait] [--timeout S]   message your Rokku agent as you and stream its reply",
    async run(config, positional, flags) {
      const text = await words(positional, flags);
      const accepted = await ask(config, text, {wait: !flags["no-wait"], timeout: seconds(flags, "timeout", 600, 5)});
      if (flags["no-wait"]) process.stdout.write(`Sent (message ${accepted.message_id}). Read the reply with: rokku chat\n`);
    },
  },
};
