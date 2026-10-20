// Web substitute for node:os. The worker extension host has no user home
// directory, so homedir() is empty; the only bundled consumer reads the
// user's git config, which the fs shim reports as missing.

export function homedir(): string {
  return '';
}

export default { homedir };
