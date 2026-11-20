// Login storage: only the two tokens go to the keychain, Gateway sessions stay in the 0600 file and
// expired ones are dropped, and a keychain write that would not fit one `security -i` line is refused.
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync, readFileSync, statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

process.env.ROKKU_CONFIG = join(mkdtempSync(join(tmpdir(), "rokku-config-")), "config.json");
process.env.ROKKU_TOKEN_STORE = "file";
const core = await import("../lib/core.mjs");

assert.deepEqual(core.SECRET_KEYS, ["access_token", "refresh_token"], "creation sessions are not keychain secrets");
const token = "x".repeat(900);
assert.match(core.keychainCommand({access_token: token, refresh_token: token}), /^add-generic-password -U -s rokku-cli /);
assert.throws(() => core.keychainCommand({access_token: "x".repeat(2100)}), /too long for one keychain write/);

const now = Date.now();
core.writeConfig({agent_id: "a", sessions: {
  live: {origin: "https://a.example", expires_at: new Date(now + 600_000).toISOString()},
  old: {origin: "https://b.example", expires_at: new Date(now - 1000).toISOString()},
  broken: {origin: "https://c.example"}}});
const written = JSON.parse(readFileSync(process.env.ROKKU_CONFIG, "utf8"));
assert.deepEqual(Object.keys(written.sessions), ["live"], "expired and unreadable sessions are dropped on write");
assert.equal(statSync(process.env.ROKKU_CONFIG).mode & 0o777, 0o600);
// A prompt whose input ends before a line is no answer: it fails instead of exiting 0.
const eof = spawnSync(process.execPath, ["--input-type=module", "-e",
  `import {prompt} from ${JSON.stringify(new URL("../lib/core.mjs", import.meta.url).href)};
   await prompt("? ").then(() => process.exit(0), error => { process.stdout.write(error.message); process.exit(error.exit); });`],
  {input: "", encoding: "utf8"});
assert.equal(eof.status, 1); assert.match(eof.stdout, /input ended/);
console.log("ok — tokens only in the keychain, sessions pruned in the 0600 file, keychain line length checked");
