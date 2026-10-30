# rig

Keeps a lane's lights on while nobody is in it: a heartbeat every minute, a status board, and
(next) a morning digest of what ran overnight.

```sh
cp .env.example .env   # set LANE_MARKER
pnpm install
pnpm dev               # http://localhost:8787
```

Working on it with an agent: start at [AGENTS.md](AGENTS.md).

## Morning digest

The service listens only on `127.0.0.1` (port `8787` by default).

- `/` links each night on disk to its digest, with `ok / retry / fail` event counts.
- `/digest/2026-10-28` renders the sample night as a server-rendered HTML table.
- `/api/digest/2026-10-28` returns the same data as JSON:
  `{ night, rows, badLines, counts }`.

Each row describes one job. `runs` counts every valid event, including retries and failures.
The reader orders events by timestamp, preserves their original timestamp strings and offsets,
and sorts rows by job name. The latest event supplies the owner and last status; the last
supplied error is retained even after recovery. Missing owners and errors display as `—`.
Three or more retries and every recorded failure are highlighted, including recovered failures.

Malformed JSON or invalid event records count toward `badLines` without hiding valid jobs.
Event timestamps require an ISO date, hours/minutes/seconds, and an explicit `Z` or `±HH:mm`
offset; fractional seconds are optional. Night identifiers must be valid `YYYY-MM-DD` dates.
A missing night returns 404; an existing empty file renders `nothing ran`.
The files in `runs/` are read-only fixtures, not current operational data.

```sh
pnpm test
pnpm typecheck
```

Keep `.env`, course proofs and exported HTML previews out of Git. Publishing or replacing a
public preview is a separate, human-approved step; running the service locally does not do it.
