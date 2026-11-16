import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { ChainGuard, classifyFailure } from '../../services/media-health.js';

type Row = { platform: string; model_id: string };
const id = (r: Row) => ({ platform: r.platform, modelId: r.model_id });
const row = (platform: string, model_id: string): Row => ({ platform, model_id });

function log(platform: string, status: 'success' | 'error', n: number, type = 'image') {
  const ins = getDb().prepare(`INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, request_type, created_at)
    VALUES (?, 'm', ?, 0, 0, 1, ?, datetime('now'))`);
  for (let i = 0; i < n; i++) ins.run(platform, status, type);
}

describe('classifyFailure', () => {
  const now = Date.UTC(2026, 10, 16, 6, 0, 0);

  it('benches the whole platform until UTC midnight on a daily-quota 429', () => {
    const c = classifyFailure({ status: 429, message: 'you have used up your daily free allocation of 10,000 neurons' }, now)!;
    expect(c.scope).toBe('platform');
    expect(c.ms).toBe(18 * 3600 * 1000);
  });

  it('benches only one model, briefly, on a plain rate limit', () => {
    expect(classifyFailure({ status: 429, message: 'rate limited' }, now)).toMatchObject({ scope: 'model', ms: 120_000 });
  });

  it('benches the platform on 402 and on a rejected key', () => {
    expect(classifyFailure({ status: 402, message: 'Purchase pre-paid credits' }, now)?.scope).toBe('platform');
    expect(classifyFailure({ status: 401, message: 'bad key' }, now)?.scope).toBe('platform');
  });

  it('benches a model that cannot serve the request, and one that times out', () => {
    expect(classifyFailure({ status: 400, message: 'models/x only supports real-time bidirectional' }, now)?.scope).toBe('model');
    expect(classifyFailure({ status: 502, message: 'The operation was aborted (nvidia, image, 60s)' }, now)?.scope).toBe('model');
  });

  it('never benches anything for the caller’s own mistakes', () => {
    expect(classifyFailure({ status: 400, message: 'prompt is empty' }, now)).toBeNull();
    expect(classifyFailure({ status: 413, message: 'too large' }, now)).toBeNull();
    expect(classifyFailure({ status: 499, message: 'client closed the request' }, now)).toBeNull();
  });
});

describe('ChainGuard', () => {
  let t = 1_000_000;
  const clock = () => t;
  const guard = (rows: Row[], modality: 'image' | 'audio' = 'image') => new ChainGuard(rows, modality, id, clock);

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });
  afterEach(() => vi.restoreAllMocks());

  it('keeps the configured order when there is no history', () => {
    const rows = [row('a', '1'), row('b', '1'), row('c', '1')];
    expect(guard(rows).items.map(r => r.platform)).toEqual(['a', 'b', 'c']);
  });

  it('skips the rest of a platform after a quota failure, so siblings are not retried', () => {
    const rows = [row('cf', '1'), row('cf', '2'), row('nv', '1')];
    const g = guard(rows);
    g.fail(rows[0], { status: 429, message: 'daily free allocation used up' });
    expect(g.items.filter(r => !g.skip(r)).map(r => `${r.platform}${r.model_id}`)).toEqual(['nv1']);
  });

  it('keeps a platform benched across requests until the cooldown expires', () => {
    const rows = [row('cf', '1'), row('nv', '1')];
    guard(rows).fail(rows[0], { status: 402, message: 'credits' });
    expect(guard(rows).items.map(r => r.platform)).toEqual(['nv']);
    t += 7 * 3600 * 1000;
    expect(guard(rows).items.map(r => r.platform)).toEqual(['cf', 'nv']);
  });

  it('lifts the bench when the platform succeeds again', () => {
    const rows = [row('cf', '1'), row('nv', '1')];
    const g = guard(rows);
    g.fail(rows[0], { status: 402, message: 'credits' });
    new ChainGuard([rows[0]], 'image', id, clock).ok(rows[0]);
    expect(guard(rows).items.map(r => r.platform)).toEqual(['cf', 'nv']);
  });

  it('tries every candidate rather than refuse when all are benched', () => {
    const rows = [row('cf', '1'), row('nv', '1')];
    const g = guard(rows);
    g.fail(rows[0], { status: 402, message: 'credits' });
    g.fail(rows[1], { status: 402, message: 'credits' });
    const again = guard(rows);
    expect(again.items).toHaveLength(2);
    expect(again.items.every(r => !again.skip(r))).toBe(true);
  });

  it('puts proven-good platforms first and proven-poor last, keeping order within a tier', () => {
    log('poor', 'error', 5);
    log('good', 'success', 5);
    const rows = [row('poor', '1'), row('new', '1'), row('good', '1'), row('new2', '1')];
    expect(guard(rows).items.map(r => r.platform)).toEqual(['good', 'new', 'new2', 'poor']);
  });

  it('ignores history from other modalities and too-small samples', () => {
    log('a', 'error', 2);          // below the evidence threshold
    log('b', 'error', 9, 'audio'); // different modality
    const rows = [row('a', '1'), row('b', '1')];
    expect(guard(rows).items.map(r => r.platform)).toEqual(['a', 'b']);
  });
});
