/**
 * DSH 0.2.0-rc.2 ToolRuntime integration: the `tools/execute` around-dispatch
 * contract, policy denial, argument-snapshot restore and listener disposal.
 *
 * Cross-platform: the rewrite source is an injected spawn, so Windows (where DSH
 * runs the `pwsh` tool) is covered too. The POSIX-only phase at the end repeats
 * the same flow through the production `apply()` entry point with a real script.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const host = process.env.DSH_RTK_HOST_ROOT;
const load = (name) => import(host ? new URL('@deepseek-ai/' + name + '/lib/index.js', 'file://' + host + '/').href : '@deepseek-ai/' + name);
const { Context } = await load('cordis');
const { SystemPrompt } = await load('dsh-system-prompt');
const { ToolRuntime, defineTool } = await load('dsh-tools');
const { default: Commands } = await load('dsh-commands');
import { apply, createRtkRuntime, createToolHook, rewriteWithRtk } from '../dsh-rtk/lib/index.js';

const directory = mkdtempSync(join(tmpdir(), 'rtk-test-'));
const saved = { bin: process.env.RTK_BIN, disabled: process.env.DSH_RTK_DISABLE, home: process.env.DSH_HOME };
// Keep the plugin's status file inside the throwaway directory instead of ~/.dsh.
process.env.DSH_HOME = join(directory, 'dsh-home');
/** A binary path that passes inspection on this platform. */
const OK_BIN = process.platform === 'win32' ? process.execPath : '/bin/sh';

/** Canned `rtk rewrite` transport: mirrors RTK's exit-code contract. */
const suggestion = (status) => (bin, args) => ({
  status,
  stdout: status === 1 ? '' : 'rtk git status',
  stderr: '',
  error: undefined,
});

async function withRuntime(run, spawn, env) {
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    const runtime = createRtkRuntime({ config: { statusFile: false }, env, spawn });
    runtime.start();
    let received;
    for (const name of ['bash', 'pwsh', 'other']) ctx.tools.register(defineTool({
      name, description: 'test command transport',
      parameters: { command: { type: 'string', required: true }, workdir: { type: 'string' } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: (args) => { received = args; return args.command; },
    }));
    const plugin = await ctx.plugin({ apply: (instance) => instance.on('tools/execute', createToolHook(runtime)) });
    const call = async (command, name = 'bash') => {
      const result = await ctx.tools.execute({ name, callId: 'rtk-test', arguments: { command, workdir: '/tmp' }, signal: new AbortController().signal });
      assert.equal(result.isError, false, JSON.stringify(result));
      return result.value;
    };
    await run({ ctx, call, plugin, received: () => received, setReceived: (value) => { received = value; } });
  } finally {
    await ctx.fiber.dispose();
  }
}

