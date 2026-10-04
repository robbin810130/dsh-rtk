/**
 * dsh-rtk — rewrite shell commands through the local RTK binary before they run.
 *
 * Integration point: DSH's supported `tools/execute` around-dispatch hook
 * (dsh-tools' `ctx.waterfall(carrier, 'tools/execute', exec, next)`). No host
 * file is patched, so a DSH update can never leave a half-applied edit behind.
 *
 * Cross-platform by construction:
 *
 *  - DSH registers `bash` on macOS/Linux and `pwsh` on Windows (`tool-bash` and
 *    `tool-pwsh` are disabled by platform in dsh-base), and the persistent tools
 *    reuse those same names. The hook therefore matches shell tools by dialect
 *    rather than by one hard-coded name.
 *  - Quoting follows the dialect: POSIX single quotes for bash/sh, PowerShell
 *    single quotes (`''` escaping) for pwsh/powershell.
 *  - Discovery candidates, executable-form checks and the per-command opt-out
 *    syntax all follow the platform.
 *
 * Three rules make "installed" equal to "working":
 *
 *  1. Zero-config discovery. RTK is resolved from `config.bin`, then the
 *     `RTK_BIN` environment variable, then — only when neither is set — a short
 *     allowlist of well-known install locations for the current platform. The
 *     PATH is never searched, and every auto-discovered candidate must be a
 *     trusted regular file that answers `--version` with `rtk <x.y.z>`.
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
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';
import z from 'schemastery';

export const name = 'dsh-rtk';
export const inject = [];

/**
 * This package's version, read from the manifest that sits beside the entry
 * point. Recorded in the status file so `doctor` can tell "the installed version
 * is running" apart from "the previous version is still running".
 */
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? null;
  } catch {
    return null;
  }
})();

export { PLUGIN_VERSION };

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
/** Human `/rtk` self-check command, shown in the session without creating a model message. */
const COMMAND_NAME = 'rtk';
const COMMAND_USAGE = [
  '用法：/rtk [status|recheck|doctor|gain]',
  '  status  （默认）当前状态：RTK 路径/版本、改写计数、配置',
  '  recheck 重新探测 RTK（刚装好 rtk、又不想重启 DSH 时用）',
  '  doctor  完整自检：二进制、各 profile 安装版本、运行中的宿主进程',
  '  gain    RTK 节省统计；可加 summary|daily|weekly|monthly|history|project|json',
].join('\n');
/**
 * Read-only `rtk gain` forms. User text is mapped onto this allowlist instead of
 * being forwarded, so a typo can never reach a state-changing flag such as
 * `--reset`.
 */
const GAIN_FORMS = {
  '': [],
  summary: [],
  daily: ['-d'],
  weekly: ['-w'],
  monthly: ['-m'],
  history: ['-H'],
  project: ['-p'],
  json: ['-f', 'json'],
};
/** Keep one command reply readable in the session panel. */
const GAIN_MAX_LINES = 40;

