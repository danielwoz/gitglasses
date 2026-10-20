// Mocha entry for the Restricted Mode run, which opens a planted workspace
// with workspace trust left on (see runUntrusted in ../runTests.ts).
import { runMochaSuite } from '../suite/index';

export function run(): Promise<void> {
  return runMochaSuite(__dirname);
}
