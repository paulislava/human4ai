import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, cpSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { execFileSync } from 'child_process';

jest.setTimeout(30000);
const root = resolve(__dirname, '..');
const track = join(root, 'scripts/ci-track.cjs');
const status = join(root, 'scripts/ci-status.cjs');
let dir: string, env: NodeJS.ProcessEnv, scenario: string;
const run = (file: string, args: string[]) => JSON.parse(execFileSync(process.execPath, [file, ...args], { env, encoding: 'utf8', timeout: 10000 }));
const set = (value: unknown) => writeFileSync(scenario, JSON.stringify(value));
const start = (args: string[] = []) => run(track, ['start', '--url', 'https://gitlab.example/group/repo/-/pipelines/10', '--poll-ms', '50', ...args]);
const wait = (id: string, ms = 5000) => run(status, [id, '--wait-ms', String(ms)]);
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ci-track-test-')); scenario = join(dir, 'scenario.json');
  const fake = join(dir, 'glab');
  writeFileSync(fake, `#!/usr/bin/env node\nconst fs=require('fs'); if(process.env.FAKE_DELAY) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Number(process.env.FAKE_DELAY)); const args=process.argv.slice(2);fs.writeFileSync(process.env.FAKE_HOST,args[args.indexOf('--hostname')+1]);const route=args.find(x=>x.startsWith('projects/')); const data=JSON.parse(fs.readFileSync(process.env.FAKE_CI)); const key=route.split('?')[0];if(!(key in data)){process.stderr.write('missing '+key);process.exit(1)};process.stdout.write(JSON.stringify(data[key]));\n`);
  chmodSync(fake, 0o755);
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/usr/bin/env node\nconst fs=require('fs'); const args=process.argv.slice(2);fs.writeFileSync(process.env.FAKE_HOST,args[args.indexOf('--hostname')+1]);const route=args.find(x=>x.startsWith('repos/'));const data=JSON.parse(fs.readFileSync(process.env.FAKE_CI)); const key=route.split('?')[0];if(!(key in data)){process.stderr.write('missing '+key);process.exit(1)}process.stdout.write(JSON.stringify(data[key]));\n`); chmodSync(gh,0o755); env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, HUMAN4AI_CI_DIR: join(dir, 'state'), FAKE_CI: scenario, FAKE_HOST: join(dir, 'host') };
});
const base = (pipeline: string, jobs: unknown[] = [], bridges: unknown[] = []) => ({
 'projects/group%2Frepo/pipelines/10': { id: 10, status: pipeline },
 'projects/group%2Frepo/pipelines/10/jobs': jobs,
 'projects/group%2Frepo/pipelines/10/bridges': bridges,
});
test('detached tracker waits across status windows and preserves private state', () => {
  set(base('running')); const started = start();
  expect(started.status).toBe('in_progress'); expect(started.pid).toBeGreaterThan(0); expect(existsSync(started.statefile)).toBe(true); expect(statSync(started.statefile).mode & 0o777).toBe(0o600); expect(statSync(join(dir, 'state')).mode & 0o777).toBe(0o700);
  expect(wait(started.id, 100).status).toBe('in_progress'); set(base('success'));
  expect(wait(started.id).status).toBe('success'); expect(readFileSync(started.statefile, 'utf8')).toContain('success');
});
test.each(['failed', 'canceled', 'manual', 'skipped'])('pipeline terminal %s', (state) => {
  set(base(state)); expect(wait(start().id).status).toBe(state === 'manual' ? 'blocked' : state);
});
test('exact job in downstream, including latest retry', () => {
  set({ ...base('running', [], [{ id: 21, status: 'running', downstream_pipeline: { id: 11, project_id: 33 } }]),
    'projects/33/pipelines/11': {id: 11, status: 'running'},
    'projects/33/pipelines/11/bridges': [],
    'projects/33/pipelines/11/jobs': [{id: 3, name:'deploy', status:'failed'}, {id: 4, name:'deploy', status:'success'}],
  });
  expect(wait(start(['--job-name', 'deploy']).id).status).toBe('success');
});
test('canceled ancestor wins over running target, missing job fails when pipeline completes', () => {
  set(base('canceled', [{ id: 3, name: 'deploy', status: 'running' }])); expect(wait(start(['--job-name','deploy']).id).status).toBe('canceled');
  set(base('success')); expect(wait(start(['--job-name','absent']).id).status).toBe('failed');
});
test('cancel stops tracker and killed worker is interrupted', () => {
  set(base('running')); let task = start();
  expect(run(track, ['cancel', task.id]).status).toBe('canceled');
  task = start(); process.kill(task.pid, 'SIGKILL'); expect(wait(task.id, 2000).status).toBe('interrupted');
});
test('portable copied plugin and optional success action', () => {
  const copy = join(dir, 'plugin'); cpSync(join(root, 'plugins/human4ai-control/scripts'), copy, { recursive: true });
  const plugin = join(copy, 'ci-track.cjs');
  set(base('success')); const out = join(dir, 'callback');
  const task = run(plugin, ['start','--url','https://gitlab.example/group/repo/-/pipelines/10','--on-success',JSON.stringify([process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(out)},'ok')`])]);
  expect(wait(task.id).status).toBe('success'); expect(readFileSync(out,'utf8')).toBe('ok');
});


