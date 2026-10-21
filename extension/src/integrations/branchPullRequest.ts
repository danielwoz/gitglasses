// Finding the open pull request a local branch belongs to (no vscode
// imports). gitConfig.ts works out where the branch is pushed and which
// repositories its pull request may target; this module asks the providers
// serving those repositories.

import type {
  AuthContext,
  HostingProvider,
  PullRequest,
  RepoDescriptor,
} from '@gitglasses/integrations';
import type { PullRequestRemotes, RemoteConfig } from './gitConfig';
import { toAuthContext, type StoredCredential } from './providerSetup';

/** A remote's repository with the provider serving its host. */
export interface RemoteHosting {
  providerId: string;
  host: string;
  provider: HostingProvider;
  repo: RepoDescriptor;
}

/** A branch's open pull request and the connection that found it. */
export interface FoundPullRequest {
  /** The repository the pull request lives in, with its credentials. */
  hosting: RemoteHosting & { auth: AuthContext; username?: string };
  pr: PullRequest;
}

export interface BranchLookupDeps {
  /** The hosting for a remote's URL, when a configured provider serves it. */
  hostingFor(remote: RemoteConfig): RemoteHosting | undefined;
  /** The credential stored for a provider on a host, when connected. */
  credentialFor(providerId: string, host: string): Promise<StoredCredential | undefined>;
}

/** The URL a remote fetches from, else the one it pushes to. */
function urlOf(remote: RemoteConfig): string | undefined {
  return remote.url ?? remote.pushUrl;
}

function repoKey(hosting: RemoteHosting): string {
  return `${hosting.host}/${hosting.repo.owner}/${hosting.repo.name}`.toLowerCase();
}

/** The pull request a branch's config names, when it is still open. */
async function findNamedPullRequest(
  target: NonNullable<PullRequestRemotes['trackedPullRequest']>,
  deps: BranchLookupDeps,
): Promise<FoundPullRequest | undefined> {
  const hosting = deps.hostingFor(target.remote);
  if (!hosting) return undefined;
  const credential = await deps.credentialFor(hosting.providerId, hosting.host);
  if (!credential) return undefined;
  const auth = toAuthContext(credential, hosting.host);
  const found = await hosting.provider.getIssueOrPr(auth, hosting.repo, `#${target.number}`);
  if (!found || !('headSha' in found) || found.state !== 'open') return undefined;
  return { hosting: { ...hosting, auth, username: credential.username }, pr: found };
}

/**
 * The open pull request for the branch `plan` describes, opened from its
 * head remote. A pull request whose head is in any other fork never
 * matches, since every lookup names the head repository's owner.
 */
export async function findBranchPullRequest(
  plan: PullRequestRemotes,
  deps: BranchLookupDeps,
): Promise<FoundPullRequest | undefined> {
  if (plan.trackedPullRequest) return findNamedPullRequest(plan.trackedPullRequest, deps);

  const headUrl = plan.headRemote.pushUrl ?? plan.headRemote.url;
  const head = headUrl ? deps.hostingFor({ name: plan.headRemote.name, url: headUrl }) : undefined;
  if (!head) return undefined;
  const credential = await deps.credentialFor(head.providerId, head.host);
  if (!credential) return undefined;
  const auth = toAuthContext(credential, head.host);

  const asked = new Set<string>();
  let failure: unknown;
  for (const lookup of plan.lookups) {
    const base = urlOf(lookup.base) === undefined ? undefined : deps.hostingFor(lookup.base);
    // A pull request lives on the host its head was pushed to.
    if (!base || base.host !== head.host) continue;
    const key = `${repoKey(base)}\n${lookup.branch}`;
    if (asked.has(key)) continue;
    asked.add(key);
    try {
      const pr = await base.provider.getPullRequestForBranch(auth, base.repo, lookup.branch, {
        owner: head.repo.owner,
        name: head.repo.name,
      });
      if (pr) return { hosting: { ...base, auth, username: credential.username }, pr };
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) {
    throw failure instanceof Error ? failure : new Error(String(failure));
  }
  return undefined;
}
