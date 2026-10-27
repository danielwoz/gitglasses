# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, not in a public issue or pull
request. Use GitHub's private reporting:
[open a draft security advisory](https://github.com/danielwoz/gitglasses/security/advisories/new)
(the repository's **Security** tab, then **Report a vulnerability**).

Include what you found, the version or commit, and the steps or a repository
that reproduces it. You will get an acknowledgement as soon as the maintainer
has seen the report; fixes are prepared in the advisory and released before
the details are made public, with credit to the reporter unless you prefer
otherwise.

## Supported versions

Only the latest release receives security fixes, so please check that a
problem still occurs there before reporting it.

## Scope

Of particular interest:

- The engine (`gitglasses-engine`) opening a repository the user does not
  trust: crafted objects, packs, configuration, hooks or paths that crash it,
  exhaust memory, run commands or touch files outside the repository.
- The extension handling provider tokens (GitHub, GitLab, Bitbucket, Azure
  DevOps, Jira, Linear) and AI provider keys.
- Webviews rendering repository content (commit messages, branch names, file
  names).

Vulnerabilities in dependencies such as libgit2 are welcome too, if
GitGlasses exposes them; report the underlying issue upstream as well.
