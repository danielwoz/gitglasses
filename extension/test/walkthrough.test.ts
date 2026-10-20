// Get Started on browser hosts: a request made before extension
// walkthroughs register shows the host's own walkthrough and is made once
// more; any other request is made once, so the walkthrough page is not
// rebuilt under the user.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = {
  web: true,
  /** The label of the active tab in each group. */
  labels: [] as Array<string | undefined>,
};

vi.mock('vscode', async () => {
  const base = await import('./support/fakeVscode');
  const tabsChanged = new base.EventEmitter<void>();
  const group = (label: string | undefined) => ({ activeTab: label ? { label } : undefined });
  return {
    ...base,
    UIKind: { Desktop: 1, Web: 2 },
    env: {
      get uiKind() {
        return host.web ? 2 : 1;
      },
    },
    window: {
      ...base.window,
      tabGroups: {
        get all() {
          return host.labels.map(group);
        },
        get activeTabGroup() {
          return group(host.labels[0]);
        },
        onDidChangeTabs: tabsChanged.event,
      },
    },
    tabsChanged,
  };
});

import { controls } from './support/fakeVscode';
import { WalkthroughOpener } from '../src/home/walkthrough';
import { WALKTHROUGHS_REGISTERED_AFTER_MS, walkthroughRetryAt } from '../src/home/homeLogic';

const requests = () =>
  controls.executed.filter((entry) => entry.command === 'workbench.action.openWalkthrough').length;

let opener: WalkthroughOpener | undefined;
const log: string[] = [];

function start(): WalkthroughOpener {
  opener = new WalkthroughOpener((line) => void log.push(line));
  return opener;
}

beforeEach(() => {
  vi.useFakeTimers();
  controls.reset();
  log.length = 0;
  host.web = true;
  host.labels = ['app.ts'];
});

afterEach(() => {
  opener?.dispose();
  opener = undefined;
  vi.useRealTimers();
});

describe('walkthroughRetryAt', () => {
  it('asks again once registration has landed, only for a request before it', () => {
    const registered = 1000 + WALKTHROUGHS_REGISTERED_AFTER_MS;
    expect(walkthroughRetryAt(1000, 1000)).toBe(registered);
    expect(walkthroughRetryAt(registered - 1, 1000)).toBe(registered);
    expect(walkthroughRetryAt(registered, 1000)).toBeUndefined();
    expect(walkthroughRetryAt(60_000, 1000)).toBeUndefined();
  });
});

describe('WalkthroughOpener', () => {
  it('asks a browser host once more when the first request came before registration', async () => {
    const walkthrough = start();
    await walkthrough.open();
    host.labels = ['Walkthrough: Setup VS Code Web'];
    expect(requests()).toBe(1);
    await vi.advanceTimersByTimeAsync(WALKTHROUGHS_REGISTERED_AFTER_MS - 1);
    expect(requests()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests()).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests()).toBe(2);
  });

  it('asks a later request once, so the step the user picks stays picked', async () => {
    const walkthrough = start();
    await walkthrough.open();
    host.labels = ['Welcome'];
    await vi.advanceTimersByTimeAsync(30_000);
    const before = requests();

    await walkthrough.open();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests()).toBe(before + 1);
  });

  it('counts a Welcome editor already in front as the start of registration', async () => {
    host.labels = ['Welcome'];
    const walkthrough = start();
    await vi.advanceTimersByTimeAsync(10_000);
    await walkthrough.open();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests()).toBe(1);
  });

  it('notes a Welcome editor opened later, before the walkthrough is requested', async () => {
    const walkthrough = start();
    await vi.advanceTimersByTimeAsync(5_000);
    host.labels = ['Welcome'];
    const vscode = (await import('vscode')) as unknown as { tabsChanged: { fire(): void } };
    vscode.tabsChanged.fire();
    await vi.advanceTimersByTimeAsync(10_000);
    await walkthrough.open();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests()).toBe(1);
  });

  it('leaves the user alone once they have moved to another tab', async () => {
    const walkthrough = start();
    await walkthrough.open();
    host.labels = ['app.ts'];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests()).toBe(1);
    expect(log).toContain('walkthrough: not asking again; the active tab is "app.ts"');
  });

  it('asks once for requests made while a retry is pending', async () => {
    const walkthrough = start();
    await walkthrough.open();
    host.labels = ['Welcome'];
    await vi.advanceTimersByTimeAsync(2_000);
    await walkthrough.open();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests()).toBe(3);
  });

  it('never asks a desktop host twice', async () => {
    host.web = false;
    const walkthrough = start();
    await walkthrough.open();
    host.labels = ['Welcome'];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests()).toBe(1);
  });
});
