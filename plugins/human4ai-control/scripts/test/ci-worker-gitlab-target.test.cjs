'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const worker = path.resolve(__dirname, '../lib/ci-worker.cjs');
const source = fs.readFileSync(worker, 'utf8').replace(/main\(\)\.catch\(e => \{[^\n]+\}\);\s*$/, 'module.exports = { observe };');
const moduleObject = { exports: {} };
vm.runInNewContext(source, { require: createRequire(worker), module: moduleObject, process, setInterval, clearInterval, console }, { filename: worker });
const observe = moduleObject.exports.observe;

test('GitLab target status takes precedence over unrelated failures', async () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-target-'));
 const scenario = path.join(dir, 'scenario.json');
 fs.writeFileSync(path.join(dir, 'glab'), `#!/usr/bin/env node\nconst fs=require('fs');const route=process.argv.find(x=>x.startsWith('projects/')).split('?')[0];const data=JSON.parse(fs.readFileSync(process.env.CI_TARGET_SCENARIO));if(!(route in data))process.exit(1);process.stdout.write(JSON.stringify(data[route]));\n`, {mode: 0o755});
 const oldPath = process.env.PATH, oldScenario = process.env.CI_TARGET_SCENARIO;
 process.env.PATH = `${dir}:${oldPath}`; process.env.CI_TARGET_SCENARIO = scenario;
 const base = { provider:'gitlab', host:'gitlab.example', project:'group/repo' };
 async function check(type, pipelineStatus, jobStatus, expected, extraJobs = []) {
  const job = {id:7, name:'deploy', status:jobStatus, pipeline:{id:10}};
  const routes = {
   'projects/group%2Frepo/jobs/7': job,
   'projects/group%2Frepo/pipelines/10': {id:10,status:pipelineStatus},
   'projects/group%2Frepo/pipelines/10/jobs': [...extraJobs, ...(jobStatus ? [job] : [])],
   'projects/group%2Frepo/pipelines/10/bridges': [],
  };
  fs.writeFileSync(scenario, JSON.stringify(routes));
  const options = {cwd:dir, target:{...base,type,number:type === 'jobs' ? 7 : 10}, ...(type === 'pipelines' ? {jobName:'deploy'} : {})};
  assert.equal((await observe(options)).status, expected, `${type}: pipeline=${pipelineStatus} job=${jobStatus}`);
 }
 try {
  for (const type of ['jobs','pipelines']) {
   await check(type,'failed','success','success');
   await check(type,'failed','running','in_progress', [{id:8,name:'other',status:'failed'}]);
   await check(type,'failed','pending','in_progress');
   await check(type,'failed','success','success');
   for (const status of ['failed','canceled','skipped','manual']) await check(type,'failed',status,status === 'manual' ? 'blocked' : status);
   for (const status of ['canceled','manual']) await check(type,status,'created',status === 'manual' ? 'blocked' : status);
   await check(type,'failed','created','failed');
  }
  for (const ownerStatus of ['canceled', 'manual', 'blocked']) {
   for (const jobStatus of ['pending', 'running', 'success']) {
    const job = {id:9, name:'deploy', status:jobStatus, pipeline:{id:11}};
    fs.writeFileSync(scenario, JSON.stringify({
     'projects/group%2Frepo/pipelines/10': {id:10,status:'failed'},
     'projects/group%2Frepo/pipelines/10/jobs': [],
     'projects/group%2Frepo/pipelines/10/bridges': [{id:21,status:ownerStatus,downstream_pipeline:{id:11,project_id:33}}],
     'projects/33/pipelines/11': {id:11,status:ownerStatus},
     'projects/33/pipelines/11/jobs': [job],
     'projects/33/pipelines/11/bridges': [],
    }));
    const result = await observe({cwd:dir,target:{...base,type:'pipelines',number:10},jobName:'deploy'});
    assert.equal(result.status, jobStatus === 'success' ? 'success' : ownerStatus === 'canceled' ? 'canceled' : 'blocked', `owner=${ownerStatus} job=${jobStatus}`);
   }
  }
  await check('pipelines','failed',null,'failed');
 } finally { process.env.PATH = oldPath; if (oldScenario === undefined) delete process.env.CI_TARGET_SCENARIO; else process.env.CI_TARGET_SCENARIO = oldScenario; }
});
