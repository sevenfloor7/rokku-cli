// rokku ask subscribes, waits for replay to finish, sends, streams the reply and ends with its run.
import assert from "node:assert/strict";
import {AGENT, CONVERSATION, fakeApi} from "./fake-api.mjs";

let sent, resolveSent;
const sentPromise = new Promise(done => { resolveSent = done; });
const common = {agent_id: AGENT, conversation_id: CONVERSATION};
let scenario = "reply", phoneAnswered = false, opened = 0;
const api = await fakeApi({
  "GET /v1/user/info": () => ({email: "x@example.com", agents: [{agent_id: AGENT, main_conversation_id: CONVERSATION, initial_stream_cursor: "c-10",
    foreground_run: scenario === "busy" ? {run_id: "r0", state: "running", trigger: "user_message"} : null}]}),
  "POST /v1/agents/{agent_id}/conversations/{conversation_id}/messages": r => { sent = r; resolveSent(); return {...common, message_id: "u1", message_seq: 41, status: "accepted"}; },
  "GET /v1/agents/{agent_id}/conversations/{conversation_id}/messages/{message_id}": r => ({message_id: r.params.message_id, message_seq: 44, role: "assistant",
    content: [{id: "c", type: "interaction_ref", payload: {interaction_id: "i-7"}, fallback_text: "Allow Notion to edit pages?"}]}),
  "GET /v1/agents/{agent_id}/conversations/{conversation_id}/interactions/{interaction_id}": r => r.params.interaction_id === "i-phone"
    ? {interaction_id: "i-phone", kind: "permission_request", state: phoneAnswered ? "resolved" : "pending", version: 1}
    : {interaction_id: r.params.interaction_id, kind: "choice_request", state: "pending", version: 1, request: {question: "?", options: []}},
  "GET /v1/agents/{agent_id}/conversations/{conversation_id}/stream": r => ({stream: async (frame, end) => {
    if (scenario === "drop" && opened++) {
      // the reopened stream resumes after the last durable event; the phone answer and the reply follow
      assert.equal(r.query.after_cursor, "c-52", "a reconnect resumes after the last event it saw");
      frame({kind: "run.status_changed", run_id: "r6", state: "running", trigger: "user_action", cursor: "c-53"});
      frame({kind: "message.created", ...common, cursor: "c-54", delivery: {message: {message_id: "q2", message_seq: 51, role: "assistant", content: [{type: "text", payload: {text: "Added."}}]}}});
      frame({kind: "run.status_changed", run_id: "r6", state: "completed", trigger: "user_action", cursor: "c-55"});
      return end();
    }
    assert.equal(r.query.after_cursor, "c-10", "subscribes from the position user/info gave");
    // replay of an older reply must not print
    frame({kind: "message.created", ...common, delivery: {message: {message_id: "old", message_seq: 40, role: "assistant", content: [{type: "text", payload: {text: "OLD"}}]}}});
    frame({kind: "stream.caught_up"});
    await sentPromise;
    if (scenario === "phone") {
      frame({kind: "run.status_changed", run_id: "r7", state: "running", trigger: "user_message"});
      frame({kind: "message.created", ...common, delivery: {message: {message_id: "p1", message_seq: 48, role: "assistant",
        content: [{type: "text", payload: {text: "I'll add it."}}, {id: "c", type: "interaction_ref", payload: {interaction_id: "i-phone"}, fallback_text: "Allow Calendar access"}]}}});
      frame({kind: "run.status_changed", run_id: "r7", state: "completed", trigger: "user_message"});
      await new Promise(done => setTimeout(done, 300));
      phoneAnswered = true;
      frame({kind: "interaction.updated", ...common, interaction_id: "i-phone", version: 2});
      frame({kind: "run.status_changed", run_id: "r8", state: "running", trigger: "user_action"});
      frame({kind: "message.created", ...common, delivery: {message: {message_id: "p2", message_seq: 49, role: "assistant", content: [{type: "text", payload: {text: "Added to your calendar."}}]}}});
      frame({kind: "run.status_changed", run_id: "r8", state: "completed", trigger: "user_action"});
      return;
    }
    if (scenario === "busy") {
      // the run for an earlier message ends first; ours (with a null trigger) ends after replying
      frame({kind: "run.status_changed", run_id: "r0", state: "completed", trigger: "user_message"});
      frame({kind: "run.status_changed", run_id: "r3", state: "running", trigger: null});
      frame({kind: "message.created", ...common, delivery: {message: {message_id: "d1", message_seq: 46, role: "assistant", content: [{type: "text", payload: {text: "Mine."}}]}}});
      frame({kind: "run.status_changed", run_id: "r3", state: "completed", trigger: null});
      return;
    }
    if (scenario === "restart") {
      frame({kind: "run.status_changed", run_id: "r2", state: "running", trigger: "user_message"});
      frame({kind: "assistant.text_delta", message_id: "b1", revision: 1, sequence: 1, block_id: "t", text_delta: "Two changes. "});
      frame({kind: "assistant.text_delta", message_id: "b1", revision: 2, sequence: 1, block_id: "t", text_delta: "Two changes. "});
      frame({kind: "assistant.text_delta", message_id: "b1", revision: 2, sequence: 2, block_id: "t", text_delta: "Both on Ping."});
      frame({kind: "message.created", ...common, delivery: {message: {message_id: "b1", message_seq: 45, role: "assistant", content: [{type: "text", payload: {text: "Two changes. Both on Ping."}}]}}});
      frame({kind: "run.status_changed", run_id: "r2", state: "completed", trigger: "user_message"});
      return;
    }
    if (scenario === "split") {
      // the Host splits the streamed reply into messages with new ids and different blank lines
      frame({kind: "run.status_changed", run_id: "r5", state: "running", trigger: "user_message"});
      for (const delta of ["Three creations.\n\n", "Everything was today:\n\n- A\n- B", "\n\nWant me to check?"])
        frame({kind: "assistant.text_delta", message_id: "s0", revision: 1, sequence: 1, block_id: "t", text_delta: delta});
      for (const [id, seq, text] of [["s1", 50, "Three creations."], ["s2", 51, "Everything was today:\n- A\n- B"], ["s3", 52, "Want me to check?"]])
        frame({kind: "message.created", ...common, delivery: {message: {message_id: id, message_seq: seq, role: "assistant", content: [{type: "text", payload: {text}}]}}});
      frame({kind: "run.status_changed", run_id: "r5", state: "completed", trigger: "user_message"});
      return;
    }
    if (scenario === "drop") {
      frame({kind: "run.status_changed", run_id: "r7", state: "running", trigger: "user_message", cursor: "c-50"});
      frame({kind: "message.created", ...common, cursor: "c-51", delivery: {message: {message_id: "q1", message_seq: 50, role: "assistant",
        content: [{id: "c", type: "interaction_ref", payload: {interaction_id: "i-phone"}, fallback_text: "Allow Calendar access"}]}}});
      frame({kind: "run.status_changed", run_id: "r7", state: "completed", trigger: "user_message", cursor: "c-52"});
      // the connection drops while the card waits for its answer
      return end();
    }
    if (scenario === "silent") {
      frame({kind: "run.status_changed", run_id: "r9", state: "running", trigger: "user_message"});
      frame({kind: "run.status_changed", run_id: "r9", state: "completed", trigger: "user_message"});
      return;
    }
    frame({kind: "run.status_changed", run_id: "bg", state: "running", trigger: "automation"});
    frame({kind: "run.status_changed", run_id: "r1", state: "running", trigger: "user_message"});
    frame({kind: "assistant.block_started", message_id: "a1", revision: 1, sequence: 1, block_id: "t", block_index: 0});
    frame({kind: "assistant.text_delta", message_id: "a1", revision: 1, sequence: 2, block_id: "t", text_delta: "Hello "});
    frame({kind: "assistant.text_delta", message_id: "a1", revision: 1, sequence: 3, block_id: "t", text_delta: "there."});
    frame({kind: "assistant.stream_ended", message_id: "a1", revision: 1, sequence: 4, reason: "committed"});
    frame({kind: "message.created", ...common, delivery: {message: {message_id: "a1", message_seq: 42, role: "assistant", content: [{type: "text", payload: {text: "Hello there."}}]}}});
    frame({kind: "message.created", ...common, delivery: {message: {message_id: "a2", message_seq: 43, role: "assistant",
      content: [{type: "text", payload: {text: "Made it."}}, {type: "artifact_ref", fallback_text: "Creation: Budget"}]}}});
    frame({kind: "message.created", ...common, delivery: {message_id: "a3", message_seq: 44}});
    frame({kind: "run.status_changed", run_id: "bg", state: "completed", trigger: "automation"});
    frame({kind: "run.status_changed", run_id: "r1", state: "completed", trigger: "user_message"});
    // the card was shown, so the reply goes on in the run its answer starts
    frame({kind: "run.status_changed", run_id: "r4", state: "running", trigger: "user_action"});
    frame({kind: "message.created", ...common, delivery: {message: {message_id: "a4", message_seq: 47, role: "assistant", content: [{type: "text", payload: {text: "Thanks, done."}}]}}});
    frame({kind: "run.status_changed", run_id: "r4", state: "completed", trigger: "user_action"});
    end();
  }}),
});

