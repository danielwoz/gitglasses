// Runs an engine binary the way the extension does: `--version` must print
// the release version, and an `initialize` handshake over Content-Length
// framed stdio must report the same engine version.

import { execFileSync, spawn } from 'node:child_process';

const HANDSHAKE_TIMEOUT_MS = 20000;

/** Throws with a description of the first check the engine fails. */
export async function smokeTestEngine(enginePath, { version, protocolVersion }) {
  const printed = execFileSync(enginePath, ['--version'], { encoding: 'utf8', timeout: HANDSHAKE_TIMEOUT_MS }).trim();
  if (printed !== version) throw new Error(`--version printed ${JSON.stringify(printed)}, expected ${version}`);

  const result = await handshake(enginePath, protocolVersion);
  if (result.engineVersion !== version) {
    throw new Error(`initialize reported engineVersion ${result.engineVersion}, expected ${version}`);
  }
  return result;
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

function handshake(enginePath, protocolVersion) {
  return new Promise((resolve, reject) => {
    const child = spawn(enginePath, ['--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffered = Buffer.alloc(0);
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      if (error) {
        child.kill();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(
      () => finish(new Error(`no initialize response within ${HANDSHAKE_TIMEOUT_MS} ms; stderr: ${stderr}`)),
      HANDSHAKE_TIMEOUT_MS,
    );

    child.on('error', (error) => finish(error));
    child.on('close', (code) => finish(new Error(`engine exited with ${code} before answering; stderr: ${stderr}`)));
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.stdout.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const headerEnd = buffered.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const length = Number(/Content-Length: *(\d+)/i.exec(buffered.toString('ascii', 0, headerEnd))?.[1]);
      if (!Number.isFinite(length) || buffered.length < headerEnd + 4 + length) return;
      const message = JSON.parse(buffered.toString('utf8', headerEnd + 4, headerEnd + 4 + length));
      if (message.error) finish(new Error(`initialize failed: ${JSON.stringify(message.error)}`));
      else finish(undefined, message.result);
    });

    child.stdin.write(
      frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion } }),
    );
  });
}
