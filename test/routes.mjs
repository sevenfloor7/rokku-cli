// Every route the CLI names must be in lib/routes.generated.mjs (generated from the backend's
// openapi/public.json), so a renamed or removed backend route fails here, not for users.
import assert from "node:assert/strict";
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {ROUTES} from "../lib/routes.generated.mjs";

const root = join(import.meta.dirname, "..");
const files = ["bin/rokku.mjs", ...readdirSync(join(root, "lib"), {recursive: true})
  .filter(name => name.endsWith(".mjs") && !name.endsWith(".generated.mjs")).map(name => join("lib", name))];
const named = new Set();
for (const file of files) {
  for (const match of readFileSync(join(root, file), "utf8").matchAll(/"((?:GET|POST|PUT|PATCH|DELETE) \/v1\/[^"]+)"/g)) {
    assert.ok(ROUTES[match[1]], `${file} names ${match[1]}, which is not a public route`);
    named.add(match[1]);
  }
}
assert.ok(named.size > 10, "found the routes the CLI uses");
console.log(`ok — the ${named.size} routes the CLI uses are all public routes`);
