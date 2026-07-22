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
  can read. Optional client-side `age` encryption closes this when needed.
- No central "my patches across devices" list; a local index only.

## Code Suggest → PR review suggestions
- Suggestions must anchor to lines inside the PR diff (GitHub/GitLab API
  limit). GitLens' whole-file/out-of-diff suggestions rely on their cloud;
  our fallback posts an Open Patch link as a PR comment.

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

## Misc
- vscode.dev (web) unsupported until the engine has a wasm build.
- Commit graph renderer is our own (GitLens' component is proprietary);
  feature parity tracked in the graph spec, pixel parity is a non-goal.
