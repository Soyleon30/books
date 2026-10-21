/**
 * 书脊/书名匹配诊断日志 → MySQL match_logs + logs/match.log
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const logDir = path.join(__dirname, '..', 'logs');
try {
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
} catch (_) {}
const PATH_MATCH = path.join(logDir, 'match.log');

let _pool = null;
function getPool() {
  if (_pool) return _pool;
  try {
    _pool = require('./db').pool;
  } catch (_) {
    _pool = null;
  }
  return _pool;
}

function clip(s, max = 4000) {
  const t = typeof s === 'string' ? s : (() => {
    try {
      return JSON.stringify(s);
    } catch {
      return String(s);
    }
  })();
  if (!t) return '';
  if (t.length <= max) return t;
  return t.slice(0, max) + `…(+${t.length - max})`;
}

function newMatchRun(meta) {
  const runId = crypto.randomBytes(8).toString('hex');
  const t0 = Date.now();
  const steps = [];
  const base = {
    run_id: runId,
    user_id: meta && meta.user_id,
    username: meta && meta.username,
    library_id: meta && meta.library_id,
  };

  function appendFile(line) {
    try {
      fs.appendFileSync(PATH_MATCH, line + '\n', 'utf8');
    } catch (_) {}
  }

  function writeDb(row) {
    const pool = getPool();
    if (!pool) return;
    pool
      .query(
        `INSERT INTO match_logs
          (run_id, user_id, username, library_id, query_text, event, site, ok, http_status,
           request_json, response_json, hits_json, pick_json, reason, elapsed_ms, summary)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          runId,
          base.user_id || null,
          base.username ? String(base.username).slice(0, 64) : null,
          base.library_id || null,
          row.query_text ? String(row.query_text).slice(0, 256) : null,
          String(row.event || 'event').slice(0, 64),
          row.site ? String(row.site).slice(0, 64) : null,
          row.ok == null ? null : row.ok ? 1 : 0,
          row.http_status != null ? Number(row.http_status) : null,
          row.request != null ? clip(row.request, 8000) : null,
          row.response != null ? clip(row.response, 12000) : null,
          row.hits != null ? clip(row.hits, 8000) : null,
          row.pick != null ? clip(row.pick, 4000) : null,
          row.reason ? String(row.reason).slice(0, 1024) : null,
          row.elapsed_ms != null ? Number(row.elapsed_ms) : null,
          row.summary ? String(row.summary).slice(0, 512) : null,
        ]
      )
      .catch((e) => console.error('[match-log-db]', e.message || e));
  }

  function log(event, detail) {
    const d = detail || {};
    const elapsed = Date.now() - t0;
    const step = {
      elapsed_ms: elapsed,
      event,
      site: d.site || null,
      query: d.query_text || d.query || null,
      ok: d.ok,
      reason: d.reason || null,
      summary: d.summary || null,
      hits_n: Array.isArray(d.hits) ? d.hits.length : d.hits_n,
      pick: d.pick || null,
    };
    steps.push(step);

    const line =
      `[${new Date().toISOString()}] +${elapsed}ms #${runId} [${event}]` +
      (d.site ? ` site=${d.site}` : '') +
      (d.query_text || d.query ? ` q=${d.query_text || d.query}` : '') +
      (d.ok != null ? ` ok=${d.ok}` : '') +
      (d.reason ? ` reason=${d.reason}` : '') +
      (d.summary ? ` ${clip(d.summary, 200)}` : '');
    console.log('[match]', line.replace(/^\[[^\]]+\] /, ''));
    appendFile(line);

    writeDb({
      event,
      site: d.site,
      query_text: d.query_text || d.query,
      ok: d.ok,
      http_status: d.http_status,
      request: d.request,
      response: d.response,
      hits: d.hits,
      pick: d.pick,
      reason: d.reason,
      elapsed_ms: d.elapsed_ms != null ? d.elapsed_ms : elapsed,
      summary: d.summary,
    });
    return step;
  }

  return {
    runId,
    t0,
    log,
    info: (event, d) => log(event, d),
    warn: (event, d) => log(event, { ...d, ok: d && d.ok != null ? d.ok : false }),
    error: (event, d) => log(event, { ...d, ok: false }),
    steps: () => steps.slice(),
    summary: () => ({
      run_id: runId,
      elapsed_ms: Date.now() - t0,
      step_count: steps.length,
      steps: steps.slice(),
    }),
  };
}

module.exports = {
  newMatchRun,
  PATH_MATCH,
};
