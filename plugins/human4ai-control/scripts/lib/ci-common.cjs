'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const terminal = new Set(['success', 'failed', 'canceled', 'blocked', 'manual', 'skipped', 'interrupted', 'timeout']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function directory() { const dir = process.env.HUMAN4AI_CI_DIR || path.join(os.homedir(), '.human4ai', 'ci-track'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700); return dir; }
function statePath(id) { if (!/^[a-f0-9]{32}$/.test(id)) throw Error('Invalid tracker ID'); return path.join(directory(), `${id}.json`); }
function save(file, value) { const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`; fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function alive(pid) { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); try { if (/^\d+ \(.*\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false; } catch {} return true; } catch (e) { return e.code === 'EPERM'; } }
function parseArgs(argv, switches = []) { const options = {}; for (let i = 0; i < argv.length; i++) { const arg = argv[i]; if (!arg.startsWith('--')) throw Error(`Unexpected argument: ${arg}`); if (switches.includes(arg)) { options[arg] = true; continue; } if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw Error(`Missing value: ${arg}`); options[arg] = argv[++i]; } return options; }
function integer(value, fallback, min, max) { if (value === undefined) return fallback; if (!/^\d+$/.test(value)) throw Error('Invalid number'); const n = Number(value); if (!Number.isSafeInteger(n) || n < min || n > max) throw Error('Number out of range'); return n; }
function parseUrl(input) {
 const url = new URL(input);
 if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Invalid CI URL');
 let m = url.pathname.match(/^\/(.+)\/-\/(pipelines|jobs)\/(\d+)\/?$/);
 if (m) {
  const project = decodeURIComponent(m[1]);
  if (!project || project.split('/').some(x => !x || x === '.' || x === '..')) throw Error('Invalid project');
  return { provider: 'gitlab', host: url.host, project, type: m[2], number: Number(m[3]) };
 }
 m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/actions\/(?:runs\/(\d+)(?:\/attempts\/(\d+)|\/job\/(\d+))?|jobs\/(\d+))\/?$/);
 if (!m) throw Error('Expected GitLab pipeline/job or GitHub Actions run/job URL');
 const owner = decodeURIComponent(m[1]); const repo = decodeURIComponent(m[2]);
 if ([owner,repo].some(x => !x || x === '.' || x === '..' || x.includes('/'))) throw Error('Invalid repository');
 return { provider: 'github', host: url.host, owner, repo, run: m[3] ? Number(m[3]) : null, attempt: m[4] ? Number(m[4]) : null, job: Number(m[5] || m[6]) || null };
}
module.exports = { terminal, sleep, directory, statePath, save, read, alive, parseArgs, integer, parseUrl };
