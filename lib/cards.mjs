// Cards the Rokku agent sends (choices, confirmations, connector approvals), answered in the terminal.
// A CLI login (client_kind "cli") reports the card protocols below. A run the CLI starts uses them only
// when the account has no App session; otherwise it borrows the latest App session's protocols, so
// other cards can come too, and those not answerable here are sent to the phone (answerableHere). Cards are answered only at an interactive terminal: a coding
// agent or MCP client that runs rokku sees the card and is told to hand it over (see personAtTerminal:
// this prevents mistakes, it is not a security boundary).
import {fail, usage, request, prompt, print, updateConfig, openBrowser, personAtTerminal} from "./core.mjs";
import {connect, finishOAuth} from "./commands/connectors.mjs";

// confirmation.generic.v1 covers trashing and restoring creations, restoring a version and deleting a theme.
export const PROTOCOLS = ["choice.v1", "confirmation.generic.v1", "connector.approval.v1", "connector.unreviewed_oauth.v1", "home.artifact_place.v1"];


// Reports the card protocols once per login and again when this list changes. client_revision is a
// per-session counter kept in the config; a conflict carries the server's revision to go past.
export async function reportCapabilities(config) {
  if (config.client_kind !== "cli" || config.reported_protocols === PROTOCOLS.join(",")) return;
  for (let attempt = 0, revision = (config.client_revision ?? 0) + 1; ; attempt++) {
    try {
      await request(config, "PUT /v1/auth/sessions/current/client-capabilities",
        {body: {schema_version: 2, client_revision: revision, interaction_protocols: PROTOCOLS, device_tool_methods: []}});
      await updateConfig(config, fresh => Object.assign(fresh, {client_revision: revision, reported_protocols: PROTOCOLS.join(",")}));
      return;
    } catch (error) {
      const current = Number(error.details?.current_version);
      if (attempt || !Number.isInteger(current)) throw error;
      revision = current + 1;
    }
  }
}

const route = "/v1/agents/{agent_id}/conversations/{conversation_id}/interactions/{interaction_id}";
const params = (config, id) => ({conversation_id: config.conversation_id, interaction_id: id});

async function choose(question, options, {multiple = false} = {}) {
  process.stderr.write(`${question}\n${options.map((option, i) => `  ${i + 1}. ${option.label}`).join("\n")}\n`);
  for (;;) {
    const answer = await prompt(multiple ? "Numbers, separated by commas: " : "Number: ");
    const picked = answer.split(",").map(part => Number(part.trim()) - 1);
    if (picked.length && (multiple || picked.length === 1) && picked.every(i => Number.isInteger(i) && options[i])) return picked.map(i => options[i]);
    process.stderr.write("Pick from the list.\n");
  }
}

async function respond(config, card, response) {
  await request(config, `POST ${route}/responses`, {params: params(config, card.interaction_id), body: {expected_version: card.version, response}});
}

export const getCard = (config, id) => request(config, `GET ${route}`, {params: params(config, id)});

// The cards a terminal can answer; everything else (device and phone permissions, native connector
// approvals) is done on the phone.
export const answerableHere = card => card.kind === "choice_request" || card.kind === "confirmation_request" ||
  (card.kind === "tool_approval_request" && Boolean(card.request?.connector_id));

// Shows one card and sends the person's answer. Returns a short line on what happened.
export async function answerCard(config, id) {
  if (!personAtTerminal()) usage(`Cards are answered by you, in a terminal: rokku answer ${id}`);
  const card = await getCard(config, id);
  if (card.state !== "pending") return `That card is already ${card.state}.`;
  if (!answerableHere(card)) fail("This card is done on your phone, in the Rokku app");
  process.stderr.write(`\n── ${card.title}${card.description ? `\n${card.description}` : ""}\n`);
  if (card.kind === "choice_request") {
    const picked = await choose(card.request.question, card.request.options, {multiple: card.request.mode === "multiple"});
    await respond(config, card, {kind: "choice_response", selected_option_ids: picked.map(option => option.option_id)});
    return `You chose: ${picked.map(option => option.label).join(", ")}`;
  }
  if (card.kind === "confirmation_request") {
    const action = card.request.action;
    const [decision] = await choose("Your answer:", [{label: "Yes", value: "confirm"}, {label: "No", value: "decline"}]);
    if (decision.value === "confirm" && action.kind === "connector_connect") await connectFor(config, card, action);
    await respond(config, card, {kind: "confirmation_response", decision: decision.value});
    return decision.value === "confirm" ? "Confirmed." : "Declined.";
  }
  const [action] = await choose("Your answer:", card.request.actions);
  await respond(config, card, {kind: "tool_approval_response", protocol_version: 2, decision: action.id});
  return `${action.label}.`;
}

// A "connect this service" card: the connection is made here first, then the card is confirmed.
async function connectFor(config, card, action) {
  if (action.entry === "open_oauth") {
    const started = await request(config, "POST /v1/agents/{agent_id}/third-party-connections/oauth", {body: action.custom_mcp_url
      ? {interaction_id: card.interaction_id, unreviewed_acknowledged: true, return_to: "web"}
      : {connector_id: action.connector_id, return_to: "web", ...(action.placement ? {placement: action.placement} : {})}});
    openBrowser(started.authorization_url);
    await finishOAuth(config, started.attempt_id);
    return;
  }
  // A key typed at a hidden prompt (the same path as rokku connector connect).
  await connect(config, action.connector_id ?? undefined, action.custom_mcp_url
    ? {"mcp-url": action.custom_mcp_url, name: action.target_label ?? new URL(action.custom_mcp_url).host, unreviewed: true,
      bearer: action.credential_kind === "static_bearer", placement: action.placement ?? undefined}
    : {"api-key": true, placement: action.placement ?? undefined});
}

export const commands = {
  answer: {
    usage: "rokku answer <card id>                         answer a card from your Rokku agent (choice, confirmation, connector approval)",
    async run(config, [id]) {
      if (!id) usage("Usage: rokku answer <card id>   (rokku ask shows the id of each card)");
      print(await answerCard(config, id));
    },
  },
};
