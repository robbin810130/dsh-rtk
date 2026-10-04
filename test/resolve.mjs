/**
 * Unit coverage for RTK resolution, diagnostics and the fail-open runtime.
 * No DSH runtime is required; `test/runtime.mjs` covers the hook contract.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apply,
  createRtkRuntime,
  DISCOVERY_CANDIDATES,
  inspectBinary,
  probeVersion,
  resolveRtkBin,
  rewriteWithRtk,
} from '../dsh-rtk/lib/index.js';

const root = mkdtempSync(join(tmpdir(), 'dsh-rtk-resolve-'));
const saved = { bin: process.env.RTK_BIN, disabled: process.env.DSH_RTK_DISABLE, home: process.env.DSH_HOME };
const logs = [];

/** Write an executable fake RTK. */
function fakeBin(name, version, mode = 0o700) {
  const path = join(root, name);
  const body = version === null
    ? '#!/bin/sh\nprintf "not-an-rtk\\n"\n'
    : `#!/bin/sh\nif [ "$1" = "--version" ]; then printf "rtk ${version}\\n"; exit 0; fi\nprintf "%s" "rtk git status"\nexit "\${RTK_TEST_STATUS:-0}"\n`;
  writeFileSync(path, body);
  chmodSync(path, mode);
  return path;
}

function quoted(bin) {
  return "'" + bin.replaceAll("'", "'\\''") + "'";
}

