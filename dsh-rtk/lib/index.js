/** RTK integration through DSH's supported around-dispatch tool hook. */
import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import z from 'schemastery';

export const name = 'dsh-rtk';
export const inject = [];
export const Config = z.object({
  enabled: z.boolean().default(true),
  verbose: z.boolean().default(false),
});

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function rewriteWithRtk(command) {
  if (process.env.DSH_RTK_DISABLE === '1' || command.trim().length === 0) return command;
  if (/(^|[\s;&|])DSH_RTK_DISABLE\s*=\s*1\b/.test(command)) return command;
  const bin = process.env.RTK_BIN;
  if (!bin || !isAbsolute(bin)) return command;
  let result;
  try {
    result = spawnSync(bin, ['rewrite', command], {
      encoding: 'utf8', timeout: 3000, windowsHide: true,
    });
  } catch {
    return command;
  }
  if (result.error || ![0, 3].includes(result.status)) return command;
  const rewritten = (result.stdout ?? '').trim();
  if (!rewritten) return command;
  // Keep the trusted binary reachable even when the tool shell has a sparse PATH.
  return rewritten.replace(/(^|[\n;&|]\s*|(?:^|[\s;&|])(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|]*\s+)+)\brtk\b/g,
    (_match, prefix) => prefix + shellQuote(bin));
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) return;
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'bash' || typeof exec.arguments?.command !== 'string' || exec.signal.aborted) return next();
    const original = exec.arguments;
    const command = rewriteWithRtk(original.command);
    if (command === original.command) return next();
    // DSH freezes the argument snapshot; replace it rather than mutating it.
    // Keep workdir, timeout, sandbox permissions and justification intact.
    exec.arguments = Object.freeze({ ...original, command });
    try {
      return await next();
    } finally {
      exec.arguments = original;
    }
  });
  if (config.verbose) console.log('[dsh-rtk] tools/execute hook registered');
}
