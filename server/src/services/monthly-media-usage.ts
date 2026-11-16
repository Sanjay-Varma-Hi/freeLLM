// Exact "this month" usage for the image, audio and video tabs.
//
// Media calls log no tokens (input/output are always 0), so the only exact
// quantity the gateway owns is how many calls each provider served. That is what
// this reports: successes and failures per platform since the 1st of the month
// (UTC), straight from the requests table — no estimation.
//
// A remaining figure is added ONLY where a daily cap is published and already
// encoded in weekly-budget.ts (today: Cloudflare images). That limit is an
// estimate and is flagged as one. Every other provider is reported with its
// usage and an explicit "no published limit" so nothing is invented.
import { getDb } from '../db/index.js';
import { IMAGE_DAILY_IMAGES } from './weekly-budget.js';

export type MonthlyModality = 'image' | 'audio' | 'video';

export interface MonthlyMediaRow {
  platform: string;
  /** Successful calls this month. */
  used: number;
  /** Failed calls this month (provider errors, quota exhaustion). */
  failed: number;
  /** Estimated monthly cap, or null when the provider publishes none. */
  limit: number | null;
  /** limit - used, floored at 0, or null alongside a null limit. */
  remaining: number | null;
  /** True when the platform has a usable key (or needs none). */
  connected: boolean;
}

export interface MonthlyMediaUsage {
  modality: MonthlyModality;
  unit: 'requests';
  /** First day of the current month, 00:00 UTC, as an ISO string. */
  monthStart: string;
  daysInMonth: number;
  totalUsed: number;
  totalFailed: number;
  rows: MonthlyMediaRow[];
  /** Keyless platforms: usable without a key, limited by rate rather than quota. */
  keyless: string[];
}

const KEYLESS = new Set(['pollinations']);
const MONTH_START_SQL = "datetime('now', 'start of month')";

const DAILY_LIMITS: Record<MonthlyModality, Record<string, number>> = {
  image: IMAGE_DAILY_IMAGES,
  audio: {},
  video: {},
};

export function getMonthlyMediaUsage(modality: MonthlyModality, now: Date = new Date()): MonthlyMediaUsage {
  const db = getDb();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();

  const keyed = new Set((db.prepare(`
    SELECT DISTINCT platform FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown')
  `).all() as { platform: string }[]).map(r => r.platform));

  const serving = (db.prepare(
    'SELECT DISTINCT platform FROM media_models WHERE enabled = 1 AND modality = ?',
  ).all(modality) as { platform: string }[]).map(r => r.platform);

  const counts = new Map<string, { used: number; failed: number }>();
  for (const r of db.prepare(`
    SELECT platform,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS used,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS failed
      FROM requests
     WHERE request_type = ? AND created_at >= ${MONTH_START_SQL}
     GROUP BY platform
  `).all(modality) as { platform: string; used: number; failed: number }[]) {
    counts.set(r.platform, { used: r.used ?? 0, failed: r.failed ?? 0 });
  }

  // Serving platforms that are connected, plus anything that actually handled a
  // call this month (a key may have been removed since).
  const platforms = new Set<string>();
  for (const p of serving) if (keyed.has(p) || KEYLESS.has(p)) platforms.add(p);
  for (const p of counts.keys()) platforms.add(p);

  const rows: MonthlyMediaRow[] = [...platforms].sort().map(platform => {
    const c = counts.get(platform) ?? { used: 0, failed: 0 };
    const daily = DAILY_LIMITS[modality][platform];
    const limit = daily === undefined ? null : daily * daysInMonth;
    return {
      platform,
      used: c.used,
      failed: c.failed,
      limit,
      remaining: limit === null ? null : Math.max(0, limit - c.used),
      connected: keyed.has(platform) || KEYLESS.has(platform),
    };
  }).sort((a, b) => b.used - a.used || a.platform.localeCompare(b.platform));

  return {
    modality,
    unit: 'requests',
    monthStart: monthStart.toISOString(),
    daysInMonth,
    totalUsed: rows.reduce((s, r) => s + r.used, 0),
    totalFailed: rows.reduce((s, r) => s + r.failed, 0),
    rows,
    keyless: serving.filter(p => KEYLESS.has(p)),
  };
}
