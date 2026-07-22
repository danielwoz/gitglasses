// Web substitute for node:fs/promises. There is no host filesystem in the
// worker extension host, so every call rejects. The only bundled consumer is
// IntegrationService's git-config remote detection, which catches the
// rejection and degrades to "no hosting detected" — documented web behavior.

function unavailable(): Promise<never> {
  return Promise.reject(
    new Error('node:fs is not available in the web extension host'),
  );
}

export const stat = unavailable;
export const readFile = unavailable;
export const readdir = unavailable;
export const writeFile = unavailable;
export const mkdir = unavailable;

export default { stat, readFile, readdir, writeFile, mkdir };
