import * as vscode from 'vscode';

// Per-provider credential management. GitHub.com goes through VS Code's
// built-in GitHub authentication provider; everything else (enterprise hosts,
// Jira, Linear, ...) uses a personal access token stored in SecretStorage.

export interface AuthInfo {
  token: string;
  /** Account username/email, when known (session label or a stored value). */
  username?: string;
}

export interface GetAuthOptions {
  /** Prompt the user (sign-in flow / token input) when nothing is stored. */
  interactive?: boolean;
  /** Also collect a username alongside the token (e.g. Jira's account email). */
  needsUsername?: boolean;
}

const SECRET_PREFIX = 'gitglasses:auth:';

function tokenKey(providerId: string, host: string): string {
  return `${SECRET_PREFIX}${providerId}:${host}`;
}

function usernameKey(providerId: string, host: string): string {
  return `${tokenKey(providerId, host)}:username`;
}

function usesVsCodeGitHubAuth(providerId: string, host: string): boolean {
  return providerId === 'github' && host === 'github.com';
}

export class AuthManager implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires when any credential is added, changed, or removed. */
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly secrets: vscode.SecretStorage) {
    this.disposables.push(
      vscode.authentication.onDidChangeSessions((e) => {
        if (e.provider.id === 'github') this.emitter.fire();
      }),
      secrets.onDidChange((e) => {
        if (e.key.startsWith(SECRET_PREFIX)) this.emitter.fire();
      }),
    );
  }

  async getAuth(
    providerId: string,
    host: string,
    options: GetAuthOptions = {},
  ): Promise<AuthInfo | undefined> {
    if (usesVsCodeGitHubAuth(providerId, host)) {
      try {
        const session = await vscode.authentication.getSession(
          'github',
          ['repo'],
          options.interactive ? { createIfNone: true } : { silent: true },
        );
        return session
          ? { token: session.accessToken, username: session.account.label }
          : undefined;
      } catch {
        // User cancelled the sign-in flow or the auth provider is unavailable.
        return undefined;
      }
    }

    let token = await this.secrets.get(tokenKey(providerId, host));
    let username = await this.secrets.get(usernameKey(providerId, host));
    if (!token && options.interactive) {
      token = await vscode.window.showInputBox({
        prompt: `Personal access token for ${providerId} (${host})`,
        password: true,
        ignoreFocusOut: true,
      });
      if (!token) return undefined;
      await this.secrets.store(tokenKey(providerId, host), token);
    }
    if (token && !username && options.needsUsername && options.interactive) {
      username = await vscode.window.showInputBox({
        prompt: `Account username/email for ${providerId} (${host})`,
        ignoreFocusOut: true,
      });
      if (username) await this.secrets.store(usernameKey(providerId, host), username);
    }
    return token ? { token, username: username ?? undefined } : undefined;
  }

  /** True when a credential is already stored/available without prompting. */
  async isConnected(providerId: string, host: string): Promise<boolean> {
    return (await this.getAuth(providerId, host)) !== undefined;
  }

  async signOut(providerId: string, host: string): Promise<void> {
    if (usesVsCodeGitHubAuth(providerId, host)) {
      // Sessions from the built-in GitHub provider are managed by VS Code's
      // Accounts menu; nothing is stored on our side.
      void vscode.window.showInformationMessage(
        'GitGlasses: GitHub sign-in is managed by VS Code — remove access from the Accounts menu.',
      );
      return;
    }
    await this.secrets.delete(tokenKey(providerId, host));
    await this.secrets.delete(usernameKey(providerId, host));
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.emitter.dispose();
  }
}
