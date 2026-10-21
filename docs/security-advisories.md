# Security advisories

Security problems fixed in GitGlasses releases, newest first. To report one,
see the security policy in the repository.

## Integration tokens for self-hosted servers sent to public hosts

- **Affected versions:** 0.1.1 and 0.1.2
- **Fixed in:** 0.2.0
- **Severity:** high

### Impact

An integration configured for a self-hosted server could send that server's
token to a public service instead:

- **Self-managed GitLab** (a `gitglasses.integrations.hosts` entry with
  `"provider": "gitlab"` and your own domain, as the setting's description
  suggests): the personal access token was sent to `gitlab.com` when the
  connection was checked, on every Launchpad refresh, for pull request chips
  in the Branches view, and when applying a patch from a snippet URL on that
  server.
- **GitHub on a custom domain** (`"provider": "github"` with a domain other
  than `github.com`): the token was sent to `api.github.com`.
- **Bitbucket on a custom domain** (`"provider": "bitbucket"`): the token was
  sent to `api.bitbucket.org`, whatever the domain.
- **Azure DevOps Server** (`"provider": "azuredevops"` with your own domain):
  the token was sent to `dev.azure.com`.

The requests went over TLS to the vendors' own services (gitlab.com,
github.com, bitbucket.org, dev.azure.com), which rejected the tokens.
GitGlasses then reported the token as rejected and signed the integration
out, so connecting again sent it again. Tokens were not sent anywhere else,
and GitHub Enterprise Server set up as `"provider": "github-enterprise"` was
not affected.

### What to do

If you connected one of the integrations above in 0.1.1 or 0.1.2, **revoke
that token on your server and create a new one**, then update GitGlasses and
connect again. Treat the old token as disclosed to the public service it was
sent to.

### Fix

0.2.0 builds every provider for the host it is configured for, rejects a
configuration a provider cannot serve, and refuses, before sending anything,
any request that would carry a credential to a host other than the one the
credential is stored for.
