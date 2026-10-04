/**
 * Unit coverage for RTK resolution, shell dialects, diagnostics and the
 * fail-open runtime. Runs on macOS, Linux and Windows: the executable-facing
 * parts go through an injected spawn, and the only real-process section is the
 * POSIX-only smoke at the end. `test/runtime.mjs` covers the DSH hook contract.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apply,
  createRtkRuntime,
  createToolHook,
  dialectForTool,
  DISCOVERY_CANDIDATES,
  inspectBinary,
  platformCandidates,
  probeVersion,
  registerCommands,
  resolveRtkBin,
  rewriteWithRtk,
} from '../dsh-rtk/lib/index.js';

const root = mkdtempSync(join(tmpdir(), 'dsh-rtk-resolve-'));
const saved = { bin: process.env.RTK_BIN, disabled: process.env.DSH_RTK_DISABLE, home: process.env.DSH_HOME };
const logs = [];
const log = (level, message) => logs.push({ level, message });
/** A binary path that passes inspection on this platform, with no quote inside. */
const OK_BIN = process.platform === 'win32' ? process.execPath : '/bin/sh';
/** Same, but with a single quote in the file name so quoting is observable. */
const QUOTED_BIN = join(root, process.platform === 'win32' ? "rtk'quoted.exe" : "rtk'quoted");

/** Canned spawn: records calls and reports one fixed outcome. */
function fakeSpawn(outcome = { status: 0, stdout: '', stderr: '' }) {
  const calls = [];
  const spawn = (bin, args, options) => {
    calls.push({ bin, args, options });
    return { status: null, stdout: '', stderr: '', error: undefined, ...outcome };
  };
  spawn.calls = calls;
  return spawn;
}

const ok3 = { status: 3, stdout: 'rtk git status\n' };

/** Register `/rtk` against a chosen runtime and collect its definition. */
function registerCommandsFor(target, runtime) {
  registerCommands({
    inject: (deps, callback) => {
      if (deps.includes('commands')) callback({ commands: { register: (definition) => { target.push(definition); return () => {}; } } });
    },
  }, runtime);
}

