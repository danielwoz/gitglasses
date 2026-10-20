import { TtlCache } from '@gitglasses/integrations';
import type { IntegrationService } from './integrationService';
import { prChipSuffix } from './prChipLogic';

const CHIP_TTL_MS = 5 * 60_000;
const CHIP_STALE_MS = 5 * 60_000;

// Lazily resolves "does this branch have an open PR?" chips for the Branches
// view, cached 5 minutes per branch. Failures cache as "no chip" via the
// stale window rather than throwing into the tree.
export class PrChipProvider {
  private cache = new TtlCache<string | undefined>();

  constructor(private readonly integrations: IntegrationService) {
    // A connection or settings change can turn a cached "no chip" into one.
    integrations.onDidChange(() => {
      this.cache = new TtlCache<string | undefined>();
    });
  }

  /** Description suffix ("PR #N ✓") for a branch, or undefined when none/unconnected. */
  async getChipFor(repoRoot: string, branch: string): Promise<string | undefined> {
    const key = `${repoRoot}\n${branch}`;
    try {
      const { value } = await this.cache.getOrFetch(key, CHIP_TTL_MS, CHIP_STALE_MS, async () => {
        // Only the pull request opened from this branch's own push remote
        // counts; another fork's branch of the same name is not this one.
        const found = await this.integrations.findPullRequestForBranch(repoRoot, branch);
        return found && found.pr.state === 'open' ? prChipSuffix(found.pr) : undefined;
      });
      return value;
    } catch {
      return undefined;
    }
  }
}
