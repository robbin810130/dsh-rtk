#!/usr/bin/env node
/**
 * `npm run doctor` — thin CLI over the shared doctor report.
 *
 * The in-session `/rtk doctor` command calls the exact same `runDoctor()`, so
 * the two can never drift apart. Exit code 0 means "a restart of the profile
 * below will rewrite commands".
 *
 * Usage: node scripts/doctor.mjs [--bin=/abs/path/to/rtk] [--json]
 */
import { runDoctor } from '../dsh-rtk/lib/doctor.js';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const bin = argv.find((value) => value.startsWith('--bin='))?.slice('--bin='.length) ?? '';
const report = runDoctor({ bin });

if (asJson) console.log(JSON.stringify(report.json, null, 2));
else console.log(report.lines.join('\n'));
process.exit(report.ok ? 0 : 1);