/** Shell dialects: how to quote a path, how the user opts out per command, where a command starts. */
const DIALECTS = {
  posix: {
    id: 'posix',
    shells: ['bash', 'sh', 'dash', 'zsh', 'ksh'],
    quote: (value) => "'" + value.replaceAll("'", "'\\''") + "'",
    disabled: /(^|[\s;&|])DSH_RTK_DISABLE\s*=\s*1\b/,
    commandStart: /(^|[\n;&|]\s*|(?:^|[\s;&|])(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|]*\s+)+)\brtk\b/g,
  },
  powershell: {
    id: 'powershell',
    shells: ['pwsh', 'powershell'],
    // PowerShell single quotes are literal; an embedded quote is doubled.
    quote: (value) => "'" + value.replaceAll("'", "''") + "'",
    disabled: /(^|[\s;&|])\$env:DSH_RTK_DISABLE\s*=\s*['"]?1['"]?\b/i,
    commandStart: /(^|[\n;&|({]\s*)\brtk\b/g,
  },
};

/**
 * Well-known RTK install locations per platform, in preference order. Only these
 * paths are ever probed without an explicit setting; PATH is not searched,
 * because RTK receives raw command text.
 */
export const POSIX_CANDIDATES = [
  '/opt/homebrew/bin/rtk',
  '/usr/local/bin/rtk',
  '/home/linuxbrew/.linuxbrew/bin/rtk',
  '/usr/bin/rtk',
  '~/.local/bin/rtk',
  '~/.cargo/bin/rtk',
];
export const WINDOWS_CANDIDATES = [
  '%USERPROFILE%\\.cargo\\bin\\rtk.exe',
  '%LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\rtk.exe',
  '%USERPROFILE%\\scoop\\shims\\rtk.exe',
  '%ProgramData%\\chocolatey\\bin\\rtk.exe',
  '%ProgramFiles%\\rtk\\rtk.exe',
];

/**
 * Candidate list for one platform.
 *
 * @param platform - `process.platform` value.
 * @returns a fresh array of candidate paths.
 */
export function platformCandidates(platform = process.platform) {
  return platform === 'win32' ? [...WINDOWS_CANDIDATES] : [...POSIX_CANDIDATES];
}

export const DISCOVERY_CANDIDATES = platformCandidates();

/** The dialect a tool name speaks, or `null` when the tool is not a shell. */
export function dialectForTool(toolName) {
  if (typeof toolName !== 'string' || toolName.length === 0) return null;
  const lower = toolName.toLowerCase();
  for (const [id, dialect] of Object.entries(DIALECTS)) {
    if (dialect.shells.includes(lower)) return id;
  }
  // Renamed/persistent shell tools carry the dialect on either side of a
  // separator (`bash-persistent`, `persistent-bash`, `tool:pwsh`).
  if (/(^|[-_:])bash$/.test(lower) || /(^|[-_:])sh$/.test(lower) || /^bash([-_:]|$)/.test(lower) || /^sh([-_:]|$)/.test(lower)) return 'posix';
  if (/(^|[-_:])(pwsh|powershell)$/.test(lower) || /^(pwsh|powershell)([-_:]|$)/.test(lower)) return 'powershell';
  return null;
}

/** The dialect used when no tool name is known (direct API use, tests). */
export function defaultDialect(platform = process.platform) {
  return platform === 'win32' ? 'powershell' : 'posix';
}

/** Case-insensitive environment lookup; Windows exposes variables in mixed case. */
function envValue(env, name) {
  const direct = env[name];
  if (typeof direct === 'string') return direct;
  const upper = name.toUpperCase();
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === upper && typeof env[key] === 'string') return env[key];
  }
  return undefined;
}

/** Expand `~` and `%VAR%` in one candidate; unresolved variables fail inspection later. */
function expandCandidate(candidate, env) {
  let value = candidate;
  if (value === '~' || value.startsWith('~/')) {
    value = join(envValue(env, 'HOME')?.trim() || envValue(env, 'USERPROFILE')?.trim() || homedir(), value.slice(1));
  }
  if (!value.includes('%')) return value;
  const fallback = {
    USERPROFILE: envValue(env, 'USERPROFILE') ?? envValue(env, 'HOME') ?? homedir(),
    LOCALAPPDATA: envValue(env, 'LOCALAPPDATA') ?? join(envValue(env, 'USERPROFILE') ?? homedir(), 'AppData', 'Local'),
    PROGRAMDATA: envValue(env, 'ProgramData') ?? 'C:\\ProgramData',
    PROGRAMFILES: envValue(env, 'ProgramFiles') ?? 'C:\\Program Files',
  };
  return value.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, variable) => {
    const upper = variable.toUpperCase();
    return envValue(env, variable) ?? fallback[upper] ?? match;
  });
}

/**
 * Validate one candidate path without executing it.
 *
 * @param candidate - absolute path, or a `~/`- / `%VAR%`-based path.
 * @param env - environment used to expand the candidate.
 * @param platform - platform whose trust rules apply.
 * @returns `{ ok, path, reason }`, where `reason` explains a rejection.
 */
