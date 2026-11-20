// What the Rokku agent remembers, read-only (the CLI never writes memory: what to remember is the
// agent's call; ask it), and a full account export.
import {createHash, randomUUID} from "node:crypto";
import {writeFileSync} from "node:fs";
import {fail, usage, request, print, table, sleep, timed, apiBase, transferTimeout, megabytes} from "../core.mjs";
import {escapeRegExp, memoryLines} from "../source.mjs";

async function readFile(config, path) {
  let text = "", cursor;
  do {
    const part = await request(config, "GET /v1/agents/{agent_id}/memory/file", {query: {path, cursor}});
    text += part.content;
    cursor = part.next_cursor;
  } while (cursor);
  return text;
}

export const commands = {
  memory: {
    usage: "rokku memory [--grep text] | files [dir] | read <path>   what your Rokku agent remembers (read-only)",
    async run(config, [verb, path], flags) {
      if (verb === undefined) {
        const lines = await memoryLines(config, flags.grep ? new RegExp(escapeRegExp(String(flags.grep)), "i") : /./);
        return print(lines.join("\n") || "(nothing matches)");
      }
      if (verb === "files") {
        const items = [];
        let cursor;
        do {
          const page = await request(config, "GET /v1/agents/{agent_id}/memory/tree", {query: {path, cursor, limit: 100}});
          items.push(...page.items);
          cursor = page.next_cursor;
        } while (cursor);
        return print(flags.raw ? items : table(items, [["path", i => i.path], ["kind", i => i.kind]]));
      }
      if (verb === "read") {
        if (!path) usage("Usage: rokku memory read <path>   (rokku memory files lists them)");
        return print(await readFile(config, path));
      }
      usage(`Unknown memory verb "${verb}"`);
    },
  },
  export: {
    usage: "rokku export [--out file]                      download your account: chats and memory, not creations (rokku pull saves a creation's source)",
    async run(config, positional, flags) {
      const started = await request(config, "POST /v1/account/exports", {body: {client_export_id: randomUUID()}});
      process.stderr.write("Preparing your export; this can take a few minutes…\n");
      let view = started;
      for (const deadline = Date.now() + 30 * 60_000; !["ready", "failed", "expired"].includes(view.state); ) {
        if (Date.now() > deadline) fail(`The export is still ${view.state}; check later with: rokku api /v1/account/exports/${view.export_id}`);
        await sleep(5000);
        view = await request(config, "GET /v1/account/exports/{export_id}", {params: {export_id: started.export_id}});
      }
      if (view.state !== "ready") fail(`The export ${view.state}${view.issue ? `: ${view.issue.summary}` : ""}`);
      const url = apiBase(config) + `/v1/account/exports/${encodeURIComponent(view.export_id)}/content`;
      if (view.archive_size_bytes > 1_048_576) process.stderr.write(`Downloading ${megabytes(view.archive_size_bytes)}…\n`);
      const response = await timed(url, {headers: {Authorization: `Bearer ${config.access_token}`}}, transferTimeout(view.archive_size_bytes ?? 0));
      if (!response.ok) fail(`Download failed: HTTP ${response.status}`);
      const archive = Buffer.from(await response.arrayBuffer());
      if (view.archive_sha256 && createHash("sha256").update(archive).digest("hex") !== view.archive_sha256) fail("The download does not match its sha256; try again");
      const named = /filename="?([^";]+)"?/.exec(response.headers.get("content-disposition") ?? "")?.[1];
      const out = typeof flags.out === "string" ? flags.out : (named?.replace(/[^\w.-]/g, "_") ??
        `rokku-export-${new Date().toISOString().slice(0, 10)}.${/zip/.test(response.headers.get("content-type") ?? "") ? "zip" : "tar"}`);
      writeFileSync(out, archive, {mode: 0o600});
      print(`Saved your Rokku export to ${out} (${megabytes(archive.length)}). It holds your private data; keep it safe.`);
    },
  },
};
