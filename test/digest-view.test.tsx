import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { DigestRow, NightDigest } from '../src/digest/types.js';
import { DigestPage } from '../src/views/digest.js';
import { Layout } from '../src/views/layout.js';

const row = (overrides: Partial<DigestRow> = {}): DigestRow => ({
  job: 'alpha',
  owner: 'night team',
  runs: 1,
  retries: 0,
  failures: 0,
  lastStatus: 'ok',
  lastError: null,
  firstAt: '2026-10-28T20:00:00+02:00',
  lastAt: '2026-10-29T04:30:00-04:00',
  ...overrides,
});

const digest = (rows: DigestRow[], badLines = 0): NightDigest => ({
  night: '2026-10-28',
  rows,
  badLines,
  counts: rows.reduce((counts, item) => ({
    ok: counts.ok + item.runs - item.retries - item.failures,
    retry: counts.retry + item.retries,
    fail: counts.fail + item.failures,
  }), { ok: 0, retry: 0, fail: 0 }),
});

async function render(value: NightDigest, withLayout = false) {
  const app = new Hono();
  app.get('/', (c) => c.html(withLayout ? (
    <Layout title="digest" lane={{ id: 'test-lane', marker: null }}>
      <DigestPage digest={value} />
    </Layout>
  ) : <DigestPage digest={value} />));
  const response = await app.request('/');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
  return response.text();
}

describe('digest view (independent of the reader and production routes)', () => {
  it('renders one accessible table in the shared reader order without mutating rows', async () => {
    const value = digest([row(), row({ job: 'beta', owner: null, lastError: 'timeout' })], 2);
    const before = structuredClone(value);
    const html = await render(value);

    expect(html.match(/<table\b/g)).toHaveLength(1);
    expect(html).toContain('<caption>Runs for 2026-10-28, sorted by job</caption>');
    for (const column of ['Job', 'Owner', 'Runs', 'Retries', 'Failures', 'Last status', 'Last error', 'First time', 'Last time']) {
      expect(html).toContain(`<th scope="col">${column}</th>`);
    }
    expect(html.indexOf('<th scope="row">alpha</th>')).toBeLessThan(html.indexOf('<th scope="row">beta</th>'));
    expect(html).toContain('<td>night team</td>');
    expect(html).toContain('<td>timeout</td>');
    expect(html.match(/<td>—<\/td>/g)).toHaveLength(2);
    expect(html).not.toContain('<td></td>');
    expect(html).toContain('Bad lines: 2');
    expect(value).toEqual(before);
    expect(html).not.toContain('<html');
  });

  it('marks retries at the threshold and above using visible text, but not below it', async () => {
    for (const retries of [0, 2, 3, 4]) {
      const html = await render(digest([row({ runs: retries + 1, retries })]));
      if (retries >= 3) {
        expect(html).toContain(`<strong class="warn">${retries} — high retries</strong>`);
      } else {
        expect(html).not.toContain('high retries');
        expect(html).not.toContain('<strong class="warn">');
      }
    }
  });

  it('marks every failure, including recovered failures with an ok final status and no error', async () => {
    for (const lastStatus of ['ok', 'retry', 'fail'] as const) {
      const html = await render(digest([row({
        runs: 3, retries: lastStatus === 'retry' ? 1 : 0, failures: 1, lastStatus,
      })]));
      expect(html).toContain('<strong class="warn">1 failure</strong>');
      expect(html).toContain(`<td>${lastStatus}</td>`);
    }
    const html = await render(digest([row({ runs: 6, retries: 3, failures: 2 })]));
    expect(html).toContain('<strong class="warn">2 failures</strong>');
    expect(html).toContain('<strong class="warn">3 — high retries</strong>');
  });

  it('preserves original timestamp strings and offsets in visible text and time attributes', async () => {
    const item = row();
    const html = await render(digest([item]));
    for (const at of [item.firstAt, item.lastAt]) {
      expect(html).toContain(`<time datetime="${at}">${at}</time>`);
    }
  });

  it('shows exactly nothing ran for an empty night and still reports bad lines', async () => {
    for (const badLines of [0, 3]) {
      const html = await render(digest([], badLines));
      expect(html).toContain('<p>nothing ran</p>');
      expect(html).toContain(`Bad lines: ${badLines}`);
      expect(html).not.toContain('<table');
    }
  });

  it('escapes user-supplied fields as JSX text and attributes, with no executable markup', async () => {
    const unsafe = '<script>alert("x")</script>';
    const value = digest([row({
      job: unsafe, owner: unsafe, lastError: unsafe, firstAt: unsafe, lastAt: unsafe,
    })]);
    value.night = unsafe;
    const html = await render(value);
    expect(html).not.toContain('<script');
    expect(html).not.toContain(unsafe);
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('datetime="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"');
  });

  it('uses the existing layout with inline styles and a focusable horizontal scroll region', async () => {
    const longError = 'a long error without truncation '.repeat(100);
    const html = await render(digest([row({ lastError: longError })]), true);
    expect(html.match(/<html\b/g)).toHaveLength(1);
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1"');
    expect(html).toContain('class="digest-table-scroll" role="region" aria-label="Nightly run details" tabindex="0"');
    expect(html).toContain('.digest-table-scroll { max-width: 100%; overflow-x: auto; }');
    expect(html).toContain(longError);
    expect(html).not.toMatch(/overflow(?:-x)?:\s*hidden|text-overflow:\s*ellipsis/);
    expect(html).not.toMatch(/<script\b|<link\b/);
  });
});
