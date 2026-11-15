// Built-in generative-media baseline.
//
// Image and video rows normally arrive only through the published catalog
// (catalog-sync). That leaves an install with exactly the media providers the
// catalog happens to list: when it lists a single image platform, one exhausted
// daily quota takes `/v1/images/generations` down, and when it lists no video
// platform this binary has an adapter for, `/v1/videos/generations` has nothing
// to route to at all.
//
// The rows below are the floor underneath the catalog. Every one of them maps
// to an adapter in media.ts, so each is usable the moment the matching provider
// key is connected (Pollinations images need no key). They are inserted only
// when missing — a row that already exists keeps its catalog metadata and any
// local disable — and catalog-sync never prunes them.
import type { Db } from '../db/types.js';
import { isCatalogModelTombstoned } from './model-state.js';

interface BuiltinMediaModel {
  platform: string;
  modelId: string;
  displayName: string;
  modality: 'image' | 'video';
  /** Failover order within the modality, lower first. Catalog image rows sit
   *  in the low 200s, so the baseline lands behind them as a fallback. */
  priority: number;
  quotaLabel: string;
  meta?: Record<string, unknown>;
}

export const BUILTIN_MEDIA_MODELS: readonly BuiltinMediaModel[] = [
  {
    platform: 'nvidia',
    modelId: 'black-forest-labs/flux.2-klein-4b',
    displayName: 'FLUX.2 Klein 4B (NVIDIA)',
    modality: 'image',
    priority: 221,
    quotaLabel: 'NVIDIA NIM free credits',
  },
  {
    platform: 'nvidia',
    modelId: 'black-forest-labs/flux.1-dev',
    displayName: 'FLUX.1 Dev (NVIDIA)',
    modality: 'image',
    priority: 222,
    quotaLabel: 'NVIDIA NIM free credits',
  },
  {
    platform: 'pollinations',
    modelId: 'sana',
    displayName: 'Sana (Pollinations)',
    modality: 'image',
    priority: 290,
    quotaLabel: 'Keyless · no API key needed',
  },
  {
    platform: 'zhipu',
    modelId: 'cogvideox-flash',
    displayName: 'CogVideoX Flash (Zhipu AI)',
    modality: 'video',
    priority: 5,
    quotaLabel: 'Free model · needs a Zhipu AI key',
  },
  {
    platform: 'huggingface',
    modelId: 'Lightricks/LTX-Video',
    displayName: 'LTX-Video (Hugging Face)',
    modality: 'video',
    priority: 10,
    quotaLabel: 'Uses Hugging Face inference credits',
    meta: { providerModelId: 'fal-ai/ltx-video-v095' },
  },
];

const BUILTIN_KEYS = new Set(BUILTIN_MEDIA_MODELS.map(m => `${m.platform}:${m.modelId}`));

/** True for rows this module owns — catalog-sync skips them when pruning. */
export function isBuiltinMediaModel(platform: string, modelId: string): boolean {
  return BUILTIN_KEYS.has(`${platform}:${modelId}`);
}

/** Insert any baseline row that is missing. Existing rows are left untouched,
 *  and a model the user deleted from the dashboard (tombstoned) stays deleted.
 *  Returns how many rows were added. */
export function ensureBuiltinMediaModels(db: Db): number {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, meta_json)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `);
  let added = 0;
  for (const m of BUILTIN_MEDIA_MODELS) {
    if (isCatalogModelTombstoned(db, 'media', m.platform, m.modelId)) continue;
    added += insert.run(
      m.platform, m.modelId, m.displayName, m.modality, m.priority, m.quotaLabel,
      m.meta ? JSON.stringify(m.meta) : null,
    ).changes;
  }
  return added;
}
