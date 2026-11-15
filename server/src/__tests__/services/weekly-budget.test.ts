import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { getWeeklyBudget } from '../../services/weekly-budget.js';

function addKey(platform: string, status = 'healthy') {
  const { encrypted, iv, authTag } = encrypt('k');
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 't', ?, ?, ?, ?, 1)
  `).run(platform, encrypted, iv, authTag, status);
}

function logRequest(platform: string, type: string, tokens: number, createdAt = "datetime('now')") {
  getDb().prepare(`
    INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, request_type, created_at)
    VALUES (?, 'm', 'success', ?, 0, 1, ?, ${createdAt})
  `).run(platform, tokens, type);
}

describe('weekly budget', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare('DELETE FROM embedding_models').run();
    getDb().prepare('DELETE FROM media_models').run();
    const em = getDb().prepare(`INSERT INTO embedding_models (family, platform, model_id, display_name, dimensions, priority, enabled, quota_label) VALUES (?, ?, ?, ?, 8, 1, 1, '')`);
    em.run('g', 'google', 'g1', 'g1');
    em.run('n', 'nvidia', 'n1', 'n1');
    em.run('c', 'cloudflare', 'c1', 'c1');
    const mm = getDb().prepare(`INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label) VALUES (?, ?, ?, 'image', 1, 1, '')`);
    mm.run('cloudflare', 'cf-img', 'cf-img');
    mm.run('pollinations', 'sana', 'sana');
    mm.run('nvidia', 'nv-img', 'nv-img');
  });

  it('only counts providers with a usable key', () => {
    addKey('google');
    addKey('cloudflare', 'invalid');
    const w = getWeeklyBudget('embedding');
    expect(w.rows.map(r => r.platform)).toEqual(['google']);
    expect(w.totalBudget).toBe(500_000 * 7);
  });

  it('lists connected providers without a published cap as unpublished', () => {
    addKey('google');
    addKey('nvidia');
    const w = getWeeklyBudget('embedding');
    expect(w.unpublished).toEqual(['nvidia']);
    expect(w.rows.map(r => r.platform)).toEqual(['google']);
  });

  it('sums embedding tokens used this week and ignores older traffic', () => {
    addKey('google');
    logRequest('google', 'embedding', 1200);
    logRequest('google', 'embedding', 300);
    logRequest('google', 'embedding', 9999, "datetime('now', '-9 days')");
    const w = getWeeklyBudget('embedding');
    expect(w.totalUsed).toBe(1500);
  });

  it('counts images, and reports the keyless provider as unmetered', () => {
    addKey('cloudflare');
    logRequest('cloudflare', 'image', 0);
    logRequest('pollinations', 'image', 0);
    const w = getWeeklyBudget('image');
    expect(w.unit).toBe('images');
    expect(w.totalBudget).toBe(700);
    expect(w.totalUsed).toBe(1);
    expect(w.unmetered).toEqual(['pollinations']);
  });

  it('starts the week on a Monday at midnight UTC', () => {
    const d = new Date(getWeeklyBudget('image').weekStart);
    expect(d.getUTCDay()).toBe(1);
    expect(d.getUTCHours()).toBe(0);
    expect(d.getTime()).toBeLessThanOrEqual(Date.now());
    expect(Date.now() - d.getTime()).toBeLessThan(7 * 86_400_000);
  });
});