const result = await api.run(["ask", "--", "make", "--me", "a budget"]);
assert.equal(result.code, 0, result.stderr);
assert.equal(sent.body.content[0].payload.text, "make --me a budget");
assert.equal(sent.headers["x-rokku-chat-protocol"], "7");
assert.ok(!result.stdout.includes("OLD"), "replayed messages are not printed");
assert.equal(result.stdout.match(/Hello there\./g).length, 1, "streamed text is printed once");
assert.match(result.stdout, /Made it\.\n\[Creation: Budget\]/);
assert.match(result.stdout, /Thanks, done\.$/, "the reply after a card is waited for");
assert.match(result.stdout, /\[Allow Notion to edit pages\?: the user answers with `rokku answer i-7` in a terminal/, "a reference delivery is fetched; cards say how to answer");
const refused = await api.run(["answer", "i-7"]);
assert.equal(refused.code, 64); assert.match(refused.stderr, /answered by you, in a terminal/);

scenario = "restart";
const restarted = await api.run(["ask", "what changed?"]);
assert.equal(restarted.stdout, "Two changes. Both on Ping.", "a restarted revision is not printed twice");

scenario = "split";
const split = await api.run(["ask", "which creations?"]);
assert.equal(split.code, 0, split.stderr);
assert.equal(split.stdout, "Three creations.\n\nEverything was today:\n\n- A\n- B\n\nWant me to check?", "a reply split into messages after streaming prints once");

scenario = "drop"; phoneAnswered = false;
const drop = await api.run(["ask", "add lunch"]);
assert.equal(drop.code, 0, drop.stderr);
assert.match(drop.stderr, /reconnecting/);
assert.match(drop.stdout, /Added\.$/, "the reply after the card arrives over the reopened stream");

scenario = "phone";
const phone = await api.run(["ask", "add lunch to my calendar"]);
assert.equal(phone.code, 0, phone.stderr);
assert.match(phone.stdout, /\[Allow Calendar access: finish this on your phone, in the Rokku app\]/);
assert.ok(!phone.stdout.includes("rokku answer"), "a phone-only card is not offered to the terminal");
assert.match(phone.stdout, /Added to your calendar\.$/, "ask waits for the reply after the phone answer");
assert.match(phone.stderr, /Waiting for the card/);

scenario = "busy";
const busy = await api.run(["ask", "and this?"]);
assert.equal(busy.code, 0); assert.equal(busy.stdout, "Mine.", "an earlier run ending does not end this ask");

scenario = "silent";
const quiet = await api.run(["ask", "hi"]);
assert.equal(quiet.code, 0); assert.match(quiet.stderr, /chose not to reply/);
const noWait = await api.run(["ask", "--no-wait", "hi"]);
assert.match(noWait.stdout, /Sent \(message u1\)/);
assert.equal((await api.run(["ask"], "")).code, 64);

api.close();
console.log("ok — rokku ask streams the reply to its own message and ends with its run");
