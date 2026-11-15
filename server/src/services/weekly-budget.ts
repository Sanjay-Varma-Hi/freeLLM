// Weekly allowance for embeddings and image generation.
//
// Chat has a real monthly token budget per model (models.monthly_token_budget).
// Embeddings and images only carry free-text quota labels ("10K neurons/day
// (shared)", "1K calls/mo"), so there is no exact total to read. This module is
// the explicit, in-one-place estimate behind the dashboard's "this week" bar:
// a per-provider DAILY allowance, multiplied by 7 and counted only for
// providers that actually have a usable key connected. Every figure is an
// estimate and the dashboard says so.
//
// Providers with no published daily cap (rate limit only, one-time credits) are
// not given an invented number; they are reported as `unpublished` instead.
// Pollinations needs no key and is rate limited rather than capped, so it is
// reported as `unmetered`.
import { getDb } from '../db/index.js';

export type WeeklyModality = 'embedding' | 'image';

/** Embedding tokens per day, per platform. Derived from each provider's quota
 *  label at an assumed ~500 tokens per request, or from Cloudflare's neuron
 *  price for a mid-size BGE model (~6K neurons per million tokens). */
export const EMBEDDING_DAILY_TOKENS: Record<string, number> = {
  google: 500_000,       // gemini-embedding-001: 1K requests/day
  cloudflare: 1_600_000, // 10K neurons/day, shared with every other Workers AI call
  cohere: 16_000,        // 1K calls/month shared with chat (~33/day)
};

/** Images per day, per platform. Cloudflare: 10K neurons/day buys roughly a
 *  hundred 1024x1024 FLUX/SDXL images. */
export const IMAGE_DAILY_IMAGES: Record<string, number> = {
  cloudflare: 100,
};

/** Platforms that need no key and are limited by rate, not by a quota. */
const UNMETERED_PLATFORMS: Record<WeeklyModality, string[]> = {
  embedding: [],
  image: ['pollinations'],
};

const DAILY: Record<WeeklyModality, Record<string, number>> = {
  embedding: EMBEDDING_DAILY_TOKENS,
  image: IMAGE_DAILY_IMAGES,
};

export interface WeeklyBudgetRow {
  platform: string;
  /** Estimated allowance for the week, in `unit`. */
  budget: number;
  /** Used so far this week, in `unit`. */
  used: number;
}

export interface WeeklyBudget {
  modality: WeeklyModality;
  unit: 'tokens' | 'images';
  /** Monday 00:00 UTC of the current week, as an ISO string. */
  weekStart: string;
  totalBudget: number;
  totalUsed: number;
  rows: WeeklyBudgetRow[];
  /** Connected providers serving this modality with no published daily cap. */
  unpublished: string[];
  /** Keyless providers used without a quota. */
  unmetered: string[];
  /** Always true: every budget figure is an estimate. */
  estimated: true;
}

const WEEK_START_SQL = "datetime('now', 'weekday 0', '-6 days', 'start of day')";

export function getWeeklyBudget(modality: WeeklyModality): WeeklyBudget {
  const db = getDb();
  const unit = modality === 'embedding' ? 'tokens' : 'images';

  const weekStartRow = db.prepare(`SELECT ${WEEK_START_SQL} AS ws`).get() as { ws: string };
  const weekStart = new Date(`${weekStartRow.ws.replace(' ', 'T')}Z`).toISOString();

  // Platforms with a usable key: a disabled or rejected key adds no capacity,
  // the same rule the chat budget uses.
  const keyed = new Set((db.prepare(`
    SELECT DISTINCT platform FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown')
  `).all() as { platform: string }[]).map(r => r.platform));

  // Platforms that serve this modality at all.
  const table = modality === 'embedding' ? 'embedding_models' : 'media_models';
  const where = modality === 'embedding' ? 'enabled = 1' : "enabled = 1 AND modality = 'image'";
  const serving = new Set((db.prepare(
    `SELECT DISTINCT platform FROM ${table} WHERE ${where}`,
  ).all() as { platform: string }[]).map(r => r.platform));

  const usedExpr = modality === 'embedding' ? 'COALESCE(SUM(input_tokens), 0)' : 'COUNT(*)';
  const usedByPlatform = new Map((db.prepare(`
    SELECT platform, ${usedExpr} AS used
      FROM requests
     WHERE request_type = ? AND status = 'success' AND created_at >= ${WEEK_START_SQL}
     GROUP BY platform
  `).all(modality) as { platform: string; used: number }[]).map(r => [r.platform, r.used]));

  const rows: WeeklyBudgetRow[] = [];
  const unpublished: string[] = [];
  const unmetered: string[] = [];
  for (const platform of [...serving].sort()) {
    if (UNMETERED_PLATFORMS[modality].includes(platform)) {
      unmetered.push(platform);
      continue;
    }
    if (!keyed.has(platform)) continue;
    const daily = DAILY[modality][platform];
    if (daily === undefined) {
      unpublished.push(platform);
      continue;
    }
    rows.push({ platform, budget: daily * 7, used: usedByPlatform.get(platform) ?? 0 });
  }

  return {
    modality,
    unit,
    weekStart,
    totalBudget: rows.reduce((s, r) => s + r.budget, 0),
    totalUsed: rows.reduce((s, r) => s + r.used, 0),
    rows,
    unpublished,
    unmetered,
    estimated: true,
  };
}