test('explicit state directory works for start, status and cancel', () => {
  set(base('running')); const stateDir = join(dir, 'separate');
  const task = start(['--state-dir', stateDir]);
  expect(run(status, [task.id, '--state-dir', stateDir, '--wait-ms', '0']).status).toBe('in_progress');
  expect(run(track, ['cancel', task.id, '--state-dir', stateDir]).status).toBe('canceled');
});


test.each([['success','success'], ['failure','failed'], ['action_required','blocked']])('GitHub Enterprise run conclusion %s maps to %s', (conclusion, expected) => {
  set({'repos/acme/project/actions/runs/42': { id: 42, status: 'completed', conclusion }});
  const task = run(track, ['start','--url','https://customexample.net/acme/project/actions/runs/42','--poll-ms','50']);
  expect(wait(task.id).status).toBe(expected);
  expect(readFileSync(join(dir,'host'),'utf8')).toBe('customexample.net');
});
test('GitHub exact job success and blocked run', () => {
  set({'repos/acme/project/actions/runs/42': {id:42,status:'in_progress'},'repos/acme/project/actions/runs/42/jobs': {jobs:[{id:5,name:'deploy',status:'completed',conclusion:'success'}]}});
  let task = run(track,['start','--url','https://customexample.net/acme/project/actions/runs/42','--job-name','deploy','--poll-ms','50']);
  expect(wait(task.id).status).toBe('success');
  set({'repos/acme/project/actions/runs/42': {id:42,status:'waiting',conclusion:null}});
  task = run(track,['start','--url','https://customexample.net/acme/project/actions/runs/42','--job-name','deploy','--poll-ms','50']);
  expect(wait(task.id).status).toBe('blocked');
});


test('GitLab forwards hostname, and failed downstream stops pipeline tracker', () => {
 set({ ...base('running', [], [{id:21,status:'running',downstream_pipeline:{id:11,project_id:33}}]), 'projects/33/pipelines/11':{id:11,status:'failed'} });
 const result = wait(start().id);
 expect(result.status).toBe('failed'); expect(readFileSync(join(dir,'host'),'utf8')).toBe('gitlab.example');
});
test('job URL fetches its parent and canceled GitHub run stops running job', () => {
 set({'repos/acme/project/actions/jobs/9':{id:9,name:'deploy',run_id:42,status:'in_progress'},'repos/acme/project/actions/runs/42':{id:42,status:'completed',conclusion:'cancelled'}});
 const task=run(track,['start','--url','https://customexample.net/acme/project/actions/jobs/9','--poll-ms','50']);
 expect(wait(task.id).status).toBe('canceled');
});
test('timeout and failed callback are terminal', () => {
 set(base('running')); expect(wait(start(['--timeout-ms','150']).id).status).toBe('timeout');
 set(base('success')); const failure = wait(start(['--on-success',JSON.stringify([process.execPath,'-e','process.exit(3)','sensitive-argument-marker'])]).id);
 expect(failure.status).toBe('failed'); expect(JSON.stringify(failure)).not.toContain('sensitive-argument-marker');
});


test('GitLab job URL supports a retried job omitted from current pipeline jobs', () => {
 set({ ...base('running'), 'projects/group%2Frepo/jobs/7': {id:7,name:'build',status:'success',pipeline:{id:10}} });
 const task=run(track,['start','--url','https://gitlab.example/group/repo/-/jobs/7','--poll-ms','50']);
 expect(wait(task.id).status).toBe('success');
});


