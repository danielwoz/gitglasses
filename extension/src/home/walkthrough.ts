import * as vscode from 'vscode';
import { WALKTHROUGH_ID, walkthroughRetryAt, walkthroughTabState } from './homeLogic';

/**
 * Opens the GitGlasses walkthrough. On browser hosts (code-server,
 * openvscode-server) extension walkthroughs register a few seconds after
 * the Welcome editor first starts in a window, and a request before then
 * shows the host's own setup walkthrough instead. Such a request is made
 * once more when the registration has landed, unless the user has moved to
 * another tab; the tab's title cannot tell which walkthrough is shown.
 * Later requests are made once, since asking again would rebuild the
 * walkthrough page and drop the step the user picked.
 */
export class WalkthroughOpener implements vscode.Disposable {
  /** When a Welcome editor was first in front in this window, or the
   *  walkthrough first requested, whichever came first. */
  private welcomeStartedAt: number | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly log: (line: string) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.noteWelcome();
    this.subscription = vscode.window.tabGroups.onDidChangeTabs(() => this.noteWelcome());
  }

  async open(): Promise<void> {
    const requestedAt = this.now();
    this.welcomeStartedAt ??= requestedAt;
    const browser = vscode.env.uiKind === vscode.UIKind.Web;
    this.log(`walkthrough: opening (${browser ? 'browser' : 'desktop'} host)`);
    const first = this.request();
    if (browser) this.scheduleRetry(requestedAt, this.welcomeStartedAt);
    await first;
  }

  private request(): Thenable<unknown> {
    return vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      WALKTHROUGH_ID,
      false,
    );
  }

  private scheduleRetry(requestedAt: number, welcomeStartedAt: number): void {
    const retryAt = walkthroughRetryAt(requestedAt, welcomeStartedAt);
    if (retryAt === undefined) {
      this.log('walkthrough: extension walkthroughs have registered; not asking again');
      return;
    }
    // A request made while one is pending is covered by it.
    if (this.retry !== undefined) return;
    this.retry = setTimeout(
      () => {
        this.retry = undefined;
        const label = vscode.window.tabGroups.activeTabGroup.activeTab?.label;
        if (walkthroughTabState(label) !== 'welcome') {
          this.log(`walkthrough: not asking again; the active tab is "${label ?? 'none'}"`);
          return;
        }
        this.log(`walkthrough: asking again now that extension walkthroughs have registered`);
        Promise.resolve(this.request()).catch((error) =>
          this.log(`walkthrough: reopening failed: ${String(error)}`),
        );
      },
      Math.max(0, retryAt - this.now()),
    );
  }

  /** Notes when a Welcome editor is first in front, which starts the
   *  service extension walkthroughs register with. */
  private noteWelcome(): void {
    if (this.welcomeStartedAt !== undefined) return;
    const shown = vscode.window.tabGroups.all.some(
      (group) => walkthroughTabState(group.activeTab?.label) !== 'elsewhere',
    );
    if (shown) this.welcomeStartedAt = this.now();
  }

  dispose(): void {
    this.subscription.dispose();
    clearTimeout(this.retry);
  }
}
