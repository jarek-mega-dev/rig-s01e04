import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';

const config = { adapter: 'shim', installed: '2026-10-29T14:06:00+01:00', beatEverySeconds: 60, runsDir: 'runs' };

describe('status board', () => {
  beforeEach(() => {
    vi.stubEnv('LANE_ID', 'lane-07');
    vi.stubEnv('LANE_MARKER', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('shows the lane banner and the nights on disk', async () => {
    vi.stubEnv('LANE_MARKER', 'TEST-MARKER');
    const res = await createApp(config).request('/');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('TEST-MARKER');
    expect(html).toContain('2026-10-28');
  });

  it('health answers with the lane id', async () => {
    const res = await createApp(config).request('/health');
    expect(await res.json()).toEqual({ ok: true, lane: 'lane-07' });
  });
});