test('failed optional downstream does not stop a successful target in the main pipeline', () => {
 set({ ...base('running', [{id:8,name:'deploy',status:'success'}], [{id:21,status:'failed',allow_failure:true,downstream_pipeline:{id:11,project_id:33}}]), 'projects/33/pipelines/11':{id:11,status:'failed'}, 'projects/33/pipelines/11/jobs':[], 'projects/33/pipelines/11/bridges':[] });
 expect(wait(start(['--job-name','deploy']).id).status).toBe('success');
});
test('heartbeat updates while waiting for a slow API call', () => {
 set(base('running')); env.FAKE_DELAY='3000'; const task=start();
 const before=JSON.parse(readFileSync(task.statefile,'utf8')).updatedAt;
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1800);
 expect(JSON.parse(readFileSync(task.statefile,'utf8')).updatedAt).toBeGreaterThan(before);
 delete env.FAKE_DELAY;
 run(track,['cancel',task.id]);
});

test('timeout during API call prevents success action', () => {
 set(base('success')); env.FAKE_DELAY='300'; const output=join(dir,'deadline-action');
 const task=start(['--timeout-ms','150','--on-success',JSON.stringify([process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(output)},'ran')`])]);
 expect(wait(task.id).status).toBe('timeout'); expect(existsSync(output)).toBe(false);
});

test('callback is never repeated after a state write failure', () => {
 const preload=join(dir,'inject.cjs'), failed=join(dir,'failed-once'), count=join(dir,'count');
 writeFileSync(preload, `const fs=require('fs');const original=fs.renameSync;fs.renameSync=function(a,b){if(b.endsWith('.json') && fs.readFileSync(a,'utf8').includes('"status":"success"') && !fs.existsSync(${JSON.stringify(failed)})){fs.writeFileSync(${JSON.stringify(failed)},'1');throw Error('simulated state write failure')}return original.apply(this,arguments)}`);
 env.NODE_OPTIONS = `--require=${preload}`;
 set(base('success'));
 const command = [process.execPath,'-e',`const fs=require('fs'); const p=${JSON.stringify(count)};fs.writeFileSync(p,String((fs.existsSync(p)?Number(fs.readFileSync(p)):0)+1))`];
 const task=start(['--on-success',JSON.stringify(command)]); const result=wait(task.id);
 expect(result.status).toBe('failed'); expect(readFileSync(count,'utf8')).toBe('1');
});

test('completed owning pipeline or run cannot leave its target queued', () => {
 set(base('success', [{id:5,name:'deploy',status:'created'}]));
 expect(wait(start(['--job-name','deploy']).id).status).toBe('failed');
 set({'repos/acme/project/actions/runs/42':{id:42,status:'completed',conclusion:'success'},'repos/acme/project/actions/runs/42/jobs':{jobs:[{id:5,name:'deploy',status:'queued'}]}});
 const task=run(track,['start','--url','https://customexample.net/acme/project/actions/runs/42','--job-name','deploy','--poll-ms','50']);
 expect(wait(task.id).status).toBe('failed');
});

test('target inside optional downstream keeps its own failed result', () => {
 set({ ...base('running', [], [{id:21,status:'failed',allow_failure:true,downstream_pipeline:{id:11,project_id:33}}]), 'projects/33/pipelines/11':{id:11,status:'failed'}, 'projects/33/pipelines/11/jobs':[{id:5,name:'deploy',status:'failed'}], 'projects/33/pipelines/11/bridges':[] });
 expect(wait(start(['--job-name','deploy']).id).status).toBe('failed');
});
test('interrupted fence prevents later API result and success action', () => {
 set(base('success')); env.FAKE_DELAY='400'; const output=join(dir,'fenced-action');
 const task=start(['--on-success',JSON.stringify([process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(output)},'ran')`])]);
 writeFileSync(`${task.statefile}.interrupted`, '', {mode:0o600});
 expect(wait(task.id).status).toBe('interrupted');
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1800);
 expect(wait(task.id,0).status).toBe('interrupted'); expect(existsSync(output)).toBe(false);
});

test('failed nested optional downstream does not block target in its optional parent', () => {
 set({ ...base('running', [], [{id:21,status:'running',allow_failure:true,downstream_pipeline:{id:11,project_id:33}}]),
  'projects/33/pipelines/11':{id:11,status:'running'},
  'projects/33/pipelines/11/jobs':[{id:7,name:'deploy',status:'success'}],
  'projects/33/pipelines/11/bridges':[{id:22,status:'failed',allow_failure:true,downstream_pipeline:{id:12,project_id:33}}],
  'projects/33/pipelines/12':{id:12,status:'failed'},
  'projects/33/pipelines/12/jobs':[], 'projects/33/pipelines/12/bridges':[] });
 expect(wait(start(['--job-name','deploy']).id).status).toBe('success');
});
