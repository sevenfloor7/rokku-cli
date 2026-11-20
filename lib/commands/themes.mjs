// Themes: see the current one, save it, switch between saved ones, undo. There is no command that edits
// single colours: users don't hand-pick colours in Rokku (product rule); a new theme comes from the Agent
// (rokku ask).
import {fail, usage, request, print, table, when, confirm, everyPage} from "../core.mjs";

const current = config => request(config, "GET /v1/design-tokens/current");
const expected = now => ({expected_revision: now.revision, expected_system_version: now.system_version, expected_theme_version: now.theme?.version ?? null});
const UNSAVED = "not saved yet (rokku theme save <name> keeps it)";
const describe = now => now.theme?.kind === "saved" ? `"${now.theme.name}"${now.theme.is_modified ? " (changed since it was applied)" : ""}` :
  now.theme?.kind === "builtin" ? `the built-in theme ${now.theme.name ?? now.theme.id}${now.theme.is_modified ? `, changed by your Rokku agent and ${UNSAVED}` : ""}` :
  now.theme?.is_modified ? `a theme your Rokku agent made, ${UNSAVED}` : "the default theme";

async function savedTheme(config, ref) {
  if (!ref) usage("Name a saved theme (rokku theme list)");
  const themes = await everyPage(config, "GET /v1/design-token-themes", {limit: 100});
  const matches = themes.filter(theme => theme.theme_id === ref || theme.name.toLowerCase() === ref.toLowerCase());
  if (!matches.length) fail(`No saved theme is called "${ref}". Run: rokku theme list`);
  if (matches.length > 1) fail(`More than one saved theme is called "${ref}"; use its id: ${matches.map(theme => theme.theme_id).join(", ")}`);
  return matches[0];
}

export const commands = {
  theme: {
    usage: "rokku theme [show | list | save <name> | apply <theme> | undo | reset | delete <theme>]",
    async run(config, [verb = "show", ref], flags) {
      if (verb === "show") {
        const now = await current(config);
        return print(flags.raw ? now : `Your Rokku uses ${describe(now)}, updated ${when(now.updated_at)}.`);
      }
      if (verb === "list") {
        const themes = await everyPage(config, "GET /v1/design-token-themes", {limit: 100});
        return print(flags.raw ? themes : table(themes, [["name", t => t.name], ["saved", t => when(t.created_at)], ["id", t => t.theme_id]]));
      }
      if (verb === "save") {
        if (!ref) usage("Usage: rokku theme save <name>");
        const now = await current(config);
        const saved = await request(config, "POST /v1/design-token-themes", {body: {name: ref, expected_revision: now.revision}});
        return print(`Saved the current theme as "${saved.name}".`);
      }
      if (verb === "apply" || verb === "switch") {
        const [theme, now] = await Promise.all([savedTheme(config, ref), current(config)]);
        await request(config, "POST /v1/design-token-themes/{theme_id}/apply", {params: {theme_id: theme.theme_id}, body: expected(now)});
        return print(`Switched to "${theme.name}". Undo with: rokku theme undo`);
      }
      if (verb === "undo" || verb === "reset") {
        const route = verb === "undo" ? "POST /v1/design-tokens/current/undo" : "POST /v1/design-tokens/current/reset";
        const after = await request(config, route, {body: expected(await current(config))});
        return print(`${verb === "undo" ? "Undone" : "Back to the default theme"}; your Rokku uses ${describe(after)}.`);
      }
      if (verb === "delete") {
        const theme = await savedTheme(config, ref);
        await confirm(flags, `Deleting the saved theme "${theme.name}"`);
        await request(config, "DELETE /v1/design-token-themes/{theme_id}", {params: {theme_id: theme.theme_id}});
        return print(`Deleted "${theme.name}".`);
      }
      usage(`Unknown theme verb "${verb}"`);
    },
  },
};
