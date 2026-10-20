// The server reports the version of the package it ships in. The copy bundled
// into the GitGlasses extension has it compiled in (GITGLASSES_MCP_VERSION);
// the npm package reads it from the manifest next to the built code.

import { readFileSync } from 'node:fs';

declare const GITGLASSES_MCP_VERSION: string | undefined;

export const SERVER_VERSION: string =
  typeof GITGLASSES_MCP_VERSION === 'string'
    ? GITGLASSES_MCP_VERSION
    : (
        JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
          version: string;
        }
      ).version;
