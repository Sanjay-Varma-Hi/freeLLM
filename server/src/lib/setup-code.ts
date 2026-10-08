import { createOneTimeCode } from './one-time-code.js';
import { getSetting, setSetting, getDb } from '../db/index.js';

// First-run setup code.
//
// POST /api/auth/setup creates the first admin account while there are zero
// users. The server binds all interfaces by default, so an exposed fresh
// install could be claimed by whoever reaches it first. To gate that without
// hurting the local/desktop first-run experience, we keep a setup code while
// the dashboard is unclaimed and log it. A browser on the same machine
// (a loopback socket) never needs the code; a request from any other address
// must present it.
//
// Stability across restarts (important for hosts like Render that sleep and
// wake the process, or wipe ephemeral disks):
//   1. FREELLMAPI_SETUP_CODE / SETUP_CODE env — pinned, never reminted
//   2. settings.first_run_setup_code — reused when the DB survives a restart
//   3. otherwise mint a fresh code and persist it in settings
// The code is cleared from memory and settings as soon as an account exists.

export const SETUP_CODE_SETTING = 'first_run_setup_code';

const _code = createOneTimeCode();

function readPinnedSetupCodeFromEnv(): string | null {
  for (const name of ['FREELLMAPI_SETUP_CODE', 'SETUP_CODE'] as const) {
    const raw = process.env[name]?.trim();
    if (!raw) continue;
    const normalized = normalizeSetupCode(raw);
    if (!normalized) {
      console.warn(
        `[setup] Ignoring ${name}: expected 6–32 alphanumeric characters (got length ${raw.length}).`,
      );
      continue;
    }
    return normalized;
  }
  return null;
}

/** Uppercase alphanumerics, length 6–32. Returns null when the value is unusable. */
export function normalizeSetupCode(raw: string): string | null {
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length < 6 || cleaned.length > 32) return null;
  return cleaned;
}

function readPersistedSetupCode(): string | null {
  try {
    const stored = getSetting(SETUP_CODE_SETTING)?.trim();
    if (!stored) return null;
    return normalizeSetupCode(stored);
  } catch {
    // DB not ready — caller only invokes this after initDb in production.
    return null;
  }
}

function persistSetupCode(code: string): void {
  try {
    setSetting(SETUP_CODE_SETTING, code);
  } catch (err) {
    console.warn('[setup] Could not persist setup code to settings:', err);
  }
}

function logSetupCode(code: string, source: 'env' | 'persisted' | 'minted'): void {
  console.log('');
  console.log('  First-run setup code: ' + code);
  if (source === 'env') {
    console.log('  (pinned via SETUP_CODE / FREELLMAPI_SETUP_CODE — stable across restarts)');
  } else if (source === 'persisted') {
    console.log('  (reused from the previous boot — stable until the first account is created)');
  } else {
    console.log('  A browser on this machine can finish setup without it. From any');
    console.log('  other device, enter this code to create the first account.');
  }
  console.log('');
}

// Resolve (or mint) the active setup code and log it. Call once at boot when
// there are zero accounts. Returns the code (handy for tests).
export function generateSetupCode(): string {
  const fromEnv = readPinnedSetupCodeFromEnv();
  if (fromEnv) {
    _code.adopt(fromEnv);
    persistSetupCode(fromEnv);
    logSetupCode(fromEnv, 'env');
    return fromEnv;
  }

  const fromDb = readPersistedSetupCode();
  if (fromDb) {
    _code.adopt(fromDb);
    logSetupCode(fromDb, 'persisted');
    return fromDb;
  }

  const code = _code.generate();
  persistSetupCode(code);
  logSetupCode(code, 'minted');
  return code;
}

export function getSetupCode(): string | null {
  return _code.get();
}

export function clearSetupCode(): void {
  _code.clear();
  try {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(SETUP_CODE_SETTING);
  } catch {
    // Ignore — already cleared or DB unavailable during tests that never wrote it.
  }
}

// Constant-time comparison against the active code. Returns false when no code
// is active or the input is not a matching string.
export function setupCodeMatches(provided: unknown): boolean {
  return _code.matches(typeof provided === 'string' ? provided.trim().toUpperCase() : provided);
}
