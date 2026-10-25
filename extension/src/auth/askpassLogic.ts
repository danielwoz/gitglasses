// Pure presentation and policy for the credential prompts git, ssh and gpg
// raise through the engine (ui/askpass). No vscode imports.

import type { EngineRequestParams } from '@gitglasses/protocol';

export type AskpassRequest = EngineRequestParams<'ui/askpass'>;

/** What the action that prompted is called, from the engine method. */
export function actionLabel(method: string | undefined): string | undefined {
  switch (method) {
    case 'mutate/push':
      return 'Push';
    case 'mutate/pull':
      return 'Pull';
    case 'mutate/fetch':
      return 'Fetch';
    case 'mutate/commit':
      return 'Commit';
    case 'mutate/merge':
      return 'Merge';
    case 'mutate/cherryPick':
      return 'Cherry-pick';
    case 'mutate/revert':
      return 'Revert';
    case 'mutate/sequencer':
      return 'Continue';
    case 'rebase/start':
    case 'rebase/continue':
      return 'Rebase';
    default:
      return undefined;
  }
}

/** Title of the prompt: the action and where it goes. */
export function promptTitle(request: AskpassRequest): string {
  // Background work (blame, history) prompts only to fetch objects a partial
  // clone left out.
  const action = request.interactive ? actionLabel(request.method) : 'Download Missing Objects';
  const host = request.host ? displayHost(request.host) : undefined;
  if (request.kind === 'hostKey') {
    return `GitGlasses: ${host ? `Connect to ${host}` : 'Connect to an unknown host'}`;
  }
  if (action && host) return `GitGlasses: ${action} (${host})`;
  if (action) return `GitGlasses: ${action}`;
  return host ? `GitGlasses: ${host}` : 'GitGlasses';
}

/** The line shown under the input: the prompt git, ssh or gpg printed,
 *  without its trailing colon and whitespace. */
export function promptText(request: AskpassRequest): string {
  const text = request.prompt.replace(/\s+$/, '').replace(/[:?]$/, '').trim();
  // ssh-keygen signing a commit asks without naming the key or the reason.
  if (text === 'Enter passphrase' && request.kind === 'passphrase') {
    return 'Enter the passphrase of the ssh key that signs your commits';
  }
  return text || defaultPrompt(request.kind);
}

function defaultPrompt(kind: AskpassRequest['kind']): string {
  switch (kind) {
    case 'username':
      return 'Username';
    case 'password':
      return 'Password';
    case 'passphrase':
      return 'Passphrase';
    default:
      return 'Answer';
  }
}

/** ssh writes "[host]:port" for a non-default port. */
export function displayHost(host: string): string {
  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(host);
  return bracketed ? `${bracketed[1]}:${bracketed[2]}` : host;
}

/** The two choices a host-key or confirmation prompt offers. */
export interface YesNoChoice {
  label: string;
  detail?: string;
  answer: 'yes' | 'no';
}

export function yesNoChoices(request: AskpassRequest): YesNoChoice[] {
  if (request.kind === 'hostKey') {
    return [
      {
        label: '$(check) Trust this host and connect',
        detail: request.fingerprint
          ? `${request.fingerprint} (saved to known_hosts)`
          : 'Its key is saved to known_hosts.',
        answer: 'yes',
      },
      { label: '$(close) Do not connect', answer: 'no' },
    ];
  }
  return [
    { label: '$(check) Yes', answer: 'yes' },
    { label: '$(close) No', answer: 'no' },
  ];
}

/** Placeholder of a yes/no prompt: the question ssh asked, on one line. */
export function yesNoQuestion(request: AskpassRequest): string {
  if (request.kind === 'hostKey') {
    const host = request.host ? displayHost(request.host) : 'this host';
    return `The authenticity of ${host} can't be established. Continue connecting?`;
  }
  return promptText(request).split('\n').pop() ?? '';
}

/** A provider credential the integrations hold, as a prompt can use it. */
export interface IntegrationCredential {
  providerId: string;
  /** Host the credential is stored under. */
  host: string;
  token: string;
  username?: string;
}

/**
 * Whether an integration's stored credential may answer this prompt: only a
 * username or password prompt for an https URL whose host is exactly the
 * integration's host. Anything looser would hand a token to whichever server
 * a repository's remote URL names.
 */
export function integrationMayAnswer(request: AskpassRequest, integrationHost: string): boolean {
  if (request.kind !== 'username' && request.kind !== 'password') return false;
  if ((request.protocol ?? '').toLowerCase() !== 'https') return false;
  if (!request.host) return false;
  return request.host.toLowerCase() === integrationHost.toLowerCase();
}

/** The username to give git alongside a provider token, when the credential
 *  stores none. Each forge accepts these with a token as the password. */
export function tokenUsername(providerId: string): string {
  switch (providerId) {
    case 'gitlab':
      return 'oauth2';
    case 'bitbucket':
      return 'x-token-auth';
    case 'azuredevops':
      return 'pat';
    default:
      return 'x-access-token';
  }
}

/** The answer an integration credential gives to a prompt it may answer. */
export function integrationAnswer(
  request: AskpassRequest,
  credential: IntegrationCredential,
): string {
  if (request.kind === 'username') {
    return credential.username || tokenUsername(credential.providerId);
  }
  return credential.token;
}

/** Key under which background prompts for one remote are remembered. */
export function backgroundKey(request: AskpassRequest): string {
  return `${request.protocol ?? ''}://${(request.host ?? '').toLowerCase()}`;
}
