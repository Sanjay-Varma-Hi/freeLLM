import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Which RELEASE this install is, for the dashboard to display.
//
// Deliberately not `server/package.json`: that version tracks the server
// workspace, not the product. The product version lives in the ROOT
// package.json (the npm workspace manifest) — the one place to bump a release.
//
// Order:
//   1. FREEAPI_VERSION — a packaged/self-hosted deployment can set it.
//   2. The root workspace manifest (the package.json that declares
//      `workspaces`), found by walking up from this module. Present in a source
//      checkout, and the Docker runtime image copies it to /app/package.json.
//   3. null — say nothing rather than state a version that isn't the release.
//      The dashboard omits the row entirely when this is null.

const MAX_WALK_UP = 6;

function readRootVersion(file: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown; workspaces?: unknown };
    if (!Array.isArray(parsed.workspaces)) return null; // a workspace package, keep walking
    return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}

function findReleaseVersion(): string | null {
  let dir: string;
  try {
    dir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
  for (let i = 0; i < MAX_WALK_UP; i++) {
    const found = readRootVersion(path.join(dir, 'package.json'));
    if (found) return found;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let cached: string | null | undefined;

/** The released app version, or null when it cannot be established honestly. */
export function getAppVersion(): string | null {
  if (cached !== undefined) return cached;
  const fromEnv = process.env.FREEAPI_VERSION?.trim();
  cached = fromEnv ? fromEnv : findReleaseVersion();
  return cached;
}

/** Test seam — the resolver caches, and env changes must be able to take effect. */
export function resetAppVersionCache(): void {
  cached = undefined;
}
