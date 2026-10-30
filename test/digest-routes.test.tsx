import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { RigConfig } from '../src/config.js';
import type { NightDigest, RunStatus } from '../src/digest/types.js';

const night = '2026-10-30';
const routes = ['/digest', '/api/digest'];
type Event = { at: string; job: string; status: RunStatus; owner: string | null; error?: string };

function event(job: string, overrides: Partial<Event> = {}): Event {
  return { at: '2026-10-30T01:00:00+01:00', job, status: 'ok', owner: 'ops', ...overrides };
}

// Inspect the server-rendered table without coupling assertions to CSS or column order.
// Decode entities only AFTER removing markup, so escaped user text remains text.
function text(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (_, entity: string) => {
      if (entity.startsWith('#')) {
        return String.fromCodePoint(
          entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)),
        );
      }
      const entities: Record<string, string> = {
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
      };
      return entities[entity.toLowerCase()];
    },
  ).replace(/\s+/g, ' ').trim();
}

function table(html: string) {
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)];
  expect(tables).toHaveLength(1);
  const markup = tables[0][1];
  const headers = [...markup.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => text(m[1]));
  const rows = [...markup.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((row) => [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => text(cell[1])))
    .filter((cells) => cells.length > 0);
  return { headers, rows };
}

function rowFor(html: string, job: string) {
  const result = table(html);
  const rows = result.rows.filter((cells) => cells.includes(job));
  expect(rows).toHaveLength(1);
  return { headers: result.headers, cells: rows[0] };
}

// A labelled count column or an explicit in-row indication both communicate the
// history. Do not require a particular badge element, class, or wording.
function expectHistory(html: string, job: string, label: RegExp, count: number) {
  const { headers, cells } = rowFor(html, job);
  const column = headers.findIndex((header) => label.test(header));
  if (column >= 0) {
    expect(cells[column]).toMatch(new RegExp(`\\b${count}\\b`));
  } else {
    expect(cells.join(' ')).toMatch(label);
  }
}

