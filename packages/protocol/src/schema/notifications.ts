// Schemas for one-way notifications in both directions.

import { Type } from '@sinclair/typebox';

import { BlameHunk, CommitSummaryInfo, strict } from './models.js';

export const ClientNotificationSchemas = {
  'doc/didChange': {
    description:
      'Pushes an editor buffer into the engine so working-tree blame reflects unsaved edits.',
    params: Type.Object(
      {
        repoId: Type.String(),
        path: Type.String({ minLength: 1 }),
        contents: Type.String(),
        /** Editor document version; the engine keeps the highest it has seen. */
        version: Type.Integer({ minimum: 0 }),
      },
      strict,
    ),
  },
  'doc/didClose': {
    description: 'Drops a pushed buffer; blame reverts to the file on disk.',
    params: Type.Object(
      { repoId: Type.String(), path: Type.String({ minLength: 1 }) },
      strict,
    ),
  },
  '$/cancelRequest': {
    description: 'Asks the engine to abandon an in-flight request.',
    params: Type.Object({ id: Type.Integer() }, strict),
  },
};

export const EngineNotificationSchemas = {
  'blame/hunks': {
    description: 'A batch of blame hunks for the blame/file request carrying this streamId.',
    params: Type.Object(
      { streamId: Type.String({ minLength: 1 }), hunks: Type.Array(BlameHunk) },
      strict,
    ),
  },
  'search/matches': {
    description: 'A batch of matches for the search/commits request carrying this streamId.',
    params: Type.Object(
      { streamId: Type.String({ minLength: 1 }), matches: Type.Array(CommitSummaryInfo) },
      strict,
    ),
  },
  'repo/didChange': {
    description:
      "Pushed when the repository's git state changes on disk. Categories are debounced and coalesced, so one notification can carry several.",
    params: Type.Object(
      {
        repoId: Type.String(),
        generation: Type.Integer({
          minimum: 1,
          description:
            'Per-repo counter, incremented once per pushed notification. Unrelated to the ref-set hash in graph/rows.',
        }),
        changed: Type.Array(
          Type.Union([
            Type.Literal('HEAD'),
            Type.Literal('refs'),
            Type.Literal('index'),
            Type.Literal('stash'),
            Type.Literal('worktrees'),
            /** A rebase, merge, cherry-pick or revert started, advanced or ended. */
            Type.Literal('sequencer'),
          ]),
          { minItems: 1 },
        ),
      },
      strict,
    ),
  },
};
