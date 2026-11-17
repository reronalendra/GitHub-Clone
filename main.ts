// Entry lifecycle: bind the forge server to an ephemeral port, register that
// port with the trial env, then poll the env until the trial is over.
//
// The env is the only thing this process talks to besides its own server:
//   - MAKEFUN_ENV_URL is the env origin (http://store:8080 in a trial). If it
//     is missing there is nothing to register with, so exit 1 right away.
//   - The server must listen on port 0 (kernel-picked). Port 8080 belongs to
//     the env and must never be bound here.
//   - POST $MAKEFUN_ENV_URL/register {"port": N} tells the env where to dial
//     this forge. The first register wins; a 409 only means someone else
//     registered first, so this process carries on waiting like any other.
//   - GET $MAKEFUN_ENV_URL/done is polled until it answers {"done": true}.
//     It answers immediately either way, so polling with a backoff is right;
//     the process must never exit before the env says done.
//   - When done, close the server and exit 0. The harness stops the env
//     afterwards and the env's export is what the scorer reads.
//
// Only the app server is imported here: no packages, no Node built-ins used
// directly, no model calls.

import { createApp } from './app.ts';

// The env origin, without a trailing slash.
const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

/** Longest a single register/done request is allowed to take. */
const REQUEST_TIMEOUT = 30_000;
/** Backoff between retries: starts here, doubles, never exceeds the cap. */
const BACKOFF_START = 250;
const BACKOFF_CAP = 2_000;

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Backoff after `failures` consecutive failed attempts, capped at BACKOFF_CAP. */
function backoffFor(failures: number): number {
  return Math.min(BACKOFF_CAP, BACKOFF_START * 2 ** Math.min(failures, 8));
}

/**
 * Run `work` until it returns true, retrying after a backoff whenever it
 * throws or returns false. `fatal` decides whether a thrown error ends the
 * program instead of being retried.
 */
async function retryUntil(
  work: () => Promise<boolean>,
  fatal: (err: unknown) => boolean,
): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      if (await work()) return;
    } catch (err) {
      if (fatal(err)) throw err;
    }
    failures += 1;
    await wait(backoffFor(failures));
  }
}

/** POST the bound port to the env's /register until it is accepted. */
async function registerForge(port: number): Promise<void> {
  await retryUntil(
    async () => {
      const res = await fetch(`${ENV_ORIGIN}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });
      if (res.status === 200 || res.status === 409) return true;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register refused: HTTP ${res.status}: ${await res.text()}`);
      }
      return false;
    },
    (err) => err instanceof Error && err.message.startsWith('register refused:'),
  );
}

/** GET /done until the env answers {"done": true}. */
async function waitUntilDone(): Promise<void> {
  await retryUntil(
    async () => {
      const res = await fetch(`${ENV_ORIGIN}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { done?: unknown };
      return body.done === true;
    },
    () => false,
  );
}

/** The whole life of the process: bind, register, wait, shut down. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] forge listening on port ${bound.port}\n`);

  await registerForge(bound.port);
  process.stdout.write('[entry] registered with env; waiting for done\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[entry] env done; shutting down\n');
}

if (ENV_ORIGIN === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: no env to register with\n');
  process.exit(1);
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
