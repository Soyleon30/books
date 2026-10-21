/** 网络类错误可重试 */
function isRetryableError(e) {
  if (!e) return false;
  const name = String(e.name || '');
  const msg = String(e.message || e || '').toLowerCase();
  const code = String((e.cause && e.cause.code) || e.code || '').toUpperCase();
  if (
    name === 'NetworkError' ||
    name === 'RequestTimeoutError' ||
    name === 'ServiceUnavailableError' ||
    name === 'PollTimeoutError' ||
    name === 'RateLimitError'
  ) {
    return true;
  }
  if (
    /timeout|timed out|network|econnreset|econnrefused|enotfound|eai_again|socket|fetch failed|503|502|504|429|unavailable|temporarily/.test(
      msg
    )
  ) {
    return true;
  }
  if (
    ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(
      code
    )
  ) {
    return true;
  }
  return false;
}

async function withRetry(fn, opts = {}) {
  const retries = Math.max(0, Number(opts.retries != null ? opts.retries : 1));
  const delayMs = Math.max(100, Number(opts.delayMs != null ? opts.delayMs : 800));
  const label = opts.label || 'op';
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const t0 = Date.now();
    try {
      if (attempt > 0) {
        log('retry', { label, attempt, max: retries, wait_ms: delayMs * attempt });
        await new Promise((r) => setTimeout(r, delayMs * attempt));
      }
      const result = await fn(attempt);
      if (attempt > 0) {
        log('retry_ok', { label, attempt, ms: Date.now() - t0 });
      }
      return result;
    } catch (e) {
      lastErr = e;
      const retryable = isRetryableError(e);
      log('attempt_fail', {
        label,
        attempt,
        retryable,
        ms: Date.now() - t0,
        name: e && e.name,
        error: e && (e.message || String(e)),
      });
      if (!retryable || attempt >= retries) break;
    }
  }
  throw lastErr;
}

module.exports = { withRetry, isRetryableError };
