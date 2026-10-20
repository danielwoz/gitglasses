// Schemas for requests the engine sends to the client. The client answers
// them like any JSON-RPC request; their ids are strings, so they never
// collide with the client's own integer ids.

import { Type } from '@sinclair/typebox';

import { AskpassKind, strict } from './models.js';

export const EngineRequestSchemas = {
  'ui/askpass': {
    description:
      'Asks the user for what git, ssh or gpg prompted for while running a request: a credential, a key passphrase or a host-key confirmation. Sent only to clients that declared clientCapabilities.askpass. The value never reaches a log. A ui/askpassCancelled notification withdraws the request when git stops waiting (it exited, timed out or was cancelled); the client then closes its prompt and its answer is ignored.',
    params: Type.Object(
      {
        /** Id of the client request whose git invocation is prompting, when
         * the prompt came from one; its deadline is paused while the prompt
         * is open. */
        requestId: Type.Optional(Type.Integer()),
        /** Method of that request, e.g. mutate/push. */
        method: Type.Optional(Type.String()),
        repoId: Type.Optional(Type.String()),
        kind: AskpassKind,
        /** The prompt text exactly as git, ssh or gpg printed it. */
        prompt: Type.String(),
        /** Scheme of the URL the prompt names (https, http, ssh), when it names one. */
        protocol: Type.Optional(Type.String()),
        host: Type.Optional(Type.String()),
        username: Type.Optional(Type.String()),
        /** SHA256 fingerprint of an ssh host key being confirmed. */
        fingerprint: Type.Optional(Type.String()),
        /** The answer is a secret: mask it while typed and never store it. */
        secret: Type.Boolean(),
        /** false when the prompt came from background work (blame, history)
         * rather than an action the user started; the client should answer
         * only from what it holds already, without showing anything. */
        interactive: Type.Boolean(),
      },
      strict,
    ),
    result: Type.Union([
      Type.Object({ value: Type.String() }, strict),
      Type.Object({ cancelled: Type.Literal(true) }, strict),
    ]),
  },
};