export function inspectBinary(candidate, env = process.env, platform = process.platform) {
  const path = expandCandidate(candidate, env);
  if (!isAbsolute(path)) return { ok: false, path, reason: '不是绝对路径' };
  let real;
  let stats;
  try {
    real = realpathSync(path);
    stats = statSync(real);
  } catch (error) {
    return { ok: false, path, reason: error?.code === 'ENOENT' ? '不存在' : `无法解析（${error?.code ?? error}）` };
  }
  if (!stats.isFile()) return { ok: false, path, reason: '不是常规文件' };

  if (platform === 'win32') {
    // Windows carries no meaningful POSIX mode/owner bits; the executable form is
    // the trust signal. `.cmd`/`.bat` shims are rejected rather than run through a
    // shell, which would re-interpret the command text.
    if (!/\.(exe|com)$/i.test(real)) return { ok: false, path, reason: 'Windows 下只接受 .exe/.com 可执行文件' };
    return { ok: true, path, reason: '' };
  }

  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
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

function missingHint(checked, platform) {
  const install = platform === 'win32'
    ? '从 https://github.com/rtk-ai/rtk 安装 Windows 版 rtk.exe（scoop/winget/手动解压均可）'
    : '`brew install rtk`（其他平台见 https://github.com/rtk-ai/rtk）';
  const shellHint = platform === 'win32'
    ? `setx ${BIN_ENV} "C:\\path\\to\\rtk.exe"（或写进 PowerShell 的 $PROFILE）`
    : `在 DSH 服务进程的环境里设置 \`${BIN_ENV}=/absolute/path/to/rtk\`（桌面版写进 ~/.zshrc 后完全退出并重开 App）`;
  return [
    'RTK 没有找到，命令输出不会被压缩。',
    `已检查：${checked.length > 0 ? checked.join('、') : '（自动发现已关闭）'}`,
    '修复任一即可：',
    `  1) 安装 RTK：${install}，然后重启 DSH；`,
    `  2) 显式指定：${shellHint}；`,
    `  3) 或在 profile 的 cordis.patch.yml 里给 dsh-rtk 配置 \`bin: ${platform === 'win32' ? 'C:\\\\path\\\\to\\\\rtk.exe' : '/absolute/path/to/rtk'}\`。`,
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
 * @param options.platform - platform whose candidates and trust rules apply.
 * @param options.candidates - candidate list override (tests, doctor).
 * @param options.probe - version probe override.
 * @returns `{ ok, bin, source, version, reason, hint, checked }`.
 */
export function resolveRtkBin(options = {}) {
  const env = options.env ?? process.env;
  const config = options.config ?? {};
  const platform = options.platform ?? process.platform;
  const candidates = options.candidates ?? platformCandidates(platform);
  const probe = options.probe ?? probeVersion;
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
  const missing = { ok: false, bin: null, source: null, version: null, platform, checked: [] };

  const explicit = [
    ['config.bin', String(config.bin ?? '').trim()],
    [BIN_ENV, String(envValue(env, BIN_ENV) ?? '').trim()],
  ].find(([, value]) => value.length > 0);
  if (explicit !== undefined) {
    const [source, value] = explicit;
    const inspection = inspectBinary(value, env, platform);
    if (!inspection.ok) {
      return { ...missing, source, hint: explicitHint(source, value, inspection.reason), reason: `${source} 不可用（${inspection.reason}）` };
    }
    return { ok: true, bin: inspection.path, source, version: probe(inspection.path, timeoutMs), platform, reason: '', hint: '', checked: [] };
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
    const inspection = inspectBinary(candidate, env, platform);
    if (!inspection.ok) {
      checked.push(`${inspection.path}（${inspection.reason}）`);
      continue;
    }
    const version = probe(inspection.path, timeoutMs);
    if (version === null) {
      checked.push(`${inspection.path}（不是 RTK：--version 未返回 "rtk <版本>"）`);
      continue;
    }
    return { ok: true, bin: inspection.path, source: 'discovered', version, platform, reason: '', hint: '', checked: [] };
  }
  return { ...missing, checked, reason: '未找到可用的 RTK 二进制', hint: missingHint(checked, platform) };
}

/** `.../profiles/<name>` → `<name>`; anything else → `null`. */
function profileName(cwd = process.cwd()) {
  const parts = cwd.split(sep);
  const index = parts.lastIndexOf('profiles');
  if (index === -1 || index === parts.length - 1) return null;
  return parts[index + 1] || null;
}

function resolveStatusPath(env) {
  const home = String(envValue(env, 'DSH_HOME') ?? '').trim() || join(homedir(), '.dsh');
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
  const spawn = options.spawn ?? spawnSync;
  const platform = options.platform ?? process.platform;
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
        pluginVersion: PLUGIN_VERSION,
        pid: process.pid,
        profile: profileName(),
        platform,
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
      log('info', `[dsh-rtk] 已生效 — ${version} @ ${resolution.bin}（来源：${resolution.source}，平台：${platform}${profile === null ? '' : `，profile：${profile}`}）`);
    } else {
      log('warn', `[dsh-rtk] 未生效：${resolution.reason}\n${resolution.hint}`);
    }
    flush(true);
  }

  function resolution() {
    const cached = state.resolution;
    if (cached !== null && (cached.ok || clock() - state.resolvedAt < RETRY_MISSING_MS)) return cached;
    state.resolution = resolveRtkBin({ config, env, platform, candidates: options.candidates });
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
   * Rewrite one command for a shell dialect.
   *
   * @param command - raw command text.
   * @param dialectId - `posix` or `powershell`; defaults to the current platform.
   * @returns `{ command, reason }`; `command` is the original string whenever
   * rewriting is not possible, so callers can fail open.
   */
  function rewrite(command, dialectId = defaultDialect(platform)) {
    const dialect = DIALECTS[dialectId] ?? DIALECTS[defaultDialect(platform)];
    if (envValue(env, DISABLE_ENV) === '1' || command.trim().length === 0) return { command, reason: 'disabled' };
    if (dialect.disabled.test(command)) return { command, reason: 'disabled-command' };

    const found = resolution();
    if (!found.ok) {
      state.skipped++;
      flush();
      return { command, reason: 'no-rtk' };
    }

    let result;
    try {
      result = spawn(found.bin, ['rewrite', command], {
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
    const rewritten = suggestion.replace(dialect.commandStart, (_match, prefix) => prefix + dialect.quote(found.bin));
    if (rewritten === command) return { command, reason: 'unchanged' };

    state.rewrites++;
    if (state.firstRewrite) {
      state.firstRewrite = false;
      log('info', `[dsh-rtk] 首次改写已执行（${dialect.id}，示例：${command.split('\n')[0].slice(0, 80)}）`);
      flush(true);
    } else if (config.verbose === true) {
      log('info', `[dsh-rtk] rewrite（${dialect.id}）: ${command.split('\n')[0].slice(0, 120)}`);
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

  /**
   * Drop the cached resolution and probe again — lets a user who installed RTK
   * after DSH started pick it up without restarting the app.
   */
  function recheck() {
    state.resolution = null;
    state.resolvedAt = 0;
    const found = resolution();
    flush(true);
    return found;
  }

  /**
   * Run a read-only RTK subcommand with the resolved binary (`/rtk gain`).
   *
   * @param subcommand - RTK subcommand such as `gain`.
   * @param args - argv entries appended verbatim; callers pass trusted constants.
   * @returns `{ ok, status, stdout, stderr, bin, version, reason, hint }`.
   */
  function run(subcommand, args = [], runOptions = {}) {
    const found = resolution();
    const failed = (reason, hint) => ({ ok: false, status: null, stdout: '', stderr: '', bin: found.ok ? found.bin : null, version: null, reason, hint });
    if (!found.ok) return failed(found.reason, found.hint);
    let result;
    try {
      result = spawn(found.bin, [subcommand, ...args], {
        encoding: 'utf8',
        timeout: runOptions.timeoutMs ?? timeoutMs,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      return failed('rtk 无法启动', error?.message ?? String(error));
    }
    if (result.error) {
      const detail = result.error.message;
      if (['ENOENT', 'EACCES', 'EPERM'].includes(result.error.code)) invalidate(`rtk 调用失败（${result.error.code}）`, detail);
      return failed(`rtk 调用失败（${result.error.code ?? 'unknown'}）`, detail);
    }
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: (result.stderr ?? '').trim(),
      bin: found.bin,
      version: found.version,
      reason: result.status === 0 ? null : `rtk ${subcommand} 退出码 ${result.status}`,
      hint: null,
    };
  }

  return {
    config,
    start,
    recheck,
    run,
    rewrite,
    resolution,
    invalidate,
    statusPath,
    state,
    /** Snapshot for `/rtk`, `npm run doctor` and tests. */
    snapshot: () => ({
      active: state.resolution?.ok === true,
      bin: state.resolution?.bin ?? null,
      source: state.resolution?.source ?? null,
      version: state.resolution?.version ?? null,
      pluginVersion: PLUGIN_VERSION,
      platform,
      timeoutMs,
      reason: state.resolution?.ok === true ? null : state.resolution?.reason ?? null,
      hint: state.resolution?.ok === true ? null : state.resolution?.hint ?? null,
      rewrites: state.rewrites,
      skipped: state.skipped,
      passthrough: state.passthrough,
      lastError: state.lastError,
      statusPath,
    }),
  };
}

/** The `/rtk` reply: what is active, what has been rewritten, and how to opt out. */
export function formatStatus(runtime) {
  const snapshot = runtime.snapshot();
  const config = runtime.config ?? {};
  const shellTool = snapshot.platform === 'win32' ? 'pwsh' : 'bash';
  const dialect = defaultDialect(snapshot.platform) === 'powershell' ? 'PowerShell' : 'POSIX';
  const lines = [`dsh-rtk ${snapshot.pluginVersion ?? '?'} · ${snapshot.platform} · 挂载 ${shellTool} 工具（${dialect} 引用）`];
  if (snapshot.active) {
    const version = snapshot.version === null ? '版本未知' : `rtk ${snapshot.version}`;
    lines.push(`状态：已生效 —— ${version} @ ${snapshot.bin}（来源：${snapshot.source}）`);
  } else {
    lines.push(`状态：未生效 —— ${snapshot.reason ?? '未知原因'}`);
    if (typeof snapshot.hint === 'string') lines.push(...snapshot.hint.split('\n').filter((line) => line.length > 0));
  }
  lines.push(`改写 ${snapshot.rewrites} 次 · 无等价命令 ${snapshot.passthrough} 次 · 未改写 ${snapshot.skipped} 次`);
  lines.push(`配置：autoDiscover=${config.autoDiscover !== false} bin=${String(config.bin ?? '').length > 0 ? config.bin : '（未设置）'} timeoutMs=${snapshot.timeoutMs} verbose=${config.verbose === true} statusFile=${config.statusFile !== false}`);
  if (snapshot.statusPath !== null) lines.push(`状态文件：${snapshot.statusPath}`);
  if (snapshot.lastError !== null) lines.push(`最近错误：${snapshot.lastError.reason}（${snapshot.lastError.at}）`);
  if (snapshot.active) {
    lines.push(snapshot.platform === 'win32'
      ? "临时跳过改写：$env:DSH_RTK_DISABLE='1'; <命令>"
      : '临时跳过改写：DSH_RTK_DISABLE=1 <命令>');
  }
  return lines.join('\n');
}

/**
 * Register `/rtk` when the profile composes the human-command service. The
 * service is optional, so the plugin stays silent in command-less profiles.
 * Exported so the command surface can be tested against a chosen runtime.
 */
export function registerCommands(ctx, runtime) {
  if (typeof ctx.inject !== 'function') return;
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: COMMAND_NAME,
      description: '查看 dsh-rtk 状态、完整自检或 RTK 节省统计',
      input: { hint: '[status|recheck|doctor|gain]' },
      handler: async (invocation) => {
        const input = String(invocation?.rawInput ?? '').trim().toLowerCase();
        if (input === '' || input === 'status') return { kind: 'success', text: formatStatus(runtime) };
        if (input === 'recheck') {
          const found = runtime.recheck();
          const header = found.ok ? '已重新探测 RTK。' : '重新探测后仍未找到可用的 RTK。';
          return { kind: found.ok ? 'success' : 'error', text: `${header}\n${formatStatus(runtime)}` };
        }
        if (input === 'doctor') {
          // Same code path as `npm run doctor`; loaded lazily so a profile that
          // never runs it does not pay for process inspection at boot.
          const { runDoctor } = await import('./doctor.js');
          const report = runDoctor({
            resolution: runtime.resolution(),
            resolutionLabel: '插件进程内解析',
          });
          return { kind: report.ok ? 'success' : 'error', text: report.lines.join('\n') };
        }
        if (input === 'gain' || input.startsWith('gain ')) {
          const form = input.slice('gain'.length).trim();
          if (!Object.hasOwn(GAIN_FORMS, form)) {
            return { kind: 'error', text: `未知的 gain 形式「${form}」。\n${COMMAND_USAGE}` };
          }
          const result = runtime.run('gain', GAIN_FORMS[form]);
          if (!result.ok) {
            return { kind: 'error', text: [result.reason, result.hint].filter((line) => typeof line === 'string' && line.length > 0).join('\n') };
          }
          const body = result.stdout.trim().split('\n');
          const clipped = body.length > GAIN_MAX_LINES
            ? [...body.slice(0, GAIN_MAX_LINES), `…（已截断，共 ${body.length} 行；完整输出可在终端直接跑 rtk gain）`]
            : body;
          return { kind: 'success', text: [`rtk ${result.version ?? '?'} @ ${result.bin}`, ...clipped].join('\n') };
        }
        return { kind: 'error', text: COMMAND_USAGE };
      },
    });
  });
}

/**
 * Build the `tools/execute` around-dispatch hook for one runtime. Exported so the
 * hook contract can be exercised without booting a DSH profile.
 */
export function createToolHook(runtime) {
  return async (exec, next) => {
    const dialect = dialectForTool(exec?.name);
    if (dialect === null || typeof exec.arguments?.command !== 'string' || exec.signal?.aborted) return next();
    const original = exec.arguments;
    const outcome = runtime.rewrite(original.command, dialect);
    if (outcome.command === original.command) return next();
    // DSH freezes the argument snapshot; replace it rather than mutating it.
    // Keep workdir, timeout, sandbox permissions and justification intact.
    exec.arguments = Object.freeze({ ...original, command: outcome.command });
    try {
      return await next();
    } finally {
      exec.arguments = original;
    }
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
 * @param command - raw command.
 * @param dialectId - shell dialect; defaults to the current platform's.
 * @returns the rewritten command, or the input unchanged.
 */
export function rewriteWithRtk(command, dialectId = defaultDialect()) {
  const key = String(process.env[BIN_ENV] ?? '');
  if (legacyKey !== key || legacyRuntime === null) {
    legacyKey = key;
    legacyRuntime = createRtkRuntime({ config: { statusFile: false } });
  }
  return legacyRuntime.rewrite(command, dialectId).command;
}

export function apply(ctx, config = {}) {
  const settings = config ?? {};
  if (settings.enabled === false) {
    emit(ctx, 'info', '[dsh-rtk] 已按配置禁用（enabled: false），命令不会被改写');
    return;
  }

  const runtime = createRtkRuntime({
    config: settings,
    log: (level, message) => emit(ctx, level, message),
  });
  runtime.start();

  ctx.on('tools/execute', createToolHook(runtime));
  registerCommands(ctx, runtime);

  if (settings.verbose === true) {
    const tools = Object.values(DIALECTS).flatMap((dialect) => dialect.shells).join('/');
    emit(ctx, 'info', `[dsh-rtk] tools/execute hook registered（匹配 shell 工具：${tools}），/rtk 可用`);
  }
}
