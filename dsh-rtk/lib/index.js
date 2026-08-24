/**
 * dsh-rtk — DSH plugin that keeps the RTK (Runtime Token Keeper) integration
 * applied to the bash tool packages.
 *
 * Every server boot, this plugin's `apply()` runs the same idempotent patch
 * that `patch-rtk.mjs` performs manually: it locates the installed
 * `@deepseek-ai/dsh` tree, checks content markers on
 * `dsh-tool-bash/lib/index.js` and `dsh-tool-bash-persistent/lib/index.js`,
 * and applies the RTK rewrite integration when missing. Because it re-applies
 * on every boot, a DSH update that overwrites node_modules is healed
 * automatically on the next restart.
 *
 * Runtime toggles (read by the patched tool code, not by this plugin):
 *   DSH_RTK_DISABLE=1   disable RTK rewriting entirely
 *   RTK_BIN=<path>      override the rtk binary location
 *   or prepend `DSH_RTK_DISABLE=1` to a single command to run it unfiltered.
 *
 * @module dsh-rtk
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import z from "schemastery";

const here = dirname(fileURLToPath(import.meta.url));
// Keep runtime backups out of the installed package directory. This avoids
// mutating package-manager-owned files and keeps recovered upstream source in
// the user's private DSH state directory instead.
const BACKUP_DIR = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".dsh"), "dsh-rtk");

/** Schemastery schema for plugin configuration. */
const Config = z.object({
	/** Set false to skip patching on boot (e.g. while testing a revert). */
	enabled: z.boolean().default(true),
	/** Log the patch outcome at info level instead of only on change. */
	verbose: z.boolean().default(false)
});

// The patch edits, as [marker, upstream, patched] triplets. `marker` is a
// unique anchor whose presence means "already patched"; `upstream` is what the
// pristine file contains; `patched` replaces it.
const EDITS = [
	{
		marker: 'import { spawnSync } from "node:child_process";',
		upstream:
			'import { DSH_ENV_PREFIX, parseExitStatus } from "@deepseek-ai/dsh-shell";',
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
			'\t// Use only an explicit RTK_BIN path. This avoids executing an unexpected\n' +
			'\t// PATH-resolved binary in the DSH service process.\n' +
			'\tconst candidates = [process.env.RTK_BIN].filter((bin) => bin !== void 0 && bin.length > 0);\n' +
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
			'\t// Use only an explicit RTK_BIN path. This avoids executing an unexpected\n' +
			'\t// PATH-resolved binary in the DSH service process.\n' +
			'\tconst candidates = [process.env.RTK_BIN].filter((bin) => bin !== void 0 && bin.length > 0);\n' +
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

const TARGETS = [
	{ name: "dsh-tool-bash", backup: "dsh-tool-bash.index.js.pristine", edits: EDITS },
	{ name: "dsh-tool-bash-persistent", backup: "dsh-tool-bash-persistent.index.js.pristine", edits: PERSISTENT_EDITS },
];

// Candidate install locations for @deepseek-ai/dsh (first existing wins).
function findDshRoot() {
	const candidates = [
		process.env.DSH_INSTALL_ROOT,
		// A DSH-managed Node runtime places its global packages beside its bin dir.
		join(dirname(process.execPath), "..", "lib", "node_modules", "@deepseek-ai", "dsh"),
		"/usr/local/lib/node_modules/@deepseek-ai/dsh",
		"/opt/homebrew/lib/node_modules/@deepseek-ai/dsh",
	].filter(Boolean);
	for (const root of candidates) {
		if (existsSync(join(root, "package.json"))) return root;
	}
	return null;
}

function findTargets() {
	const root = findDshRoot();
	if (!root) return null;
	return TARGETS.map((target) => ({
		...target,
		path: join(root, "node_modules", "@deepseek-ai", target.name, "lib", "index.js"),
	}));
}

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

/**
 * Apply the RTK patch to both bash tool packages. Idempotent; safe to call on
 * every boot. Returns a summary of what happened per target.
 * @returns an array of { name, path, status } where status is one of
 *   "already-patched" | "patched" | "skipped-missing".
 */
function applyPatch() {
	const targets = findTargets();
	if (!targets) {
		throw new Error("dsh-rtk: could not locate @deepseek-ai/dsh — pass DSH_HOME or edit findDshRoot()");
	}
	const summary = [];
	for (const target of targets) {
		if (!existsSync(target.path)) {
			summary.push({ name: target.name, path: target.path, status: "skipped-missing" });
			continue;
		}
		const source = readFileSync(target.path, "utf8");
		ensureBackup(target, source);
		if (isPatched(source, target.edits)) {
			summary.push({ name: target.name, path: target.path, status: "already-patched" });
			continue;
		}
		let next = source;
		for (const edit of target.edits) {
			if (!next.includes(edit.upstream)) {
				throw new Error(`dsh-rtk: upstream anchor not found for marker ${JSON.stringify(edit.marker)} in ${target.name} — file may have changed in a DSH update; aborting (no changes made)`);
			}
			next = next.replace(edit.upstream, edit.patched);
		}
		// Write atomically: a crash cannot leave a partially-written DSH tool file.
		const temporary = `${target.path}.dsh-rtk-${process.pid}.tmp`;
		writeFileSync(temporary, next);
		renameSync(temporary, target.path);
		summary.push({ name: target.name, path: target.path, status: "patched" });
	}
	return summary;
}

/**
 * The cordis plugin entry. `apply` runs once at composition mount (server
 * boot, before any agent session mounts its bash tool), so the patch is in
 * place before the first command of any session in any preset mode.
 */
export function apply(ctx, config) {
	if (config.enabled === false) {
		if (config.verbose) console.log("[dsh-rtk] disabled by config — skipping patch");
		return;
	}
	try {
		const summary = applyPatch();
		for (const item of summary) {
			if (item.status === "patched" || config.verbose) {
				console.log(`[dsh-rtk] ${item.name}: ${item.status} (${item.path})`);
			}
		}
	} catch (error) {
		console.error(`[dsh-rtk] patch failed: ${String(error?.message ?? error)}`);
	}
}

export const inject = [];
export const name = "dsh-rtk";
export { Config };
