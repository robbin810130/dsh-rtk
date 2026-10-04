/**
 * dsh-rtk — rewrite bash commands through the local RTK binary before they run.
 *
 * Integration point: DSH's supported `tools/execute` around-dispatch hook
 * (dsh-tools' `ctx.waterfall(carrier, 'tools/execute', exec, next)`). No host
 * file is patched, so a DSH update can never leave a half-applied edit behind.
 *
 * Three rules make "installed" equal to "working":
 *
 *  1. Zero-config discovery. RTK is resolved from `config.bin`, then the
 *     `RTK_BIN` environment variable, then — only when neither is set — a short
 *     allowlist of well-known install locations. The PATH is never searched,
 *     and every auto-discovered candidate must be a non-world-writable,
 *     root/self-owned regular file that answers `--version` with `rtk <x.y.z>`.
 *  2. No silent failure. A resolution that fails is reported once as an
 *     actionable warning (and recorded in the status file) instead of turning
 *     the whole plugin into a no-op nobody notices.
 *  3. No silent substitution. An explicit `config.bin` / `RTK_BIN` is
 *     authoritative: if it is unusable the plugin reports the problem rather
 *     than quietly executing a different binary.
 */
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';
import z from 'schemastery';

export const name = 'dsh-rtk';
export const inject = [];

export const Config = z.object({
  /** Master switch; `false` keeps the plugin installed but inert. */
  enabled: z.boolean().default(true),
  /** Explicit RTK path. Authoritative when set — a bad value is reported, never bypassed. */
  bin: z.string().default(''),
  /** Look in the well-known install locations when neither `bin` nor `RTK_BIN` is set. */
  autoDiscover: z.boolean().default(true),
  /** Hard limit for one `rtk rewrite` call, in milliseconds. */
  timeoutMs: z.number().default(3000),
  /** Log every rewrite instead of only the first one. */
  verbose: z.boolean().default(false),
  /** Record resolution state and counters in `$DSH_HOME/dsh-rtk/status.json`. */
  statusFile: z.boolean().default(true),
});

const BASH_TOOL = 'bash';
const BIN_ENV = 'RTK_BIN';
const DISABLE_ENV = 'DSH_RTK_DISABLE';
const DEFAULT_TIMEOUT_MS = 3000;
const PROBE_TIMEOUT_MS = 1500;
/** A failed resolution is retried this often, so installing RTK mid-session starts working without a restart. */
const RETRY_MISSING_MS = 30_000;
/** Rewrite counters reach the status file at most this often. */
const STATUS_FLUSH_MS = 30_000;
/** RTK exit codes that carry a usable rewrite suggestion (`3` is "suggestion", not an error). */
const ACCEPTED_STATUS = [0, 3];
/** RTK's documented "this command has no RTK equivalent" status; not a failure. */
const NO_SUGGESTION_STATUS = 1;
const RTK_WORD = /(^|[\n;&|]\s*|(?:^|[\s;&|])(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|]*\s+)+)\brtk\b/g;

/**
 * Well-known RTK install locations, in preference order. `~` expands to the
 * current home directory. Only these paths are ever probed without an explicit
 * setting; PATH is not searched, because RTK receives raw command text.
 */
export const DISCOVERY_CANDIDATES = [
  '/opt/homebrew/bin/rtk',
  '/usr/local/bin/rtk',
  '/home/linuxbrew/.linuxbrew/bin/rtk',
  '/usr/bin/rtk',
  '~/.local/bin/rtk',
  '~/.cargo/bin/rtk',
];

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function expandHome(candidate, env) {
  if (candidate === '~' || candidate.startsWith('~/')) {
    return join(env.HOME?.trim() || homedir(), candidate.slice(1));
  }
  return candidate;
}

/**
 * Validate one candidate path without executing it.
 *
 * @param candidate - absolute path, or a `~/…` path.
 * @param env - environment used to expand `~`.
 * @returns `{ ok, path, reason }`, where `reason` explains a rejection.
 */
export function inspectBinary(candidate, env = process.env) {
  const path = expandHome(candidate, env);
  if (!isAbsolute(path)) return { ok: false, path, reason: '不是绝对路径' };
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  let real;
  let stats;
  try {
    real = realpathSync(path);
    stats = statSync(real);
  } catch (error) {
    return { ok: false, path, reason: error?.code === 'ENOENT' ? '不存在' : `无法解析（${error?.code ?? error}）` };
  }
  if (!stats.isFile()) return { ok: false, path, reason: '不是常规文件' };
  if ((stats.mode & 0o002) !== 0) return { ok: false, path, reason: '其他用户可写（world-writable）' };
  if (uid !== null && stats.uid !== 0 && stats.uid !== uid) {
    return { ok: false, path, reason: `属主是 uid ${stats.uid}，不是 root 也不是当前用户` };
  }
  try {
    if ((statSync(dirname(path)).mode & 0o002) !== 0) return { ok: false, path, reason: `所在目录可被其他用户写入：${dirname(path)}` };
  } catch {
    /* the parent must exist for the file to exist; ignore */
  }
  try {
    accessSync(real, fsConstants.X_OK);
  } catch {
    return { ok: false, path, reason: '没有执行权限' };
  }
  return { ok: true, path, reason: '' };
}

