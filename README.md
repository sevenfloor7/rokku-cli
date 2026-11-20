# rokku CLI

Lets Claude Code / Codex on your laptop read and write your Rokku creations and talk to your Rokku agent, so the same account works from the laptop and the phone. Zero dependencies, Node 20.11+.

## Install and log in

From GitHub (not on npm yet):

```bash
git clone https://github.com/sevenfloor7/rokku-cli && npm install -g ./rokku-cli   # update: git -C rokku-cli pull && npm install -g ./rokku-cli
rokku login                   # your Rokku email + code; this laptop becomes its own device
ln -s "$PWD/rokku-cli/skills/rokku" ~/.claude/skills/rokku   # the Claude Code skill
```

For Codex, append `agents/AGENTS.md` to your `~/.codex/AGENTS.md` (or a project's `AGENTS.md`).

Either agent can also use the CLI as MCP tools: `claude mcp add rokku -- rokku mcp`, or `codex mcp add rokku -- rokku mcp`. For Codex, two settings matter: if the server's `env` sets `PATH`, it must include the folder `node` is in (otherwise the tools silently don't appear), and `codex exec` needs `default_tools_approval_mode = "approve"` on the server, since its default approval of `never` blocks every tool call. Under MCP, commands that need a secret value refuse and ask the user to run them in a terminal. A tool call can pass `yes` to skip the confirmation of a delete or removal, since the agent asks the user before calling the tool; in a terminal those still ask first.

The default API is test (`https://test-api.rokku.ai`). For production: `rokku login --api https://api.rokku.ai`.

## Layout

- `bin/rokku.mjs`, `skills/rokku/`: the CLI and its skill.

## Commands

```
rokku login | logout | whoami | creations [--raw]
rokku ask "text" | --file prompt.md [--no-wait] [--timeout 600]   message your Rokku agent as you; streams its reply
rokku chat [--last 6] [--full]        read your Rokku agent's latest replies
rokku data list   <creation> <collection> [--where f=v ...] [--raw]
rokku data get    <creation> <collection> <id>
rokku data put    <creation> <collection> [<id>] (--json '{...}' | --file f | --file - <<'EOF') [--stamp field] [--if-absent]
rokku data patch  <creation> <collection> <id> (--json | --file | stdin) [--stamp field]
rokku data delete <creation> <collection> <id>
rokku data import <creation> <collection> --file rows.jsonl [--if-absent]   bulk, one process
rokku data wait   <creation> <collection> <id> --until f=v [--timeout 240]    exit 0 = matched, 2 = not yet
rokku data watch  <creation> <collection> [--where f=v] [--include-existing] [--once] [--timeout S]
rokku call <creation> <METHOD> </path> [--json '{...}']
rokku pull <creation> <dir> [--version N] [--force]   into an empty dir; --force refreshes a pulled dir in place
rokku check <creation> <dir> --note "…"  /  rokku push <creation> <dir> --note "…" [--base N]   push builds on the pulled version
rokku secret list|set|delete
rokku versions <creation> [--raw]
rokku restore-version <creation> <version>  /  rokku trash <creation>  /  rokku untrash <creation>  /  rokku creations --trashed
rokku link <creation> [--on [--version N] | --off]   public link
rokku usage <creation> [--month YYYY-MM]
rokku home [list | add <creation> [--size s|m|l] | size <creation> s|m|l | move <creation> --top|--bottom|--slot N | version <creation> N | remove <creation>]
rokku theme [show | list | save <name> | apply <theme> | undo | reset | delete <theme>]
rokku automation [list | show <a> | create (--file def.json | stdin) | edit <a> --file patch.json | on <a> | off <a> | delete <a> | fires <a>]
rokku task [list [--state running,waiting] | show <id> [--content] | message <id> "text" | cancel <id> | retry <id>]
rokku connector [list | catalog | connect <connector> | connect --mcp-url URL --unreviewed [--bearer] | remove <c> | allow <c> view=… manage=…]
rokku model [show | use <model> (--key <k> | --provider P | --base-url URL) | default]   the model Rokku runs on (BYOK or Rokku's default)
rokku key [list | providers | add (--provider P | --base-url URL) [--label L] | label <k> <label> | rotate <k> | remove <k> | models <k>]
rokku memory [--grep text] | files [dir] | read <path>     read-only
rokku export [--out file]                                  everything in your account
rokku api [GET] </v1/...>                               raw Rokku API read; other methods need --write
```

Changes that cannot be undone (removing from Home, deleting a theme, an automation, a connection or a Key) ask first; `--yes` answers for scripts. Keys, tokens and connector credentials are read only from a hidden prompt or stdin, never from arguments.

Exit codes: 0 ok, 1 error, 2 not yet (`data wait` / `watch --once`), 3 not logged in, 4 conflict (someone changed it first), 5 Rokku unreachable or busy (retry later), 6 publication checks failed, 64 bad arguments.

`<creation>` is an id or a title. Reads accept part of a title; writes need the exact title, so a renamed creation never receives data meant for another. `data` works on any Rokku app creation with DATA collections: the platform gives every one of them the same `/api/records/<collection>` routes.

## How it works

- **Login** uses Rokku's normal email-code login under its own device id, so it doesn't sign your phone out. It shows up in the app's device list as "Rokku CLI on <host>", where you can revoke it; `rokku logout` revokes it too. On macOS the tokens live in the login keychain (item "rokku-cli"); elsewhere, or with `ROKKU_TOKEN_STORE=file`, in `~/.config/rokku/config.json` (mode 0600). Other settings are always in that file.
- **Creation access** uses the accepted ADR-0067 path: the first request to a creation's address carries your account token, and the Gateway swaps it for a per-creation session cookie and CSRF token. Every later read and write goes through the creation's own backend, with the same owner checks, budget and revision checks the app gets.
- **Writes** use the platform's revision check: `put` creates or replaces; `patch` merges fields and retries if your phone edited the record at the same moment.

## Limits of this login

The CLI holds the same full-account session as the App. Keep it on your own laptop, and revoke it from the App's device list or with `rokku logout`. A scoped token comes before a wide public release.

## Test

```bash
npm test   # fake Rokku API + fake Gateway running the platform recordsWorker (copy in test/fixtures):
           # login, refresh, session renewal, CAS retry, parallel writers, wait/watch, pull/push/check
```

## Routes

The CLI sends requests only to routes listed in `lib/routes.generated.mjs`, generated from rokku-backend's `openapi/public.json`. `npm test` fails if the code names a route that is not there. After the backend's API changes:

```bash
git -C ../rokku-backend fetch origin test && git -C ../rokku-backend show origin/test:openapi/public.json > /tmp/public.json
npm run gen:routes -- /tmp/public.json && npm test
```

