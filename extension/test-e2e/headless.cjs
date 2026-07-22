#!/usr/bin/env node
// Launches the compiled e2e entry point, wrapping it in xvfb-run when no
// display server is available (headless Linux). When DISPLAY is already set —
// a desktop session, or CI wrapping the whole command in xvfb-run — this
// passes straight through to node.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const entry = path.join(__dirname, '..', 'dist-e2e', 'runTests.js');

let command = process.execPath;
let args = [entry];

const headlessLinux =
  process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
if (headlessLinux) {
  const probe = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' });
  if (probe.error) {
    console.error(
      '[e2e] No DISPLAY and xvfb-run is not installed; VS Code cannot launch headless.',
    );
    console.error('[e2e] Install xvfb (e.g. apt-get install xvfb) or run inside a display server.');
    process.exit(1);
  }
  command = 'xvfb-run';
  args = ['-a', process.execPath, entry];
}

const result = spawnSync(command, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
