import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const host = process.env.DSH_RTK_HOST_ROOT;
const load = (name) => import(host ? new URL('@deepseek-ai/' + name + '/lib/index.js', 'file://' + host + '/').href : '@deepseek-ai/' + name);
const { Context } = await load('cordis');
const { SystemPrompt } = await load('dsh-system-prompt');
const { ToolRuntime, defineTool } = await load('dsh-tools');
import { apply, rewriteWithRtk } from '../dsh-rtk/lib/index.js';

const directory = mkdtempSync(join(tmpdir(), "rtk test's "));
const bin = join(directory, 'rtk');
const saved = { bin: process.env.RTK_BIN, disabled: process.env.DSH_RTK_DISABLE };
const ctx = new Context();
try {
  writeFileSync(bin, '#!/bin/sh\nprintf "%s" "rtk git status"\nexit "${RTK_TEST_STATUS:-0}"\n', { mode: 0o700 });
  process.env.RTK_BIN = bin;
  delete process.env.DSH_RTK_DISABLE;
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const plugin = await ctx.plugin({ apply }, {});
  let received;
  for (const name of ['bash', 'other']) ctx.tools.register(defineTool({
    name, description: 'test command transport',
    parameters: { command: { type: 'string', required: true }, workdir: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: (args) => { received = args; return args.command; },
  }));
  const call = async (command, name = 'bash') => {
    const result = await ctx.tools.execute({ name, callId: 'rtk-test', arguments: { command, workdir: '/tmp' }, signal: new AbortController().signal });
    assert.equal(result.isError, false, JSON.stringify(result));
    return result.value;
  };
  const expected = "'" + bin.replaceAll("'", "'\\''") + "' git status";
  assert.equal(await call('git status'), expected);
  assert.equal(received.workdir, '/tmp');
  // RTK 0.45 returns 3 for a valid suggestion under its default permission rules.
  process.env.RTK_TEST_STATUS = '3';
  assert.equal(await call('git status'), expected);
  for (const status of ['1', '2', '99']) {
    process.env.RTK_TEST_STATUS = status;
    assert.equal(await call('git status'), 'git status');
  }
  delete process.env.RTK_TEST_STATUS;
  assert.equal(await call('git status', 'other'), 'git status');
  assert.equal(await call('DSH_RTK_DISABLE=1 git status'), 'DSH_RTK_DISABLE=1 git status');
  process.env.DSH_RTK_DISABLE = '1';
  assert.equal(await call('git status'), 'git status');
  delete process.env.DSH_RTK_DISABLE;
  process.env.RTK_BIN = 'rtk';
  assert.equal(rewriteWithRtk('git status'), 'git status');
  process.env.RTK_BIN = join(directory, 'missing');
  assert.equal(rewriteWithRtk('git status'), 'git status');
  process.env.RTK_BIN = bin;
  const deny = ctx.on('tools/pre-execute', () => ({ kind: 'deny', reason: 'test policy' }));
  received = undefined;
  const denied = await ctx.tools.execute({ name: 'bash', callId: 'denied', arguments: { command: 'git status' }, signal: new AbortController().signal });
  assert.equal(denied.isError, true);
  assert.equal(received, undefined);
  deny();
  let finalCommand;
  ctx.on('tools/result', (exec) => { finalCommand = exec.arguments.command; });
  await call('git status');
  assert.equal(finalCommand, 'git status');
  await plugin.dispose();
  assert.equal(await call('git status'), 'git status');
  // Explicitly selected local RTK can additionally exercise the installed binary.
  if (process.env.DSH_RTK_TEST_BIN) {
    process.env.RTK_BIN = process.env.DSH_RTK_TEST_BIN;
    assert.notEqual(rewriteWithRtk('git status'), 'git status');
  }
  console.log('DSH 0.2.0-rc.2 runtime integration passed (rewrite, policy, opt-out, disposal).');
} finally {
  await ctx.fiber.dispose();
  rmSync(directory, { recursive: true, force: true });
  for (const [key, value] of [['RTK_BIN', saved.bin], ['DSH_RTK_DISABLE', saved.disabled]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  delete process.env.RTK_TEST_STATUS;
}
