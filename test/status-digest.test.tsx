import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RigConfig } from '../src/config.js';
import type { NightDigest, ReadNight, StatusCounts } from '../src/digest/types.js';
import type { Status } from '../src/status.js';
import { StatusBoard } from '../src/views/status.js';

// Reader integration is verified after merge; no placeholder reader or log parser.
const { readNight, lastBeat } = vi.hoisted(() => ({
  readNight: vi.fn<ReadNight>(),
  lastBeat: vi.fn(),
}));
vi.mock('../src/digest/reader.js', () => ({ readNight }));
vi.mock('../src/heartbeat.js', () => ({ lastBeat }));

function digest(night: string, counts: StatusCounts): NightDigest {
  return { night, rows: [], badLines: 0, counts };
}

describe('status board view', () => {
  const status: Status = {
    adapter: 'shim',
    installed: '2026-10-29T14:06:00+01:00',
    lastBeat: { at: '2026-10-30T09:00:00+01:00', pid: 123, laneId: 'lane-07' },
    nights: ['2026-10-28', '2026-10-27'],
    nightCounts: {
      '2026-10-28': { ok: 2, retry: 3, fail: 1 },
      '2026-10-27': { ok: 0, retry: 0, fail: 0 },
    },
  };

  it('renders each link with its counts, including zeros, in supplied newest-first order', () => {
    const html = StatusBoard({ status }).toString();
    expect(html).toContain('<a href="/digest/2026-10-28">2026-10-28</a> · <span>ok 2 / retry 3 / fail 1</span>');
    expect(html).toContain('<a href="/digest/2026-10-27">2026-10-27</a> · <span>ok 0 / retry 0 / fail 0</span>');
    expect(html.indexOf('/digest/2026-10-28')).toBeLessThan(html.indexOf('/digest/2026-10-27'));
    expect(html).toContain('<th>adapter</th><td>shim</td>');
    expect(html).toContain(`<th>installed</th><td>${status.installed}</td>`);
    expect(html).toContain('2026-10-30T09:00:00+01:00 · pid 123');
  });

  it('keeps links with unavailable counts and displays a dash instead of invented zeros', () => {
    const html = StatusBoard({ status: { ...status, nightCounts: { '2026-10-28': null } } }).toString();
    expect(html).toContain('<a href="/digest/2026-10-28">2026-10-28</a> · <span>—</span>');
    expect(html).toContain('<a href="/digest/2026-10-27">2026-10-27</a> · <span>—</span>');
  });

  it('preserves empty-board and missing-heartbeat messages', () => {
    const html = StatusBoard({
      status: { ...status, nights: [], nightCounts: {}, lastBeat: null },
    }).toString();
    expect(html).toContain('nothing in runs/');
    expect(html).toContain('<span class="warn">none</span>');
    expect(html).not.toContain('href="/digest/');
  });
});

