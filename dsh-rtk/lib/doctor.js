/**
 * dsh-rtk doctor — answer "装完之后到底生效了吗" without guessing.
 *
 * One implementation, two callers: `scripts/doctor.mjs` (CLI, `npm run doctor`)
 * and the in-session `/rtk doctor` command. It reports
 *   1. whether a usable RTK binary is reachable (and from which source),
 *   2. which DSH profiles actually carry the plugin bundle,
 *   3. what the running DSH host processes carry, and what the plugin recorded
 *      in its status file the last time it booted.
 *
 * `ok === true` means "a restart of the profile below will rewrite commands";
 * the CLI maps that to its exit code.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { inspectBinary, platformCandidates, PLUGIN_VERSION, probeVersion, resolveRtkBin } from './index.js';

/** Running dsh host processes, with the settings the plugin would actually see. */
export function runningHosts(platform = process.platform) {
  try {
    if (platform === 'win32') {
      // `ps` does not exist on Windows; Win32_Process still reports the command line,
      // though (unlike `ps eww`) it cannot expose the child's environment.
      const listing = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*dsh-desktop-host*' } | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }",
      ], { encoding: 'utf8', timeout: 20000 });
      return listing
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const [pid, command = ''] = line.split('\t');
          return {
            pid: Number.parseInt(pid, 10),
            profile: /profiles[\\/]([^\s\\/]+)/.exec(command)?.[1] ?? null,
            rtkBin: null,
            disabled: null,
          };
        })
        .filter((host) => Number.isFinite(host.pid));
    }
    const listing = execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' });
    return listing
      .split('\n')
      .filter((line) => line.includes('dsh-desktop-host/lib/index.js'))
      .map((line) => {
        const pid = Number.parseInt(line.trim().split(/\s+/)[0], 10);
        let environment = '';
        try {
          environment = execFileSync('ps', ['eww', '-p', String(pid)], { encoding: 'utf8' });
        } catch {
          /* ps may refuse; the status file still covers this case */
        }
        return {
          pid,
          profile: /profiles\/([^\s/]+)/.exec(line)?.[1] ?? null,
          rtkBin: /(?:^|\s)RTK_BIN=([^\s]*)/.exec(environment)?.[1] || null,
          disabled: /(?:^|\s)DSH_RTK_DISABLE=([^\s]*)/.exec(environment)?.[1] || null,
        };
      })
      .filter((host) => Number.isFinite(host.pid));
  } catch {
    // A blocked or unavailable process listing must not turn into a false alarm.
    return [];
  }
}

