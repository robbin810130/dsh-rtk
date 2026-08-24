#!/usr/bin/env node
/**
 * patch-rtk.mjs — apply / check / revert the RTK (Runtime Token Keeper)
 * integration patch for the DSH shell tools.
 *
 * The patch edits the installed `@deepseek-ai/dsh-tool-bash` and
 * `@deepseek-ai/dsh-tool-bash-persistent` packages so every bash command the
 * agent runs is first rewritten via `rtk rewrite` (the same mechanism Codex's
 * PreToolUse hook uses). Commands with an RTK equivalent (git, ls, cat/read,
 * find, pnpm, cargo, ...) then run through RTK's token-optimized filters,
 * cutting the output tokens the LLM must ingest.
 *
 * Both packages are covered so RTK applies in every agent preset: the
 * one-shot bash tool (`standard`/`code`/`cordis` presets) and the persistent
 * bash tool (`minimal` preset).
 *
 * Because the edits live in node_modules, a DSH reinstall/update wipes them —
 * re-run `node patch-rtk.mjs apply` afterwards.
 *
 * Usage:
 *   node patch-rtk.mjs apply     apply the patch (idempotent)
 *   node patch-rtk.mjs check     report whether the patch is applied
 *   node patch-rtk.mjs revert    restore the pristine upstream files
 *
 * Toggles (env vars, read by the patched code at runtime):
 *   DSH_RTK_DISABLE=1   disable RTK rewriting entirely
 *   RTK_BIN=<path>      override the rtk binary location
 *   or prepend `DSH_RTK_DISABLE=1` to a single command to run it unfiltered.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = join(here, ".backup");

// Candidate install locations for @deepseek-ai/dsh (first existing wins).
function findDshRoot() {
  const candidates = [
    process.env.DSH_HOME && join(process.env.DSH_HOME, "..", "lib", "node_modules", "@deepseek-ai", "dsh"),
    "/Users/Robbin/.workbuddy/binaries/node/versions/22.22.2/lib/node_modules/@deepseek-ai/dsh",
    "/usr/local/lib/node_modules/@deepseek-ai/dsh",
    "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh",
  ].filter(Boolean);
  for (const root of candidates) {
    if (existsSync(join(root, "package.json"))) return root;
  }
  // Fall back to a glob-free search of likely global roots.
  for (const base of ["/usr/local/lib/node_modules", "/opt/homebrew/lib/node_modules", process.env.HOME && join(process.env.HOME, ".nvm")]) {
    if (!base || !existsSync(base)) continue;
    const walk = (dir) => {
      for (const entry of ["@deepseek-ai", "dsh"]) {
        const next = join(dir, entry);
        if (!existsSync(next)) continue;
        if (entry === "dsh") {
          if (existsSync(join(next, "package.json"))) return next;
        } else {
          const found = walk(next);
          if (found) return found;
        }
      }
      return null;
    };
    const found = walk(base);
    if (found) return found;
  }
  return null;
}

/** Both shell tool targets under one dsh root: one-shot bash and persistent bash. */
function findTargets() {
  const root = findDshRoot();
  if (!root) return null;
  return TARGETS.map((target) => ({
    ...target,
    path: join(root, "node_modules", "@deepseek-ai", target.name, "lib", "index.js"),
  }));
}

