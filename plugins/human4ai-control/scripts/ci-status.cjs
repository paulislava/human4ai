#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { terminal, sleep, statePath, read, save, alive, parseArgs, integer } = require('./lib/ci-common.cjs');
function output(state) { const { options, ...result } = state; process.stdout.write(JSON.stringify(result) + '\n'); }
async function main() {
 const [id, ...rest] = process.argv.slice(2); const args = parseArgs(rest, ['--cancel','--infinite']);
 if (args['--state-dir']) process.env.HUMAN4AI_CI_DIR = require('path').resolve(args['--state-dir']);
 const file = statePath(id || '');
 for (const key of Object.keys(args)) if (!['--wait-ms','--cancel','--infinite','--state-dir'].includes(key)) throw Error(`Unknown option ${key}`);
 if (args['--infinite'] && args['--wait-ms']) throw Error('Choose --infinite or --wait-ms');
 const wait = args['--infinite'] ? Infinity : integer(args['--wait-ms'], 300000, 0, 300000);
 if (args['--cancel']) fs.writeFileSync(`${file}.cancel`, '', { mode: 0o600 });
 const deadline = Date.now() + wait;
 for (;;) {
  let state = read(file);
  if (fs.existsSync(`${file}.interrupted`)) { output({ ...state, status: 'interrupted', message: 'Tracker process is not responding' }); return; }
  if (terminal.has(state.status)) { output(state); return; }
  if (!alive(state.pid) || Date.now() - state.updatedAt > Math.max(45000, state.options.pollMs + 35000)) {
   fs.closeSync(fs.openSync(`${file}.interrupted`, 'a', 0o600));
   state = { ...state, status: 'interrupted', updatedAt: Date.now(), message: 'Tracker process is not responding' }; save(file, state); output(state); return;
  }
  if (Date.now() >= deadline) { output(state); return; }
  await sleep(Math.min(100, deadline - Date.now()));
 }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
