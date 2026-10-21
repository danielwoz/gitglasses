// Programmatic mocha runner loaded by the VS Code extension test host.
// Discovers compiled *.test.js files next to this file; the numeric filename
// prefixes give a stable execution order (activation first, then the tests
// that depend on the engine having discovered the fixture repo).
import * as path from 'node:path';
import * as fs from 'node:fs';
import Mocha from 'mocha';

export function run(): Promise<void> {
  return runMochaSuite(__dirname);
}

/** Runs every compiled *.test.js file in `directory`, in filename order. */
export function runMochaSuite(directory: string): Promise<void> {
  const mocha = new Mocha({
    ui: 'bdd',
    color: true,
    timeout: 60_000,
  });

  const files = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.test.js'))
    .sort();
  for (const file of files) mocha.addFile(path.join(directory, file));

  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) reject(new Error(`${failures} e2e test(s) failed`));
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}