// The patch edits, as [marker, upstream, patched] triplets. `marker` is a
// unique anchor whose presence means "already patched"; `upstream` is what the
// pristine file contains; `patched` replaces it.
const EDITS = [
  {
    marker: 'import { spawnSync } from "node:child_process";',
    upstream: 'import { DSH_ENV_PREFIX, parseExitStatus } from "@deepseek-ai/dsh-shell";',
    patched:
      'import { DSH_ENV_PREFIX, parseExitStatus } from "@deepseek-ai/dsh-shell";\n' +
      'import { spawnSync } from "node:child_process";',
  },
  {
    marker: "function rewriteWithRtk(command) {",
    upstream:
      "function validateBashArgs(args) {\n" +
      '\tif (args.command.trim().length === 0) throw new Error("invalid command: expected a non-empty string");\n' +
      '\tif (args.description.trim().length === 0) throw new Error("invalid description: expected a non-empty string");\n' +
      '\tif (args.timeoutMs !== void 0 && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`);\n' +
      "\tvalidateEscalationArgs(args.sandbox_permissions, args.justification);\n" +
      "}",
    patched:
      "function validateBashArgs(args) {\n" +
      '\tif (args.command.trim().length === 0) throw new Error("invalid command: expected a non-empty string");\n' +
      '\tif (args.description.trim().length === 0) throw new Error("invalid description: expected a non-empty string");\n' +
      '\tif (args.timeoutMs !== void 0 && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`);\n' +
      "\tvalidateEscalationArgs(args.sandbox_permissions, args.justification);\n" +
      "}\n" +
      "/**\n" +
      "* RTK (Runtime Token Keeper) integration: rewrite a bash command to its\n" +
      "* token-optimized RTK equivalent before execution (e.g. `git status` →\n" +
      "* `rtk git status`, `cat file` → `rtk read file`), mirroring how Codex's\n" +
      "* PreToolUse hook uses `rtk rewrite`. Commands without an RTK equivalent\n" +
      "* (rtk rewrite exits 1 with empty stdout) run unchanged. Disable with\n" +
      "* `DSH_RTK_DISABLE=1`; override the binary with `RTK_BIN`.\n" +
      "* @param command - the model's bash command.\n" +
      "* @returns the RTK-rewritten command when one exists, else the original.\n" +
      "*/\n" +
      "function rewriteWithRtk(command) {\n" +
      '\tif (process.env.DSH_RTK_DISABLE === "1" || command.trim().length === 0) return command;\n' +
      '\t// Per-command opt-out: "DSH_RTK_DISABLE=1 <cmd>" (anywhere in the command,\n' +
      '\t// e.g. after "&&") runs the whole command unfiltered.\n' +
      "\tif (/(^|[\\s;&|])DSH_RTK_DISABLE\\s*=\\s*1\\b/.test(command)) return command;\n" +
      '\tconst candidates = [process.env.RTK_BIN, "/opt/homebrew/bin/rtk", "/usr/local/bin/rtk", "rtk"].filter((bin) => bin !== void 0 && bin.length > 0);\n' +
      "\tfor (const bin of candidates) {\n" +
      "\t\tlet result;\n" +
      "\t\ttry {\n" +
      '\t\t\tresult = spawnSync(bin, ["rewrite", command], { encoding: "utf8", timeout: 3000, windowsHide: true });\n' +
      "\t\t} catch {\n" +
      "\t\t\tcontinue;\n" +
      "\t\t}\n" +
      "\t\tif (result.error !== void 0) {\n" +
      '\t\t\tif (result.error.code === "ENOENT") continue;\n' +
      "\t\t\treturn command;\n" +
      "\t\t}\n" +
      '\t\tconst rewritten = (result.stdout ?? "").trim();\n' +
      "\t\tif (rewritten.length === 0) return command;\n" +
      "\t\t// The executed command runs in a subprocess whose PATH may lack the\n" +
      "\t\t// Homebrew bin dir (so a bare `rtk` would not resolve) — substitute the\n" +
      "\t\t// resolved binary path for command-position `rtk` tokens in the rewrite\n" +
      "\t\t// (command start, after ; & | separators, or after VAR=value prefixes).\n" +
      '\t\tif (bin === "rtk") return rewritten;\n' +
      '\t\treturn rewritten.replace(/(^|[\\n;&|]\\s*|(?:^|[\\s;&|])(?:[A-Za-z_][A-Za-z0-9_]*=[^\\s;&|]*\\s+)+)\\brtk\\b/g, (_match, sep) => `${sep}${bin}`);\n' +
      "\t}\n" +
      "\treturn command;\n" +
      "}",
  },
  {
    marker: "const rtkCommand = rewriteWithRtk(args.command);",
    upstream:
      "\t\tasync execute(args, exec) {\n" +
      "\t\t\tvalidateBashArgs(args);\n" +
      "\t\t\tconst standingPolicy = resolveSandboxPolicy(exec);",
    patched:
      "\t\tasync execute(args, exec) {\n" +
      "\t\t\tvalidateBashArgs(args);\n" +
      "\t\t\tconst rtkCommand = rewriteWithRtk(args.command);\n" +
      "\t\t\tconst standingPolicy = resolveSandboxPolicy(exec);",
  },
  {
    marker: "command: rtkCommand,",
    upstream: "\t\t\t\tcommand: args.command,",
    patched: "\t\t\t\tcommand: rtkCommand,",
  },
  {
    marker: "When a matching filter exists, the command is auto-rewritten via RTK",
    upstream: "the full output is saved to a file whose path is reported when available. ` + background;",
    // The target text lives inside a template literal, so inline code spans
    // must stay escaped (`\``) in the file — String.raw keeps the backslashes.
    patched:
      "the full output is saved to a file whose path is reported when available. " +
      String.raw`When a matching filter exists, the command is auto-rewritten via RTK (\`rtk rewrite\`) and its output compacted to save tokens — for commands that need exact raw output (e.g. precise \`git diff\` content, full file reads), the output may be abbreviated; re-run with \`DSH_RTK_DISABLE=1\` prepended to get unfiltered output. ` +
      "` + background;",
  },
];

