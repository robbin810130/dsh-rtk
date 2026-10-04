#!/usr/bin/env node
/**
 * dsh-rtk doctor — answer "装完之后到底生效了吗" without guessing.
 *
 * It performs the same resolution the plugin performs at boot, then reports:
 *   1. whether a usable RTK binary is reachable (and from which source),
 *   2. which DSH profiles actually carry the plugin bundle,
 *   3. what the running DSH host processes carry, and what the plugin recorded
 *      in its status file the last time it booted.
 *
 * Exit code 0 means "a restart of the profile below will rewrite commands".
 *
 * Usage: node scripts/doctor.mjs [--bin=/abs/path/to/rtk] [--json]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DISCOVERY_CANDIDATES, inspectBinary, probeVersion, resolveRtkBin } from '../dsh-rtk/lib/index.js';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const binArg = argv.find((value) => value.startsWith('--bin='))?.slice('--bin='.length) ?? '';
const root = new URL('..', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const dshHome = (process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh');

const out = [];
const say = (line = '') => { out.push(line); if (!asJson) console.log(line); };

/** Running dsh host processes, with the settings the plugin would actually see. */
function runningHosts() {
  if (process.platform === 'win32') return [];
  try {
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
    return [];
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
function installedProfiles() {
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

function readStatus() {
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

const resolution = resolveRtkBin({ config: { bin: binArg }, env: process.env });
const probes = DISCOVERY_CANDIDATES.map((candidate) => {
  const inspection = inspectBinary(candidate, process.env);
  return { candidate, path: inspection.path, ok: inspection.ok, reason: inspection.reason, version: inspection.ok ? probeVersion(inspection.path) : null };
});
const profiles = installedProfiles();
const hosts = runningHosts();
const status = readStatus();
const profileNames = new Set(profiles.map((entry) => entry.profile));
const hostUncovered = hosts.find((host) => host.profile !== null && !profileNames.has(host.profile)) ?? null;
const hostDisabled = hosts.find((host) => host.disabled === '1' || host.disabled === 'true') ?? null;
// The plugin writes the status file on every boot it participates in, so its
// absence while a host is running means that host never loaded this version:
// either it has not been restarted yet, or the entry failed to import.
const runtimeSeen = status !== null;
const ok = resolution.ok
  && profiles.some((entry) => entry.problems.length === 0)
  && hostUncovered === null
  && hostDisabled === null
  && (hosts.length === 0 || runtimeSeen);

if (asJson) {
  console.log(JSON.stringify({
    version: pkg.version,
    dshHome,
    platform: process.platform,
    node: process.version,
    resolution,
    probes,
    profiles,
    hosts,
    status,
    ok,
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

say(`dsh-rtk doctor — v${pkg.version}`);
say(`DSH_HOME: ${dshHome}   platform: ${process.platform}   node: ${process.version}`);
say();
say('[1] RTK 二进制（按本命令的环境解析）');
if (resolution.ok) {
  say(`    ✅ ${resolution.bin}${resolution.version === null ? '' : `（rtk ${resolution.version}）`} —— 来源：${resolution.source}`);
} else {
  say(`    ❌ ${resolution.reason}`);
  for (const line of resolution.hint.split('\n')) say(`    ${line}`);
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
  say(`       安装：dsh plugin --profile <profile> add github:robbin810130/dsh-rtk#v${pkg.version}`);
} else {
  for (const entry of profiles) {
    say(`    ${entry.problems.length === 0 ? '✅' : '❌'} profile ${entry.profile}${entry.installedVersion === null ? '' : ` · v${entry.installedVersion}`}${entry.dependency === null ? '' : `（${entry.dependency}）`}${entry.problems.length === 0 ? '' : ` —— ${entry.problems.join('；')}`}`);
  }
}
say();
say('[3] 运行中的宿主进程');
if (hosts.length === 0) {
  say('    未发现 dsh-desktop-host 进程（CLI 启动的 dsh web / tui 的宿主进程不在统计内）');
} else {
  for (const host of hosts) {
    const covered = host.profile === null || profileNames.has(host.profile);
    const blocked = host.disabled === '1' || host.disabled === 'true';
    say(`    ${covered && !blocked ? '✅' : '❌'} pid ${host.pid}${host.profile === null ? '' : ` · profile ${host.profile}`} · RTK_BIN=${host.rtkBin ?? '（未设置）'}${blocked ? ` · DSH_RTK_DISABLE=${host.disabled}（本次进程已全局关闭改写）` : ''}`);
  }
  if (hostUncovered !== null) {
    say(`    ⚠️  宿主用的 profile「${hostUncovered.profile}」没有安装 dsh-rtk，插件不会被加载`);
  }
  const hostBin = hosts.find((host) => host.rtkBin !== null)?.rtkBin ?? null;
  if (hostBin !== null && resolution.source !== 'RTK_BIN' && hostBin !== resolution.bin) {
    say(`    ⚠️  宿主进程里的 RTK_BIN=${hostBin} 优先于本命令的解析结果，插件会以宿主环境为准`);
  }
}
if (status !== null) {
  say(`    最近一次插件记录：${status.updatedAt} · active=${status.active} · ${status.bin ?? status.reason ?? 'n/a'} · 改写 ${status.rewrites} 次${status.passthrough === undefined ? '' : ` · 无等价命令 ${status.passthrough} 次`} · profile ${status.profile ?? '(未知)'}`);
  if (status.lastError != null) say(`    最近错误：${status.lastError.reason}（${status.lastError.at}）`);
  if (status.active !== true && typeof status.hint === 'string') {
    for (const line of status.hint.split('\n')) say(`    ${line}`);
  }
} else if (hosts.length > 0) {
  say(`    ❌ 运行中的宿主没有留下本版本的启动记录（缺少 ${join(dshHome, 'dsh-rtk', 'status.json')}）`);
  say('       刚装完还没重启 → 完全退出并重开 DSH；否则检查宿主 profile 是否正确，以及启动输出里是否出现 failed to import / did not activate');
} else {
  say(`    尚无 ${join(dshHome, 'dsh-rtk', 'status.json')}：插件还没在 DSH 里跑起来过`);
}
say();
say(ok ? '结论：配置就绪 —— 重启对应 profile 后 bash 命令会被 RTK 改写。' : '结论：还不能生效，按上面 ❌ 的提示修复。');
process.exit(ok ? 0 : 1);
