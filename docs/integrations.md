# Integrations

GitGlasses talks to forges and issue trackers directly with your own tokens,
which stay in VS Code's secret storage. Run **GitGlasses: Connect
Integration…** to set one up: it lists the hosts found in your workspace's
remotes first, and only a self-hosted server asks for a hostname.

## Git hosts

| Host | Set up | Launchpad | PR chips | Suggest Change | Token |
|---|---|---|---|---|---|
| GitHub (github.com) | built in | yes | yes | yes | VS Code GitHub sign-in |
| GitHub Enterprise Server | hostname | yes | yes | yes | personal access token (`repo`) |
| GitLab.com | built in | yes | yes | yes | personal access token (`api`) |
| GitLab self-managed | hostname | yes | yes | yes | personal access token (`api`) |
| Bitbucket Cloud (bitbucket.org) | built in | yes | yes | no | API token plus Atlassian email, or an access token |
| Bitbucket Data Center | hostname | yes | yes | no | HTTP access token |
| Azure DevOps Services (dev.azure.com) | organization | yes | yes | no | personal access token |

In `gitglasses.integrations.hosts` an entry names the domain and one of the
provider ids `github`, `github-enterprise`, `gitlab`, `bitbucket`,
`bitbucketDC` or `azuredevops`; an Azure DevOps entry also names its
`organization`. `github` on any domain other than github.com is treated as
GitHub Enterprise Server. An entry a provider cannot serve, such as
`bitbucket` on a domain other than bitbucket.org, is ignored with a warning.

Pull request chips and Suggest Change look for the pull request opened from
the remote the branch is pushed to, under the branch's own name. The
`upstream` remote, as a fork usually has, is asked first, then `origin`,
then the remotes the branch tracks and pushes to. A pull request from
someone else's fork never matches, even when its branch has the same name.

A branch checked out for review is matched to its pull request too: one
made by `gh pr checkout` (from a fork, or from `refs/pull/<n>/head`) or by
the GitHub Pull Requests extension. A new branch started from another
branch, such as `git checkout -b fix origin/develop`, has no pull request
until it is pushed under its own name. Of the user's own git config, only
`remote.pushDefault` is read; `include` files are not followed.

## Issue trackers (Start Work)

| Tracker | Set up | Token |
|---|---|---|
| Jira Cloud (*.atlassian.net) | site name | API token plus Atlassian account email |
| Linear | built in | personal API key |
| GitHub Issues (github.com) | built in | VS Code GitHub sign-in |
| GitHub Enterprise Server issues | settings entry with the host | personal access token (`repo`) |

## Suggest Change fallback

When a suggestion cannot be anchored in the pull request diff, GitGlasses
offers to post it as a comment instead. The comment carries the replacement
and a patch of only the suggested lines, built from the file at the pull
request head; nothing else from your working tree is included. By default
the patch goes in the comment itself, readable by whoever can read the pull
request. On GitHub you can choose to upload it as a secret gist instead
(unlisted, but readable by anyone with the link, which is posted on the
pull request). The confirmation shows the patch before anything is posted,
and Preview Patch opens it in an editor to read in full.

Suggestions are refused when the file differs from the pull request head
above or within the selected lines, because the line numbers would land on
different text. Commit and push, or pull the latest, and try again.

## Not yet supported

- Jira Server and Jira Data Center (only Jira Cloud sites on atlassian.net).
- Azure DevOps Server (only Azure DevOps Services on dev.azure.com).
- More than one Azure DevOps organization in the Launchpad: one
  organization is configured per host. Pull request chips work for
  repositories in any organization the token can read.
- GitLab, Bitbucket and Azure DevOps issues in Start Work.
- Suggest Change on Bitbucket and Azure DevOps.