describe('digest routes', () => {
  let directory: string;
  let config: RigConfig;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'rig-digest-routes-'));
    const runsDir = join(directory, 'runs');
    mkdirSync(runsDir);
    config = { adapter: 'shim', installed: '2026-10-29T14:06:00+01:00', beatEverySeconds: 60, runsDir };
    vi.stubEnv('LANE_ID', 'digest-test-lane');
    vi.stubEnv('LANE_MARKER', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  function writeNight(events: Event[]) {
    writeFileSync(join(config.runsDir, `${night}.jsonl`), events.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  }

  async function readBoth() {
    const app = createApp(config);
    const htmlResponse = await app.request(`/digest/${night}`);
    const jsonResponse = await app.request(`/api/digest/${night}`);
    expect([htmlResponse.status, jsonResponse.status]).toEqual([200, 200]);
    expect(htmlResponse.headers.get('content-type')).toMatch(/text\/html/);
    expect(jsonResponse.headers.get('content-type')).toMatch(/application\/json/);
    const html = await htmlResponse.text();
    const digest: NightDigest = await jsonResponse.json();
    return { html, digest };
  }

  it('serves HTML and the complete NightDigest JSON contract with 200', async () => {
    const entry = event('daily-export');
    writeNight([entry]);

    const { html, digest } = await readBoth();

    expect(digest).toEqual({
      night,
      rows: [{
        job: entry.job, owner: 'ops', runs: 1, retries: 0, failures: 0,
        lastStatus: 'ok', lastError: null, firstAt: entry.at, lastAt: entry.at,
      }],
      badLines: 0,
      counts: { ok: 1, retry: 0, fail: 0 },
    });
    expect(rowFor(html, entry.job).cells).toContain('ops');
    expect(html).toContain('digest-test-lane');
    expect(html).not.toMatch(/<script\b/i);
  });

  it.each(routes)('%s returns 404 when the night file is missing', async (route) => {
    const response = await createApp(config).request(`${route}/${night}`);
    expect(response.status).toBe(404);
  });

  it('distinguishes an empty file from a missing night in both representations', async () => {
    writeFileSync(join(config.runsDir, `${night}.jsonl`), '');

    const { html, digest } = await readBoth();

    expect(text(html)).toMatch(/nothing ran/i);
    expect(digest).toEqual({ night, rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } });
    expect(html).not.toMatch(/<script\b/i);
  });

  it('counts a malformed line and preserves valid rows on either side', async () => {
    writeFileSync(join(config.runsDir, `${night}.jsonl`), [
      JSON.stringify(event('zulu')),
      '{broken-json',
      JSON.stringify(event('alpha', { status: 'fail', error: 'connection refused' })),
      '',
    ].join('\n'));

    const { html, digest } = await readBoth();

    expect(digest.badLines).toBe(1);
    expect(digest.counts).toEqual({ ok: 1, retry: 0, fail: 1 });
    expect(digest.rows.map((row) => row.job)).toEqual(['alpha', 'zulu']);
    expect(digest.rows.find((row) => row.job === 'alpha')).toMatchObject({
      runs: 1, failures: 1, lastStatus: 'fail', lastError: 'connection refused',
    });
    expect(rowFor(html, 'alpha').cells.join(' ')).toMatch(/fail/i);
    expect(rowFor(html, 'zulu').cells).toContain('ops');
    expect(table(html).rows).toHaveLength(2);
  });

  it('sorts jobs rather than preserving input order, with exactly the same HTML and JSON sequence', async () => {
    writeNight([event('zulu'), event('middle'), event('alpha'), event('middle')]);

    const { html, digest } = await readBoth();
    const jobs = ['alpha', 'middle', 'zulu'];
    const htmlJobs = table(html).rows.map((cells) => {
      const matches = cells.filter((cell) => jobs.includes(cell));
      expect(matches).toHaveLength(1);
      return matches[0];
    });

    expect(digest.rows.map((row) => row.job)).toEqual(jobs);
    expect(htmlJobs).toEqual(digest.rows.map((row) => row.job));
    expect(digest.rows.find((row) => row.job === 'middle')?.runs).toBe(2);
  });

  it('keeps a null owner in JSON and renders an em dash instead of dropping the job', async () => {
    writeNight([event('unowned', { owner: null })]);

    const { html, digest } = await readBoth();

    expect(digest.rows).toHaveLength(1);
    expect(digest.rows[0].owner).toBeNull();
    const { headers, cells } = rowFor(html, 'unowned');
    const ownerColumn = headers.findIndex((header) => /owner/i.test(header));
    expect(ownerColumn).toBeGreaterThanOrEqual(0);
    expect(cells[ownerColumn]).toBe('—');
  });

  it.each([3, 4])('shows %i retries even when the final event succeeds', async (retries) => {
    writeNight([
      ...Array.from({ length: retries }, (_, index) => event('queue-drain', {
        at: `2026-10-30T01:0${index}:00+01:00`, status: 'retry',
      })),
      event('queue-drain', { at: '2026-10-30T02:00:00+01:00' }),
    ]);

    const { html, digest } = await readBoth();

    expect(digest.rows[0]).toMatchObject({ retries, runs: retries + 1, lastStatus: 'ok' });
    expect(digest.counts).toEqual({ ok: 1, retry: retries, fail: 0 });
    expectHistory(html, 'queue-drain', /retr(?:y|ies)/i, retries);
  });

  it('retains a recovered failure and its error, not just the final successful status', async () => {
    writeNight([
      event('recovered', { status: 'fail', error: 'upstream unavailable' }),
      event('recovered', { at: '2026-10-30T02:00:00+01:00' }),
    ]);

    const { html, digest } = await readBoth();

    expect(digest.rows[0]).toMatchObject({
      runs: 2, failures: 1, lastStatus: 'ok', lastError: 'upstream unavailable',
    });
    expect(digest.counts).toEqual({ ok: 1, retry: 0, fail: 1 });
    expectHistory(html, 'recovered', /fail/i, 1);
    expect(rowFor(html, 'recovered').cells.join(' ')).toMatch(/\bok\b/);
    expect(text(html)).toContain('upstream unavailable');
  });

  it('preserves original timezone strings while determining first and last by instant', async () => {
    const firstAt = '2026-10-30T03:00:00+03:00';
    const lastAt = '2026-10-29T23:30:00-02:00';
    // Reverse chronological input; lexical timestamp ordering is also incorrect here.
    writeNight([
      event('offset-job', { at: lastAt }),
      event('offset-job', { at: firstAt, status: 'retry' }),
    ]);

    const { html, digest } = await readBoth();

    expect(digest.rows[0]).toMatchObject({ firstAt, lastAt, lastStatus: 'ok' });
    const cells = rowFor(html, 'offset-job').cells.join(' ');
    expect(cells).toContain(firstAt);
    expect(cells).toContain(lastAt);
  });

  it('escapes job, owner and error in HTML while preserving their literal JSON values', async () => {
    const job = '<script>alert("job")</script>';
    const owner = '<img src=x onerror=alert("owner")>';
    const error = '<svg onload=alert("error")>& failure';
    writeNight([event(job, { owner, error, status: 'fail' })]);

    const { html, digest } = await readBoth();

    expect(digest.rows[0]).toMatchObject({ job, owner, lastError: error });
    const cells = rowFor(html, job).cells.join(' ');
    expect(cells).toContain(owner);
    expect(cells).toContain(error);
    expect(html).not.toContain(job);
    expect(html).not.toContain(owner);
    expect(html).not.toContain(error);
    expect(html).not.toMatch(/<(?:script|img|svg)\b/i);
  });

  it.each(routes)('%s rejects unsafe and invalid night identifiers', async (route) => {
    // A real, readable sentinel makes traversal checks meaningful after integration.
    writeFileSync(join(directory, 'outside.jsonl'), JSON.stringify(event('outside-runs')));
    writeFileSync(join(config.runsDir, 'not-a-night.jsonl'), JSON.stringify(event('invalid-night')));
    const app = createApp(config);

    for (const invalid of ['..%2Foutside', 'not-a-night', `${night}.jsonl`]) {
      const response = await app.request(`${route}/${invalid}`);
      expect(response.status, invalid).toBe(404);
      expect(await response.text()).not.toMatch(/outside-runs|invalid-night/);
    }
  });
});
