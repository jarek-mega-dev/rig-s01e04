import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { RigConfig } from '../src/config.js';
import type { NightDigest, ReadNight } from '../src/digest/types.js';

const { readNight, digestPage } = vi.hoisted(() => ({
  readNight: vi.fn<ReadNight>(),
  digestPage: vi.fn((_props: { digest: NightDigest }) => 'digest view'),
}));

// Test doubles only: the reader and page are supplied by their respective workers.
vi.mock('../src/digest/reader.js', () => ({ readNight }));
vi.mock('../src/views/digest.js', () => ({ DigestPage: digestPage }));

const config: RigConfig = {
  adapter: 'shim',
  installed: '2026-10-29T14:06:00+01:00',
  beatEverySeconds: 60,
  runsDir: '/configured/night-logs',
};

const digest: NightDigest = {
  night: '2026-10-28',
  rows: [
    {
      job: 'alpha',
      owner: null,
      runs: 4,
      retries: 3,
      failures: 1,
      lastStatus: 'fail',
      lastError: 'timed out',
      firstAt: '2026-10-28T01:00:00+01:00',
      lastAt: '2026-10-28T01:03:00+01:00',
    },
    {
      job: 'beta',
      owner: 'rook',
      runs: 1,
      retries: 0,
      failures: 0,
      lastStatus: 'ok',
      lastError: null,
      firstAt: '2026-10-28T02:00:00+01:00',
      lastAt: '2026-10-28T02:00:00+01:00',
    },
  ],
  badLines: 1,
  counts: { ok: 1, retry: 3, fail: 1 },
};

beforeEach(() => {
  readNight.mockReset();
  digestPage.mockClear();
  readNight.mockReturnValue(digest);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('digest API wiring', () => {
  it('returns the entire reader result, preserving row order and bad-line counts', async () => {
    const res = await createApp(config).request('/api/digest/2026-10-28');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual(digest);
    expect(readNight).toHaveBeenCalledExactlyOnceWith(config.runsDir, digest.night);
    expect(digestPage).not.toHaveBeenCalled();
  });

  it('returns an existing empty night as JSON with status 200', async () => {
    const empty: NightDigest = {
      night: '2026-10-29',
      rows: [],
      badLines: 0,
      counts: { ok: 0, retry: 0, fail: 0 },
    };
    readNight.mockReturnValue(empty);

    const res = await createApp(config).request('/api/digest/2026-10-29');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(empty);
    expect(readNight).toHaveBeenCalledExactlyOnceWith(config.runsDir, empty.night);
  });

  it.each(['2026-10-27', 'invalid-night'])('returns a JSON 404 when the reader rejects %s', async (night) => {
    readNight.mockReturnValue(null);

    const res = await createApp(config).request(`/api/digest/${night}`);

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'Night not found' });
    expect(readNight).toHaveBeenCalledExactlyOnceWith(config.runsDir, night);
  });
});

describe('shared digest page wiring', () => {
  it('passes the same digest and row order to the page inside the lane layout', async () => {
    vi.stubEnv('LANE_ID', 'test-lane');
    vi.stubEnv('LANE_MARKER', 'TEST-MARKER');
    const app = createApp(config);

    const api = await app.request('/api/digest/2026-10-28');
    const page = await app.request('/digest/2026-10-28');
    const html = await page.text();

    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(readNight).toHaveBeenCalledTimes(2);
    expect(readNight).toHaveBeenNthCalledWith(1, config.runsDir, digest.night);
    expect(readNight).toHaveBeenNthCalledWith(2, config.runsDir, digest.night);
    expect(digestPage).toHaveBeenCalledTimes(1);
    expect(digestPage.mock.calls[0][0].digest).toBe(digest);
    expect(await api.json()).toEqual(digestPage.mock.calls[0][0].digest);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('test-lane');
    expect(html).toContain('TEST-MARKER');
    expect(html).toContain('digest view');
    expect(html).not.toContain('<script');
  });

  it('returns 404 without rendering a digest page for a missing night', async () => {
    readNight.mockReturnValue(null);

    const res = await createApp(config).request('/digest/2026-10-27');

    expect(res.status).toBe(404);
    expect(readNight).toHaveBeenCalledExactlyOnceWith(config.runsDir, '2026-10-27');
    expect(digestPage).not.toHaveBeenCalled();
  });
});