try {
  delete process.env.RTK_BIN;
  delete process.env.DSH_RTK_DISABLE;
  process.env.DSH_HOME = join(root, 'dsh-home');

  const good = fakeBin('rtk-9.9.9', '9.9.9');
  const other = fakeBin('rtk-1.1.1', '1.1.1');
  const impostor = fakeBin('not-rtk', null);
  const worldWritable = fakeBin('rtk-world', '9.9.9', 0o777);
  const notExecutable = fakeBin('rtk-noexec', '9.9.9', 0o600);
  const missing = join(root, 'absent', 'rtk');

  // ── probe + trust checks ────────────────────────────────────────────────
  assert.equal(probeVersion(good), '9.9.9');
  assert.equal(probeVersion(impostor), null, 'a binary that is not RTK must not pass the probe');
  assert.equal(probeVersion(missing), null);
  assert.equal(inspectBinary(good).ok, true);
  assert.equal(inspectBinary('rtk').reason, '不是绝对路径');
  assert.equal(inspectBinary(missing).reason, '不存在');
  assert.equal(inspectBinary(impostor).ok, true, 'trust checks are about the file, not its identity');
  assert.match(inspectBinary(worldWritable).reason, /world-writable/);
  assert.equal(inspectBinary(notExecutable).reason, '没有执行权限');

  // ── discovery ───────────────────────────────────────────────────────────
  const discovered = resolveRtkBin({ config: {}, env: {}, candidates: [missing, impostor, good] });
  assert.equal(discovered.ok, true, JSON.stringify(discovered));
  assert.equal(discovered.bin, good);
  assert.equal(discovered.source, 'discovered');
  assert.equal(discovered.version, '9.9.9');
  assert.equal(resolveRtkBin({ config: {}, env: {}, candidates: [missing, impostor] }).ok, false);
  assert.match(resolveRtkBin({ config: {}, env: {}, candidates: [missing] }).checked.join(' '), /不存在/);
  assert.match(resolveRtkBin({ config: {}, env: {}, candidates: [impostor] }).checked.join(' '), /不是 RTK/);
  assert.equal(resolveRtkBin({ config: { autoDiscover: false }, env: {}, candidates: [good] }).ok, false);
  assert.match(resolveRtkBin({ config: { autoDiscover: false }, env: {}, candidates: [good] }).hint, /autoDiscover/);
  assert.equal(DISCOVERY_CANDIDATES.length > 0, true);

  // ── explicit settings are authoritative (no silent substitution) ─────────
  assert.equal(resolveRtkBin({ config: {}, env: { RTK_BIN: good }, candidates: [] }).source, 'RTK_BIN');
  assert.equal(resolveRtkBin({ config: { bin: other }, env: { RTK_BIN: good }, candidates: [] }).bin, other);
  const brokenExplicit = resolveRtkBin({ config: {}, env: { RTK_BIN: missing }, candidates: [good] });
  assert.equal(brokenExplicit.ok, false, 'a broken RTK_BIN must not silently fall back to another binary');
  assert.match(brokenExplicit.hint, /不会改写任何命令/);
  assert.equal(resolveRtkBin({ config: {}, env: { RTK_BIN: 'rtk' }, candidates: [good] }).ok, false);
  assert.equal(resolveRtkBin({ config: { bin: '~/rtk' }, env: {}, candidates: [] }).ok, false, '~ must expand, not pass through');

  // ── runtime: rewrite, disable switches, status file ──────────────────────
  const log = (level, message) => logs.push({ level, message });
  const runtime = createRtkRuntime({ config: { statusFile: false }, env: { RTK_BIN: good }, log });
  assert.equal(runtime.start().ok, true);
  assert.equal(runtime.rewrite('git status').command, `${quoted(good)} git status`);
  assert.equal(runtime.rewrite('ls -la').command, `${quoted(good)} git status`, 'the fake RTK always suggests git status');
  assert.equal(runtime.rewrite('DSH_RTK_DISABLE=1 git status').command, 'DSH_RTK_DISABLE=1 git status');
  assert.equal(runtime.rewrite('   ').command, '   ');
  const blocked = createRtkRuntime({ config: { statusFile: false }, env: { RTK_BIN: good, DSH_RTK_DISABLE: '1' }, log });
  assert.equal(blocked.rewrite('git status').command, 'git status');
  assert.equal(runtime.snapshot().rewrites, 2);
  assert.ok(logs.some((entry) => entry.level === 'info' && entry.message.includes('已生效')), 'activation must be logged');

  const broken = createRtkRuntime({ config: { statusFile: false }, env: { RTK_BIN: missing }, log });
  broken.start();
  assert.ok(logs.some((entry) => entry.level === 'warn' && entry.message.includes('未生效')), 'a missing binary must warn');
  const warnings = logs.filter((entry) => entry.level === 'warn').length;
  broken.rewrite('git status');
  broken.rewrite('git status');
  assert.equal(logs.filter((entry) => entry.level === 'warn').length, warnings, 'the same failure must be reported once');

  // ── runtime: "no RTK equivalent" is a normal path, not a failure ─────────
  const silent = join(root, 'rtk-silent');
  writeFileSync(silent, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "rtk 9.9.9\\n"; exit 0; fi\nexit 1\n');
  chmodSync(silent, 0o700);
  const quiet = createRtkRuntime({ config: { statusFile: false }, env: { RTK_BIN: silent }, log });
  quiet.start();
  const quietLogs = logs.length;
  assert.equal(quiet.rewrite('echo hi').command, 'echo hi');
  assert.equal(quiet.rewrite('echo hi').reason, 'no-equivalent');
  assert.equal(logs.length, quietLogs, '"exit 1 / no output" must not be reported as a failure');
  assert.equal(quiet.snapshot().passthrough, 2);
  assert.equal(quiet.snapshot().rewrites, 0);
  assert.equal(quiet.snapshot().skipped, 0);

  const statusDir = join(root, 'dsh-home');
  const statused = createRtkRuntime({ config: {}, env: { RTK_BIN: good, DSH_HOME: statusDir }, log });
  statused.start();
  const statusPath = join(statusDir, 'dsh-rtk', 'status.json');
  assert.equal(statused.statusPath, statusPath);
  assert.equal(existsSync(statusPath), true, 'the status file makes a live install verifiable');
  const status = JSON.parse(readFileSync(statusPath, 'utf8'));
  assert.equal(status.active, true);
  assert.equal(status.bin, good);
  assert.equal(status.pid, process.pid);

  // ── runtime: a vanished binary is re-discovered instead of failing forever ─
  const vanishing = fakeBin('rtk-vanishing', '9.9.9');
  const survivor = fakeBin('rtk-survivor', '0.0.1');
  const live = createRtkRuntime({ config: { statusFile: false }, env: { RTK_BIN: vanishing }, candidates: [], log });
  live.start();
  assert.equal(live.rewrite('git status').command, `${quoted(vanishing)} git status`);
  unlinkSync(vanishing);
  assert.equal(live.rewrite('git status').command, 'git status', 'a vanished binary falls back to the original command');
  assert.equal(live.snapshot().active, false);
  assert.match(live.snapshot().lastError.reason, /ENOENT|无法启动/);
  const rediscovered = createRtkRuntime({ config: { statusFile: false }, env: {}, candidates: [survivor], log });
  assert.equal(rediscovered.start().bin, survivor);

  // ── legacy one-shot helper ──────────────────────────────────────────────
  process.env.RTK_BIN = good;
  assert.equal(rewriteWithRtk('git status'), `${quoted(good)} git status`);
  process.env.RTK_BIN = 'rtk';
  assert.equal(rewriteWithRtk('git status'), 'git status', 'a relative RTK_BIN is refused, never resolved through PATH');
  delete process.env.RTK_BIN;

  // ── apply(): hook wiring against a mock cordis context ───────────────────
  const handlers = new Map();
  const ctx = {
    logger: { info: (m) => logs.push({ level: 'info', message: m }), warn: (m) => logs.push({ level: 'warn', message: m }), error: (m) => logs.push({ level: 'error', message: m }) },
    on: (event, handler) => { handlers.set(event, handler); },
  };
  apply(ctx, { bin: good });
  const hook = handlers.get('tools/execute');
  assert.equal(typeof hook, 'function');
  const exec = { name: 'bash', arguments: Object.freeze({ command: 'git status', workdir: '/tmp' }), signal: { aborted: false } };
  let seen;
  await hook(exec, async () => { seen = exec.arguments.command; return 'ok'; });
  assert.equal(seen, `${quoted(good)} git status`);
  assert.equal(exec.arguments.command, 'git status', 'the frozen argument snapshot is restored after dispatch');
  let otherSeen;
  const otherExec = { name: 'fs', arguments: { command: 'git status' }, signal: { aborted: false } };
  await hook(otherExec, async () => { otherSeen = otherExec.arguments.command; return 'ok'; });
  assert.equal(otherSeen, 'git status');

  const disabledHandlers = new Map();
  apply({ logger: console, on: (event, handler) => { disabledHandlers.set(event, handler); } }, { enabled: false });
  assert.equal(disabledHandlers.size, 0, 'enabled: false must not install a hook');

  console.log('Resolution, diagnostics and fail-open runtime checks passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of [['RTK_BIN', saved.bin], ['DSH_RTK_DISABLE', saved.disabled], ['DSH_HOME', saved.home]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  delete process.env.RTK_TEST_STATUS;
}
