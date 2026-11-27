# Rokku CLI

[中文说明](README.zh-CN.md)

Use your [Rokku](https://www.rokku.ai) account from the terminal, Claude Code, and Codex.

Rokku is a personal AI assistant on your iPhone. With this CLI, a coding agent on your laptop can build and update your Rokku creations (the small apps on your Rokku Home screen), manage Home, themes, automations, connectors and model keys, and hand anything else to your Rokku agent. Everything it does lands in the same account, so you see the result on your phone right away.

- Zero dependencies. Needs Node.js 20.11 or newer.
- Works as a plain CLI, as a Claude Code skill, as Codex instructions, or as an MCP server.
- MIT licensed.

## What you can do

| Area | Examples |
| --- | --- |
| Creations | Create, pull, check and push new versions; see version history; restore an old version; trash and restore; public links; usage |
| Creation data | Read and write a creation's stored data; wait for or watch changes |
| Home | Add, remove, reorder and resize cards on your Home screen |
| Themes | Show, save, apply, switch and undo themes |
| Automations and tasks | Create, edit, pause and delete scheduled automations; list, read, message and cancel tasks |
| Connectors and keys | Connect services (OAuth finishes in your browser), remove connections, see and stop the connector events a creation gets, add your own model keys, switch the model Rokku runs on or its mode, see your key's balance |
| Chat, memory and account | Read, search and delete chat messages; read what Rokku remembers (read-only); see your plan and credits; export your account |
| Your Rokku agent | `rokku ask` sends a message and streams the reply. Use it for anything without a direct command, including things that run on your phone (calendar, reminders, photos and so on); when your phone needs to confirm, the card shows up there |

When you change a creation from your laptop, your Rokku agent can see it: each version keeps a short note about what changed, and Home changes are recorded too. On your phone you can ask "what did I just change on my computer?"

## Install

```bash
git clone https://github.com/sevenfloor7/rokku-cli
npm install -g ./rokku-cli
```

To update later:

```bash
git -C rokku-cli pull && npm install -g ./rokku-cli
```

To uninstall: `npm uninstall -g rokku-cli`.

## Log in

```bash
rokku login
```

Enter your Rokku email and the code you receive. The laptop signs in as its own device, so your phone stays signed in. It appears in the Rokku app's device list as "Rokku CLI on \<your computer>", and you can revoke it there or with `rokku logout`.

Check it worked:

```bash
rokku whoami
```

## Connect your coding agent

### Claude Code

Install the skill (run this from the folder where you cloned the repo):

```bash
mkdir -p ~/.claude/skills && ln -s "$PWD/rokku-cli/skills/rokku" ~/.claude/skills/rokku
```

Or use the CLI as MCP tools:

```bash
claude mcp add rokku -- rokku mcp
```

### Codex

Append `agents/AGENTS.md` to `~/.codex/AGENTS.md` (or to a project's `AGENTS.md`), or add the MCP server:

```bash
codex mcp add rokku -- rokku mcp
```

Two Codex settings matter:

- If the server's `env` sets `PATH`, it must include the folder `node` is in. Otherwise the tools silently don't appear.
- `codex exec` needs `default_tools_approval_mode = "approve"` on the server. The default, `never`, blocks every tool call.

### Other MCP clients

Run `rokku mcp` as a stdio server.

## Quick examples

```bash
rokku creations                                   # list your creations
rokku pull "Reading List" ./reading-list          # download its source
#   ...edit the files, or let your coding agent edit them...
rokku push "Reading List" ./reading-list --note "Group books by month"
rokku home add "Reading List" --size m            # put it on Home
rokku ask "Make my theme warmer for the evening"  # hand something to your Rokku agent
```

Run `rokku help` for every command and flag.

## Commands

```
rokku login | logout | whoami | mcp
rokku ask "text" | --file f [--no-wait] [--timeout S]    message your Rokku agent as you; streams its reply
rokku answer <card id>                                   answer a card from your Rokku agent, in a terminal
rokku chat [--last 6] [--full] [--ids]                   read your Rokku agent's latest replies
rokku chat search <text> | delete <message id>...        search your chat; delete messages (asks first)

rokku creations [--trashed] [--raw]
rokku create <dir> --note "…" [--title T]                publish local source as a new creation
rokku pull <creation> <dir> [--version N] [--force]
rokku check <creation> <dir> | --new <dir>               run the publication checks, publish nothing
rokku push <creation> <dir> --note "…" [--base N]        publish the next version
rokku versions <creation>  |  restore-version <creation> <version>
rokku trash <creation>  |  untrash <creation>
rokku link <creation> [--on | --off]                     public link
rokku usage <creation> [--month YYYY-MM]
rokku secret list | set NAME --host HOST | delete NAME   keys a creation's backend may use

rokku data list|get|put|patch|delete|import|wait|watch <creation> <collection> …
rokku call <creation> <METHOD> <path> [--json '{…}']     raw request to the creation's backend

rokku home [list | add | size | move | version | remove]
rokku theme [show | list | save | apply | undo | reset | delete]
rokku automation [list | show | create | edit | on | off | delete | fires]
rokku task [list | show | message | cancel | retry]
rokku connector [list | catalog | connect | remove | allow | events | stop-event]
rokku key [list | providers | add | label | rotate | remove | models]
rokku model [show | use | default | mode | usage]        the model Rokku runs on
rokku memory [--grep text] | files [dir] | read <path> | stats   read-only
rokku export [--out file]                                your chats and memory
rokku billing                                            your plan and credits (read-only)
rokku api [GET] </v1/...>                                raw API read; other methods need --write
```

`<creation>` is an id or a title. Reads accept part of a title; writes need the exact title, so a renamed creation never gets changes meant for another.

## What stays with you

Some steps need you, not your coding agent, by design:

- **Logging in.** The agent asks you to run `rokku login`.
- **Answering cards.** When Rokku asks for a choice, a confirmation or a permission, you answer on your phone or with `rokku answer <id>` in your own terminal. The agent only tells you what is being asked.
- **Secrets.** Keys, tokens and connector credentials are read only from a hidden prompt or stdin, never from command arguments. Under MCP, commands that need one refuse and ask you to run them yourself.
- **Changes that can't be undone.** Deleting a theme, an automation, a connection or a key asks first. `--yes` answers for scripts; an MCP tool call can pass `yes` because the agent asks you before calling the tool.

The CLI uses the same full-account session as the Rokku app, so keep it on your own computer. A login with narrower permissions is planned.

On macOS, login tokens live in the login keychain (item "rokku-cli"). Elsewhere, or with `ROKKU_TOKEN_STORE=file`, they live in `~/.config/rokku/config.json` with file mode 0600.

## Costs

The CLI itself and your coding agent's own usage don't count toward Rokku. Work that Rokku does for you counts toward your Rokku usage, the same as in the app: replies to `rokku ask` and the tasks it starts, plus deploying and running your creations.

## Troubleshooting

- **`rokku: command not found`.** npm's global bin folder isn't on your `PATH`. Run `npm prefix -g` and add its `bin` folder to `PATH`.
- **Behind a proxy.** The CLI follows `HTTPS_PROXY` / `HTTP_PROXY` on Node 22.21+ and 24+. On older Node it can't, and says so when Rokku is unreachable.
- **Push says the creation changed.** Someone (or your Rokku agent) published a newer version. Run `rokku pull` again and redo your change on top.

Exit codes for scripts: 0 ok, 1 error, 2 not yet (`data wait` / `data watch --once`), 3 not logged in, 4 conflict (someone changed it first), 5 Rokku unreachable or busy (retry later), 6 publication checks failed, 64 bad arguments.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
