// Schemas for one-way notifications in both directions.

import { Type } from '@sinclair/typebox';

import { BlameHunk, CommitSummaryInfo, strict } from './models.js';

export const ClientNotificationSchemas = {
  'doc/didChange': {
    params: Type.Object(
      {
        repoId: Type.String(),
        path: Type.String(),
        contents: Type.String(),
        version: Type.Number(),
      },
      strict,
    ),
  },
  'doc/didClose': {
    params: Type.Object({ repoId: Type.String(), path: Type.String() }, strict),
  },
  '$/cancelRequest': {
    params: Type.Object({ id: Type.Number() }, strict),
  },
};

export const EngineNotificationSchemas = {
  'blame/hunks': {
    params: Type.Object(
      { streamId: Type.String(), hunks: Type.Array(BlameHunk) },
      strict,
    ),
  },
  'search/matches': {
    params: Type.Object(
      { streamId: Type.String(), matches: Type.Array(CommitSummaryInfo) },
      strict,
    ),
  },
  'repo/didChange': {
    params: Type.Object(
      {
        repoId: Type.String(),
        generation: Type.Number(),
        changed: Type.Array(
          Type.Union([
            Type.Literal('HEAD'),
            Type.Literal('refs'),
            Type.Literal('index'),
            Type.Literal('stash'),
            Type.Literal('worktrees'),
            Type.Literal('sequencer'),
          ]),
        ),
      },
      strict,
    ),
  },
};
