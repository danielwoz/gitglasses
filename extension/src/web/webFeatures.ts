// Explicit manifest of what GitGlasses activates on the web (wasm engine)
// versus the native host. extensionWeb.ts is written against this map, and a
// vitest suite asserts it against expectations, so moving a feature across
// the line is always a conscious, reviewed decision.

export type WebFeatureStatus =
  /** Wired on the web with full behavior. */
  | 'included'
  /** Wired on the web, but with reduced behavior (reason says how). */
  | 'degraded'
  /** Not wired on the web at all (reason says why). */
  | 'excluded';

export interface WebFeature {
  status: WebFeatureStatus;
  reason?: string;
}

export const WEB_FEATURES: Readonly<Record<string, WebFeature>> = {
  engineWasmTransport: { status: 'included' },
  memfsWorkspaceMirror: {
    status: 'degraded',
    reason:
      'read-only v1: workspace changes sync into MEMFS, but .git-internal changes from outside the window (external pushes) are not watched',
  },
  blameHover: { status: 'included' },
  lineBlame: {
    status: 'degraded',
    reason: 'internal file-scheme gate: active only when the workspace uses the file scheme (vscode.dev local folders), dormant on virtual schemes',
  },
  fileAnnotations: {
    status: 'degraded',
    reason: 'internal file-scheme gate: file-scheme workspaces only',
  },
  blameCodeLens: {
    status: 'degraded',
    reason: 'internal file-scheme gate: file-scheme workspaces only',
  },
  documentOverlaySync: { status: 'included' },
  revisionContentProvider: { status: 'included' },
  quickDiff: {
    status: 'degraded',
    reason: 'internal file-scheme gate: file-scheme workspaces only',
  },
  treeViews: {
    status: 'degraded',
    reason:
      'firstWorkspaceRepo requires a file-scheme workspace folder; on virtual schemes the views show "no repository"',
  },
  searchView: { status: 'included' },
  homeView: {
    status: 'degraded',
    reason: 'branch card works; push/pull actions are rejected by the wasm engine (-32003)',
  },
  launchpad: {
    status: 'degraded',
    reason: 'no git-config remote detection on web, so hosting is never auto-resolved',
  },
  graphWebview: { status: 'included' },
  timelineWebview: { status: 'included' },
  rebaseWebview: {
    status: 'degraded',
    reason: 'opens, but rebase mutations are engine-gated (-32003)',
  },
  gitPalette: {
    status: 'degraded',
    reason: 'read-only flows work; mutations engine-gated (-32003)',
  },
  worktrees: {
    status: 'degraded',
    reason: 'listing works when the engine supports it; add/remove are engine-gated',
  },
  terminalShaLinks: { status: 'included' },
  repoGroups: {
    status: 'included',
  },
  ai: { status: 'included' },
  integrationsRemoteDetection: {
    status: 'excluded',
    reason: 'reads .git/config through node:fs; the web shim always rejects',
  },
  openOnRemote: {
    status: 'excluded',
    reason:
      'depends on integrationsRemoteDetection, which cannot read .git/config on the web; stub commands explain',
  },
  hunkStaging: {
    status: 'excluded',
    reason:
      'inherits stageMutations: staging would only touch the MEMFS mirror; stub commands explain',
  },
  onboardingWalkthrough: { status: 'included' },
  patches: {
    status: 'excluded',
    reason: 'envelope encryption uses node:crypto ciphers; stub commands explain',
  },
  suggestChange: {
    status: 'degraded',
    reason: 'command exists but is enablement-gated off (engineFullCapabilities is false on wasm)',
  },
  stageMutations: {
    status: 'excluded',
    reason: 'read-only v1: staging would mutate the MEMFS mirror only, never the real repository',
  },
  engineWatch: {
    status: 'excluded',
    reason: 'wasm engine has no watcher; the MEMFS bridge synthesizes refreshes client-side',
  },
  processEngine: {
    status: 'excluded',
    reason: 'no child processes in the worker extension host',
  },
} as const;

export function webFeaturesByStatus(status: WebFeatureStatus): string[] {
  return Object.keys(WEB_FEATURES)
    .filter((id) => WEB_FEATURES[id].status === status)
    .sort();
}
