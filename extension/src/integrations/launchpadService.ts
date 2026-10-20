import {
  TtlCache,
  groupItems,
  type AuthContext,
  type HostingProvider,
  type LaunchpadBucket,
  type LaunchpadGroup,
  type PullRequest,
} from '@gitglasses/integrations';
import {
  SNOOZE_DURATION_MS,
  attentionCount,
  mergeGroups,
  partitionSnoozed,
  pruneSnoozes,
  type SnoozeMap,
} from './launchpadLogic';
import type { IntegrationService } from './integrationService';
import { toAuthContext } from './providerSetup';

const SNOOZE_STORAGE_KEY = 'gitglasses.launchpad.snoozes';
const FRESH_MS = 60_000;
const STALE_MS = 5 * 60_000;

/** Minimal Memento shape so the service stays vscode-free and testable. */
export interface StorageLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export interface LaunchpadModel {
  /** False when no hosting provider has credentials (view shows a hint, status bar hides). */
  connected: boolean;
  groups: Array<{ bucket: LaunchpadBucket | 'snoozed'; items: PullRequest[] }>;
  attentionCount: number;
}

/**
 * The login a connection's pull request authors are compared with: the
 * account name stored with the credential, else the provider's answer for the
 * token (cached per token), else '' when neither is known.
 */
async function viewerLogin(
  entry: { provider: HostingProvider; auth: { username?: string } },
  auth: AuthContext,
): Promise<string> {
  if (entry.auth.username) return entry.auth.username;
  if (!entry.provider.getViewerLogin) return '';
  // A failed lookup only leaves the Changes Requested group empty; the
  // connection's pull requests still show.
  return entry.provider.getViewerLogin(auth).catch(() => '');
}

// Fetches "my PRs" across every connected hosting provider, classifies them
// into launchpad buckets, and layers snooze state on top. Results are cached
// 60s with stale-while-revalidate so view refreshes stay cheap.
export class LaunchpadService {
  private readonly cache = new TtlCache<PullRequest[]>();

  constructor(
    private readonly integrations: IntegrationService,
    private readonly storage: StorageLike,
    private readonly now: () => number = Date.now,
  ) {}

  async getModel(force = false): Promise<LaunchpadModel> {
    const entries = await this.integrations.getConnectedHostingEntries();
    if (entries.length === 0) {
      return { connected: false, groups: [], attentionCount: 0 };
    }

    const results = await Promise.allSettled(
      entries.map(async (entry) => {
        if (force) this.cache.delete(entry.host);
        const auth = toAuthContext(entry.auth, entry.host);
        const [{ value }, viewer] = await Promise.all([
          this.cache.getOrFetch(entry.host, FRESH_MS, STALE_MS, () =>
            entry.provider.getMyPullRequests(auth, { limit: 50 }),
          ),
          viewerLogin(entry, auth),
        ]);
        return { items: value, viewer };
      }),
    );

    const nowMs = this.now();
    const snoozes = this.loadSnoozes();
    const perProvider: LaunchpadGroup[][] = [];
    const snoozedItems: PullRequest[] = [];
    // One dead provider never blanks the list: rejected entries are skipped.
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { active, snoozed } = partitionSnoozed(result.value.items, snoozes, nowMs);
      snoozedItems.push(...snoozed);
      perProvider.push(groupItems(active, result.value.viewer));
    }

    const groups: LaunchpadModel['groups'] = mergeGroups(perProvider);
    const count = attentionCount(groups as LaunchpadGroup[]);
    if (snoozedItems.length > 0) groups.push({ bucket: 'snoozed', items: snoozedItems });
    return { connected: true, groups, attentionCount: count };
  }

  snooze(prId: string): Thenable<void> {
    const snoozes = this.loadSnoozes();
    return this.storage.update(SNOOZE_STORAGE_KEY, {
      ...snoozes,
      [prId]: this.now() + SNOOZE_DURATION_MS,
    });
  }

  unsnooze(prId: string): Thenable<void> {
    const snoozes = { ...this.loadSnoozes() };
    delete snoozes[prId];
    return this.storage.update(SNOOZE_STORAGE_KEY, snoozes);
  }

  private loadSnoozes(): SnoozeMap {
    const raw = this.storage.get<SnoozeMap>(SNOOZE_STORAGE_KEY) ?? {};
    const pruned = pruneSnoozes(raw, this.now());
    if (pruned !== raw) void this.storage.update(SNOOZE_STORAGE_KEY, pruned);
    return pruned;
  }
}