/**
 * Ask one binary for its version.
 *
 * @param bin - absolute path to probe.
 * @param timeoutMs - probe deadline.
 * @returns the version string when stdout is `rtk <version>`, otherwise `null`.
 */
export function probeVersion(bin, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const result = spawnSync(bin, ['--version'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.error || result.status !== 0) return null;
    const match = /^rtk\s+(\S+)/m.exec((result.stdout ?? '').trim());
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function missingHint(checked) {
  return [
    'RTK 没有找到，bash 输出不会被压缩。',
    `已检查：${checked.length > 0 ? checked.join('、') : '（自动发现已关闭）'}`,
    '修复任一即可：',
    '  1) 安装 RTK：`brew install rtk`（其他平台见 https://github.com/rtk-ai/rtk），然后重启 DSH；',
    `  2) 显式指定：在 DSH 服务进程的环境里设置 \`${BIN_ENV}=/absolute/path/to/rtk\`（桌面版写进 ~/.zshrc 后完全退出并重开 App）；`,
    '  3) 或在 profile 的 cordis.patch.yml 里给 dsh-rtk 配置 `bin: /absolute/path/to/rtk`。',
  ].join('\n');
}

function explicitHint(source, value, reason) {
  return [
    `${source} 指向的 RTK 不可用：${value} —— ${reason}。`,
    '为避免静默替换成别的二进制，插件这次不会改写任何命令。',
    '修复：改成正确的绝对路径，或删除该项设置改用自动发现（见 README「安装」）。',
  ].join('\n');
}

/**
 * Decide which RTK binary this session should use.
 *
 * Precedence: `config.bin` → `RTK_BIN` → discovered candidates. An explicit
 * setting that is unusable is a hard failure, never a fallback.
 *
 * @param options.config - validated plugin config.
 * @param options.env - environment to read `RTK_BIN` from.
 * @param options.candidates - candidate list override (tests, doctor).
 * @param options.probe - version probe override.
 * @returns `{ ok, bin, source, version, reason, hint, checked }`.
 */
export function resolveRtkBin(options = {}) {
  const env = options.env ?? process.env;
  const config = options.config ?? {};
  const candidates = options.candidates ?? DISCOVERY_CANDIDATES;
  const probe = options.probe ?? probeVersion;
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
  const missing = { ok: false, bin: null, source: null, version: null, checked: [] };

  const explicit = [
    ['config.bin', String(config.bin ?? '').trim()],
    [BIN_ENV, String(env[BIN_ENV] ?? '').trim()],
  ].find(([, value]) => value.length > 0);
  if (explicit !== undefined) {
    const [source, value] = explicit;
    const inspection = inspectBinary(value, env);
    if (!inspection.ok) {
      return { ...missing, source, hint: explicitHint(source, value, inspection.reason), reason: `${source} 不可用（${inspection.reason}）` };
    }
    return { ok: true, bin: inspection.path, source, version: probe(inspection.path, timeoutMs), reason: '', hint: '', checked: [] };
  }

  if (config.autoDiscover === false) {
    return {
      ...missing,
      hint: ['自动发现已关闭（autoDiscover: false），且没有配置 bin / ' + BIN_ENV + '。', '配置其一即可启用改写。'].join('\n'),
      reason: '未配置 RTK 且已关闭自动发现',
    };
  }

  const checked = [];
  for (const candidate of candidates) {
    const inspection = inspectBinary(candidate, env);
    if (!inspection.ok) {
      checked.push(`${inspection.path}（${inspection.reason}）`);
      continue;
    }
    const version = probe(inspection.path, timeoutMs);
    if (version === null) {
      checked.push(`${inspection.path}（不是 RTK：--version 未返回 "rtk <版本>"）`);
      continue;
    }
    return { ok: true, bin: inspection.path, source: 'discovered', version, reason: '', hint: '', checked: [] };
  }
  return { ...missing, checked, reason: '未找到可用的 RTK 二进制', hint: missingHint(checked) };
}

/** `.../profiles/<name>` → `<name>`; anything else → `null`. */
function profileName(cwd = process.cwd()) {
  const parts = cwd.split(sep);
  const index = parts.lastIndexOf('profiles');
  if (index === -1 || index === parts.length - 1) return null;
  return parts[index + 1] || null;
}

function resolveStatusPath(env) {
  const home = String(env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh');
  return join(home, 'dsh-rtk', 'status.json');
}

/**
 * One session-scoped RTK runtime: resolves the binary, rewrites commands and
 * keeps a small status record for `npm run doctor`.
 */
export function createRtkRuntime(options = {}) {
  const env = options.env ?? process.env;
  const config = options.config ?? {};
  const log = options.log ?? (() => {});
  const clock = options.now ?? Date.now;
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
  const statusPath = config.statusFile === false ? null : resolveStatusPath(env);
  const state = {
    resolution: null,
    resolvedAt: 0,
    rewrites: 0,
    skipped: 0,
    passthrough: 0,
    firstRewrite: true,
    reported: new Set(),
    lastError: null,
    startedAt: new Date().toISOString(),
    flushedAt: 0,
  };

  function flush(force = false) {
    if (statusPath === null) return;
    if (!force && clock() - state.flushedAt < STATUS_FLUSH_MS) return;
    state.flushedAt = clock();
    try {
      mkdirSync(dirname(statusPath), { recursive: true });
      writeFileSync(statusPath, JSON.stringify({
        plugin: 'dsh-rtk',
        pid: process.pid,
        profile: profileName(),
        cwd: process.cwd(),
        startedAt: state.startedAt,
        updatedAt: new Date().toISOString(),
        active: state.resolution?.ok === true,
        bin: state.resolution?.bin ?? null,
        source: state.resolution?.source ?? null,
        version: state.resolution?.version ?? null,
        reason: state.resolution?.ok === true ? null : state.resolution?.reason ?? null,
        hint: state.resolution?.ok === true ? null : state.resolution?.hint ?? null,
        rewrites: state.rewrites,
        skipped: state.skipped,
        passthrough: state.passthrough,
        lastError: state.lastError,
        statusPath,
      }, null, 2) + '\n');
    } catch {
      /* the status file is best effort and must never break rewriting */
    }
  }

  /** Announce a resolution outcome exactly once per distinct outcome. */
  function report(resolution) {
    const key = resolution.ok ? `ok:${resolution.bin}` : `fail:${resolution.source ?? 'none'}:${resolution.reason}`;
    if (state.reported.has(key)) return;
    state.reported.add(key);
    if (resolution.ok) {
      const version = resolution.version === null ? '未知版本' : `rtk ${resolution.version}`;
      const profile = profileName();
      log('info', `[dsh-rtk] 已生效 — ${version} @ ${resolution.bin}（来源：${resolution.source}${profile === null ? '' : `，profile：${profile}`}）`);
    } else {
      log('warn', `[dsh-rtk] 未生效：${resolution.reason}\n${resolution.hint}`);
    }
    flush(true);
  }

  function resolution() {
    const cached = state.resolution;
    if (cached !== null && (cached.ok || clock() - state.resolvedAt < RETRY_MISSING_MS)) return cached;
    state.resolution = resolveRtkBin({ config, env, candidates: options.candidates });
    state.resolvedAt = clock();
    report(state.resolution);
    return state.resolution;
  }

  function invalidate(reason, error) {
    state.lastError = { at: new Date().toISOString(), reason, error };
    state.resolution = null;
    state.resolvedAt = 0;
    flush(true);
  }

  /**
   * Rewrite one command.
   *
   * @returns `{ command, reason }`; `command` is the original string whenever
   * rewriting is not possible, so callers can fail open.
   */
  function rewrite(command) {
    if (env[DISABLE_ENV] === '1' || command.trim().length === 0) return { command, reason: 'disabled' };
    if (new RegExp(`(^|[\\s;&|])${DISABLE_ENV}\\s*=\\s*1\\b`).test(command)) return { command, reason: 'disabled-command' };

    const found = resolution();
    if (!found.ok) {
      state.skipped++;
      flush();
      return { command, reason: 'no-rtk' };
    }

    let result;
    try {
      result = spawnSync(found.bin, ['rewrite', command], {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      state.skipped++;
      reportFailure(found, 'rtk 无法启动', error?.message ?? String(error), true);
      return { command, reason: 'spawn-error' };
    }

    if (result.error) {
      const gone = ['ENOENT', 'EACCES', 'EPERM'].includes(result.error.code);
      state.skipped++;
      reportFailure(found, `rtk 调用失败（${result.error.code ?? 'unknown'}）`, result.error.message, gone);
      return { command, reason: 'spawn-error' };
    }

    const suggestion = (result.stdout ?? '').trim();
    // RTK documents "exit 1 with no output" as "this command has no RTK
    // equivalent". That is the normal path for most commands, not a failure —
    // only a status outside {0, 1, 3} or output on a failing status is worth a warning.
    if (result.status === NO_SUGGESTION_STATUS && suggestion.length === 0) {
      state.passthrough++;
      flush();
      return { command, reason: 'no-equivalent' };
    }
    if (!ACCEPTED_STATUS.includes(result.status)) {
      state.skipped++;
      reportFailure(found, `rtk rewrite 退出码 ${result.status}`, (result.stderr ?? '').trim().slice(0, 400) || suggestion.slice(0, 400) || '（无输出）', false);
      return { command, reason: `exit-${result.status}` };
    }
    if (suggestion.length === 0) return { command, reason: 'empty-suggestion' };
    // Keep the trusted binary reachable even when the tool shell has a sparse PATH.
    const rewritten = suggestion.replace(RTK_WORD, (_match, prefix) => prefix + shellQuote(found.bin));
    if (rewritten === command) return { command, reason: 'unchanged' };

    state.rewrites++;
    if (state.firstRewrite) {
      state.firstRewrite = false;
      log('info', `[dsh-rtk] 首次改写已执行（示例：${command.split('\n')[0].slice(0, 80)}）`);
      flush(true);
    } else if (config.verbose === true) {
      log('info', `[dsh-rtk] rewrite: ${command.split('\n')[0].slice(0, 120)}`);
      flush();
    } else {
      flush();
    }
    return { command: rewritten, reason: 'rewritten' };
  }

  /** Warn once per distinct failure signature; `gone` re-enables discovery. */
  function reportFailure(found, reason, detail, gone) {
    state.lastError = { at: new Date().toISOString(), reason, detail: String(detail).slice(0, 400), bin: found.bin };
    const key = `${reason}:${String(detail).slice(0, 120)}`;
    if (!state.reported.has(key)) {
      state.reported.add(key);
      log('warn', `[dsh-rtk] ${reason}：${found.bin}\n${String(detail).slice(0, 400)}`);
    }
    if (gone) invalidate(reason, detail);
    else flush(true);
  }

  /** Resolve and announce now, so boot logs answer "did it take effect?". */
  function start() {
    const found = resolution();
    flush(true);
    return found;
  }

  return {
    config,
    start,
    rewrite,
    resolution,
    invalidate,
    statusPath,
    state,
    /** Snapshot for `npm run doctor` and tests. */
    snapshot: () => ({
      active: state.resolution?.ok === true,
      bin: state.resolution?.bin ?? null,
      source: state.resolution?.source ?? null,
      version: state.resolution?.version ?? null,
      reason: state.resolution?.ok === true ? null : state.resolution?.reason ?? null,
      rewrites: state.rewrites,
      skipped: state.skipped,
      passthrough: state.passthrough,
      lastError: state.lastError,
      statusPath,
    }),
  };
}

/** Log through the DSH logger when the host provides one, else through the console. */
function emit(ctx, level, message) {
  let delivered = false;
  try {
    const logger = ctx?.logger;
    if (logger !== undefined && typeof logger[level] === 'function') {
      logger[level](message);
      delivered = true;
    }
  } catch {
    /* fall through to the console */
  }
  // Failures additionally go to stderr: the DSH shell keeps the host's stderr for
  // crash reports, which is often the only sink a desktop user can inspect.
  if (level === 'error') console.error(message);
  else if (level === 'warn') console.warn(message);
  else if (!delivered) console.log(message);
}

let legacyKey = null;
let legacyRuntime = null;

/**
 * Backward-compatible one-shot helper. Uses `RTK_BIN`/discovery for the current
 * environment and re-resolves whenever `RTK_BIN` changes.
 *
 * @param command - raw bash command.
 * @returns the rewritten command, or the input unchanged.
 */
export function rewriteWithRtk(command) {
  const key = String(process.env[BIN_ENV] ?? '');
  if (legacyKey !== key || legacyRuntime === null) {
    legacyKey = key;
    legacyRuntime = createRtkRuntime({ config: { statusFile: false } });
  }
  return legacyRuntime.rewrite(command).command;
}

export function apply(ctx, config = {}) {
  const settings = config ?? {};
  if (settings.enabled === false) {
    emit(ctx, 'info', '[dsh-rtk] 已按配置禁用（enabled: false），bash 命令不会被改写');
    return;
  }

  const runtime = createRtkRuntime({
    config: settings,
    log: (level, message) => emit(ctx, level, message),
  });
  runtime.start();

  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== BASH_TOOL || typeof exec.arguments?.command !== 'string' || exec.signal?.aborted) return next();
    const original = exec.arguments;
    const outcome = runtime.rewrite(original.command);
    if (outcome.command === original.command) return next();
    // DSH freezes the argument snapshot; replace it rather than mutating it.
    // Keep workdir, timeout, sandbox permissions and justification intact.
    exec.arguments = Object.freeze({ ...original, command: outcome.command });
    try {
      return await next();
    } finally {
      exec.arguments = original;
    }
  });

  if (settings.verbose === true) emit(ctx, 'info', '[dsh-rtk] tools/execute hook registered');
}
