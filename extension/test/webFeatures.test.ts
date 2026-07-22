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
      'integrationsRemoteDetection',
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
});
