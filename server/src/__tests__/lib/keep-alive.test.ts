import { describe, it, expect, vi, afterEach } from 'vitest';
import { keepAliveTarget, keepAliveIntervalMs, startKeepAlive } from '../../lib/keep-alive.js';
import type { Scheduler } from '../../lib/scheduler.js';

describe('keep-alive', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('is off without a public URL', () => {
    expect(keepAliveTarget({})).toBeNull();
  });

  it('uses the URL Render provides, and KEEP_ALIVE_URL wins over it', () => {
    expect(keepAliveTarget({ RENDER_EXTERNAL_URL: 'https://app.onrender.com' }))
      .toBe('https://app.onrender.com/api/ping');
    expect(keepAliveTarget({
      RENDER_EXTERNAL_URL: 'https://app.onrender.com',
      KEEP_ALIVE_URL: 'https://llm.example.com/some/path',
    })).toBe('https://llm.example.com/api/ping');
  });

  it('can be switched off and ignores unusable URLs', () => {
    expect(keepAliveTarget({ RENDER_EXTERNAL_URL: 'https://app.onrender.com', KEEP_ALIVE: 'off' })).toBeNull();
    expect(keepAliveTarget({ KEEP_ALIVE_URL: 'not a url' })).toBeNull();
    expect(keepAliveTarget({ KEEP_ALIVE_URL: 'ftp://example.com' })).toBeNull();
  });

  it('defaults to 10 minutes and refuses intervals under a minute', () => {
    expect(keepAliveIntervalMs({})).toBe(600_000);
    expect(keepAliveIntervalMs({ KEEP_ALIVE_INTERVAL_MS: '1000' })).toBe(600_000);
    expect(keepAliveIntervalMs({ KEEP_ALIVE_INTERVAL_MS: '300000' })).toBe(300_000);
  });

  it('schedules a ping that survives a failing target', async () => {
    vi.stubEnv('KEEP_ALIVE_URL', 'https://llm.example.com');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => { throw new Error('offline'); });
    globalThis.fetch = fetchMock as any;

    let tick: (() => void | Promise<void>) | undefined;
    const scheduler: Scheduler = {
      every: (_ms, fn) => { tick = fn; return () => {}; },
      after: () => () => {},
    };
    expect(startKeepAlive(scheduler)).toBeTypeOf('function');
    await tick!();
    await tick!();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://llm.example.com/api/ping');
    // One warning per failure streak, not one per ping.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there is no target', () => {
    vi.stubEnv('KEEP_ALIVE_URL', '');
    vi.stubEnv('RENDER_EXTERNAL_URL', '');
    const every = vi.fn();
    expect(startKeepAlive({ every, after: vi.fn() } as unknown as Scheduler)).toBeNull();
    expect(every).not.toHaveBeenCalled();
  });
});
