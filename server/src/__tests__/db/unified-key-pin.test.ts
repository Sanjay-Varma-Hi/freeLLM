import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getUnifiedApiKey,
  initDb,
  isUnifiedApiKeyPinned,
  readPinnedUnifiedApiKey,
  regenerateUnifiedKey,
  syncPinnedUnifiedApiKey,
  getDb,
} from '../../db/index.js';

const ORIGINAL_UNIFIED = process.env.UNIFIED_API_KEY;
const ORIGINAL_FREELLM = process.env.FREELLMAPI_UNIFIED_API_KEY;

const PINNED = 'freellmapi-' + 'ab'.repeat(24); // 48 hex chars

describe('pinned unified API key', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    delete process.env.UNIFIED_API_KEY;
    delete process.env.FREELLMAPI_UNIFIED_API_KEY;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    initDb(':memory:');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv('UNIFIED_API_KEY', ORIGINAL_UNIFIED);
    restoreEnv('FREELLMAPI_UNIFIED_API_KEY', ORIGINAL_FREELLM);
  });

  it('reads a valid UNIFIED_API_KEY from the environment', () => {
    // Uppercase hex should normalize to lowercase.
    process.env.UNIFIED_API_KEY = 'freellmapi-' + 'AB'.repeat(24);
    expect(readPinnedUnifiedApiKey()).toBe(PINNED);
    expect(isUnifiedApiKeyPinned()).toBe(true);
  });

  it('getUnifiedApiKey prefers the env pin over the DB row', () => {
    const minted = getUnifiedApiKey();
    expect(minted.startsWith('freellmapi-')).toBe(true);

    process.env.UNIFIED_API_KEY = PINNED;
    expect(getUnifiedApiKey()).toBe(PINNED);
    expect(getUnifiedApiKey()).not.toBe(minted);
  });

  it('syncPinnedUnifiedApiKey overwrites a reminted DB row', () => {
    const minted = getUnifiedApiKey();
    process.env.FREELLMAPI_UNIFIED_API_KEY = PINNED;
    syncPinnedUnifiedApiKey();

    const row = getDb()
      .prepare("SELECT value FROM settings WHERE key = 'unified_api_key'")
      .get() as { value: string };
    expect(row.value).toBe(PINNED);
    expect(row.value).not.toBe(minted);
    expect(getUnifiedApiKey()).toBe(PINNED);
  });

  it('refuses regenerateUnifiedKey while the env pin is set', () => {
    process.env.UNIFIED_API_KEY = PINNED;
    expect(() => regenerateUnifiedKey()).toThrow(/pinned/i);
    expect(getUnifiedApiKey()).toBe(PINNED);
  });

  it('allows regenerateUnifiedKey when no env pin is set', () => {
    const before = getUnifiedApiKey();
    const after = regenerateUnifiedKey();
    expect(after).not.toBe(before);
    expect(getUnifiedApiKey()).toBe(after);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
