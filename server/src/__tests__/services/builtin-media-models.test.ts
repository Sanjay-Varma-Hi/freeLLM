import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  BUILTIN_MEDIA_MODELS,
  ensureBuiltinMediaModels,
  isBuiltinMediaModel,
} from '../../services/builtin-media-models.js';
import { MEDIA_PLATFORMS, VIDEO_PLATFORMS } from '../../services/media.js';

function mediaRows() {
  return getDb()
    .prepare('SELECT platform, model_id, modality, enabled, display_name FROM media_models')
    .all() as { platform: string; model_id: string; modality: string; enabled: number; display_name: string }[];
}

describe('built-in media baseline', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare('DELETE FROM media_models').run();
  });

  it('every baseline row targets a platform that has an adapter', () => {
    for (const m of BUILTIN_MEDIA_MODELS) {
      const platforms = m.modality === 'video' ? VIDEO_PLATFORMS : MEDIA_PLATFORMS;
      expect(platforms.has(m.platform), `${m.platform}:${m.modelId}`).toBe(true);
    }
  });

  it('gives both image and video at least one provider', () => {
    ensureBuiltinMediaModels(getDb());
    const modalities = new Set(mediaRows().map(r => r.modality));
    expect(modalities.has('image')).toBe(true);
    expect(modalities.has('video')).toBe(true);
  });

  it('is idempotent', () => {
    expect(ensureBuiltinMediaModels(getDb())).toBe(BUILTIN_MEDIA_MODELS.length);
    expect(ensureBuiltinMediaModels(getDb())).toBe(0);
    expect(mediaRows()).toHaveLength(BUILTIN_MEDIA_MODELS.length);
  });

  it('never overwrites an existing row, so a local disable survives', () => {
    const first = BUILTIN_MEDIA_MODELS[0]!;
    getDb().prepare(`
      INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label)
      VALUES (?, ?, 'mine', ?, 1, 0, '')
    `).run(first.platform, first.modelId, first.modality);
    ensureBuiltinMediaModels(getDb());
    const row = mediaRows().find(r => r.platform === first.platform && r.model_id === first.modelId)!;
    expect(row.enabled).toBe(0);
    expect(row.display_name).toBe('mine');
  });

  it('identifies its own rows for the catalog prune', () => {
    const first = BUILTIN_MEDIA_MODELS[0]!;
    expect(isBuiltinMediaModel(first.platform, first.modelId)).toBe(true);
    expect(isBuiltinMediaModel('cloudflare', '@cf/some/other-model')).toBe(false);
  });
});
