// Failure-aware ordering for the image / video / speech / transcription chains.
//
// The media chains used to walk the same fixed priority list on every request.
// A provider that was down for a known, lasting reason (Cloudflare's daily free
// allocation used up, Hugging Face asking for prepaid credits, a Gemini "Live"
// model that only speaks websockets, an NVIDIA model that times out) was
// retried first every single time: each retry cost seconds of latency and left
// another `error` row in the log, and a single image request could burn through
// all eleven Cloudflare models before reaching a provider that works.
//
// ChainGuard fixes both halves:
//   1. SKIP what is known to be dead. A failure is classified into a cooldown on
//      the whole PLATFORM (quota / credits / rejected key) or on one MODEL
//      (unsupported, timeout). Cooled entries are left out until the cooldown
//      expires, and a failure mid-chain immediately skips the rest of that
//      platform instead of trying its sibling models.
//   2. TRY THE BEST FIRST. Platforms are bucketed by their recent success rate
//      for this modality: proven-good first, unproven next, proven-poor last.
//      Within a bucket the configured priority order is kept, so an operator's
//      ordering still decides between equally healthy providers.
//
// Safety valve: if every candidate is cooled, the chain is returned untouched.
// A stale or over-broad cooldown must never turn "degraded" into "all media
// requests refused". Cooldowns are in-memory on purpose — they are a hint to
// stop hammering a dead provider, and a restart simply re-probes.
import { getDb } from '../db/index.js';

export type HealthModality = 'image' | 'video' | 'audio' | 'transcription';

interface Failure { status: number; message: string }
interface Cooldown { scope: 'platform' | 'model'; ms: number }

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Evidence a platform needs before its success rate is allowed to reorder it. */
const MIN_ATTEMPTS = 3;
const GOOD_RATE = 0.6;
const POOR_RATE = 0.3;
const WINDOW_SQL = "datetime('now', '-7 days')";

const cooldowns = new Map<string, number>();
// Cooldowns describe the provider state seen through ONE database's keys and
// request history. A different database instance (a restore, or a test's fresh
// in-memory DB) starts with a clean slate rather than inheriting stale benches.
let owner: unknown = null;
function syncOwner(): void {
  let db: unknown = null;
  try { db = getDb(); } catch { /* no DB yet: nothing to sync against */ }
  if (db !== owner) { owner = db; cooldowns.clear(); }
}

const platformKey = (platform: string) => `p:${platform}`;
const modelKey = (platform: string, modelId: string) => `m:${platform}:${modelId}`;

function msUntilNextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now;
}

/** Map a failure to the cooldown it deserves, or null when the failure says
 *  nothing about the provider (the caller's own bad request, a client that hung
 *  up) and so must not bench anything. */
export function classifyFailure(f: Failure, now: number = Date.now()): Cooldown | null {
  const msg = f.message ?? '';
  const status = f.status;

  // Quota / credits: nothing on this platform will succeed until it resets.
  if (status === 402) return { scope: 'platform', ms: 6 * HOUR };
  if (status === 429) {
    if (/daily|allocation|quota|exhaust|used up|out of (credits|tokens)/i.test(msg)) {
      return { scope: 'platform', ms: Math.min(24 * HOUR, msUntilNextUtcMidnight(now)) };
    }
    // Plain rate limit: usually per model, so bench only this one, briefly.
    return { scope: 'model', ms: 2 * MINUTE };
  }
  // The operator's key was rejected.
  if (status === 401 || status === 403) return { scope: 'platform', ms: HOUR };

  // This model cannot serve the request at all (e.g. realtime-only Gemini Live).
  if ((status === 400 || status === 404) &&
      /only supports|bidirectional|real-?time|does not support|not support|unsupported|no longer|deprecated|not found/i.test(msg)) {
    return { scope: 'model', ms: 12 * HOUR };
  }

  // Slow or unreachable: stop paying a full timeout on every request.
  if (/aborted|timed? ?out|timeout|ETIMEDOUT|ECONNRESET|fetch failed/i.test(msg)) {
    return { scope: 'model', ms: 5 * MINUTE };
  }
  if (status >= 500) return { scope: 'model', ms: MINUTE };

  return null; // 400 bad input, 413, 499, anything the caller owns
}

export function resetMediaHealth(): void {
  cooldowns.clear();
}

function isCooledAt(platform: string, modelId: string, now: number): boolean {
  const p = cooldowns.get(platformKey(platform));
  if (p !== undefined && p > now) return true;
  const m = cooldowns.get(modelKey(platform, modelId));
  return m !== undefined && m > now;
}

/** Per-platform success rate for a modality over the last 7 days. Only platforms
 *  with enough attempts to mean something are returned. */
function recentRates(modality: HealthModality): Map<string, number> {
  const rates = new Map<string, number>();
  try {
    const rows = getDb().prepare(`
      SELECT platform,
             SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS ok,
             COUNT(*) AS total
        FROM requests
       WHERE request_type = ? AND status IN ('success', 'error') AND created_at >= ${WINDOW_SQL}
       GROUP BY platform
    `).all(modality) as { platform: string; ok: number; total: number }[];
    for (const r of rows) if (r.total >= MIN_ATTEMPTS) rates.set(r.platform, r.ok / r.total);
  } catch {
    // Ordering is an optimisation: a DB hiccup keeps the configured order.
  }
  return rates;
}

function tier(rate: number | undefined): number {
  if (rate === undefined) return 1;      // unproven
  if (rate >= GOOD_RATE) return 0;       // proven good
  if (rate < POOR_RATE) return 2;        // proven poor
  return 1;
}

export class ChainGuard<T> {
  /** Candidates in the order they should be tried. */
  readonly items: T[];
  private readonly bypass: boolean;

  constructor(
    items: T[],
    modality: HealthModality,
    private readonly idOf: (item: T) => { platform: string; modelId: string },
    private readonly clock: () => number = Date.now,
  ) {
    syncOwner();
    const now = clock();
    const live = items.filter(i => {
      const { platform, modelId } = idOf(i);
      return !isCooledAt(platform, modelId, now);
    });
    // Everything benched: try them all rather than refuse the request.
    this.bypass = live.length === 0;
    const pool = this.bypass ? items : live;

    const rates = recentRates(modality);
    this.items = pool
      .map((item, index) => ({ item, index, t: tier(rates.get(idOf(item).platform)) }))
      .sort((a, b) => a.t - b.t || a.index - b.index)
      .map(x => x.item);
  }

  /** True when this candidate was benched by an earlier failure in this chain
   *  (or another request) and should be passed over. */
  skip(item: T): boolean {
    if (this.bypass) return false;
    const { platform, modelId } = this.idOf(item);
    return isCooledAt(platform, modelId, this.clock());
  }

  /** Record a failed attempt; benches the platform or model when warranted. */
  fail(item: T, failure: Failure): void {
    const cd = classifyFailure(failure, this.clock());
    if (!cd) return;
    const { platform, modelId } = this.idOf(item);
    const key = cd.scope === 'platform' ? platformKey(platform) : modelKey(platform, modelId);
    const until = this.clock() + cd.ms;
    if ((cooldowns.get(key) ?? 0) < until) cooldowns.set(key, until);
  }

  /** A success proves the platform works again: lift its cooldowns. */
  ok(item: T): void {
    const { platform, modelId } = this.idOf(item);
    cooldowns.delete(platformKey(platform));
    cooldowns.delete(modelKey(platform, modelId));
  }
}
