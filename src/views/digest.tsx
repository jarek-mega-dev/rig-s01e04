import type { NightDigest } from '../digest/types.js';

export function DigestPage({ digest }: { digest: NightDigest }) {
  return (
    <>
      <h1>digest · {digest.night}</h1>
      <p>Bad lines: {digest.badLines}</p>
      {digest.rows.length === 0 ? (
        <p>nothing ran</p>
      ) : (
        <div class="digest-table-scroll" role="region" aria-label="Nightly run details" tabindex={0}>
          <table class="digest-table">
            <caption>Runs for {digest.night}, sorted by job</caption>
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Owner</th>
                <th scope="col">Runs</th>
                <th scope="col">Retries</th>
                <th scope="col">Failures</th>
                <th scope="col">Last status</th>
                <th scope="col">Last error</th>
                <th scope="col">First time</th>
                <th scope="col">Last time</th>
              </tr>
            </thead>
            <tbody>
              {/* The reader owns ordering, shared with the JSON endpoint. */}
              {digest.rows.map((row) => (
                <tr key={row.job}>
                  <th scope="row">{row.job}</th>
                  <td>{row.owner ?? '—'}</td>
                  <td>{row.runs}</td>
                  <td>
                    {row.retries >= 3 ? (
                      <strong class="warn">{row.retries} — high retries</strong>
                    ) : row.retries}
                  </td>
                  <td>
                    {row.failures > 0 ? (
                      <strong class="warn">{row.failures} {row.failures === 1 ? 'failure' : 'failures'}</strong>
                    ) : row.failures}
                  </td>
                  <td>{row.lastStatus}</td>
                  <td>{row.lastError ?? '—'}</td>
                  <td><time datetime={row.firstAt}>{row.firstAt}</time></td>
                  <td><time datetime={row.lastAt}>{row.lastAt}</time></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