/** Persistent-bash edits: same RTK rewrite, applied to `dsh-tool-bash-persistent`
* (used by the `minimal` agent preset). The rewrite runs at the top of
* `executeCommand`, and the tool description gains the same RTK note. */
const PERSISTENT_EDITS = [
  {
    marker: 'import { spawnSync } from "node:child_process";',
    upstream: 'import { randomUUID } from "node:crypto";',
    patched:
      'import { randomUUID } from "node:crypto";\n' +
      'import { spawnSync } from "node:child_process";',
  },
  {
    marker: "function rewriteWithRtk(command) {",
    upstream: "async function executeCommand(ctx, shells, owner, command, config, upstream) {",
    patched:
      "function rewriteWithRtk(command) {\n" +
      '\tif (process.env.DSH_RTK_DISABLE === "1" || command.trim().length === 0) return command;\n' +
      '\t// Per-command opt-out: "DSH_RTK_DISABLE=1 <cmd>" (anywhere in the command,\n' +
      '\t// e.g. after "&&") runs the whole command unfiltered.\n' +
      "\tif (/(^|[\\s;&|])DSH_RTK_DISABLE\\s*=\\s*1\\b/.test(command)) return command;\n" +
      '\tconst candidates = [process.env.RTK_BIN, "/opt/homebrew/bin/rtk", "/usr/local/bin/rtk", "rtk"].filter((bin) => bin !== void 0 && bin.length > 0);\n' +
      "\tfor (const bin of candidates) {\n" +
      "\t\tlet result;\n" +
      "\t\ttry {\n" +
      '\t\t\tresult = spawnSync(bin, ["rewrite", command], { encoding: "utf8", timeout: 3000, windowsHide: true });\n' +
      "\t\t} catch {\n" +
      "\t\t\tcontinue;\n" +
      "\t\t}\n" +
      "\t\tif (result.error !== void 0) {\n" +
      '\t\t\tif (result.error.code === "ENOENT") continue;\n' +
      "\t\t\treturn command;\n" +
      "\t\t}\n" +
      '\t\tconst rewritten = (result.stdout ?? "").trim();\n' +
      "\t\tif (rewritten.length === 0) return command;\n" +
      "\t\t// The executed command runs in a subprocess whose PATH may lack the\n" +
      "\t\t// Homebrew bin dir (so a bare `rtk` would not resolve) — substitute the\n" +
      "\t\t// resolved binary path for command-position `rtk` tokens in the rewrite\n" +
      "\t\t// (command start, after ; & | separators, or after VAR=value prefixes).\n" +
      '\t\tif (bin === "rtk") return rewritten;\n' +
      '\t\treturn rewritten.replace(/(^|[\\n;&|]\\s*|(?:^|[\\s;&|])(?:[A-Za-z_][A-Za-z0-9_]*=[^\\s;&|]*\\s+)+)\\brtk\\b/g, (_match, sep) => `${sep}${bin}`);\n' +
      "\t}\n" +
      "\treturn command;\n" +
      "}\n" +
      "async function executeCommand(ctx, shells, owner, command, config, upstream) {\n" +
      "\tcommand = rewriteWithRtk(command);",
  },
  {
    marker: "When a matching filter exists, the command is auto-rewritten via RTK",
    upstream: "\t\tdescription: config.description,",
    patched:
      '\t\tdescription: config.description + " When a matching filter exists, the command is auto-rewritten via RTK (`rtk rewrite`) and its output compacted to save tokens — for commands that need exact raw output (e.g. precise `git diff` content, full file reads), the output may be abbreviated; re-run with `DSH_RTK_DISABLE=1` prepended to get unfiltered output.",',
  },
];

