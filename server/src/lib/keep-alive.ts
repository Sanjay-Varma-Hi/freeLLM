// Keep-alive for hosts that put an idle service to sleep.
//
// Render's free plan spins a web service down after 15 minutes without inbound
// traffic; the next request then waits ~a minute for a cold start (and, without
// MongoDB persistence, lands on a wiped disk). A request to the service's own
// PUBLIC url counts as inbound traffic, so pinging it on a timer keeps the
// instance awake.
//
// Render sets RENDER_EXTERNAL_URL on every web service, so this turns itself on
// there with no configuration. Elsewhere it stays off unless KEEP_ALIVE_URL is
// set. It cannot wake a service that is already asleep — the scheduled GitHub
// workflow (.github/workflows/keep-alive.yml) covers that from the outside.
import type { Scheduler } from './scheduler.js';

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const PING_TIMEOUT_MS = 20 * 1000;

/** The URL to ping, or null when keep-alive is off. */
export function keepAliveTarget(env: NodeJS.ProcessEnv = process.env): string | null {
  const flag = (env.KEEP_ALIVE ?? '').trim().toLowerCase();
  if (flag === 'off' || flag === 'false' || flag === '0') return null;
  const raw = (env.KEEP_ALIVE_URL ?? env.RENDER_EXTERNAL_URL ?? '').trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return `${url.origin}/api/ping`;
}

export function keepAliveIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.KEEP_ALIVE_INTERVAL_MS);
  return Number.isFinite(n) && n >= MIN_INTERVAL_MS ? Math.floor(n) : DEFAULT_INTERVAL_MS;
}

export function startKeepAlive(scheduler: Scheduler): (() => void) | null {
  const target = keepAliveTarget();
  if (!target) return null;
  const intervalMs = keepAliveIntervalMs();
  let failing = false;
  const ping = async () => {
    try {
      const res = await fetch(target, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (failing) console.log('[keep-alive] ping recovered');
      failing = false;
    } catch (err) {
      // Log the first failure of a streak only: a ping every few minutes
      // would otherwise fill the log while the public URL is unreachable.
      if (!failing) console.warn(`[keep-alive] ping failed: ${err instanceof Error ? err.message : err}`);
      failing = true;
    }
  };
  console.log(`[keep-alive] pinging ${target} every ${Math.round(intervalMs / 60000)} min`);
  return scheduler.every(intervalMs, ping, { name: 'keep-alive' });
}
