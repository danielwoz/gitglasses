import { describe, expect, it } from 'vitest';
import { WEB_FEATURES, webFeaturesByStatus } from '../src/web/webFeatures';

// The manifest is the conscious record of what runs on the web. If a change
// moves a feature across the line, this test forces the move to be explicit.
describe('web feature manifest', () => {
  it('includes the read pipeline outright', () => {
    expect(webFeaturesByStatus('included')).toEqual([
      'ai',
      'blameHover',
      'documentOverlaySync',
      'engineWasmTransport',
      'graphWebview',
      'onboardingWalkthrough',
      'repoGroups',
      'revisionContentProvider',
      'searchView',
      'terminalShaLinks',
      'timelineWebview',
    ]);
  });

  it('keeps node-only and mutating features off the web', () => {
    expect(webFeaturesByStatus('excluded')).toEqual([
      'engineWatch',
      'hunkStaging',
      'integrationsRemoteDetection',
      'openOnRemote',
      'patches',
      'processEngine',
      'stageMutations',
    ]);
  });

  it('documents every degraded feature with a reason', () => {
    for (const [id, feature] of Object.entries(WEB_FEATURES)) {
      if (feature.status === 'included') continue;
      expect(feature.reason, `feature ${id} needs a reason`).toBeTruthy();
    }
  });

  it('covers the wasm engine invariants', () => {
    expect(WEB_FEATURES.stageMutations.status).toBe('excluded'); // read-only v1
    expect(WEB_FEATURES.engineWatch.status).toBe('excluded'); // bridge synthesizes
    expect(WEB_FEATURES.processEngine.status).toBe('excluded'); // no spawn on web
  });

  // These are contributed unconditionally in package.json — the editor context
  // menu and the walkthrough both reference them — so they must resolve to a
  // stub on the web rather than fail with "command not found".
  it('excludes remote and staging commands but still contributes them', () => {
    expect(WEB_FEATURES.openOnRemote.status).toBe('excluded');
    expect(WEB_FEATURES.hunkStaging.status).toBe('excluded');
    expect(WEB_FEATURES.onboardingWalkthrough.status).toBe('included');
  });
});
