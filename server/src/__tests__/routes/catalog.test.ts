import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

let dashToken = '';
const realFetch = globalThis.fetch;

async function call(app: Express, method: string, path: string, auth = true) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await realFetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: auth ? { Authorization: `Bearer ${dashToken}` } : {},
  });
  const body = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body };
}

// The paid "Premium" surface was removed; the dashboard keeps a plain catalog
// status + "check for updates" endpoint.
describe('/api/catalog', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requires a dashboard session', async () => {
    const { status } = await call(app, 'GET', '/api/catalog', false);
    expect(status).toBe(401);
  });

  it('GET reports the catalog sync state', async () => {
    const { status, body } = await call(app, 'GET', '/api/catalog');
    expect(status).toBe(200);
    expect(body.catalog).toHaveProperty('baseUrl');
    expect(body.catalog).toHaveProperty('appliedVersion');
  });

  it('POST /sync answers with the sync result even when the catalog is unreachable', async () => {
    // Only the outbound catalog request fails; the test's own calls to the
    // local server go through the real fetch captured above.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const { status, body } = await call(app, 'POST', '/api/catalog/sync');
    expect(status).toBe(200);
    expect(body.sync.ok).toBe(false);
    expect(body.catalog).toHaveProperty('baseUrl');
  });

  it('the old Premium API no longer exists', async () => {
    const { status } = await call(app, 'GET', '/api/premium');
    expect(status).toBe(404);
  });
});
