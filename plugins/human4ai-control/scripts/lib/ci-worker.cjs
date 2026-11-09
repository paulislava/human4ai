'use strict';
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { read, save, sleep } = require('./ci-common.cjs');
const run = promisify(execFile); const file = process.argv[2];
const pathFor = (project, suffix) => `projects/${encodeURIComponent(String(project))}/${suffix}`;
const end = new Set(['success','failed','canceled','manual','blocked','skipped']);
function normalized(s) { return s === 'manual' ? 'blocked' : s; }
async function api(options, project, suffix) {
 const { stdout } = await run('glab', ['api', '--hostname', options.target.host, pathFor(project, suffix)], { cwd: options.cwd, timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
 return JSON.parse(stdout);
}
async function list(options, project, suffix) {
 let result = [];
 for (let page = 1; page <= 100; page++) {
  const items = await api(options, project, `${suffix}?per_page=100&page=${page}`);
  if (!Array.isArray(items)) throw Error('Invalid GitLab API list');
  result = result.concat(items); if (items.length < 100) return result;
 }
 throw Error('GitLab pagination limit exceeded');
}
function githubStatus(item) {
 if (item.status === 'waiting' || item.status === 'requested' && item.conclusion === 'action_required') return 'blocked';
 if (item.status !== 'completed') return 'in_progress';
 return ({success:'success',failure:'failed',startup_failure:'failed',cancelled:'canceled',action_required:'blocked',timed_out:'timeout',skipped:'skipped',neutral:'skipped',stale:'failed'})[item.conclusion] || 'failed';
}
async function observeGithub(options) {
 const t=options.target; const repo=`repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}`;
 async function get(suffix) {
  const {stdout} = await run('gh', ['api', '--hostname', t.host, `${repo}/${suffix}`], {cwd:options.cwd,timeout:10000,maxBuffer:8*1024*1024});
  return JSON.parse(stdout);
 }
 let job = t.job ? await get(`actions/jobs/${t.job}`) : null;
 const runId = t.run || job?.run_id;
 if (!runId || (job && Number(job.run_id) !== Number(runId))) throw Error('GitHub job run does not match URL');
 const workflow = await get(t.attempt ? `actions/runs/${runId}/attempts/${t.attempt}` : `actions/runs/${runId}`);
 const runStatus=githubStatus(workflow);
 if (['failed','canceled','blocked','timeout'].includes(runStatus)) return {status:runStatus,message:'Workflow stopped'};
 if (!job && options.jobName) {
  let jobs=[];
  for (let page=1;page<=100;page++) {
   const suffix = t.attempt ? `actions/runs/${runId}/attempts/${t.attempt}/jobs` : `actions/runs/${runId}/jobs`;
   const result=await get(`${suffix}?per_page=100&page=${page}`);
   if (!Array.isArray(result.jobs)) throw Error('Invalid GitHub jobs list');
   jobs=jobs.concat(result.jobs); if(result.jobs.length<100) break;
   if(page===100) throw Error('GitHub pagination limit exceeded');
  }
  job=jobs.filter(j=>j.name===options.jobName).sort((a,b)=>Number(b.id)-Number(a.id))[0];
  if (!job) return runStatus === 'in_progress' ? {status:'in_progress'} : {status:'failed',message:'Target job was not found'};
 }
 if (job) { const status=githubStatus(job); return {status:status === 'in_progress' && runStatus === 'success' ? 'failed' : status,job:{id:job.id,name:job.name,status:job.status,conclusion:job.conclusion}}; }
 return {status:runStatus};
}
async function observe(options) {
 if (options.target.provider === 'github') return observeGithub(options);
 const target = options.target; let project = target.project; let pipeline = target.number; let jobId = null; let directJob = null;
 if (target.type === 'jobs') { directJob = await api(options, project, `jobs/${target.number}`); if (!directJob.pipeline?.id) throw Error('Job has no pipeline'); pipeline = directJob.pipeline.id; jobId = target.number; }
 const seen = new Set(); const found = directJob ? [directJob] : []; let pending = false; let blocker = null;
 const optionalScopes = [];
 async function visit(projectId, pipelineId, scope = null) {
  const key = `${projectId}/${pipelineId}`; if (seen.has(key)) return; seen.add(key); if (seen.size > 200) throw Error('Too many downstream pipelines');
  const p = await api(options, projectId, `pipelines/${pipelineId}`);
  if (['failed','canceled','manual','blocked'].includes(p.status)) {
   if (!scope) { blocker = blocker || normalized(p.status); return; }
   scope.blocker = scope.blocker || normalized(p.status);
  }
  if (directJob && String(projectId) === String(project) && Number(pipelineId) === Number(pipeline)) directJob.ownerPipelineStatus = p.status;
  if (!end.has(p.status)) pending = true;
  const jobs = options.jobName ? await list(options, projectId, `pipelines/${pipelineId}/jobs`) : [];
  for (const j of jobs) if (j.name === options.jobName) { found.push({...j, ownerPipelineStatus:p.status}); for (let current = scope; current; current = current.parent) current.found = true; }
  const bridges = await list(options, projectId, `pipelines/${pipelineId}/bridges`);
  for (const bridge of bridges) {
   if (bridge.allow_failure && !options.jobName) continue;
   let childScope = scope;
   if (bridge.allow_failure) { childScope = {found:false, blocker:null, parent:scope}; optionalScopes.push(childScope); }
   if (['failed','canceled','manual','blocked'].includes(bridge.status) && !bridge.allow_failure) {
    if (scope) scope.blocker = scope.blocker || normalized(bridge.status); else blocker = blocker || normalized(bridge.status);
   }
   if (bridge.downstream_pipeline?.id) await visit(bridge.downstream_pipeline.project_id || projectId, bridge.downstream_pipeline.id, childScope);
   else if (!end.has(bridge.status)) pending = true;
  }
  if (!scope && !found.length && jobs.some(j => ['failed','canceled','manual','blocked'].includes(j.status) && !j.allow_failure)) blocker = blocker || 'blocked';
 }
 await visit(project, pipeline);
 for (const scope of optionalScopes) if (scope.found && scope.blocker) blocker = blocker || scope.blocker;
 if (blocker) return { status: blocker, message: 'Pipeline or required dependency stopped' };
 if (!options.jobName && !jobId) {
  const p = await api(options, project, `pipelines/${pipeline}`); return { status: pending ? 'in_progress' : end.has(p.status) ? normalized(p.status) : 'in_progress' };
 }
 if (found.length) {
  found.sort((a,b) => Number(b.id)-Number(a.id)); const job = found[0];
  return { status: end.has(job.status) ? normalized(job.status) : job.ownerPipelineStatus === 'success' ? 'failed' : 'in_progress', job: { id: job.id, name: job.name, status: job.status } };
 }
 return pending ? { status: 'in_progress' } : { status: 'failed', message: 'Target job was not found' };
}
async function main() {
 let state; for (let i=0; i<100; i++) { state=read(file); if (state.pid === process.pid) break; await sleep(10); }
 if (state.pid !== process.pid) return;
 const options = state.options; let failures = 0;
 const interrupted = () => fs.existsSync(`${file}.interrupted`);
 async function update(extra) { if (interrupted()) throw Error('interrupted'); state = { ...state, ...extra, updatedAt: Date.now() }; save(file, state); }
 const heartbeat = setInterval(() => { if (!interrupted() && state.status === 'in_progress') { state.updatedAt=Date.now(); save(file,state); } }, 1000);
 heartbeat.unref();
 for (;;) {
  if (fs.existsSync(`${file}.cancel`)) { await update({ status: 'canceled', message: 'Tracker canceled' }); return; }
  if (Date.now() - state.startedAt >= options.timeoutMs) { await update({ status: 'timeout' }); return; }
  let result;
  try { result = await observe(options); failures = 0; }
  catch (error) {
   if (interrupted()) return;
   failures++; if (failures >= 3) { await update({ status: 'failed', message: 'CI API error after retries' }); return; }
   await update({ message: 'CI API retry' });
  }
  if (result) {
   if (fs.existsSync(`${file}.cancel`)) { await update({status:'canceled', message:'Tracker canceled'}); return; }
   if (Date.now() - state.startedAt >= options.timeoutMs) { await update({status:'timeout'}); return; }
   if (interrupted()) return;
   if (result.status === 'success' && options.callback) {
    await update({ callbackClaimed: true, message: 'Running success action' });
    if (interrupted()) return;
    try { await run(options.callback[0], options.callback.slice(1), { cwd: options.cwd, timeout: 30000, maxBuffer: 1024 * 1024 }); }
    catch (error) { await update({ status: 'failed', message: `Success action failed${typeof error.code === 'number' ? ` (exit ${error.code})` : error.signal ? ` (signal ${error.signal})` : ''}` }); return; }
    if (fs.existsSync(`${file}.cancel`)) { await update({status:'canceled',message:'Tracker canceled after action started'}); return; }
    if (Date.now() - state.startedAt >= options.timeoutMs) { await update({status:'timeout',message:'Tracker timed out after action started'}); return; }
   }
   await update(result); if (result.status !== 'in_progress') return;
  }
  const until = Date.now() + options.pollMs;
  while (Date.now() < until) { if (fs.existsSync(`${file}.cancel`)) { await update({status:'canceled', message:'Tracker canceled'}); return; } if (Date.now()-state.startedAt >= options.timeoutMs) { await update({status:'timeout'}); return; } await sleep(Math.min(100, until-Date.now())); }
 }
}
main().catch(e => { if (fs.existsSync(`${file}.interrupted`)) return; try { const state=read(file); save(file, {...state,status:'failed',message:'Tracker failed',updatedAt:Date.now()}); } catch {} });
