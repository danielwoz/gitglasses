// The Launchpad groups a connection's pull requests by who the user is on
// that host. A token stored without an account name (GitHub Enterprise,
// Bitbucket Data Center, or any personal access token) is matched to its
// owner by the pull requests the provider reports as the viewer's own.

import { describe, expect, it } from 'vitest';
import type { FetchLike, HttpRequestInit, HttpResponseLike } from '@gitglasses/integrations';
import type { IntegrationService } from '../src/integrations/integrationService';
import { LaunchpadService, type StorageLike } from '../src/integrations/launchpadService';
import { buildHostingEntries } from '../src/integrations/providerSetup';

const HOST = 'github.corp.example';
const DC_HOST = 'bitbucket.corp.example';

function jsonResponse(body: unknown, status = 200): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function prNode(number: number, author: string, reviewDecision: string): unknown {
  return {
    id: `PR_${number}`,
    number,
    title: `PR ${number}`,
    url: `https://${HOST}/acme/widgets/pull/${number}`,
    state: 'OPEN',
    isDraft: false,
    author: { login: author },
    baseRefName: 'main',
    headRefName: `topic-${number}`,
    headRefOid: 'deadbeef',
    repository: { name: 'widgets', owner: { login: 'acme' } },
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: `2026-07-0${number}T00:00:00Z`,
    reviewDecision,
    mergeable: 'MERGEABLE',
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    reviewRequests: { nodes: [] },
    assignees: { nodes: [] },
  };
}

type Requests = Array<{ url: string; init?: HttpRequestInit }>;

/** An enterprise host where "octo" has one pull request with changes
 *  requested, and is mentioned on someone else's. */
function enterpriseHost(): { fetchFn: FetchLike; requests: Requests } {
  const requests: Requests = [];
  const fetchFn: FetchLike = async (url, init) => {
    requests.push({ url, init });
    if (url === `https://${HOST}/api/graphql`) {
      return jsonResponse({
        data: {
          viewer: { login: 'octo' },
          search: {
            nodes: [
              prNode(1, 'octo', 'CHANGES_REQUESTED'),
              prNode(2, 'hubot', 'CHANGES_REQUESTED'),
            ],
          },
        },
      });
    }
    return jsonResponse({ message: 'Not Found' }, 404);
  };
  return { fetchFn, requests };
}

function dcPullRequest(id: number, author: string, status: string): unknown {
  const ref = (branch: string) => ({
    id: `refs/heads/${branch}`,
    displayId: branch,
    repository: { slug: 'widgets', project: { key: 'ACME' } },
  });
  return {
    id,
    title: `PR ${id}`,
    state: 'OPEN',
    author: { user: { name: author, slug: author } },
    reviewers: [{ user: { name: 'reviewer' }, status }],
    fromRef: ref(`topic-${id}`),
    toRef: ref('main'),
    createdDate: Date.parse('2026-07-01T00:00:00Z'),
    updatedDate: Date.parse(`2026-07-0${id}T00:00:00Z`),
  };
}

/** A Data Center host where "ann" authored a pull request that needs work,
 *  and reviews someone else's. */
function dataCenterHost(): FetchLike {
  return async (url) => {
    if (url.includes('/dashboard/pull-requests') && url.includes('role=AUTHOR')) {
      return jsonResponse({ values: [dcPullRequest(1, 'ann', 'NEEDS_WORK')] });
    }
    if (url.includes('/dashboard/pull-requests') && url.includes('role=REVIEWER')) {
      return jsonResponse({ values: [dcPullRequest(2, 'bob', 'NEEDS_WORK')] });
    }
    return jsonResponse({ message: 'Not Found' }, 404);
  };
}

function service(
  fetchFn: FetchLike,
  username?: string,
  host: { domain: string; provider: string } = { domain: HOST, provider: 'github-enterprise' },
): LaunchpadService {
  const { entries } = buildHostingEntries([host], fetchFn);
  const entry = entries.get(host.domain)!;
  const integrations = {
    getConnectedHostingEntries: async () => [{ ...entry, auth: { token: 'token', username } }],
  } as unknown as IntegrationService;
  const storage: StorageLike = { get: () => undefined, update: async () => undefined };
  return new LaunchpadService(integrations, storage, () => Date.parse('2026-07-10T00:00:00Z'));
}

function buckets(model: { groups: Array<{ bucket: string; items: Array<{ number: number }> }> }) {
  return model.groups.map((group) => [group.bucket, group.items.map((item) => item.number)]);
}

describe('LaunchpadService viewer', () => {
  it("puts the token owner's pull request with changes requested under Changes Requested", async () => {
    const { fetchFn, requests } = enterpriseHost();
    const model = await service(fetchFn).getModel();
    expect(buckets(model)).toEqual([
      ['changes-requested', [1]],
      ['waiting', [2]],
    ]);
    // The search names the viewer, so nothing else is asked.
    expect(requests.map((request) => request.url)).toEqual([`https://${HOST}/api/graphql`]);
  });

  it('asks only for the pull requests on each refresh', async () => {
    const { fetchFn, requests } = enterpriseHost();
    const launchpad = service(fetchFn);
    await launchpad.getModel();
    await launchpad.getModel(true);
    await launchpad.getModel();
    expect(requests.map((request) => request.url)).toEqual([
      `https://${HOST}/api/graphql`,
      `https://${HOST}/api/graphql`,
    ]);
  });

  it('agrees with the account name stored with the credential', async () => {
    const { fetchFn } = enterpriseHost();
    const model = await service(fetchFn, 'octo').getModel();
    expect(buckets(model)[0]).toEqual(['changes-requested', [1]]);
  });

  it('finds the token owner on Bitbucket Data Center too', async () => {
    const launchpad = service(dataCenterHost(), undefined, {
      domain: DC_HOST,
      provider: 'bitbucketDC',
    });
    expect(buckets(await launchpad.getModel())).toEqual([
      ['needs-your-review', [2]],
      ['changes-requested', [1]],
    ]);
  });
});
