/**
 * 书脊识别分步日志 → 控制台 + backend/logs/spine.log
 * 同时累积 steps，随 API 返回给前端
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const logDir = path.join(__dirname, '..', 'logs');
try {
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
} catch (_) {}

const PATH_SPINE = path.join(logDir, 'spine.log');

function clip(s, max = 500) {
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

function newSpineTrace(meta) {
  const runId = crypto.randomBytes(6).toString('hex');
  const t0 = Date.now();
  const steps = [];
  const base = {
    run_id: runId,
    ...(meta || {}),
  };

  function write(level, step, detail) {
    const elapsed = Date.now() - t0;
    const row = {
      ts: new Date().toISOString(),
      elapsed_ms: elapsed,
      level: level || 'info',
      step: String(step || 'step'),
      detail: detail == null ? null : detail,
    };
    steps.push({
      elapsed_ms: elapsed,
      level: row.level,
      step: row.step,
      message: formatMessage(row.step, detail),
      detail: typeof detail === 'object' && detail !== null ? detail : undefined,
    });

    const line =
      `[${row.ts}] +${elapsed}ms #${runId} [${row.level}] ${row.step}` +
      (detail != null ? ' ' + clip(typeof detail === 'string' ? detail : JSON.stringify(detail), 800) : '');

    try {
      console.log('[spine]', line.replace(/^\[[^\]]+\] /, ''));
    } catch (_) {}
    try {
      fs.appendFileSync(PATH_SPINE, line + '\n', 'utf8');
    } catch (e) {
      console.error('[spine-log]', e.message || e);
    }
    return row;
  }

  function formatMessage(step, detail) {
    if (detail == null) return step;
    if (typeof detail === 'string') return `${step}: ${detail}`;
    try {
      const bits = [];
      for (const [k, v] of Object.entries(detail)) {
        if (v == null || v === '') continue;
        if (typeof v === 'object') bits.push(`${k}=${clip(JSON.stringify(v), 80)}`);
        else bits.push(`${k}=${clip(String(v), 80)}`);
      }
      return bits.length ? `${step} · ${bits.join(' ')}` : step;
    } catch {
      return step;
    }
  }

  return {
    runId,
    t0,
    base,
    info: (step, detail) => write('info', step, detail),
    warn: (step, detail) => write('warn', step, detail),
    error: (step, detail) => write('error', step, detail),
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
  newSpineTrace,
  PATH_SPINE,
};
