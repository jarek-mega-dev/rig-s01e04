import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readNight } from '../src/digest/reader.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const night = '2026-10-28';
const directories: string[] = [];
const event = (overrides: Record<string, unknown> = {}) => ({
  at: '2026-10-28T23:00:00+01:00', job: 'job', status: 'ok', owner: 'rook', ...overrides,
});

function fixture(contents: string): string {
  const directory = fs.mkdtempSync(join(tmpdir(), 'rig-reader-'));
  directories.push(directory);
  fs.writeFileSync(join(directory, `${night}.jsonl`), contents);
  return directory;
}

function eventsFixture(events: unknown[]): string {
  return fixture(events.map(value => JSON.stringify(value)).join('\n'));
}

afterEach(() => {
  vi.mocked(fs.readFileSync).mockReset();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('readNight', () => {
  it('reads the real, read-only night with five jobs and one malformed line', () => {
    const digest = readNight(fileURLToPath(new URL('../runs/', import.meta.url)), night);
    expect(digest).toEqual({
      night,
      badLines: 1,
      counts: { ok: 10, retry: 4, fail: 1 },
      rows: [
        { job: 'digest/render', owner: null, runs: 1, retries: 0, failures: 0, lastStatus: 'ok', lastError: null, firstAt: '2026-10-29T05:41:09+01:00', lastAt: '2026-10-29T05:41:09+01:00' },
        { job: 'fixtures/refresh', owner: 'rook', runs: 4, retries: 3, failures: 0, lastStatus: 'ok', lastError: 'upstream 503', firstAt: '2026-10-29T01:30:00+01:00', lastAt: '2026-10-29T01:37:00+01:00' },
        { job: 'lane/sync', owner: 'rook', runs: 8, retries: 1, failures: 0, lastStatus: 'ok', lastError: 'lock held', firstAt: '2026-10-28T23:00:06+01:00', lastAt: '2026-10-29T05:00:04+01:00' },
        { job: 'notes/backup', owner: 'lane-07', runs: 1, retries: 0, failures: 1, lastStatus: 'fail', lastError: 'quota exceeded', firstAt: '2026-10-29T04:00:01+01:00', lastAt: '2026-10-29T04:00:01+01:00' },
        { job: 'rig/rotate-logs', owner: 'lane-07', runs: 1, retries: 0, failures: 0, lastStatus: 'ok', lastError: null, firstAt: '2026-10-28T23:00:02+01:00', lastAt: '2026-10-28T23:00:02+01:00' },
      ],
    });
  });

  it('distinguishes a missing night from an existing empty night', () => {
    const directory = fixture('');
    expect(readNight(directory, '2026-10-27')).toBeNull();
    expect(readNight(join(directory, 'missing'), night)).toBeNull();
    expect(readNight(directory, night)).toEqual({
      night, rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 },
    });
  });

  it.each([
    '', '../2026-10-28', '/2026-10-28', '..\\2026-10-28', '2026-10-28/../2026-10-27',
    '2026-10-28.jsonl', '2026-10-28\0', '2026-10-28\n', '2026-1-01',
    '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-10-00',
  ])('rejects invalid night %j before accessing the filesystem', invalid => {
    const read = vi.mocked(fs.readFileSync);
    expect(readNight('/not-used', invalid)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('accepts a real leap day', () => {
    const directory = fixture('');
    fs.writeFileSync(join(directory, '2024-02-29.jsonl'), '');
    expect(readNight(directory, '2024-02-29')?.night).toBe('2024-02-29');
  });

  it('counts malformed schemas without losing valid null owners', () => {
    const invalid = [
      null, [], true, 42, 'text', {}, event({ at: null }), event({ job: 1 }),
      event({ job: '' }), event({ job: ' \t' }), event({ status: 'success' }),
      event({ owner: undefined }), event({ owner: 1 }), event({ error: null }),
      event({ error: 7 }), event({ at: undefined }), event({ job: undefined }),
      event({ status: undefined }),
    ];
    const directory = eventsFixture([...invalid, event({ owner: null })]);
    const digest = readNight(directory, night);
    expect(digest?.badLines).toBe(invalid.length);
    expect(digest?.counts).toEqual({ ok: 1, retry: 0, fail: 0 });
    expect(digest?.rows).toHaveLength(1);
    expect(digest?.rows[0].owner).toBeNull();
  });

  it.each([
    '', 'tomorrow', '2026-10-28', '2026-10-28T23:00:00',
    '2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-13-01T00:00:00Z',
    '2026-10-28T24:00:00Z', '2026-10-28T23:60:00Z', '2026-10-28T23:00:60Z',
    '2026-10-28T23:00:00+24:00', '2026-10-28T23:00:00+01:60',
    '2026-10-28T23:00:00Z\n',
  ])('counts invalid timestamp %j as a bad line', at => {
    const directory = eventsFixture([event({ at }), event()]);
    expect(readNight(directory, night)?.badLines).toBe(1);
    expect(readNight(directory, night)?.counts).toEqual({ ok: 1, retry: 0, fail: 0 });
  });

  it('aggregates by instant, keeps tied file order, and retains errors after recovery', () => {
    const directory = eventsFixture([
      event({ at: '2026-10-29T00:00:00+02:00', status: 'retry', error: 'latest error' }),
      event({ at: '2026-10-28T23:30:00+03:00', status: 'fail', error: 'earlier error' }),
      event({ at: '2026-10-28T22:00:00Z', owner: null }),
      event({ at: '2026-10-28T15:00:00-06:00', status: 'fail', error: 'middle error' }),
    ]);
    expect(readNight(directory, night)).toEqual({
      night, badLines: 0, counts: { ok: 1, retry: 1, fail: 2 },
      rows: [{
        job: 'job', owner: null, runs: 4, retries: 1, failures: 2,
        lastStatus: 'ok', lastError: 'latest error',
        firstAt: '2026-10-28T23:30:00+03:00', lastAt: '2026-10-28T22:00:00Z',
      }],
    });
  });

  it('preserves empty supplied errors and timestamps with submillisecond precision', () => {
    const directory = eventsFixture([
      event({ at: '2026-10-28T23:00:00.0002Z', error: '', owner: 'latest' }),
      event({ at: '2026-10-28T23:00:00.000100Z', error: 'older' }),
      event({ at: '2026-10-28T23:00:00.0001Z', error: 'tied' }),
    ]);
    expect(readNight(directory, night)?.rows[0]).toMatchObject({
      owner: 'latest', lastError: '', firstAt: '2026-10-28T23:00:00.000100Z',
      lastAt: '2026-10-28T23:00:00.0002Z',
    });
  });

  it('sorts jobs by codepoint without locale dependence or object-key collisions', () => {
    const jobs = ['😀', '\uE000', 'ä', 'a', '__proto__', 'Z', 'A', 'aa', 'constructor'];
    const directory = eventsFixture(jobs.map(job => event({ job })));
    expect(readNight(directory, night)?.rows.map(row => row.job)).toEqual([
      'A', 'Z', '__proto__', 'a', 'aa', 'constructor', 'ä', '\uE000', '😀',
    ]);
  });

  it.each(['\n', '\r\n'])('handles %j separators and ignores only one final newline', separator => {
    const directory = fixture([JSON.stringify(event()), '', 'broken', '  ', JSON.stringify(event()), ''].join(separator));
    expect(readNight(directory, night)).toMatchObject({
      badLines: 3, counts: { ok: 2, retry: 0, fail: 0 },
    });
  });

  it.each([['\n', 1], ['\r\n', 1], ['\n\n', 2], ['broken\n', 1]])(
    'counts actual bad lines in %j', (contents, badLines) => {
      expect(readNight(fixture(contents), night)).toEqual({
        night, rows: [], badLines, counts: { ok: 0, retry: 0, fail: 0 },
      });
    },
  );

  it('propagates a real filesystem error when runsDir is a file', () => {
    const directory = fixture('');
    expect(() => readNight(join(directory, `${night}.jsonl`), night)).toThrow(
      expect.objectContaining({ code: 'ENOTDIR' }),
    );
  });

  it.each(['EACCES', 'EIO', 'ELOOP', 'EISDIR'])('propagates %s unchanged', code => {
    const error = Object.assign(new Error('read failed'), { code });
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw error; });
    expect(() => readNight('/not-used', night)).toThrow(error);
  });
});
