import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DigestRow, ReadNight, RunStatus } from './types.js';

type Event = {
  at: string;
  job: string;
  status: RunStatus;
  owner: string | null;
  error?: string;
  time: number;
  submillisecond: string;
};

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseEvent(line: string): Event | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (
    typeof event.at !== 'string' ||
    typeof event.job !== 'string' || event.job.trim() === '' ||
    (event.owner !== null && typeof event.owner !== 'string') ||
    (event.status !== 'ok' && event.status !== 'retry' && event.status !== 'fail') ||
    ('error' in event && typeof event.error !== 'string')
  ) return null;

  // Require a real calendar date and an explicit offset, not Date.parse's loose input grammar.
  const timestamp = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.(\d+))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(event.at);
  if (!timestamp || !validDate(timestamp[1])) return null;
  const time = Date.parse(event.at);
  if (!Number.isFinite(time)) return null;
  return {
    at: event.at,
    job: event.job,
    status: event.status,
    owner: event.owner,
    ...(typeof event.error === 'string' ? { error: event.error } : {}),
    time,
    // Date.parse truncates below milliseconds; retain that precision when sorting.
    submillisecond: (timestamp[3] ?? '').slice(3).replace(/0+$/, ''),
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareJobs(left: DigestRow, right: DigestRow): number {
  const a = Array.from(left.job);
  const b = Array.from(right.job);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const difference = a[i].codePointAt(0)! - b[i].codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

export const readNight: ReadNight = (runsDir, night) => {
  if (!validDate(night)) return null;
  let contents: string;
  try {
    contents = readFileSync(join(runsDir, `${night}.jsonl`), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }

  const lines = contents === '' ? [] : contents.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const events: Event[] = [];
  let badLines = 0;
  for (const line of lines) {
    const event = parseEvent(line);
    if (event) events.push(event);
    else badLines++;
  }
  // Array.sort is stable: equal instants retain their original file order.
  events.sort((a, b) => a.time - b.time || compareText(a.submillisecond, b.submillisecond));

  const counts = { ok: 0, retry: 0, fail: 0 };
  const jobs = new Map<string, DigestRow>();
  for (const event of events) {
    counts[event.status]++;
    let row = jobs.get(event.job);
    if (!row) {
      row = {
        job: event.job,
        owner: event.owner,
        runs: 0,
        retries: 0,
        failures: 0,
        lastStatus: event.status,
        lastError: null,
        firstAt: event.at,
        lastAt: event.at,
      };
      jobs.set(event.job, row);
    }
    row.runs++;
    if (event.status === 'retry') row.retries++;
    if (event.status === 'fail') row.failures++;
    row.owner = event.owner;
    row.lastStatus = event.status;
    if (event.error !== undefined) row.lastError = event.error;
    row.lastAt = event.at;
  }
  return { night, rows: [...jobs.values()].sort(compareJobs), badLines, counts };
};