try {
  const expected = "'" + OK_BIN + "' git status";

  // ── every platform: rewrite, opt-out, policy, restore, disposal ─────────
  await withRuntime(async ({ call, received, setReceived }) => {
    assert.equal(await call('git status'), expected);
    assert.equal(received().workdir, '/tmp', 'unrelated arguments survive the rewrite');
    assert.equal(await call('git status', 'other'), 'git status', 'non-shell tools are untouched');
    assert.equal(await call('DSH_RTK_DISABLE=1 git status'), 'DSH_RTK_DISABLE=1 git status', 'the POSIX opt-out prefix is honoured');
    assert.equal(await call("$env:DSH_RTK_DISABLE='1'; git status", 'pwsh'), "$env:DSH_RTK_DISABLE='1'; git status", 'the PowerShell opt-out prefix is honoured');
  }, suggestion(3), { RTK_BIN: OK_BIN });

  await withRuntime(async ({ call }) => {
    assert.equal(await call('git status'), 'git status', 'an unexpected exit code falls back to the original command');
  }, suggestion(2), { RTK_BIN: OK_BIN });

  await withRuntime(async ({ call }) => {
    assert.equal(await call('echo hi'), 'echo hi', 'no RTK equivalent is a normal pass-through');
  }, suggestion(1), { RTK_BIN: OK_BIN });

  await withRuntime(async ({ call }) => {
    assert.equal(await call('git status'), 'git status', 'the service-wide opt-out disables rewriting');
  }, suggestion(3), { RTK_BIN: OK_BIN, DSH_RTK_DISABLE: '1' });

  // Windows uses the `pwsh` tool; the same hook must serve it with PowerShell quoting.
  const pwshExpected = "'" + OK_BIN + "' git status";
  await withRuntime(async ({ call }) => {
    assert.equal(await call('git status', 'pwsh'), pwshExpected);
  }, suggestion(3), { RTK_BIN: OK_BIN });

  // Policy denial keeps the original command away from the tool body.
  await withRuntime(async ({ ctx, plugin, setReceived }) => {
    let received;
    const deny = ctx.on('tools/pre-execute', () => ({ kind: 'deny', reason: 'test policy' }));
    const denied = await ctx.tools.execute({ name: 'bash', callId: 'denied', arguments: { command: 'git status' }, signal: new AbortController().signal });
    assert.equal(denied.isError, true);
    assert.equal(received, undefined, 'a denied call never reaches the tool body');
    deny();
    let finalCommand;
    ctx.on('tools/result', (exec) => { finalCommand = exec.arguments.command; });
    const result = await ctx.tools.execute({ name: 'bash', callId: 'restored', arguments: { command: 'git status' }, signal: new AbortController().signal });
    assert.equal(result.isError, false);
    assert.equal(finalCommand, 'git status', 'later pipeline stages observe the original command');
    await plugin.dispose();
    const after = await ctx.tools.execute({ name: 'bash', callId: 'after', arguments: { command: 'git status' }, signal: new AbortController().signal });
    assert.equal(after.value, 'git status', 'disposing the plugin releases the hook');
    setReceived(received);
  }, suggestion(3), { RTK_BIN: OK_BIN });

  // ── legacy helper behaviour ─────────────────────────────────────────────
  process.env.RTK_BIN = 'rtk';
  assert.equal(rewriteWithRtk('git status'), 'git status', 'a relative RTK_BIN is refused');
  process.env.RTK_BIN = join(directory, 'missing');
  assert.equal(rewriteWithRtk('git status'), 'git status');
  if (process.env.DSH_RTK_TEST_BIN) {
    process.env.RTK_BIN = process.env.DSH_RTK_TEST_BIN;
    assert.notEqual(rewriteWithRtk('git status'), 'git status', 'the installed RTK produces a suggestion');
  }
  delete process.env.RTK_BIN;

  // ── POSIX only: the production `apply()` entry point against a real script ─
  if (process.platform !== 'win32') {
    const ctx = new Context();
    try {
      const bin = join(directory, 'rtk-real');
      // Mirrors RTK's documented contract: exit 1 with no output means "no RTK equivalent".
      writeFileSync(bin, '#!/bin/sh\n[ "${RTK_TEST_STATUS:-0}" = "1" ] && exit 1\nprintf "%s" "rtk git status"\nexit "${RTK_TEST_STATUS:-0}"\n');
      chmodSync(bin, 0o700);
      process.env.RTK_BIN = bin;
      delete process.env.DSH_RTK_DISABLE;
      await ctx.plugin(SystemPrompt);
      await ctx.plugin(ToolRuntime);
      const plugin = await ctx.plugin({ apply }, {});
      ctx.tools.register(defineTool({
        name: 'bash', description: 'test command transport',
        parameters: { command: { type: 'string', required: true } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: (args) => args.command,
      }));
      const call = async (command) => (await ctx.tools.execute({ name: 'bash', callId: 'apply', arguments: { command }, signal: new AbortController().signal })).value;
      const appliedExpected = "'" + bin.replaceAll("'", "'\\''") + "' git status";
      assert.equal(await call('git status'), appliedExpected);
      await plugin.dispose();
      assert.equal(await call('git status'), 'git status');
    } finally {
      await ctx.fiber.dispose();
    }
  }

  // ── real command registry: definition validity + disposal ───────────────
  {
    const ctx = new Context();
    try {
      await ctx.plugin(SystemPrompt);
      await ctx.plugin(Commands);
      const plugin = await ctx.plugin({ apply }, { bin: OK_BIN });
      const descriptors = ctx.commands.list(undefined);
      const rtk = descriptors.find((entry) => entry.name === 'rtk');
      assert.ok(rtk, `the real registry must accept the /rtk definition (got ${descriptors.map((entry) => entry.name).join(', ') || 'none'})`);
      assert.equal(typeof rtk.description, 'string');
      assert.equal(typeof rtk.input?.hint, 'string', 'the hint survives normalization');
      // The command service is optional: without it the plugin must still load.
      await plugin.dispose();
      ctx.commands.list(undefined).forEach((entry) => assert.notEqual(entry.name, 'rtk'));
    } finally {
      await ctx.fiber.dispose();
    }
  }

  console.log('DSH 0.2.0-rc.2 runtime integration passed (bash + pwsh, policy, opt-out, restore, disposal, /rtk).');
} finally {
  rmSync(directory, { recursive: true, force: true });
  for (const [key, value] of [['RTK_BIN', saved.bin], ['DSH_RTK_DISABLE', saved.disabled], ['DSH_HOME', saved.home]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  delete process.env.RTK_TEST_STATUS;
}
