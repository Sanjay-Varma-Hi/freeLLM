import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb, getSetting } from '../../db/index.js';
import {
  SETUP_CODE_SETTING,
  clearSetupCode,
  generateSetupCode,
  getSetupCode,
  setupCodeMatches,
} from '../../lib/setup-code.js';

const ORIGINAL_SETUP = process.env.SETUP_CODE;
const ORIGINAL_FREELLM = process.env.FREELLMAPI_SETUP_CODE;

describe('setup code stability across restarts', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    delete process.env.SETUP_CODE;
    delete process.env.FREELLMAPI_SETUP_CODE;
    initDb(':memory:');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    clearSetupCode();
    vi.restoreAllMocks();
    restoreEnv('SETUP_CODE', ORIGINAL_SETUP);
    restoreEnv('FREELLMAPI_SETUP_CODE', ORIGINAL_FREELLM);
  });

  it('persists a minted code and reuses it on the next generateSetupCode call', () => {
    const first = generateSetupCode();
    expect(getSetting(SETUP_CODE_SETTING)).toBe(first);

    // Simulate a process restart: clear in-memory state, keep the settings row.
    clearSetupCodeMemoryOnly();
    expect(getSetupCode()).toBeNull();
    expect(getSetting(SETUP_CODE_SETTING)).toBe(first);

    const second = generateSetupCode();
    expect(second).toBe(first);
    expect(setupCodeMatches(first)).toBe(true);
  });

  it('prefers SETUP_CODE env over a persisted value', () => {
    generateSetupCode();
    process.env.SETUP_CODE = 'PINNED99AB';
    const code = generateSetupCode();
    expect(code).toBe('PINNED99AB');
    expect(getSetting(SETUP_CODE_SETTING)).toBe('PINNED99AB');
    expect(setupCodeMatches('pinned99ab')).toBe(true);
  });

  it('clears the persisted code once setup completes', () => {
    const code = generateSetupCode();
    expect(getSetting(SETUP_CODE_SETTING)).toBe(code);
    clearSetupCode();
    expect(getSetupCode()).toBeNull();
    expect(getSetting(SETUP_CODE_SETTING)).toBeUndefined();
  });
});

/** Drop only the in-memory code, leaving the settings row (restart simulation). */
function clearSetupCodeMemoryOnly(): void {
  // Re-import path is heavy; instead generate is the public API. Adopt empty
  // by clearing via the shared module's clear then re-writing the setting.
  const stored = getSetting(SETUP_CODE_SETTING)!;
  clearSetupCode();
  getDb().prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?)",
  ).run(SETUP_CODE_SETTING, stored);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
