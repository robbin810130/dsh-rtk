import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const patch = readFileSync(join(root, "cordis.patch.yml"), "utf8");
const source = readFileSync(join(root, "dsh-rtk", "lib", "index.js"), "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");

assert.equal(pkg.name, "dsh-rtk");
assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml");
assert.equal(pkg.exports?.["."]?.import, "./dsh-rtk/lib/index.js");
assert.match(patch, /name: 'dsh-rtk'/);

// Everything the pack layout relies on must be shipped and must exist.
for (const file of pkg.files) assert.equal(existsSync(join(root, file)), true, `missing packed file: ${file}`);
assert.equal(pkg.files.includes("scripts/doctor.mjs"), true);
assert.equal(pkg.scripts.doctor, "node ./scripts/doctor.mjs");
for (const test of ["marketplace-smoke", "resolve", "runtime"]) {
  assert.equal(pkg.scripts.test.includes(`./test/${test}.mjs`), true, `test script must run test/${test}.mjs`);
}

// The install instructions in the README must describe the version being shipped.
assert.match(readme, new RegExp(`## ${pkg.version.replaceAll(".", "\\.")}`), "README must document the current version");
assert.match(readme, /autoDiscover|自动发现/, "README must document zero-config discovery");

// Cross-platform claims must stay true in the source and the docs.
assert.match(source, /pwsh/, "the plugin must know the Windows shell tool");
assert.match(source, /win32/, "the plugin must branch on platform");
assert.match(source, /\.exe/, "the Windows candidate list must name executable images");
assert.match(readme, /Windows/, "README must document Windows support");
assert.match(readme, /pwsh/, "README must name the Windows shell tool");

assert.doesNotMatch(source, /\/Users\/Robbin|dsh-rtk-heartbeat/);


execFileSync(process.execPath, ["--check", join(root, "dsh-rtk", "lib", "index.js")], { stdio: "inherit" });
execFileSync(process.execPath, ["--check", join(root, "scripts", "doctor.mjs")], { stdio: "inherit" });
console.log("Marketplace smoke checks passed.");