/** Patch targets: each carries its own edit set and pristine backup name. */
const TARGETS = [
  { name: "dsh-tool-bash", backup: "dsh-tool-bash.index.js.pristine", edits: EDITS },
  { name: "dsh-tool-bash-persistent", backup: "dsh-tool-bash-persistent.index.js.pristine", edits: PERSISTENT_EDITS },
];

function isPatched(source, edits) {
  return edits.every((edit) => source.includes(edit.marker));
}

/** Reverse the edits on a patched source to reconstruct the pristine upstream. */
function reverseEdits(patchedSource, edits) {
  let next = patchedSource;
  for (const edit of edits) {
    if (!next.includes(edit.patched)) {
      throw new Error(`patched anchor not found for marker ${JSON.stringify(edit.marker)} — cannot reverse`);
    }
    next = next.replace(edit.patched, edit.upstream);
  }
  return next;
}

function ensureBackup(target, source) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const backup = join(BACKUP_DIR, target.backup);
  if (!existsSync(backup)) {
    const pristine = isPatched(source, target.edits) ? reverseEdits(source, target.edits) : source;
    writeFileSync(backup, pristine);
  }
  return backup;
}

function apply() {
  const targets = findTargets();
  if (!targets) {
    console.error("✗ could not locate @deepseek-ai/dsh — pass DSH_HOME or edit findDshRoot()");
    process.exit(1);
  }
  for (const target of targets) {
    if (!existsSync(target.path)) {
      console.warn(`⚠ target missing, skipping: ${target.path}`);
      continue;
    }
    const source = readFileSync(target.path, "utf8");
    ensureBackup(target, source);
    if (isPatched(source, target.edits)) {
      console.log(`✓ already patched: ${target.path}`);
      continue;
    }
    let next = source;
    for (const edit of target.edits) {
      if (!next.includes(edit.upstream)) {
        console.error(`✗ upstream anchor not found for marker ${JSON.stringify(edit.marker)} in ${target.name} — file may have changed in a DSH update; aborting (no changes made)`);
        process.exit(1);
      }
      next = next.replace(edit.upstream, edit.patched);
    }
    writeFileSync(target.path, next);
    console.log(`✓ patched ${target.path}`);
  }
  console.log("  Restart the dsh web server (or the dsh process) for the change to take effect.");
}

function revert() {
  const targets = findTargets();
  if (!targets) {
    console.error("✗ could not locate @deepseek-ai/dsh");
    process.exit(1);
  }
  for (const target of targets) {
    if (!existsSync(target.path)) continue;
    const source = readFileSync(target.path, "utf8");
    const backup = ensureBackup(target, source);
    if (!isPatched(source, target.edits)) {
      console.log(`✓ already pristine: ${target.path}`);
      continue;
    }
    copyFileSync(backup, target.path);
    console.log(`✓ reverted ${target.path} to pristine upstream`);
  }
}

function check() {
  const targets = findTargets();
  if (!targets) {
    console.error("✗ could not locate @deepseek-ai/dsh");
    process.exit(1);
  }
  for (const target of targets) {
    if (!existsSync(target.path)) {
      console.warn(`⚠ target missing: ${target.path}`);
      continue;
    }
    const source = readFileSync(target.path, "utf8");
    console.log(`${isPatched(source, target.edits) ? "✓ RTK patch IS applied" : "✗ RTK patch NOT applied"} (${target.path})`);
  }
}

const mode = process.argv[2] ?? "check";
if (mode === "apply") apply();
else if (mode === "revert") revert();
else if (mode === "check") check();
else {
  console.error(`unknown mode ${JSON.stringify(mode)} — use apply | check | revert`);
  process.exit(1);
}
