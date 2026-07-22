import type { Clock } from '../src/cache.js';
import type { PullRequest } from '../src/models.js';

/** Manually-advanced clock for deterministic time-based tests. */
export class FakeClock implements Clock {
  constructor(private time = 0) {}

  now(): number {
    return this.time;
  }

  advance(ms: number): void {
    this.time += ms;
  }

  set(ms: number): void {
    this.time = ms;
  }
}

/** Sleep stub that records requested waits and advances the fake clock. */
export function fakeSleep(clock: FakeClock): { sleeps: number[]; sleep: (ms: number) => Promise<void> } {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock.advance(ms);
    },
  };
}

export function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'PR_1',
    number: 1,
    title: 'A change',
    url: 'https://github.com/acme/widgets/pull/1',
    state: 'open',
    draft: false,
    author: { id: 'alice', username: 'alice' },
    baseRef: 'main',
    headRef: 'feature/x',
    headSha: 'abc123',
    repo: { provider: 'github', host: 'github.com', owner: 'acme', name: 'widgets' },
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-02T00:00:00Z',
    viewerRole: 'none',
    reviewRequestedFromViewer: false,
    ...overrides,
  };
}
