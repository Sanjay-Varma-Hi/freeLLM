import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { getMonthlyMediaUsage } from '../../services/monthly-media-usage.js';

function addKey(platform: string, status = 'healthy') {
  const { encrypted, iv, authTag } = encrypt('k');
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 't', ?, ?, ?, ?, 1)
  `).run(platform, encrypted, iv, authTag, status);
}

function log(platform: string, type: string, status: string, createdAt = "datetime('now')") {
  getDb().prepare(`
    INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, request_type, created_at)
    VALUES (?, 'm', ?, 0, 0, 1, ?, ${createdAt})
  `).run(platform, status, type);
}

describe('monthly media usage', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare('DELETE FROM media_models').run();
    const mm = getDb().prepare(`INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label) VALUES (?, ?, ?, ?, 1, 1, '')`);
    mm.run('cloudflare', 'cf', 'cf', 'image');
    mm.run('nvidia', 'nv', 'nv', 'image');
    mm.run('pollinations', 'sana', 'sana', 'image');
    mm.run('google', 'tts', 'tts', 'audio');
  });

  it('counts successes and failures separately, per platform', () => {
    addKey('nvidia');
    log('nvidia', 'image', 'success');
    log('nvidia', 'image', 'success');
    log('nvidia', 'image', 'error');
    const u = getMonthlyMediaUsage('image');
    const nv = u.rows.find(r => r.platform === 'nvidia')!;
    expect([nv.used, nv.failed]).toEqual([2, 1]);
    expect(u.totalUsed).toBe(2);
    expect(u.totalFailed).toBe(1);
  });

  it('ignores last month and other modalities', () => {
    addKey('nvidia');
    log('nvidia', 'image', 'success', "datetime('now', 'start of month', '-1 day')");
    log('nvidia', 'audio', 'success');
    expect(getMonthlyMediaUsage('image').totalUsed).toBe(0);
  });

  it('gives a remaining figure only where a cap is published', () => {
    addKey('cloudflare');
    addKey('nvidia');
    log('cloudflare', 'image', 'success');
    const u = getMonthlyMediaUsage('image', new Date(Date.UTC(2026, 10, 16)));
    const cf = u.rows.find(r => r.platform === 'cloudflare')!;
    expect(cf.limit).toBe(100 * 30);
    expect(cf.remaining).toBe(100 * 30 - 1);
    const nv = u.rows.find(r => r.platform === 'nvidia')!;
    expect([nv.limit, nv.remaining]).toEqual([null, null]);
  });

  it('skips unconnected platforms, lists keyless ones, keeps ones that served calls', () => {
    addKey('cloudflare', 'invalid');
    log('google', 'image', 'success');
    const u = getMonthlyMediaUsage('image');
    expect(u.rows.map(r => r.platform).sort()).toEqual(['google', 'pollinations']);
    expect(u.keyless).toEqual(['pollinations']);
  });
});
