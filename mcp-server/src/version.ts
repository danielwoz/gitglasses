// The server reports the version of the gitglasses-mcp package it ships in,
// read from the package manifest next to the built (or bundled) code.

import { readFileSync } from 'node:fs';

export const SERVER_VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
