---
name: rokku
description: Work with the user's Rokku account (their personal-agent phone app) through the `rokku` CLI: creations (apps on their phone) and their source and data, Home, themes, automations, tasks, connectors, model Keys, memory (read-only), and messages to their Rokku agent. Use when a task involves any of these, or when another skill says to use rokku.
---

# rokku CLI

Rokku is the user's personal-agent app. Everything you do here happens in their account and shows up on their phone. Run `rokku help` for every command and flag.

## Before anything

Run `rokku whoami`. If it fails, ask the user to run `rokku login` themselves.

## Two ways to get things done

- **Direct commands** for what has a command: creations (`create`, `pull`, `check`, `push`, `versions`, `restore-version`, `trash`, `untrash`, `link`, `usage`), `data`, `call`, `home`, `theme`, `automation`, `task`, `connector`, `key`, `model`, `memory`, `export`, `chat`, `billing`.
- **`rokku ask "…"`** for anything Rokku can do that has no command here, including what runs on the user's phone. It sends the message as the user and prints the agent's reply. Some actions need the user to confirm on their phone; `rokku ask` waits for that. Say in the message that it comes from a coding agent on the user's laptop, and send only what the user asked to hand over.

## Rules

- Secrets: never ask the user for a key, token or password, and never put one in a command, file, record or message. Commands that need one (`secret set`, `key add`, `key rotate`, connecting with a key) prompt the user; ask the user to run them in their own terminal.
- Changes that cannot be undone ask first. Pass `--yes` only when the user has asked for that exact change.
- Cards: when `rokku ask` prints a card from the Rokku agent, don't answer it for the user. Tell them what it asks and where to answer: on their phone, or with the `rokku answer <id>` it names in their own terminal.
- Memory is read-only. To have Rokku remember or forget something, use `rokku ask`.
- Themes are applied, saved, switched or undone here; to change colors, fonts or decoration, ask Rokku (rokku ask).
- Pass JSON on stdin with a quoted heredoc (`--file - <<'EOF'`), not inside a quoted shell string.
- Exit codes: 2 not yet, 3 not logged in, 4 someone changed it first (read again, then redo), 5 Rokku unreachable or busy (retry later), 6 publication checks failed, 64 bad arguments.

## Creations

- **Change one:** `rokku pull <creation> <new dir>`, edit, `rokku check <creation> <dir> --note "…"`, `rokku push <creation> <dir> --note "…"`. The note says in one or two sentences what changed and why; the Rokku agent reads it before it next edits the creation. Push builds on the version the directory was pulled at and is refused if the creation moved on; then pull the latest into a new directory and redo the change on top. A directory that was not pulled needs `--base N`. Never edit `.rokku-pulled.json`.
- **Make one:** a directory with `manifest.json`, then `rokku check --new <dir>` and `rokku create <dir> --title "…" --note "…"`. Run `create` once per app. Every `index.html` needs `<meta name="rokku-theme-contract" content="1">` in its `<head>`.
  - A static page: `{"schema_version": 2, "mime_type": "application/vnd.rokku.static-app+tar", "entrypoint": "index.html", "assets": ["index.html"], "agent_instructions": "AGENT.md"}`. It has no Worker, no data and no Home card.
  - A dynamic app: `{"schema_version": 2, "entrypoint": "worker.mjs", "modules": ["worker.mjs"], "assets": ["index.html"], "agent_instructions": "AGENT.md"}`, plus `data_collections` (`[{"name": "<collection>", "indexes": [], "schema_revision": 1}]`) and `requested_capabilities` (`["data.read", "data.write"]`) when it stores data.
  - A creation with a Home card goes on Home by itself shortly after `create`; if `rokku home list` still lacks it after a minute, `rokku home add <creation>`.
- **Page frame:** Rokku opens a creation full screen, with its own close (✕) and more (⋯) buttons floating at the top. Put `<meta name="rokku-layout" content="immersive-top">` in every page's `<head>`: the page's background or artwork then runs to the top edge; keep its text and controls below `var(--rokku-safe-top, 0px)`, clear of those buttons. So don't draw your own close button or ⋯ menu at the top (use ‹ for going back inside the creation, a text button for a menu). Give `html` or `body` an opaque background.
- **Worker:** `worker.mjs` default-exports `{async fetch(request, env, ctx)}`. Serve the page with `env.ASSETS.fetch` (rewrite `/` to `/index.html`). Before a private read or write, require `request.headers.get("X-Rokku-Viewer") === "owner"`. A request must answer within 20 seconds.
  - Data is `ctx.props.DATA`: `get(collection, id)`, `page(collection, limit, after)`, `putResult(collection, {mutationId, recordId, expectedRevision, value, sortKey})`, `deleteResult(collection, {mutationId, recordId, expectedRevision})` and `receipt(collection, mutationId)`. Writes return `{kind: "committed", receipt}` or another `kind` (a conflict, or the budget is used up); they don't throw. `expectedRevision` is 0 for a new record.
  - An app with `data_collections` serves `GET/POST/DELETE /api/records/<collection>`, `GET /api/records/<collection>/receipt?id=` and `GET /api/records/<collection>/record?id=` (the Home card and the phone use them). Copy `records-worker.mjs` from this skill's folder unchanged, add it to `modules`, and write `export default recordsWorker({collections: [...], routes})`. `routes(request, env, ctx)` runs first for the app's own endpoints and returns nothing to fall through.
- **AGENT.md is the source of truth.** The Rokku agent reads a creation's `AGENT.md` before it edits the creation. When you change how a creation works (where its page lives, which collections are live, what must not change), update `AGENT.md` in the same push.
- **Home card:** `Card.tsx`, named by `manifest.rn_source`, with `manifest.rn_card` = `{"contract_version": 1, "allowed_actions": [], "required_capabilities": ["data.read"]}`. One `function Card({data, language, timeZone}: {data?: {[key: string]: JSONValue}; language?: string; timeZone?: string})` (it is type-checked), no imports or exports, only `Rokku.*` components and the injected hooks. Read data with `useArtifactWorkerQuery({path: '/api/...'}, {refreshOnDataChange: true})` (the request first, options second). Handle error, loading and empty states with `<Rokku.ContentState state="loading" | "empty" | "error" message="…" onRetry={…}>`. No `useEffect`, `fetch` or timers (use `useCardTimer`).
- **Limits:** a push or create is one request of at most about 2 MB with files base64-encoded, so keep the source under about 1.4 MB. Design for one DATA record ≤ 16 KB of UTF-8 JSON and one request body ≤ 32 KB. Keep records bounded: split long text and growing lists across records. DATA takes only finite JSON (no `undefined`, `NaN`, `Infinity`). `page()` records name their id `record_id`. A creation request must answer within 20 seconds: start slow work in one request and collect it in a later one.
- **Data:** `rokku data list|get|put|patch|delete <creation> <collection> [id]`. `put` replaces a record, `patch` merges fields and retries if someone wrote at the same time.

## Automations

`rokku automation create --file - <<'EOF'` with a definition `{"name": "…", "trigger": {…}, "action": {…}}`:

- `trigger`: `{"kind": "at", "at": "<ISO time with offset>"}`, `{"kind": "cron", "cron": "0 9 * * 1-5", "timezone": "<IANA zone>"}`, or `{"kind": "interval", "every_seconds": N, "starts_at": "<ISO time>"}`.
- `action`: `{"kind": "emit_timer_event", "instruction": "…"}` hands the instruction to the Rokku agent when it fires; `{"kind": "start_task", "title": "…", "description": "…", "instruction": "…"}` starts a background task (the definition then needs `"schema_version": 2`).
