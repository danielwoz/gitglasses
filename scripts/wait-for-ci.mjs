#!/usr/bin/env node
// Waits for the CI workflow to pass on the commit being released.
// Usage:
//   node scripts/wait-for-ci.mjs --repo <owner/name> --sha <commit>
//     [--workflow ci.yml] [--timeout <minutes>] [--grace <minutes>] [--interval <seconds>]
// Reads the token from GH_TOKEN and the API root from GITHUB_API_URL. Exits 0
// once a run that tested exactly this commit has succeeded (see
// lib/ci-gate.mjs), and 1 when every such run failed, when none has started
// within --grace minutes, or when none has finished by --timeout minutes.

import { setTimeout as sleep } from 'node:timers/promises';
import { ciVerdict } from './lib/ci-gate.mjs';

const DEFAULTS = { workflow: 'ci.yml', timeout: '230', grace: '30', interval: '60' };
const options = { ...DEFAULTS };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const name = args[i].replace(/^--/, '');
  if (!args[i].startsWith('--') || !['repo', 'sha', ...Object.keys(DEFAULTS)].includes(name) || args[i + 1] === undefined) {
    usage();
  }
  options[name] = args[i + 1];
}
const [timeout, grace, interval] = ['timeout', 'grace', 'interval'].map((name) => Number(options[name]));
if (!options.repo || !options.sha || ![timeout, grace, interval].every((n) => Number.isFinite(n) && n >= 0)) usage();

function usage() {
  console.error(
    'usage: wait-for-ci.mjs --repo <owner/name> --sha <commit> [--workflow ci.yml] [--timeout <minutes>] [--grace <minutes>] [--interval <seconds>]',
  );
  process.exit(2);
}

const api = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
const url = `${api}/repos/${options.repo}/actions/workflows/${options.workflow}/runs?head_sha=${options.sha}&per_page=100`;
const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;

const urls = (runs) => runs.map((run) => run.html_url).join(' ');
const started = Date.now();
const minutes = () => (Date.now() - started) / 60000;

for (;;) {
  let runs;
  try {
    const response = await fetch(url, { headers });
    if (response.status === 404) fail(`${options.workflow} was not found in ${options.repo}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    runs = (await response.json()).workflow_runs ?? [];
  } catch (error) {
    console.log(`::warning::Could not list the CI runs for ${options.sha}: ${error.message}`);
  }

  if (runs) {
    const verdict = ciVerdict(runs, options.sha);
    if (verdict.state === 'passed') {
      console.log(`CI passed on ${options.sha}: ${urls(verdict.runs)}`);
      process.exit(0);
    }
    if (verdict.state === 'failed') {
      fail(
        `CI did not pass on ${options.sha}: ${urls(verdict.runs)}. Re-run CI and then this job, or fix main and release a new version.`,
      );
    }
    if (verdict.state === 'missing' && minutes() >= grace) {
      const ignored = verdict.ignored.length
        ? ` The pull request runs ${urls(verdict.ignored)} tested it merged into their base branch, so they do not count.`
        : '';
      fail(
        `No CI run has tested ${options.sha} itself after ${grace} minutes.${ignored} Tag a commit that CI ran on when it was pushed to main, such as a merge commit, under a new version.`,
      );
    }
    console.log(
      verdict.state === 'pending' ? `Waiting for ${urls(verdict.runs)}` : `Waiting for a CI run on ${options.sha}`,
    );
  }

  if (minutes() >= timeout) fail(`CI had not passed on ${options.sha} after ${timeout} minutes.`);
  await sleep(interval * 1000);
}

function fail(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}