// A mock cannot resolve the absent module in this isolated worker branch.
// Defer app/status imports until the reader worker's file has been merged.
const hasReader = existsSync(new URL('../src/digest/reader.ts', import.meta.url));
describe.skipIf(!hasReader)('status board digest links (mocked reader; needs reader module)', () => {
  let runsDir: string;
  let config: RigConfig;
  let createApp: typeof import('../src/app.js').createApp;
  let readStatus: typeof import('../src/status.js').readStatus;

  beforeEach(async () => {
    ({ createApp } = await import('../src/app.js'));
    ({ readStatus } = await import('../src/status.js'));
    runsDir = mkdtempSync(join(tmpdir(), 'rig-status-digest-'));
    config = {
      adapter: 'shim',
      installed: '2026-10-29T14:06:00+01:00',
      beatEverySeconds: 60,
      runsDir,
    };
    readNight.mockReset();
    lastBeat.mockReset();
    lastBeat.mockReturnValue(null);
  });

  afterEach(() => {
    rmSync(runsDir, { recursive: true, force: true });
  });

  it('links every night newest first with whole-night counts, not final job statuses', async () => {
    writeFileSync(join(runsDir, '2026-10-27.jsonl'), '');
    writeFileSync(join(runsDir, '2026-10-28.jsonl'), '');
    writeFileSync(join(runsDir, 'notes.txt'), '');
    writeFileSync(join(runsDir, 'not-a-night.jsonl'), '');
    const recovered: NightDigest = {
      ...digest('2026-10-28', { ok: 2, retry: 3, fail: 1 }),
      rows: [{
        job: 'recovered-job',
        owner: null,
        runs: 6,
        retries: 3,
        failures: 1,
        lastStatus: 'ok',
        lastError: 'temporary failure',
        firstAt: '2026-10-28T01:00:00+01:00',
        lastAt: '2026-10-28T02:00:00+01:00',
      }],
    };
    readNight.mockImplementation((_dir, night) => night === recovered.night
      ? recovered
      : digest(night, { ok: 5, retry: 0, fail: 2 }));

    const response = await createApp(config).request('/');
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('<a href="/digest/2026-10-28">2026-10-28</a> · <span>ok 2 / retry 3 / fail 1</span>');
    expect(html).toContain('<a href="/digest/2026-10-27">2026-10-27</a> · <span>ok 5 / retry 0 / fail 2</span>');
    expect(html.indexOf('/digest/2026-10-28')).toBeLessThan(html.indexOf('/digest/2026-10-27'));
    expect(readNight.mock.calls).toEqual([
      [runsDir, '2026-10-28'],
      [runsDir, '2026-10-27'],
    ]);
  });

  it('shows zero counts for an empty night', async () => {
    writeFileSync(join(runsDir, '2026-10-28.jsonl'), '');
    readNight.mockReturnValue(digest('2026-10-28', { ok: 0, retry: 0, fail: 0 }));

    const response = await createApp(config).request('/');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(
      '<a href="/digest/2026-10-28">2026-10-28</a> · <span>ok 0 / retry 0 / fail 0</span>',
    );
  });

  it('renders the valid counts when the reader reports malformed lines', async () => {
    writeFileSync(join(runsDir, '2026-10-28.jsonl'), 'not JSON\n');
    readNight.mockReturnValue({
      ...digest('2026-10-28', { ok: 0, retry: 0, fail: 0 }),
      badLines: 1,
    });

    const response = await createApp(config).request('/');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('ok 0 / retry 0 / fail 0');
  });

  it('preserves the link and displays missing data if a listed night disappears', async () => {
    writeFileSync(join(runsDir, '2026-10-28.jsonl'), '');
    readNight.mockReturnValue(null);

    const response = await createApp(config).request('/');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(
      '<a href="/digest/2026-10-28">2026-10-28</a> · <span>—</span>',
    );
  });

  it('preserves existing status fields and heartbeat rendering', async () => {
    const heartbeat = { at: '2026-10-30T09:00:00+01:00', pid: 123, laneId: 'lane-07' };
    lastBeat.mockReturnValue(heartbeat);
    expect(readStatus(config)).toEqual({
      adapter: config.adapter,
      installed: config.installed,
      lastBeat: heartbeat,
      nights: [],
      nightCounts: {},
    });

    const html = await (await createApp(config).request('/')).text();
    expect(html).toContain('<th>adapter</th><td>shim</td>');
    expect(html).toContain(`<th>installed</th><td>${config.installed}</td>`);
    expect(html).toContain(`${heartbeat.at} · pid 123`);
  });

  it('preserves the empty-board and missing-heartbeat messages without reading nights', async () => {
    const response = await createApp(config).request('/');
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('nothing in runs/');
    expect(html).toContain('<span class="warn">none</span>');
    expect(readNight).not.toHaveBeenCalled();
  });

  it('keeps a missing runs directory empty', () => {
    expect(readStatus({ ...config, runsDir: join(runsDir, 'missing') })).toMatchObject({
      nights: [],
      nightCounts: {},
    });
    expect(readNight).not.toHaveBeenCalled();
  });
});
