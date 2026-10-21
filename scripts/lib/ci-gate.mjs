// Whether CI has passed on the commit being released. Only runs that tested
// exactly that commit count: a push run (CI runs on each push to main) or a
// manual run on it. A pull_request run reports the pull request's head
// commit as its head_sha, but it tests that commit merged into the base
// branch as it was then, which is a different tree from the tagged one.

const EVENTS_TESTING_HEAD_SHA = new Set(['push', 'workflow_dispatch']);

/**
 * Classifies the CI workflow's runs (GitHub workflow run objects) for `sha`:
 * `passed` once a qualifying run has succeeded, `failed` when every
 * qualifying run finished without success, `pending` while one is queued or
 * running, and `missing` when no run tested this exact commit. `runs` holds
 * the qualifying runs behind the verdict and `ignored` the runs for `sha`
 * that do not count.
 */
export function ciVerdict(runs, sha) {
  const forCommit = runs.filter((run) => run.head_sha === sha);
  const qualifying = forCommit.filter((run) => EVENTS_TESTING_HEAD_SHA.has(run.event));
  const ignored = forCommit.filter((run) => !EVENTS_TESTING_HEAD_SHA.has(run.event));
  const passed = qualifying.find(
    (run) => run.status === 'completed' && run.conclusion === 'success',
  );
  if (passed) return { state: 'passed', runs: [passed], ignored };
  if (qualifying.length === 0) return { state: 'missing', runs: [], ignored };
  if (qualifying.every((run) => run.status === 'completed'))
    return { state: 'failed', runs: qualifying, ignored };
  return { state: 'pending', runs: qualifying, ignored };
}
