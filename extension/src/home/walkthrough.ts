import * as vscode from 'vscode';
import { WALKTHROUGH_ID, walkthroughTabState } from './homeLogic';

/** When a browser host is asked again, counted from the first request.
 *  Extension walkthroughs register about five seconds after the Welcome
 *  editor's service starts there, which the first request is what starts. */
const RETRY_AFTER_MS = [6000, 10000];

function activeTabLabel(): string | undefined {
  return vscode.window.tabGroups.activeTabGroup.activeTab?.label;
}

/**
 * Opens the GitGlasses walkthrough. On browser hosts (code-server,
 * openvscode-server) the first request in a session can arrive before the
 * extension's walkthroughs are registered, and the Welcome editor then
 * falls back to the host's own setup walkthrough. The tab's title cannot
 * always tell which walkthrough it shows, so while the Welcome editor stays
 * in front the request is repeated once the registration has had time to
 * land; asking for the walkthrough that is already shown changes nothing.
 */
export async function openWalkthrough(log: (line: string) => void): Promise<void> {
  const open = (): Thenable<unknown> =>
    vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID, false);
  await open();
  if (vscode.env.uiKind !== vscode.UIKind.Web) return;
  const started = Date.now();
  void (async () => {
    for (const at of RETRY_AFTER_MS) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, started + at - Date.now())));
      const label = activeTabLabel();
      if (walkthroughTabState(label) !== 'welcome') return;
      log(`walkthrough: asking again while the Welcome editor shows "${label}"`);
      await open();
    }
  })().catch((error) => log(`walkthrough: reopening failed: ${String(error)}`));
}
