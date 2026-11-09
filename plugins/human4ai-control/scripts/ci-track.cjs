#!/usr/bin/env node
'use strict';
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const { statePath, save, parseArgs, integer, parseUrl } = require('./lib/ci-common.cjs');
function main() {
 const [command, ...rest] = process.argv.slice(2);
 if (command === 'cancel') {
  const [id, ...flags] = rest; const args = parseArgs(flags);
  for (const key of Object.keys(args)) if (key !== '--state-dir') throw Error(`Unknown option ${key}`);
  const opts = args['--state-dir'] ? ['--state-dir', args['--state-dir']] : [];
  process.stdout.write(execFileSync(process.execPath, [path.join(__dirname,'ci-status.cjs'), id || '', '--cancel', ...opts], { encoding: 'utf8' }));
  return;
 }
 if (command !== 'start') throw Error('Expected start or cancel');
 const args = parseArgs(rest);
 if (args['--state-dir']) process.env.HUMAN4AI_CI_DIR = path.resolve(args['--state-dir']);
 for (const key of Object.keys(args)) if (!['--url','--job-name','--cwd','--poll-ms','--timeout-ms','--on-success','--state-dir'].includes(key)) throw Error(`Unknown option ${key}`);
 if (!args['--url']) throw Error('--url is required');
 const target = parseUrl(args['--url']);
 if (args['--job-name'] !== undefined && !args['--job-name']) throw Error('Empty job name');
 const callback = args['--on-success'] === undefined ? null : JSON.parse(args['--on-success']);
 if (callback && (!Array.isArray(callback) || !callback.length || callback.some(x => typeof x !== 'string') || !callback[0])) throw Error('--on-success must be a JSON array of arguments');
 const id = crypto.randomBytes(16).toString('hex'); const file = statePath(id);
 const options = { target, url: args['--url'], jobName: args['--job-name'] || null, cwd: args['--cwd'] ? path.resolve(args['--cwd']) : process.cwd(), pollMs: integer(args['--poll-ms'], 10000, 10, 300000), timeoutMs: integer(args['--timeout-ms'], 86400000, 1, 604800000), callback };
 const state = { id, pid: 0, statefile: file, status: 'in_progress', startedAt: Date.now(), updatedAt: Date.now(), options };
 save(file, state);
 const child = spawn(process.execPath, [path.join(__dirname,'lib/ci-worker.cjs'), file], { detached: true, stdio: 'ignore', cwd: options.cwd, env: process.env });
 state.pid = child.pid; save(file, state); child.unref();
 process.stdout.write(JSON.stringify({ id, pid: child.pid, statefile: file, status: 'in_progress' }) + '\n');
}
try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
