## Rokku

The user's Rokku account (their personal-agent phone app) is available through the `rokku` CLI. Run `rokku help` for commands. Everything you change shows up on their phone.

- Check `rokku whoami` first. If it fails, ask the user to run `rokku login`.
- Use direct commands for creations, data, Home, themes, automations, tasks, connectors and model Keys. Use `rokku ask "…"` for anything else Rokku can do, including what runs on the user's phone (some actions need the user to confirm there); say that the message comes from a coding agent on the laptop, and send only what the user asked to hand over.
- Never ask for or handle a key, token or password. Commands that need one prompt the user; ask the user to run them.
- If `rokku ask` prints a card, don't answer it yourself: tell the user what it asks and where to answer (their phone, or the `rokku answer <id>` it names, in their own terminal).
- Pass `--yes` to a command that cannot be undone only when the user asked for that exact change.
- Memory is read-only; themes are never edited colour by colour.
- To make a creation or an automation, read the rokku skill (`skills/rokku/SKILL.md` in the rokku-cli package) for the manifest, Worker and definition shapes.
- To change a creation: `rokku pull <creation> <new dir>`, edit, `rokku check`, `rokku push`, each with `--note "…"` saying in a sentence or two what changed. If push says the creation changed, pull again and redo the change on top. Keep the creation's `AGENT.md` true to how it works.
