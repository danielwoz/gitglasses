// A release publishes only after CI has passed on the exact tagged commit; a
// pull request run, which tests that commit merged into its base, must never
// stand in for it.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ciVerdict } from '../lib/ci-gate.mjs';

const script = fileURLToPath(new URL('../wait-for-ci.mjs', import.meta.url));
const SHA = '02a1825e5926350c3437c8107bdd6b4a60088a3a';

function run(event, status, conclusion = null, id = event) {
  return {
    event,
    head_sha: SHA,
    head_branch: event === 'pull_request' ? 'feature' : 'main',
    status,
    conclusion,
    html_url: `https://github.com/o/r/actions/runs/${id}`,
  };
}

describe('ciVerdict', () => {
  it('passes on a successful push or manual run of the commit', () => {
    expect(ciVerdict([run('push', 'completed', 'success')], SHA).state).toBe('passed');
    expect(ciVerdict([run('workflow_dispatch', 'completed', 'success')], SHA).state).toBe('passed');
    expect(
      ciVerdict(
        [run('push', 'completed', 'failure', 1), run('push', 'completed', 'success', 2)],
        SHA,
      ),
    ).toMatchObject({
      state: 'passed',
      runs: [{ html_url: 'https://github.com/o/r/actions/runs/2' }],
    });
  });

  it('does not count a pull request run, even a successful one', () => {
    const prOnly = ciVerdict([run('pull_request', 'completed', 'success')], SHA);
    expect(prOnly).toMatchObject({
      state: 'missing',
      runs: [],
      ignored: [{ event: 'pull_request' }],
    });
    expect(
      ciVerdict([run('pull_request', 'completed', 'success'), run('push', 'in_progress')], SHA)
        .state,
    ).toBe('pending');
    expect(
      ciVerdict(
        [run('pull_request', 'completed', 'success'), run('push', 'completed', 'failure')],
        SHA,
      ).state,
    ).toBe('failed');
  });

  it('ignores runs of other commits', () => {
    expect(
      ciVerdict([{ ...run('push', 'completed', 'success'), head_sha: 'f'.repeat(40) }], SHA).state,
    ).toBe('missing');
  });

  it('waits while a run is queued or running', () => {
    expect(ciVerdict([run('push', 'queued')], SHA).state).toBe('pending');
    expect(
      ciVerdict(
        [run('push', 'completed', 'cancelled', 1), run('push', 'in_progress', null, 2)],
        SHA,
      ).state,
    ).toBe('pending');
  });
});

describe('wait-for-ci', () => {
  let server;
  afterEach(() => server?.close());

  // Serves each listing in turn (repeating the last), as the runs API would.
  async function waitForCi(listings, ...args) {
    const requested = [];
    server = createServer((request, response) => {
      requested.push(request.url);
      const runs = listings[Math.min(requested.length - 1, listings.length - 1)];
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ total_count: runs.length, workflow_runs: runs }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const child = spawn(
      process.execPath,
      [script, '--repo', 'o/r', '--sha', SHA, '--interval', '0', '--grace', '0', ...args],
      {
        env: {
          ...process.env,
          GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
          GH_TOKEN: '',
        },
      },
    );
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    const status = await new Promise((resolve) => child.on('close', resolve));
    for (const url of requested) {
      expect(url).toBe(`/repos/o/r/actions/workflows/ci.yml/runs?head_sha=${SHA}&per_page=100`);
    }
    return { status, stdout, served: requested.length };
  }

  it('fails when only a pull request run passed on the commit', async () => {
    const { status, stdout } = await waitForCi([[run('pull_request', 'completed', 'success', 7)]]);
    expect(status).toBe(1);
    expect(stdout).toContain(`::error::No CI run has tested ${SHA} itself`);
    expect(stdout).toContain(
      'pull request runs https://github.com/o/r/actions/runs/7 tested it merged into their base branch',
    );
  });

  it('waits for the push run and passes when it succeeds', async () => {
    const { status, stdout, served } = await waitForCi(
      [
        [run('pull_request', 'completed', 'success')],
        [run('pull_request', 'completed', 'success'), run('push', 'queued', null, 8)],
        [run('pull_request', 'completed', 'success'), run('push', 'completed', 'success', 8)],
      ],
      '--grace',
      '5',
    );
    expect(status, stdout).toBe(0);
    expect(served).toBe(3);
    expect(stdout).toContain(`CI passed on ${SHA}: https://github.com/o/r/actions/runs/8`);
  });

  it('fails when the push run failed', async () => {
    const { status, stdout } = await waitForCi([[run('push', 'completed', 'failure', 9)]]);
    expect(status).toBe(1);
    expect(stdout).toContain(
      `::error::CI did not pass on ${SHA}: https://github.com/o/r/actions/runs/9`,
    );
  });

  it('gives up at the timeout', async () => {
    const { status, stdout } = await waitForCi([[run('push', 'in_progress')]], '--timeout', '0');
    expect(status).toBe(1);
    expect(stdout).toContain(`::error::CI had not passed on ${SHA} after 0 minutes.`);
  });
});
