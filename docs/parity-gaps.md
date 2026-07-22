# Parity gaps vs GitLens Pro

GitGlasses reimplements GitLens Pro's feature surface without a proprietary
cloud service. Most features are at full parity or better (no paywall, no
account). These are the honest gaps, with the reasons and our alternatives.

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
- No zero-config hosted AI quota. Bring your own key (Anthropic, OpenAI,
  Gemini), use VS Code language models (Copilot), or run fully offline with
  Ollama.

## Integrations
- GitKraken brokers OAuth for many providers; we use VS Code's built-in
  GitHub/Microsoft auth where possible and PATs elsewhere (more setup, more
  privacy — tokens never leave the machine).
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
