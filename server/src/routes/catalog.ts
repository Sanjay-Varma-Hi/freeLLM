import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSyncState, syncCatalog } from '../services/catalog-sync.js';

/**
 * Model catalog status and manual refresh for the dashboard.
 *
 * The router keeps its model list (rate limits, context windows, new free
 * models) current by syncing the public catalog on a schedule. These two
 * endpoints let the dashboard show that state and trigger a refresh on demand
 * ("Check for updates" in a key's model picker).
 */
export const catalogRouter = Router();

/** GET /api/catalog — current sync state (applied version, last check, last error). */
catalogRouter.get('/', (_req: Request, res: Response) => {
  res.json({ catalog: getSyncState() });
});

/** POST /api/catalog/sync — check for a newer catalog right now. */
catalogRouter.post('/sync', async (_req: Request, res: Response) => {
  const sync = await syncCatalog(true);
  res.json({ catalog: getSyncState(), sync });
});
