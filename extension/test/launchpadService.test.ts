// The Launchpad groups a connection's pull requests by who the user is on
// that host. A token stored without an account name (GitHub Enterprise, or
// any personal access token) is asked who it belongs to.

import { describe, expect, it } from 'vitest';
import type { FetchLike, HttpRequestInit, HttpResponseLike } from '@gitglasses/integrations';
import type { IntegrationService } from '../src/integrations/integrationService';
import { LaunchpadService, type StorageLike } from '../src/integrations/launchpadService';
import { buildHostingEntries } from '../src/integrations/providerSetup';

const HOST = 'github.corp.example';

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

/** An enterprise host where "octo" has one pull request with changes
 *  requested, and is mentioned on someone else's. */
function enterpriseHost(user: () => HttpResponseLike = () => jsonResponse({ login: 'octo' })): {
  fetchFn: FetchLike;
  requests: Array<{ url: string; init?: HttpRequestInit }>;
} {
  const requests: Array<{ url: string; init?: HttpRequestInit }> = [];
  const fetchFn: FetchLike = async (url, init) => {
    requests.push({ url, init });
    if (url === `https://${HOST}/api/v3/user`) return user();
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

function service(fetchFn: FetchLike, username?: string): LaunchpadService {
  const { entries } = buildHostingEntries(
    [{ domain: HOST, provider: 'github-enterprise' }],
    fetchFn,
  );
  const entry = entries.get(HOST)!;
  const integrations = {
    getConnectedHostingEntries: async () => [{ ...entry, auth: { token: 'ghe-token', username } }],
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
    const lookup = requests.find((request) => request.url.endsWith('/user'));
    expect(lookup?.url).toBe(`https://${HOST}/api/v3/user`);
    expect(lookup?.init?.headers?.authorization).toBe('Bearer ghe-token');
  });

  it('asks who the token belongs to once per connection', async () => {
    const { fetchFn, requests } = enterpriseHost();
    const launchpad = service(fetchFn);
    await launchpad.getModel();
    await launchpad.getModel(true);
    await launchpad.getModel(true);
    const lookups = requests.filter((request) => request.url.endsWith('/user'));
    const searches = requests.filter((request) => request.url.endsWith('/graphql'));
    expect(lookups).toHaveLength(1);
    expect(searches).toHaveLength(3);
  });

  it('uses the account name stored with the credential without asking', async () => {
    const { fetchFn, requests } = enterpriseHost();
    const model = await service(fetchFn, 'octo').getModel();
    expect(buckets(model)[0]).toEqual(['changes-requested', [1]]);
    expect(requests.some((request) => request.url.endsWith('/user'))).toBe(false);
  });

  it('still lists the pull requests when the lookup fails', async () => {
    const { fetchFn } = enterpriseHost(() =>
      jsonResponse({ message: 'API rate limit exceeded' }, 429),
    );
    const model = await service(fetchFn).getModel();
    expect(buckets(model)).toEqual([['waiting', [2, 1]]]);
  });
});
