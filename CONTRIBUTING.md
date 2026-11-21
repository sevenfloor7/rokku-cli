# Contributing

Thanks for helping improve the Rokku CLI.

## Layout

- `bin/rokku.mjs`: the entry point and `rokku help`.
- `lib/`: the API client, login and config (`core.mjs`), source push/pull (`source.mjs`), the MCP server (`mcp.mjs`), and one file per command group in `lib/commands/`.
- `skills/rokku/`: the Claude Code skill. `agents/AGENTS.md`: the Codex instructions.
- `test/`: tests against a fake Rokku API.

## Run the tests

```bash
npm test
```

The tests run against a fake Rokku API and a fake creation backend. They need no account and no network. CI runs them on Node 20.11, 22 and 24.

## Try it against the test environment

The CLI talks to production by default. To use the Rokku test environment instead:

```bash
rokku login --api https://test-api.rokku.ai
```

`ROKKU_API` overrides the API for a single command. An existing login keeps the API it was made with.

## API routes

The CLI only calls routes listed in `lib/routes.generated.mjs`, which is generated from Rokku's public OpenAPI document. `npm test` fails if the code names a route that isn't in the list. When the API changes, regenerate it:

```bash
npm run gen:routes -- path/to/public.json && npm test
```

## Pull requests

- Keep each pull request small, and say what it changes and why.
- Text that coding agents read (the skill, `agents/AGENTS.md`, MCP tool descriptions) is English only. Keep it short.
- Secrets never go in command arguments, logs or URLs.
- `npm test` must pass.
