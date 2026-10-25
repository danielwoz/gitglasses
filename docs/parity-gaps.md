# Known limitations

GitGlasses has no servers of its own: everything a hosted git tool would do
in its cloud, GitGlasses does on your machine or directly against your
forge's API with your own token. This page lists where that, or anything
else, makes it behave differently from what you might expect, and the
alternative where there is one.

## Launchpad
- **No server push** — PR state refreshes by polling provider APIs (visible
  views only, backs off when unfocused). GitKraken's cloud can push.
- **Per-account quota** — each configured account spends its own API quota.
- Snooze/pin state syncs via VS Code Settings Sync, not a cloud account.

## Cloud Patches → Open Patches
- Patch envelopes are stored as files or secret Gists/GitLab Snippets.
  **Secret gists are unlisted, not access-controlled** — anyone with the URL
  can read. The "Share Encrypted…" destination closes this: client-side
  passphrase encryption (scrypt + AES-256-GCM), decrypted on apply. The
  passphrase itself still has to travel out-of-band.
- No central "my patches across devices" list; a local index only.

## Code Suggest → PR review suggestions
- Suggestions must anchor to lines inside the PR diff (GitHub/GitLab API
  limit). GitLens' whole-file/out-of-diff suggestions rely on their cloud;
  when the anchor is rejected (or the provider cannot suggest but can
  comment), GitGlasses automatically offers to share the working changes as
  a patch link posted in a top-level PR comment. The reviewer applies it
  with GitGlasses rather than a one-click provider UI, and the patch carries
  the whole WIP (the engine has no per-file patch filter yet).

## Workspaces → Repo Groups
- Groups sync via Settings Sync (remote URLs, portable), not a team cloud.
  Team sharing = export the group file into a repo.

## AI
- No hosted AI quota. The first AI command offers what the editor can use: a
  language model another extension provides (such as GitHub Copilot in VS
  Code; Open VSX editors usually have none), a local Ollama model, or your
  own Anthropic, OpenAI-compatible or Gemini key.
- Hosted providers receive the diff, commit messages, file paths and author
  names and emails of what you ask about, after a confirmation once per
  workspace. Explain Commit sends at most about 6,000 tokens of diff.

## Integrations
- What each forge and tracker supports, and what is not supported yet, is in
  [integrations.md](integrations.md).
- There is no OAuth broker: GitHub uses the editor's built-in GitHub sign-in,
  and other providers take a personal access token. That is more setup, but
  each token is stored in the editor's secret storage and is only ever sent
  to the provider it belongs to.
- Bitbucket Data Center's older API lacks a mergeability signal — shown as
  "unknown".
- Jira dev-panel branch linking requires a Jira Marketplace app; we create
  issue remote-links instead.

## Web (vscode.dev)
- **Supported** via the wasm engine build: blame (libgit2 in-process), hovers,
  history, graph, timeline, search, revision docs, AI — read-only.
- Requires a workspace with a real `.git` folder (e.g. a local folder opened
  in the browser). The repo is mirrored into wasm memory, bounded by
  `gitglasses.web.maxRepoBytes` (default 200 MB).
- Not on web (v1): mutations/rebase/stage (engine is read-only there),
  patches (node crypto), provider integrations, external `.git` change
  watching. github.dev virtual repos (no `.git`) show a clear notice and
  stay dormant — an API-backed provider for those is future work.

## Misc
- Commit graph renderer is our own (GitLens' component is proprietary);
  feature parity tracked in the graph spec, pixel parity is a non-goal.
