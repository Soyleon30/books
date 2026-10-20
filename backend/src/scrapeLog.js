/**
 * 刮削日志：文件 + MySQL scrape_logs
 * 用 AsyncLocalStorage 绑定一次刮削的 run_id / isbn
 */
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const logDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const PATH_SCRAPE = path.join(logDir, 'scrape.log');
const PATH_REQUESTS = path.join(logDir, 'requests.log');
const PATH_SUMMARY = path.join(logDir, 'summary.log');

const BODY_MAX = Number(process.env.SCRAPE_LOG_BODY_MAX || 8000);
const scrapeCtx = new AsyncLocalStorage();

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

function redactUrl(url) {
  return String(url || '')
    .replace(/([?&](?:appKey|apikey|api_key|key)=)[^&]*/gi, '$1***')
    .replace(/(appKey|apikey|api_key)=([^&\s]+)/gi, '$1=***');
}

function clip(s, max = BODY_MAX) {
  const t = typeof s === 'string' ? s : JSON.stringify(s);
  if (!t) return '';
  if (t.length <= max) return t;
  return t.slice(0, max) + `…[truncated ${t.length - max} chars, total ${t.length}]`;
}

function safeJson(obj, max = BODY_MAX) {
  try {
    return clip(JSON.stringify(obj, null, 0), max);
  } catch {
    return String(obj);
  }
}

function appendFile(file, line) {
  try {
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch (e) {
    console.error('[scrape-log]', e.message || e);
  }
}

function ctxRun() {
  return scrapeCtx.getStore() || null;
}

function runWithContext(ctx, fn) {
  return scrapeCtx.run(ctx, fn);
}

function writeDbLog(row) {
  const pool = getPool();
  if (!pool) return;
  const run = ctxRun();
  const runId = (run && run.runId) || row.run_id || null;
  if (!runId) return;
  const isbn = row.isbn != null ? row.isbn : run && run.isbn;
  const payload = {
    run_id: String(runId).slice(0, 36),
    isbn: isbn ? String(isbn).slice(0, 20) : null,
    event: String(row.event || 'event').slice(0, 64),
    site: row.site
      ? String(row.site).slice(0, 64)
      : row.tag
        ? String(row.tag).slice(0, 64)
        : row.provider
          ? String(row.provider).slice(0, 64)
          : null,
    phase: row.phase ? String(row.phase).slice(0, 32) : null,
    ok:
      row.ok === true || row.ok === 1
        ? 1
        : row.ok === false || row.ok === 0
          ? 0
          : null,
    http_status:
      row.status != null
        ? Number(row.status)
        : row.http_status != null
          ? Number(row.http_status)
          : null,
    url: row.url ? String(redactUrl(row.url)).slice(0, 1024) : null,
    request_json:
      row.request_json != null
        ? clip(
            typeof row.request_json === 'string' ? row.request_json : safeJson(row.request_json),
            60000
          )
        : row.headers
          ? safeJson(
              { headers: row.headers, method: row.method, timeout_ms: row.timeout_ms },
              8000
            )
          : null,
    response_json:
      row.response_json != null
        ? clip(
            typeof row.response_json === 'string'
              ? row.response_json
              : safeJson(row.response_json),
            60000
          )
        : null,
    response_body:
      row.body != null
        ? clip(String(row.body), 60000)
        : row.response_body != null
          ? clip(String(row.response_body), 60000)
          : null,
    meta_json:
      row.meta != null
        ? safeJson(row.meta, 8000)
        : row.meta_json != null
          ? clip(String(row.meta_json), 8000)
          : null,
    error_text: row.error
      ? String(row.error).slice(0, 1024)
      : row.reason
        ? String(row.reason).slice(0, 1024)
        : null,
    elapsed_ms: row.elapsed_ms != null ? Number(row.elapsed_ms) : null,
    summary: row.summary ? String(row.summary).slice(0, 512) : null,
  };
  pool
    .query(
      `INSERT INTO scrape_logs
        (run_id, isbn, event, site, phase, ok, http_status, url, request_json, response_json, response_body, meta_json, error_text, elapsed_ms, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.run_id,
        payload.isbn,
        payload.event,
        payload.site,
        payload.phase,
        payload.ok,
        payload.http_status,
        payload.url,
        payload.request_json,
        payload.response_json,
        payload.response_body,
        payload.meta_json,
        payload.error_text,
        payload.elapsed_ms,
        payload.summary,
      ]
    )
    .catch((e) => console.error('[scrape-db-log]', e.message || e));
}

function logScrape(event, payload = {}) {
  const row = { ts: new Date().toISOString(), event, ...payload };
  appendFile(PATH_SCRAPE, JSON.stringify(row));
  writeDbLog({ event, ...payload });
  if (process.env.SCRAPE_LOG_CONSOLE === '1') {
    console.log(`[scrape] ${event}`, safeJson(payload, 500));
  }
}

function logHttp(entry) {
  const row = { ts: new Date().toISOString(), ...entry };
  appendFile(PATH_REQUESTS, JSON.stringify(row));
  appendFile(PATH_SCRAPE, JSON.stringify({ event: 'http', ...row }));
  const summary =
    entry.phase === 'request'
      ? `REQ ${entry.tag || ''} ${entry.method || 'GET'} ${redactUrl(entry.url || '')}`
      : entry.phase === 'response'
        ? `RES ${entry.tag || ''} status=${entry.status} ok=${entry.ok} len=${entry.body_len || 0} ${entry.elapsed_ms || 0}ms`
        : `ERR ${entry.tag || ''} ${entry.error || ''}`;
  writeDbLog({
    event: 'http',
    site: entry.tag,
    phase: entry.phase,
    ok: entry.ok,
    status: entry.status,
    url: entry.url,
    headers: entry.headers,
    method: entry.method,
    timeout_ms: entry.timeout_ms,
    body: entry.body,
    error: entry.error,
    elapsed_ms: entry.elapsed_ms,
    summary,
    response_json:
      entry.phase === 'response'
        ? safeJson({
            status: entry.status,
            content_type: entry.content_type,
            final_url: entry.final_url,
            body_len: entry.body_len,
            probe_ok: entry.probe_ok,
            reason: entry.reason,
          })
        : null,
  });
}

function logSummary(text, extra = {}) {
  const line = `[${new Date().toISOString()}] ${text}`;
  appendFile(PATH_SUMMARY, line);
  console.log('[scrape]', text);
  writeDbLog({
    event: 'summary',
    summary: text,
    ...extra,
  });
}

module.exports = {
  logDir,
  PATH_SCRAPE,
  PATH_REQUESTS,
  PATH_SUMMARY,
  BODY_MAX,
  redactUrl,
  clip,
  safeJson,
  logScrape,
  logHttp,
  logSummary,
  writeDbLog,
  runWithContext,
  ctxRun,
  scrapeCtx,
};