try {
  delete process.env.RTK_BIN;
  delete process.env.DSH_RTK_DISABLE;
  process.env.DSH_HOME = join(root, 'dsh-home');
  writeFileSync(QUOTED_BIN, 'fake');
  chmodSync(QUOTED_BIN, 0o700);

  // ── dialect routing (DSH ships bash on POSIX, pwsh on Windows) ──────────
  assert.equal(dialectForTool('bash'), 'posix');
  assert.equal(dialectForTool('pwsh'), 'powershell');
  assert.equal(dialectForTool('powershell'), 'powershell');
  assert.equal(dialectForTool('bash-persistent'), 'posix', 'persistent tools reuse the shell name but tolerate suffixes');
  assert.equal(dialectForTool('pwsh-persistent'), 'powershell');
  assert.equal(dialectForTool('fs'), null, 'non-shell tools must never be rewritten');
  assert.equal(dialectForTool(undefined), null);

  // ── platform candidates ─────────────────────────────────────────────────
  for (const candidate of platformCandidates('win32')) {
    assert.match(candidate, /\.exe$/, 'Windows candidates must name an executable image');
  }
  assert.equal(platformCandidates('win32').every((value) => /%[A-Za-z]+%/.test(value)), true, 'Windows candidates expand from environment variables');
  assert.equal(platformCandidates('linux').some((value) => value === '/opt/homebrew/bin/rtk'), true);
  assert.equal(platformCandidates('linux').some((value) => value.includes('linuxbrew')), true);
  assert.equal(DISCOVERY_CANDIDATES.length > 0, true);

  // ── trust checks ────────────────────────────────────────────────────────
  assert.equal(inspectBinary(OK_BIN, process.env, process.platform).ok, true);
  assert.equal(inspectBinary('rtk', process.env, 'linux').reason, '不是绝对路径');
  assert.equal(inspectBinary(join(root, 'absent', 'rtk'), process.env, 'linux').reason, '不存在');

  const windowsExe = join(root, 'rtk.exe');
  writeFileSync(windowsExe, 'fake');

  // POSIX mode/owner/executable-bit rules can only be exercised on a POSIX host:
  // Windows ignores chmod's write bits and treats every existing file as executable.
  if (process.platform !== 'win32') {
    const worldWritable = join(root, 'rtk-world');
    writeFileSync(worldWritable, 'fake');
    chmodSync(worldWritable, 0o777);
    const notExecutable = join(root, 'rtk-noexec');
    writeFileSync(notExecutable, 'fake');
    chmodSync(notExecutable, 0o600);
    assert.match(inspectBinary(worldWritable, process.env, 'linux').reason, /world-writable/);
    assert.equal(inspectBinary(notExecutable, process.env, 'linux').reason, '没有执行权限');
    assert.equal(inspectBinary(windowsExe, process.env, 'linux').reason, '没有执行权限', 'a non-executable file is refused on POSIX');
  }

  const windowsShim = join(root, 'rtk.cmd');
  writeFileSync(windowsShim, '@echo off\n');
  assert.match(inspectBinary(windowsShim, process.env, 'win32').reason, /只接受 \.exe/, 'a .cmd shim must be refused rather than run through a shell');
  assert.equal(inspectBinary(windowsExe, process.env, 'win32').ok, true);

  assert.equal(inspectBinary('%ProgramFiles%\\rtk\\rtk.exe', { ProgramFiles: root }, 'win32').path, `${root}\\rtk\\rtk.exe`, 'Windows candidates expand %VAR% without touching separators');

  // ── resolution precedence ───────────────────────────────────────────────
  const probe = () => '9.9.9';
  assert.equal(resolveRtkBin({ config: {}, env: { RTK_BIN: OK_BIN }, candidates: [], probe }).source, 'RTK_BIN');
  assert.equal(resolveRtkBin({ config: {}, env: { rtk_bin: OK_BIN }, candidates: [], probe }).source, 'RTK_BIN', 'environment lookup is case-insensitive (Windows)');
  assert.equal(resolveRtkBin({ config: { bin: QUOTED_BIN }, env: { RTK_BIN: OK_BIN }, candidates: [], probe }).bin, QUOTED_BIN);
  const brokenExplicit = resolveRtkBin({ config: {}, env: { RTK_BIN: join(root, 'absent', 'rtk') }, candidates: [OK_BIN], probe });
  assert.equal(brokenExplicit.ok, false, 'a broken RTK_BIN must not silently fall back to another binary');
  assert.match(brokenExplicit.hint, /不会改写任何命令/);
  assert.equal(resolveRtkBin({ config: {}, env: { RTK_BIN: 'rtk' }, candidates: [OK_BIN], probe }).ok, false, 'a relative RTK_BIN is refused, never resolved through PATH');
  const discovered = resolveRtkBin({ config: {}, env: {}, candidates: [join(root, 'absent', 'rtk'), OK_BIN], probe });
  assert.equal(discovered.ok, true);
  assert.equal(discovered.source, 'discovered');
  assert.equal(discovered.version, '9.9.9');
  assert.equal(resolveRtkBin({ config: { autoDiscover: false }, env: {}, candidates: [OK_BIN], probe }).ok, false);
  assert.match(resolveRtkBin({ config: { autoDiscover: false }, env: {}, candidates: [OK_BIN], probe }).hint, /autoDiscover/);
  assert.match(resolveRtkBin({ config: {}, env: {}, candidates: [join(root, 'absent', 'rtk')], probe }).checked.join(' '), /不存在/);
  assert.match(resolveRtkBin({ config: {}, env: {}, platform: 'win32', candidates: [join(root, 'absent', 'rtk.exe')], probe }).hint, /rtk\.exe/, 'Windows guidance must name rtk.exe');

  // ── runtime: dialect-aware rewriting ────────────────────────────────────
  const spawn = fakeSpawn(ok3);
  const runtime = createRtkRuntime({ config: { statusFile: false }, env: { RTK_BIN: OK_BIN }, spawn, log });
  assert.equal(runtime.start().ok, true);
  assert.ok(logs.some((entry) => entry.message.includes('已生效')), 'activation must be logged');

  const quoted = createRtkRuntime({ config: { statusFile: false }, env: { RTK_BIN: QUOTED_BIN }, spawn: fakeSpawn(ok3), log });
  quoted.start();
  const posixQuoted = quoted.rewrite('git status', 'posix').command;
  const powershellQuoted = quoted.rewrite('git status', 'powershell').command;
  assert.equal(posixQuoted, "'" + QUOTED_BIN.replaceAll("'", "'\\''") + "' git status", "POSIX shells escape a quote as '\\''");
  assert.equal(powershellQuoted, "'" + QUOTED_BIN.replaceAll("'", "''") + "' git status", 'PowerShell escapes a quote by doubling it');
  assert.notEqual(posixQuoted, powershellQuoted);

  assert.equal(runtime.rewrite('git status').command, "'" + OK_BIN + "' git status");
  assert.equal(runtime.rewrite('git status', 'powershell').command, "'" + OK_BIN + "' git status");
  assert.equal(runtime.rewrite('DSH_RTK_DISABLE=1 git status', 'posix').command, 'DSH_RTK_DISABLE=1 git status');
  assert.equal(runtime.rewrite("$env:DSH_RTK_DISABLE='1'; git status", 'powershell').command, "$env:DSH_RTK_DISABLE='1'; git status");
  assert.equal(runtime.rewrite('   ').command, '   ');
  assert.equal(spawn.calls[0].args[0], 'rewrite');
  assert.equal(spawn.calls[0].options.windowsHide, true);
  assert.equal(runtime.snapshot().rewrites, 2, 'only the two rewritable calls count; opt-outs do not');

  const blocked = createRtkRuntime({ config: { statusFile: false }, env: { RTK_BIN: OK_BIN, DSH_RTK_DISABLE: '1' }, spawn: fakeSpawn(ok3), log });
  assert.equal(blocked.rewrite('git status').command, 'git status');

  // ── runtime: "no RTK equivalent" is normal, unexpected failures are not ──
  const passthrough = createRtkRuntime({ config: { statusFile: false }, env: { RTK_BIN: OK_BIN }, spawn: fakeSpawn({ status: 1, stdout: '' }), log });
  passthrough.start();
  const before = logs.length;
  assert.equal(passthrough.rewrite('echo hi').command, 'echo hi');
  assert.equal(passthrough.rewrite('echo hi').reason, 'no-equivalent');
  assert.equal(logs.length, before, '"exit 1 / no output" must not be reported as a failure');
  assert.equal(passthrough.snapshot().passthrough, 2);
  assert.equal(passthrough.snapshot().skipped, 0);

  const failing = createRtkRuntime({ config: { statusFile: false }, env: { RTK_BIN: OK_BIN }, spawn: fakeSpawn({ status: 2, stdout: 'rtk git status' }), log });
  failing.start();
  assert.equal(failing.rewrite('git status').command, 'git status');
  const warnings = logs.filter((entry) => entry.level === 'warn').length;
  failing.rewrite('git status');
  assert.equal(logs.filter((entry) => entry.level === 'warn').length, warnings, 'the same failure must be reported once');
  assert.equal(failing.snapshot().skipped, 2);

  // A vanished binary invalidates the cache instead of failing forever.
  const goneSpawn = fakeSpawn({ status: null, stdout: '', error: { code: 'ENOENT', message: 'spawn rtk ENOENT' } });
  const liveBin = createRtkRuntime({ config: { statusFile: false }, env: { RTK_BIN: OK_BIN }, spawn: goneSpawn, log });
  liveBin.start();
  assert.equal(liveBin.rewrite('git status').command, 'git status');
  assert.equal(liveBin.snapshot().active, false);
  assert.match(liveBin.snapshot().lastError.reason, /ENOENT|无法启动/);
  const missingBin = createRtkRuntime({ config: { statusFile: false }, env: { RTK_BIN: join(root, 'absent', 'rtk') }, candidates: [], spawn: goneSpawn, log });
  assert.equal(missingBin.start().ok, false);

  // ── status file ─────────────────────────────────────────────────────────
  const statusDir = join(root, 'status-home');
  const statused = createRtkRuntime({ config: {}, env: { RTK_BIN: OK_BIN, DSH_HOME: statusDir }, spawn: fakeSpawn(ok3), log });
  statused.start();
  const statusPath = join(statusDir, 'dsh-rtk', 'status.json');
  assert.equal(statused.statusPath, statusPath);
  assert.equal(existsSync(statusPath), true, 'the status file makes a live install verifiable');
  const status = JSON.parse(readFileSync(statusPath, 'utf8'));
  assert.equal(status.active, true);
  assert.equal(status.bin, OK_BIN);
  assert.equal(status.pid, process.pid);
  assert.equal(status.platform, process.platform);
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(status.pluginVersion, manifest.version, 'the record must name the running plugin version so doctor can spot a stale host');

  // ── legacy one-shot helper (positive case needs a real binary; see below) ─
  process.env.RTK_BIN = 'rtk';
  assert.equal(rewriteWithRtk('git status'), 'git status', 'a relative RTK_BIN is refused');
  process.env.RTK_BIN = join(root, 'absent', 'rtk');
  assert.equal(rewriteWithRtk('git status'), 'git status');
  delete process.env.RTK_BIN;

  // ── hook wiring against a mock cordis context ───────────────────────────
  const handlers = new Map();
  const mockCtx = {
    logger: { info: (m) => logs.push({ level: 'info', message: m }), warn: (m) => logs.push({ level: 'warn', message: m }), error: (m) => logs.push({ level: 'error', message: m }) },
    on: (event, handler) => { handlers.set(event, handler); },
  };
  // A missing explicit binary keeps the hook spawn-free while still exercising it.
  apply(mockCtx, { bin: join(root, 'absent', 'rtk'), autoDiscover: false });
  const hook = handlers.get('tools/execute');
  assert.equal(typeof hook, 'function');
  const exec = { name: 'bash', arguments: Object.freeze({ command: 'git status', workdir: '/tmp' }), signal: { aborted: false } };
  assert.equal(await hook(exec, async () => 'ok'), 'ok');
  assert.equal(exec.arguments.command, 'git status');

  const hookRuntime = createRtkRuntime({ config: { statusFile: false }, env: { RTK_BIN: OK_BIN }, spawn: fakeSpawn(ok3), log });
  hookRuntime.start();
  const wired = createToolHook(hookRuntime);
  let bashSeen;
  const bashExec = { name: 'bash', arguments: Object.freeze({ command: 'git status' }), signal: { aborted: false } };
  await wired(bashExec, async () => { bashSeen = bashExec.arguments.command; return 'ok'; });
  assert.equal(bashSeen, "'" + OK_BIN + "' git status");
  assert.equal(bashExec.arguments.command, 'git status', 'the frozen argument snapshot is restored after dispatch');
  let pwshSeen;
  const pwshExec = { name: 'pwsh', arguments: Object.freeze({ command: 'git status' }), signal: { aborted: false } };
  await wired(pwshExec, async () => { pwshSeen = pwshExec.arguments.command; return 'ok'; });
  assert.equal(pwshSeen, "'" + OK_BIN + "' git status", 'the same hook must serve the Windows shell tool');
  const fsExec = { name: 'fs', arguments: { command: 'git status' }, signal: { aborted: false } };
  await wired(fsExec, async () => 'ok');
  assert.equal(fsExec.arguments.command, 'git status');

  const disabledHandlers = new Map();
  apply({ logger: console, on: (event, handler) => { disabledHandlers.set(event, handler); } }, { enabled: false });
  assert.equal(disabledHandlers.size, 0, 'enabled: false must not install a hook');

  // ── /rtk command ────────────────────────────────────────────────────────
  /** A mock command service: `inject` runs the callback only when asked for `commands`. */
  const registrations = [];
  const commandCtx = {
    logger: console,
    on: () => {},
    inject: (deps, callback) => {
      if (!deps.includes('commands')) return;
      callback({ commands: { register: (definition) => { registrations.push(definition); return () => {}; } } });
    },
  };
  apply(commandCtx, { bin: QUOTED_BIN });
  assert.equal(registrations.length, 1, 'exactly one command is registered');
  const [definition] = registrations;
  assert.equal(definition.name, 'rtk');
  assert.equal(typeof definition.description, 'string');
  assert.equal(definition.description.length > 0, true);
  assert.equal(typeof definition.input?.hint, 'string', 'the registry rejects an empty or missing hint object');
  assert.equal(definition.input.hint.trim().length > 0, true);

  const statusReply = await definition.handler({ rawInput: '' });
  assert.equal(statusReply.kind, 'success');
  assert.match(statusReply.text, /dsh-rtk/);
  assert.match(statusReply.text, /已生效/);
  assert.match(statusReply.text, /改写 \d+ 次/, 'status must report counters');
  assert.equal((await definition.handler({ rawInput: 'status' })).kind, 'success');
  assert.equal((await definition.handler({ rawInput: '  ' })).kind, 'success');
  const recheckReply = await definition.handler({ rawInput: 'RECHECK' });
  assert.equal(recheckReply.kind, 'success', 'recheck on a healthy runtime succeeds');
  assert.match(recheckReply.text, /已重新探测/);
  const usageReply = await definition.handler({ rawInput: 'nonsense' });
  assert.equal(usageReply.kind, 'error');
  assert.match(usageReply.text, /用法/);

  // /rtk gain maps a small allowlist onto read-only rtk flags — never raw user text.
  const gainRuntime = createRtkRuntime({ config: { statusFile: false }, env: { RTK_BIN: OK_BIN }, spawn: fakeSpawn({ status: 0, stdout: 'RTK Token Savings\nTotal commands: 42\n' }), log });
  gainRuntime.start();
  const gainRegistrations = [];
  registerCommandsFor(gainRegistrations, gainRuntime);
  const gainReply = await gainRegistrations[0].handler({ rawInput: 'gain' });
  assert.equal(gainReply.kind, 'success', JSON.stringify(gainReply));
  assert.match(gainReply.text, /Total commands: 42/);
  assert.equal((await gainRegistrations[0].handler({ rawInput: 'GAIN daily' })).kind, 'success');
  assert.equal((await gainRegistrations[0].handler({ rawInput: 'gain json' })).kind, 'success');
  const gainBad = await gainRegistrations[0].handler({ rawInput: 'gain --reset --yes' });
  assert.equal(gainBad.kind, 'error', 'state-changing flags must never be forwarded');
  assert.match(gainBad.text, /未知的 gain 形式/);

  // /rtk doctor reuses the CLI report; the resolution comes from this process.
  const doctorRegistrations = [];
  registerCommandsFor(doctorRegistrations, createRtkRuntime({ config: { statusFile: false }, env: { RTK_BIN: OK_BIN }, spawn: fakeSpawn(ok3), log }));
  const doctorReply = await doctorRegistrations[0].handler({ rawInput: 'doctor' });
  assert.match(doctorReply.text, /dsh-rtk doctor/);
  assert.match(doctorReply.text, /插件进程内解析/);
  assert.match(doctorReply.text, /\[2\] 插件安装位置/);
  assert.equal(typeof doctorReply.kind, 'string');

  // A runtime with no usable RTK reports the reason instead of a bare failure.
  const brokenRegistrations = [];
  apply({
    logger: console,
    on: () => {},
    inject: (_deps, callback) => callback({ commands: { register: (entry) => { brokenRegistrations.push(entry); return () => {}; } } }),
  }, { bin: join(root, 'absent', 'rtk'), autoDiscover: false });
  const brokenReply = await brokenRegistrations[0].handler({ rawInput: '' });
  assert.equal(brokenReply.kind, 'success', 'reporting a broken state is still a successful command');
  assert.match(brokenReply.text, /未生效/);
  assert.match(brokenReply.text, /RTK 没有找到|不可用/, 'the reply must carry the actionable reason');
  assert.equal((await brokenRegistrations[0].handler({ rawInput: 'recheck' })).kind, 'error', 'recheck that still fails is an error');

  // Profiles without the command service must stay silent instead of throwing.
  apply({ logger: console, on: () => {} }, { bin: OK_BIN });

  // ── POSIX-only: the real spawn path against a real script ───────────────
  if (process.platform !== 'win32') {
    const script = join(root, 'rtk-real');
    writeFileSync(script, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "rtk 9.9.9\\n"; exit 0; fi\nprintf "%s" "rtk git status"\nexit "${RTK_TEST_STATUS:-0}"\n');
    chmodSync(script, 0o700);
    assert.equal(probeVersion(script), '9.9.9');
    const real = createRtkRuntime({ config: { statusFile: false }, env: { RTK_BIN: script }, log });
    assert.equal(real.start().version, '9.9.9');
    assert.equal(real.rewrite('git status').command, `'${script}' git status`);
    assert.equal(inspectBinary(script).ok, true, 'an executable user-owned script is trusted on POSIX');
    process.env.RTK_BIN = script;
    assert.equal(rewriteWithRtk('git status'), `'${script}' git status`, 'the legacy helper rewrites with a real binary too');
    delete process.env.RTK_BIN;
  }

  console.log('Resolution, dialect, diagnostics and fail-open runtime checks passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of [['RTK_BIN', saved.bin], ['DSH_RTK_DISABLE', saved.disabled], ['DSH_HOME', saved.home]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  delete process.env.RTK_TEST_STATUS;
}
