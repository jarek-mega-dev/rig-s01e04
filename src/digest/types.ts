/** A valid event's status. Counts below count events, not final job statuses. */
export type RunStatus = 'ok' | 'retry' | 'fail';

export type StatusCounts = Record<RunStatus, number>;

/** One job, aggregated chronologically; timestamp strings retain their original offsets. */
export type DigestRow = {
  job: string;
  /** Owner of the most recent event; null is displayed as —, not omitted. */
  owner: string | null;
  /** All valid events, including retry and fail events. */
  runs: number;
  retries: number;
  /** Count every failure, including failures followed by a successful event. */
  failures: number;
  lastStatus: RunStatus;
  /** Most recent supplied error, retained even if a later event succeeds. */
  lastError: string | null;
  firstAt: string;
  lastAt: string;
};

export type NightDigest = {
  night: string;
  /** Ascending job-name order, shared by HTML and JSON. */
  rows: DigestRow[];
  badLines: number;
  counts: StatusCounts;
};

/**
 * readNight(runsDir, night): synchronous reader shared by all consumers.
 * null means a missing file or invalid YYYY-MM-DD night identifier (routes return 404).
 * An existing empty file returns an empty digest, not null.
 * Invalid JSON/schema lines are counted; the usual final newline is not a bad line.
 * Unexpected filesystem errors must propagate, not masquerade as a missing night.
 */
export type ReadNight = (runsDir: string, night: string) => NightDigest | null;
