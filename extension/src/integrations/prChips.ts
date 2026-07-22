import { TtlCache } from '@gitglasses/integrations';
import type { IntegrationService } from './integrationService';
import { prChipSuffix } from './prChipLogic';

const CHIP_TTL_MS = 5 * 60_000;
const CHIP_STALE_MS = 5 * 60_000;

// Lazily resolves "does this branch have an open PR?" chips for the Branches
// view, cached 5 minutes per branch. Failures cache as "no chip" via the
// stale window rather than throwing into the tree.
export class PrChipProvider {
  private readonly cache = new TtlCache<string | undefined>();

  constructor(private readonly integrations: IntegrationService) {}

  /** Description suffix ("PR #N ✓") for a branch, or undefined when none/unconnected. */
  async getChipFor(repoRoot: string, branch: string): Promise<string | undefined> {
    const hosting = await this.integrations.getConnectedHostingFor(repoRoot);
    if (!hosting) return undefined;
    const key = `${hosting.repo.host}/${hosting.repo.owner}/${hosting.repo.name}#${branch}`;
    try {
      const { value } = await this.cache.getOrFetch(key, CHIP_TTL_MS, CHIP_STALE_MS, async () => {
        const pr = await hosting.provider.getPullRequestForBranch(
          hosting.auth,
          hosting.repo,
          branch,
        );
        return pr && pr.state === 'open' ? prChipSuffix(pr) : undefined;
      });
      return value;
    } catch {
      return undefined;
    }
  }
}
