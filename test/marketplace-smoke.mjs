import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const patch = readFileSync(join(root, "cordis.patch.yml"), "utf8");
const source = readFileSync(join(root, "dsh-rtk", "lib", "index.js"), "utf8");

assert.equal(pkg.name, "@robbin810130/dsh-rtk");
assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml");
assert.equal(pkg.exports?.["."]?.import, "./dsh-rtk/lib/index.js");
assert.match(patch, /name: '@robbin810130\/dsh-rtk'/);
assert.match(source, /export function apply\(ctx, config\)/);
assert.doesNotMatch(source, /\/Users\/Robbin|dsh-rtk-heartbeat/);
assert.match(source, /renameSync\(temporary, target\.path\)/);

execFileSync(process.execPath, ["--check", join(root, "dsh-rtk", "lib", "index.js")], { stdio: "inherit" });
console.log("Marketplace smoke checks passed.");
