// rokku mcp: the CLI as a Model Context Protocol server on stdio (JSON-RPC, one message per line).
// Each tool runs one rokku command in a child process, so tools and the CLI never drift apart.
// Under MCP, commands that need a secret value refuse (the value would come from the model), and
// login stays in the user's terminal.
import {spawn} from "node:child_process";
import {readFileSync} from "node:fs";
import {createInterface} from "node:readline";
import {fileURLToPath} from "node:url";

const CLI = fileURLToPath(new URL("../bin/rokku.mjs", import.meta.url));
const {version: VERSION} = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// Model-visible tool descriptions. Each tool takes the command's arguments as a list of strings.
const TOOLS = {
  whoami: "Check that the user is logged in to Rokku. Args: none.",
  creations: "List the user's Rokku creations (apps shown on their phone). Args: [--trashed] [--raw].",
  versions: "List a creation's saved versions. Args: <creation> [--raw].",
  pull: "Download a version's source into an empty directory. Args: <creation> <dir> [--version N] [--force].",
  check: "Run the publication checks on local source without publishing. Args: <creation> <dir> --note <what changed>, or --new <dir> [--title T] before create.",
  push: "Publish local source as the creation's next version. Args: <creation> <dir> --note <what changed, one or two sentences> [--base N].",
  create: "Publish local source as a new creation. Args: <dir> --title T --note <what it is> [--description D --icon icon.png].",
  "restore-version": "Publish an old version's source as the newest version. Args: <creation> <version>.",
  trash: "Move a creation to the trash (recoverable). Args: <creation>.",
  untrash: "Restore a creation from the trash. Args: <creation>.",
  link: "Show, create or turn off a creation's public link. Args: <creation> [--on | --off]. The link opens the version that is running.",
  usage: "A creation's usage this month. Args: <creation> [--month YYYY-MM].",
  data: "Read and write a creation's data records. Args: list|get|put|patch|delete|import|wait|watch <creation> <collection> [<id>] [...]; record JSON goes in stdin with --file -.",
  call: "Send a request to a creation's own backend. Args: <creation> <METHOD> </path> [--json '{...}'].",
  home: "The phone's Home. Args: [list | add <creation> [--size s|m|l] | size <creation> s|m|l | move <creation> --top|--bottom|--slot N | version <creation> N | remove <creation>].",
  theme: "Themes. Args: [show | list | save <name> | apply <saved theme, or dot for the default> | undo | reset | delete <theme>]. Colours are never edited one by one; ask Rokku for a new theme.",
  automation: "Scheduled and event-driven jobs. Args: [list | show <a> | create (definition JSON in stdin: {name, trigger: {kind: at|cron|interval, …}, action: {kind: emit_timer_event|start_task, …}}; start_task needs schema_version 2) | edit <a> (patch JSON in stdin) | on <a> | off <a> | delete <a> | fires <a>].",
  task: "Tasks the Rokku agent runs. Args: [list [--state S] | show <id> | message <id> <text> | cancel <id> | retry <id>].",
  connector: "Third-party and MCP connectors. Args: [list | catalog | connect <connector> (opens the user's browser) | remove <c> | events [<creation>] | stop-event <grant id>]. events lists which creations get which connector events. What Rokku may do without asking, and unreviewed servers, are set by the user in their own terminal.",
  model: "The model Rokku runs on. Args: [show | use <model> --key <k> | default | mode [fast|balanced|advanced] | usage]. use needs a Key the user already added (rokku key list); a new Key is added by the user in their terminal. mode is the tier of Rokku's own models, cheapest first. usage is the provider's balance and spend for the Key in use.",
  key: "The user's own model Keys. Args: [list | providers | label <k> <label> | remove <k> | models <k>]. Adding or rotating a Key is done by the user in their terminal.",
  memory: "What the Rokku agent remembers, read-only. Args: [--grep text] | files [dir] | read <path> | stats.",
  ask: "Send a message to the user's Rokku agent as the user and return its reply. Use it for anything Rokku can do that has no tool here, including what runs on the user's phone; some actions need the user to confirm on their phone, and this waits for that. Args: <text> [--timeout S], or the text in stdin. If the reply holds a card, don't answer it: tell the user what it asks and where to answer (their phone, or the rokku answer command it names, in their terminal).",
  chat: "Read or search the Rokku chat. Args: [--last N] [--full] [--ids] | search <text> [--before N]. Deleting messages is done by the user in their terminal (rokku chat delete <message id>...).",
  billing: "The user's Rokku plan, credits left and what used them this period. Read-only. Args: none.",
  secret: "Keys a creation may use, by name; values are never shown. Args: list | delete NAME. Setting one is done by the user in their terminal.",
};

const schema = {type: "object", properties: {
  args: {type: "array", items: {type: "string"}, description: "Arguments after the command, as in the description."},
  yes: {type: "boolean", description: "Skip the confirmation of a change that cannot be undone (a delete or removal). Set it only when the user asked for that exact change."},
  stdin: {type: "string", description: "Text for the command's standard input, such as JSON for data or automation."},
}, additionalProperties: false};

function runCommand(command, args = [], stdin = "") {
  return new Promise(done => {
    const child = spawn(process.execPath, [CLI, command, ...args], {env: {...process.env, ROKKU_MCP: "1"}});
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", code => done({code, stdout, stderr}));
    child.stdin.end(stdin);
  });
}

async function handle(message) {
  const {method, params} = message;
  if (method === "initialize") return {protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: {tools: {}},
    serverInfo: {name: "rokku", version: VERSION}};
  if (method === "ping") return {};
  if (method === "tools/list") return {tools: Object.entries(TOOLS).map(([name, description]) => ({name: `rokku_${name.replace(/-/g, "_")}`, description, inputSchema: schema}))};
  if (method === "tools/call") {
    const command = Object.keys(TOOLS).find(name => `rokku_${name.replace(/-/g, "_")}` === params?.name);
    if (!command) throw Object.assign(new Error(`Unknown tool ${params?.name}`), {code: -32602});
    const {args = [], stdin = "", yes = false} = params.arguments ?? {};
    if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) throw Object.assign(new Error("args must be a list of strings"), {code: -32602});
    const result = await runCommand(command, yes === true ? [...args, "--yes"] : args, typeof stdin === "string" ? stdin : "");
    const text = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n") || "(no output)";
    return {content: [{type: "text", text: result.code ? `${text}\n(exit ${result.code})` : text}], isError: result.code !== 0};
  }
  throw Object.assign(new Error(`Method not found: ${method}`), {code: -32601});
}

export function serve() {
  const write = value => process.stdout.write(JSON.stringify(value) + "\n");
  const lines = createInterface({input: process.stdin});
  lines.on("line", async line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return write({jsonrpc: "2.0", id: null, error: {code: -32700, message: "Parse error"}}); }
    if (message.id === undefined) return; // notifications (initialized, cancelled) need no answer
    try { write({jsonrpc: "2.0", id: message.id, result: await handle(message)}); }
    catch (error) { write({jsonrpc: "2.0", id: message.id, error: {code: error.code ?? -32603, message: error.message}}); }
  });
  return new Promise(done => lines.on("close", done));
}