/** Whether one pid is still running; the status record is only evidence if it lives. */
export function isProcessAlive(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (platform === 'win32') {
    try {
      return execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', timeout: 10000 }).includes(String(pid));
    } catch {
      return true;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Explicitly disabled by a profile-level patch entry (`- id: dsh-rtk` + `disabled: true`). */
function disabledInPatch(path) {
  if (!existsSync(path)) return false;
  try {
    const text = readFileSync(path, 'utf8');
    const block = /(^|\n)\s*-\s*id:\s*dsh-rtk\b([\s\S]*?)(?=\n\s*-\s|\s*$)/.exec(text);
    return block !== null && /(^|\n)\s*disabled:\s*true\b/.test(block[2]);
  } catch {
    return false;
  }
}

/** Every profile that carries the plugin bundle. */
export function installedProfiles(dshHome) {
  const profilesRoot = join(dshHome, 'profiles');
  if (!existsSync(profilesRoot)) return [];
  const found = [];
  for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(profilesRoot, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      continue;
    }
    const dependency = Object.entries(manifest.dependencies ?? {}).find(([key]) => key === 'dsh-rtk');
    const bundle = (manifest.dsh?.profile?.bundles ?? []).includes('dsh-rtk');
    if (dependency === undefined && !bundle) continue;
    const problems = [];
    if (!bundle) problems.push('未加入 dsh.profile.bundles');
    const installedManifest = join(profilesRoot, entry.name, 'node_modules', 'dsh-rtk', 'package.json');
    if (!existsSync(installedManifest)) problems.push('node_modules 下缺少包');
    if (disabledInPatch(join(profilesRoot, entry.name, 'cordis.patch.yml'))) problems.push('被 profile 补丁禁用（disabled: true）');
    let installedVersion = null;
    try {
      installedVersion = JSON.parse(readFileSync(installedManifest, 'utf8')).version ?? null;
    } catch {
      /* reported as a missing package above */
    }
    found.push({ profile: entry.name, dependency: dependency?.[1] ?? null, bundle, installedVersion, problems });
  }
  return found;
}

function readStatus(dshHome) {
  const path = join(dshHome, 'dsh-rtk', 'status.json');
  if (!existsSync(path)) return null;
  try {
    const status = JSON.parse(readFileSync(path, 'utf8'));
    // A status file written by a test run is not evidence about the real host.
    return status.pid === undefined ? null : status;
  } catch {
    return null;
  }
}

/**
 * Build one doctor report.
 *
 * Every input is injectable so tests stay hermetic and `/rtk doctor` can reuse
 * the plugin's own resolution instead of re-deriving it from its environment.
 *
 * @param options.env - environment to read `DSH_HOME` / `RTK_BIN` from.
 * @param options.platform - platform whose rules apply.
 * @param options.dshHome - harness home; defaults to `$DSH_HOME` or `~/.dsh`.
 * @param options.bin - explicit RTK path override (CLI `--bin=`).
 * @param options.resolution - pre-computed resolution (the in-session caller).
 * @param options.resolutionLabel - how section [1] describes its source.
 * @param options.hosts - process listing override; pass `[]` to skip inspection.
 * @param options.profiles - installed-profile listing override.
 * @param options.status - status record override.
 * @returns `{ ok, lines, json }`.
 */
export function runDoctor(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const version = options.version ?? PLUGIN_VERSION;
  const dshHome = options.dshHome ?? ((String(env.DSH_HOME ?? '').trim()) || join(homedir(), '.dsh'));
  const resolution = options.resolution ?? resolveRtkBin({ config: { bin: options.bin ?? '' }, env, platform });
  const resolutionLabel = options.resolutionLabel ?? '按本命令的环境解析';
  const probes = platformCandidates(platform).map((candidate) => {
    const inspection = inspectBinary(candidate, env, platform);
    return { candidate, path: inspection.path, ok: inspection.ok, reason: inspection.reason, version: inspection.ok ? probeVersion(inspection.path) : null };
  });
  const profiles = options.profiles ?? installedProfiles(dshHome);
  const hosts = options.hosts ?? runningHosts(platform);
  const status = options.status !== undefined ? options.status : readStatus(dshHome);
  /** DSH disables tool-bash on Windows and tool-pwsh elsewhere; the plugin follows the same split. */
  const shellTool = platform === 'win32' ? 'pwsh' : 'bash';
  const profileNames = new Set(profiles.map((entry) => entry.profile));
  const hostUncovered = hosts.find((host) => host.profile !== null && !profileNames.has(host.profile)) ?? null;
  const hostDisabled = hosts.find((host) => host.disabled === '1' || host.disabled === 'true') ?? null;
  // The plugin writes the status file on every boot it participates in, so a record
  // is only evidence when its pid belongs to a host that is still running (matched
  // against the process listing where one exists, otherwise checked for liveness).
  const statusHost = status === null ? null : hosts.find((host) => host.pid === status.pid) ?? null;
  const statusLive = status !== null && (hosts.length > 0 ? statusHost !== null : isProcessAlive(status.pid, platform));
  const statusIsStale = status !== null && !statusLive;
  // A live pid is not enough after an upgrade: the running host may still hold the
  // previous version in memory while the profile already carries a newer one.
  const installedForHost = status?.profile == null ? null : profiles.find((entry) => entry.profile === status.profile)?.installedVersion ?? null;
  const statusIsOutdated = statusLive
    && typeof status.pluginVersion === 'string'
    && installedForHost !== null
    && status.pluginVersion !== installedForHost;
  // Records written before 1.3.1 carry no version, so fall back to "was this host
  // started before the installed package was written?".
  const hostManifest = status?.profile == null ? null : join(dshHome, 'profiles', status.profile, 'node_modules', 'dsh-rtk', 'package.json');
  let installedAt = null;
  try {
    installedAt = hostManifest !== null && existsSync(hostManifest) ? statSync(hostManifest).mtimeMs : null;
  } catch {
    installedAt = null;
  }
  const statusStartedMs = status === null ? null : Date.parse(status.startedAt);
  const statusPredatesInstall = statusLive
    && typeof status.pluginVersion !== 'string'
    && installedAt !== null
    && Number.isFinite(statusStartedMs)
    && statusStartedMs < installedAt;
  const runtimeSeen = statusLive && !statusIsOutdated && !statusPredatesInstall;
  const ok = resolution.ok
    && profiles.some((entry) => entry.problems.length === 0)
    && hostUncovered === null
    && hostDisabled === null
    && runtimeSeen;

  const lines = [];
  const say = (line = '') => lines.push(line);
  say(`dsh-rtk doctor — v${version}`);
  say(`DSH_HOME: ${dshHome}   platform: ${platform}   node: ${process.version}`);
  say(`本平台加载的 shell 工具：${shellTool}（DSH 在 Windows 上用 pwsh，其他平台用 bash）`);
  say();
  say(`[1] RTK 二进制（${resolutionLabel}）`);
  if (resolution.ok) {
    say(`    ✅ ${resolution.bin}${resolution.version === null ? '' : `（rtk ${resolution.version}）`} —— 来源：${resolution.source}`);
  } else {
    say(`    ❌ ${resolution.reason}`);
    for (const line of String(resolution.hint ?? '').split('\n')) say(`    ${line}`);
  }
  if (!resolution.ok || resolution.source === 'discovered') {
    say('    候选路径：');
    for (const probe of probes) {
      say(`      ${probe.ok ? `✅ rtk ${probe.version}` : '❌'} ${probe.path}${probe.ok ? '' : ` —— ${probe.reason}`}`);
    }
  }
  say();
  say('[2] 插件安装位置');
  if (profiles.length === 0) {
    say(`    ❌ ${join(dshHome, 'profiles')} 下没有任何 profile 安装 dsh-rtk`);
    say(`       安装：dsh plugin --profile <profile> add github:robbin810130/dsh-rtk#v${version}`);
  } else {
    for (const entry of profiles) {
      say(`    ${entry.problems.length === 0 ? '✅' : '❌'} profile ${entry.profile}${entry.installedVersion === null ? '' : ` · v${entry.installedVersion}`}${entry.dependency === null ? '' : `（${entry.dependency}）`}${entry.problems.length === 0 ? '' : ` —— ${entry.problems.join('；')}`}`);
    }
  }
  say();
  say('[3] 运行中的宿主进程');
  if (hosts.length === 0) {
    const listing = platform === 'win32' ? 'Win32_Process 查询不可用' : 'ps 不可用或无匹配进程';
    say(`    未发现 dsh-desktop-host 进程（${listing}；CLI 启动的 dsh web / tui 的宿主进程不在统计内）`);
  } else {
    for (const host of hosts) {
      const covered = host.profile === null || profileNames.has(host.profile);
      const blocked = host.disabled === '1' || host.disabled === 'true';
      const environment = platform === 'win32' ? '（Windows 无法读取子进程环境）' : `RTK_BIN=${host.rtkBin ?? '（未设置）'}`;
      say(`    ${covered && !blocked ? '✅' : '❌'} pid ${host.pid}${host.profile === null ? '' : ` · profile ${host.profile}`} · ${environment}${blocked ? ` · DSH_RTK_DISABLE=${host.disabled}（本次进程已全局关闭改写）` : ''}`);
    }
    if (hostUncovered !== null) {
      say(`    ⚠️  宿主用的 profile「${hostUncovered.profile}」没有安装 dsh-rtk，插件不会被加载`);
    }
    const hostBin = hosts.find((host) => host.rtkBin !== null)?.rtkBin ?? null;
    if (hostBin !== null && resolution.source !== 'RTK_BIN' && hostBin !== resolution.bin) {
      say(`    ⚠️  宿主进程里的 RTK_BIN=${hostBin} 优先于本命令的解析结果，插件会以宿主环境为准`);
    }
  }
  if (status === null) {
    if (hosts.length > 0) {
      say(`    ❌ 运行中的宿主没有留下本版本的启动记录（缺少 ${join(dshHome, 'dsh-rtk', 'status.json')}）`);
      say('       刚装完还没重启 → 完全退出并重开 DSH；否则检查宿主 profile 是否正确，以及启动输出里是否出现 failed to import / did not activate');
    } else {
      say(`    尚无 ${join(dshHome, 'dsh-rtk', 'status.json')}：插件还没在 DSH 里跑起来过`);
    }
  } else if (statusIsStale) {
    say(`    ❌ 状态文件来自 pid ${status.pid}（${status.updatedAt}），不在当前运行中的宿主里 —— 可能是上一次运行或手动执行插件留下的`);
    say('       重启 DSH 后再看这里，才是本次运行的真实状态');
  } else if (statusIsOutdated) {
    say(`    ❌ 运行中的宿主（pid ${status.pid}）加载的是 v${status.pluginVersion}，而 profile ${status.profile ?? ''} 里已安装 v${installedForHost}`);
    say('       完全退出并重开 DSH 后，新版本才会生效');
  } else if (statusPredatesInstall) {
    say(`    ❌ 运行中的宿主（pid ${status.pid}）启动于 ${status.startedAt}，早于本次安装（${new Date(installedAt).toISOString()}）`);
    say('       该记录不含版本标记（1.3.1 之前），无法确认运行的就是已安装的版本 → 完全退出并重开 DSH，再跑一次即可精确核对');
  } else {
    say(`    最近一次插件记录：v${typeof status.pluginVersion === 'string' ? status.pluginVersion : '（未标记版本，来自 1.3.1 之前）'} · ${status.updatedAt} · active=${status.active} · ${status.bin ?? status.reason ?? 'n/a'} · 改写 ${status.rewrites} 次${status.passthrough === undefined ? '' : ` · 无等价命令 ${status.passthrough} 次`} · profile ${status.profile ?? '(未知)'}${statusHost === null ? '' : '（宿主 pid 匹配）'}`);
    if (status.pluginVersion === undefined) {
      say('       提示：该记录不含版本标记（1.3.1 之前），升级并重启后即可核对「运行中的版本」与「已安装的版本」是否一致');
    }
    if (status.lastError != null) say(`    最近错误：${status.lastError.reason}（${status.lastError.at}）`);
    if (status.active !== true && typeof status.hint === 'string') {
      for (const line of status.hint.split('\n')) say(`    ${line}`);
    }
  }
  say();
  say(ok ? `结论：配置就绪 —— 重启对应 profile 后 ${shellTool} 命令会被 RTK 改写。` : '结论：还不能生效，按上面 ❌ 的提示修复。');

  return {
    ok,
    lines,
    json: {
      version,
      dshHome,
      platform,
      node: process.version,
      resolution,
      resolutionLabel,
      probes,
      profiles,
      hosts,
      status,
      statusHostPid: statusHost?.pid ?? null,
      statusLive,
      statusIsStale,
      statusIsOutdated,
      statusPredatesInstall,
      installedAt,
      statusPluginVersion: status?.pluginVersion ?? null,
      installedForHost,
      runtimeSeen,
      shellTool,
      ok,
    },
  };
}
