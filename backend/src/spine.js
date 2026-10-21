const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { createWorker } = require('tesseract.js');
const OcrApi = require('@alicloud/ocr-api20210707');
const OpenApi = require('@alicloud/openapi-client');
const { PaddleOCRClient, Model } = require('@paddleocr/api-sdk');
const { withRetry } = require('./ocrRetry');

let workerPromise = null;
let aliyunClient = null;
let paddleClient = null;

const MAX_SPINES = 20;

function ocrLog(level, step, detail) {
  const line =
    `[ocr] ${level} ${step}` +
    (detail != null
      ? ' ' +
        (typeof detail === 'string'
          ? detail
          : (() => {
              try {
                return JSON.stringify(detail);
              } catch {
                return String(detail);
              }
            })())
      : '');
  if (level === 'error') console.error(line);
  else console.log(line);
  try {
    const logDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, 'spine.log'),
      `${new Date().toISOString()} ${line}\n`,
      'utf8'
    );
  } catch (_) {}
}

function aliyunConfigured() {
  return !!(
    process.env.ALIYUN_OCR_ACCESS_KEY_ID &&
    process.env.ALIYUN_OCR_ACCESS_KEY_SECRET
  );
}

function paddleToken() {
  return (
    process.env.PADDLE_TOKEN ||
    process.env.PADDLEOCR_ACCESS_TOKEN ||
    process.env.PADDLE_OCR_TOKEN ||
    ''
  ).trim();
}

function paddleConfigured() {
  return !!paddleToken();
}

function getAliyunClient() {
  if (aliyunClient) return aliyunClient;
  if (!aliyunConfigured()) return null;
  const config = new OpenApi.Config({
    accessKeyId: process.env.ALIYUN_OCR_ACCESS_KEY_ID,
    accessKeySecret: process.env.ALIYUN_OCR_ACCESS_KEY_SECRET,
  });
  config.endpoint =
    process.env.ALIYUN_OCR_ENDPOINT || 'ocr-api.cn-hangzhou.aliyuncs.com';
  const Client = OcrApi.default || OcrApi;
  aliyunClient = new Client(config);
  return aliyunClient;
}

function getPaddleClient() {
  if (paddleClient) return paddleClient;
  const token = paddleToken();
  if (!token) return null;
  paddleClient = new PaddleOCRClient({
    token,
    timeout: Number(process.env.PADDLE_TIMEOUT_MS || 180000),
    requestTimeout: Number(process.env.PADDLE_REQUEST_TIMEOUT_MS || 60000),
    pollTimeout: Number(process.env.PADDLE_POLL_TIMEOUT_MS || 180000),
  });
  return paddleClient;
}

function normalizeTitleLine(l) {
  return String(l || '')
    .replace(/[|｜]/g, ' ')
    .replace(/[^\u4e00-\u9fffA-Za-z0-9\s·・\-:：'’"“”《》()（）]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 出版社 / 作者署名 / 营销副标题 —— 不当书名 */
function isNonTitleLine(t) {
  const s = String(t || '').trim();
  if (!s) return true;
  // 出版社
  if (
    /(出版|书局|书店|印务|印制|发行|传媒|文化传播|有限公司|股份公司)/.test(s) &&
    !/(自传|小说|故事|日记|手记)/.test(s)
  ) {
    return true;
  }
  if (/^(中信|人民|商务|三联|译林|机械工业|电子工业|清华|北大|广西师大|新星|理想国)/.test(s) && s.length <= 12) {
    if (/出版|集团|社$/.test(s)) return true;
  }
  // 作者行：…著 / …译 / [美]xxx
  if (/^[\[【\(（]?[美英日法德俄苏]?[\]】\)）]?.{0,12}(著|译|编著|主编|编)$/.test(s)) return true;
  if (/(著|译|编著|主编)$/.test(s) && s.length <= 12) return true;
  // 纯英文且像副标题/系列，且较短
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  if (cjk === 0) {
    if (/^(the|and|of|at|in|to|for|with)\b/i.test(s)) return true;
    if (/\b(dawn|discovery|exploration|curiosity|worlds?)\b/i.test(s) && s.length > 12) return true;
    if (s.length > 28) return true;
  }
  // 明显广告/说明句
  if (/(领域的|探索与发现|好奇[、,，]?探索)/.test(s)) return true;
  if (/^(定价|isbn|issn|cip)/i.test(s)) return true;
  return false;
}

function isGarbageTitle(t) {
  const s = String(t || '').trim();
  if (!s || s.length < 2) return true;
  if (s.length > 48) return true;
  if (/^[\d\s\-.:：/\\]+$/.test(s)) return true;
  if (/^(isbn|issn|定价|出版社|印刷|版权|cip|www\.|http|qr)/i.test(s)) return true;
  if (isNonTitleLine(s)) return true;
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  if (cjk === 0 && letters < 3) return true;
  if (cjk >= 2) {
    const junkLatin = (s.match(/(?:^|[^A-Za-z])[A-Za-z](?=[^A-Za-z]|$)/g) || []).length;
    if (junkLatin >= 3 && cjk < 8) return true;
  }
  if (/(.)\1{4,}/.test(s)) return true;
  if (s.split(/\s+/).filter((w) => w.length === 1).length >= 6) return true;
  return false;
}

function isNoiseTitle(t) {
  if (isGarbageTitle(t)) return true;
  if (t.length < 3 && !/[\u4e00-\u9fff]/.test(t)) return true;
  return false;
}

function scoreLine(s) {
  const t = String(s || '').trim();
  if (isNoiseTitle(t)) return 0;
  let score = Math.min(t.length, 36);
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  if (cjk >= 2) score += 18 + Math.min(cjk, 10);
  // 书名常见长度更优
  if (cjk >= 3 && cjk <= 12) score += 14;
  if (cjk >= 4 && cjk <= 8) score += 10;
  if (/[A-Za-z]{3,}/.test(t) && cjk === 0) score += 2;
  if (t.length >= 2 && t.length <= 24) score += 8;
  if (t.length > 30) score -= 8;
  if (/[《》]/.test(t)) score += 10;
  if (/(自传|小说|文集|选集|手记|日记|故事|传记|回忆录)$/.test(t)) score += 16;
  // 副标题/广告句降权
  if (/(领域的|探索与|出版集团|有限公司|著$|译$|编著)$/.test(t)) score -= 20;
  if (/^(the |and |of )/i.test(t) && cjk === 0) score -= 10;
  // 全英文降权（中文书脊优先中文主书名）
  if (cjk === 0 && t.length >= 4) score -= 8;
  return score;
}

/** 只保留像「书名」的候选，限制数量；best 取最高分 */
function pickTitleCandidates(lines, max = 6) {
  const scored = (lines || [])
    .map((text) => {
      const t = normalizeTitleLine(text).slice(0, 40);
      return { text: t, score: scoreLine(t) };
    })
    .filter((x) => x.score >= 28 && !isGarbageTitle(x.text))
    .sort((a, b) => b.score - a.score);

  const seen = new Set();
  const out = [];
  for (const x of scored) {
    const key = x.text.toLowerCase().replace(/\s+/g, '');
    if (seen.has(key)) continue;
    // 与已有候选高度重叠则跳过（避免「三体」「三体全集」并列为两脊）
    let near = false;
    for (const prev of out) {
      const pk = prev.toLowerCase().replace(/\s+/g, '');
      if (pk === key) {
        near = true;
        break;
      }
      if (pk.includes(key) || key.includes(pk)) {
        const ratio = Math.min(pk.length, key.length) / Math.max(pk.length, key.length);
        if (ratio >= 0.7) {
          near = true;
          break;
        }
      }
    }
    if (near) continue;
    seen.add(key);
    out.push(x.text);
    if (out.length >= max) break;
  }
  return out;
}

function extractSpineQueries(raw, max = MAX_SPINES) {
  const chunks = String(raw || '')
    .replace(/\r/g, '\n')
    .split(/[\n]+/)
    .map(normalizeTitleLine)
    .filter(Boolean);

  const lines = [];
  for (const c of chunks) {
    const parts = c.split(/\s{2,}|[、|／/]+/).map(normalizeTitleLine).filter(Boolean);
    if (parts.length > 1) lines.push(...parts);
    else lines.push(c);
  }

  const scored = lines
    .map((text) => ({ text: text.slice(0, 40), score: scoreLine(text) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const seen = new Set();
  const out = [];
  for (const { text } of scored) {
    const key = text.toLowerCase().replace(/\s+/g, '');
    if (seen.has(key)) continue;
    let subsumed = false;
    for (let i = 0; i < out.length; i++) {
      const prev = out[i];
      const pk = prev.toLowerCase().replace(/\s+/g, '');
      if (pk.includes(key) && pk.length >= key.length + 2) {
        subsumed = true;
        break;
      }
      if (key.includes(pk) && key.length >= pk.length + 2) {
        out[i] = text;
        seen.add(key);
        subsumed = true;
        break;
      }
    }
    if (subsumed) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  const order = new Map();
  lines.forEach((l, i) => {
    const k = l.toLowerCase().replace(/\s+/g, '');
    if (!order.has(k)) order.set(k, i);
  });
  out.sort(
    (a, b) =>
      (order.get(a.toLowerCase().replace(/\s+/g, '')) ?? 99) -
      (order.get(b.toLowerCase().replace(/\s+/g, '')) ?? 99)
  );
  return out.slice(0, max);
}

function wordBox(w) {
  let xs = [];
  let ys = [];
  if (Array.isArray(w.pos) && w.pos.length) {
    for (const p of w.pos) {
      if (p && p.x != null) xs.push(Number(p.x));
      if (p && p.y != null) ys.push(Number(p.y));
    }
  }
  if (w.left != null) {
    xs.push(Number(w.left), Number(w.left) + Number(w.width || 0));
    ys.push(Number(w.top), Number(w.top) + Number(w.height || 0));
  }
  if (!xs.length) return null;
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    minX,
    maxX,
    minY,
    maxY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY),
  };
}

function clusterWordsToSpines(words, max = MAX_SPINES) {
  const items = [];
  for (const w of words) {
    const text = normalizeTitleLine(w.word || w.text || '');
    if (!text || text.length > 20) continue;
    if (/^(isbn|定价|出版社)/i.test(text)) continue;
    const box = wordBox(w);
    if (!box) continue;
    items.push({ text, ...box });
  }
  if (items.length < 2) return [];

  const cxs = items.map((i) => i.cx).sort((a, b) => a - b);
  const spanX = cxs[cxs.length - 1] - cxs[0] || 1;
  const avgW = items.reduce((s, i) => s + i.w, 0) / items.length;
  const gapThresh = Math.max(avgW * 1.2, spanX * 0.06, 24);

  items.sort((a, b) => a.cx - b.cx || a.cy - b.cy);
  const clusters = [];
  let cur = [];
  let curCx = null;
  for (const it of items) {
    if (curCx == null || Math.abs(it.cx - curCx) <= gapThresh) {
      cur.push(it);
      curCx = cur.reduce((s, x) => s + x.cx, 0) / cur.length;
    } else {
      if (cur.length) clusters.push(cur);
      cur = [it];
      curCx = it.cx;
    }
  }
  if (cur.length) clusters.push(cur);
  if (clusters.length < 2) return [];

  const titles = [];
  const seen = new Set();
  for (const cl of clusters) {
    const sorted = [...cl].sort((a, b) => a.cy - b.cy || a.cx - b.cx);
    const allShort = sorted.every((x) => x.text.length <= 2);
    let title = allShort
      ? sorted.map((x) => x.text).join('')
      : sorted
          .map((x) => x.text)
          .join(sorted.some((x) => /[A-Za-z]/.test(x.text)) ? ' ' : '');
    title = normalizeTitleLine(title).slice(0, 40);
    if (isNoiseTitle(title) || scoreLine(title) < 15) continue;
    if (title.length > 28 && allShort) continue;
    const key = title.toLowerCase().replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push(title);
    if (titles.length >= max) break;
  }
  return titles;
}

function cleanOcrText(raw, words) {
  const full = String(raw || '').trim().slice(0, 4000);
  let spines = extractSpineQueries(full);

  if (spines.length < 2 && Array.isArray(words) && words.length >= 4) {
    const clustered = clusterWordsToSpines(words, MAX_SPINES);
    const good = clustered.filter((t) => scoreLine(t) >= 28);
    if (good.length > spines.length) spines = good;
  }

  // 强过滤出版社/署名/副标题，再按书名分取 top（默认最多 6 脊）
  spines = pickTitleCandidates(spines, 6);

  const best = spines[0] || '';
  // 检索 hint：仅主书名；不再把两本不同书拼成一条 query
  const combos = [];
  if (best) combos.push(best);

  return {
    raw: full,
    best: best || '',
    lines: spines.slice(),
    spines: spines.slice(),
    query: (best || '').slice(0, 80),
    spine_count: spines.length,
    search_hints: combos.slice(0, 1),
  };
}

function parseAliyunPayload(data) {
  let obj = data;
  if (data == null) return { text: '', words: [] };
  if (typeof data === 'string') {
    const s = data.trim();
    if (!s) return { text: '', words: [] };
    try {
      obj = JSON.parse(s);
    } catch (_) {
      return { text: s, words: [] };
    }
  }
  if (typeof obj !== 'object') return { text: String(obj || ''), words: [] };

  const words = [];
  const list =
    obj.prism_wordsInfo ||
    obj.wordsInfo ||
    (obj.Data && (obj.Data.prism_wordsInfo || obj.Data.wordsInfo)) ||
    [];
  if (Array.isArray(list)) {
    for (const w of list) {
      if (!w) continue;
      words.push({
        word: w.word || w.text || '',
        pos: w.pos || null,
        left: w.left,
        top: w.top,
        width: w.width,
        height: w.height,
      });
    }
  }

  let text = '';
  if (obj.content != null && String(obj.content).trim()) text = String(obj.content);
  else if (obj.Data && obj.Data.content) text = String(obj.Data.content);
  else if (words.length) text = wordsToPlainText(words);
  else if (obj.Data) return parseAliyunPayload(obj.Data);

  return { text, words };
}

function wordsToPlainText(words) {
  const items = [];
  for (const w of words) {
    const text = String(w.word || w.text || '').trim();
    if (!text) continue;
    const box = wordBox(w);
    items.push({
      text,
      cy: box ? box.cy : items.length * 10,
      cx: box ? box.cx : 0,
    });
  }
  if (!items.length) return '';
  items.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  const lines = [];
  let cur = [];
  let curY = null;
  const th = 18;
  for (const it of items) {
    if (curY == null || Math.abs(it.cy - curY) <= th) {
      cur.push(it);
      curY = cur.reduce((s, x) => s + x.cy, 0) / cur.length;
    } else {
      cur.sort((a, b) => a.cx - b.cx);
      lines.push(cur.map((x) => x.text).join(cur.every((x) => x.text.length <= 2) ? '' : ' '));
      cur = [it];
      curY = it.cy;
    }
  }
  if (cur.length) {
    cur.sort((a, b) => a.cx - b.cx);
    lines.push(cur.map((x) => x.text).join(cur.every((x) => x.text.length <= 2) ? '' : ' '));
  }
  return lines.join('\n');
}

function qualityScore(result) {
  if (!result) return -1;
  if (result.error && !(result.spines && result.spines.length)) return -1;
  let s = 0;
  s += (result.spine_count || (result.spines && result.spines.length) || 0) * 12;
  s += Math.min(Number(result.confidence) || 0, 100) * 0.3;
  if (result.best) s += scoreLine(result.best);
  if (result.engine && String(result.engine).startsWith('paddle')) s += 8;
  if (result.engine === 'aliyun') s += 5;
  return s;
}

function finalizeFromText(text, words, meta) {
  const cleaned = cleanOcrText(text, words || null);
  // soft_fallback 仅取最高分 1~2 条像书名的行，禁止把原文整页塞进 spines
  if (!cleaned.spines.length && text) {
    const fallback = pickTitleCandidates(
      String(text)
        .split(/\n+/)
        .map(normalizeTitleLine)
        .filter(Boolean),
      2
    );
    if (fallback.length) {
      cleaned.spines = fallback;
      cleaned.lines = fallback;
      cleaned.best = fallback[0];
      cleaned.query = fallback[0];
      cleaned.spine_count = fallback.length;
      cleaned.soft_fallback = true;
    }
  }
  return {
    ...cleaned,
    confidence: cleaned.spine_count ? meta.confidence || 90 : cleaned.query ? 70 : 0,
    engine: meta.engine,
    api: meta.api || meta.model || null,
    model: meta.model || null,
    requestId: meta.requestId || meta.jobId || null,
    word_count: (words && words.length) || cleaned.spine_count || 0,
    content_preview: String(text || '').replace(/\s+/g, ' ').slice(0, 200),
    attempts: meta.attempts,
  };
}

async function recognizeAliyunOnce(buf) {
  const client = getAliyunClient();
  if (!client) throw new Error('aliyun_not_configured');
  const api = String(process.env.ALIYUN_OCR_API || 'RecognizeGeneral').trim();
  const stream = Readable.from(buf);
  let resp;
  if (api === 'RecognizeAdvanced' && typeof client.recognizeAdvanced === 'function') {
    resp = await client.recognizeAdvanced(new OcrApi.RecognizeAdvancedRequest({ body: stream }));
  } else {
    resp = await client.recognizeGeneral(new OcrApi.RecognizeGeneralRequest({ body: stream }));
  }
  const body = resp && resp.body;
  if (!body) throw new Error('阿里 OCR 无响应');
  if (body.code && String(body.code) !== '200' && body.message) {
    throw new Error(body.message || `阿里 OCR 错误 ${body.code}`);
  }
  const parsed = parseAliyunPayload(body.data);
  return finalizeFromText(parsed.text, parsed.words, {
    engine: 'aliyun',
    api,
    requestId: body.requestId || null,
    confidence: 90,
  });
}

async function recognizeAliyun(buf) {
  const retries = Number(process.env.OCR_RETRY != null ? process.env.OCR_RETRY : 1);
  return withRetry(() => recognizeAliyunOnce(buf), {
    retries,
    delayMs: Number(process.env.OCR_RETRY_DELAY_MS || 900),
    label: 'aliyun',
    log: (step, d) => ocrLog(step === 'attempt_fail' ? 'warn' : 'info', `aliyun_${step}`, d),
  });
}

function parsePaddleResult(result, model) {
  const pages = (result && result.pages) || [];
  const texts = [];
  const words = [];
  for (const page of pages) {
    const pr = page && page.prunedResult;
    if (!pr) continue;
    const recTexts = pr.rec_texts || pr.recTexts || [];
    const recScores = pr.rec_scores || pr.recScores || [];
    const recBoxes = pr.rec_boxes || pr.recBoxes || pr.rec_polys || pr.dt_polys || [];
    for (let i = 0; i < recTexts.length; i++) {
      const t = String(recTexts[i] || '').trim();
      if (!t) continue;
      texts.push(t);
      const box = recBoxes[i];
      let left;
      let top;
      let width;
      let height;
      let pos;
      if (Array.isArray(box) && box.length >= 4 && typeof box[0] === 'number') {
        // [x1,y1,x2,y2]
        left = box[0];
        top = box[1];
        width = box[2] - box[0];
        height = box[3] - box[1];
      } else if (Array.isArray(box) && Array.isArray(box[0])) {
        pos = box.map((p) => ({ x: p[0], y: p[1] }));
      }
      words.push({
        word: t,
        score: recScores[i],
        left,
        top,
        width,
        height,
        pos,
      });
    }
  }
  const text = texts.join('\n');
  const avgScore =
    words.length && words.some((w) => w.score != null)
      ? words.reduce((s, w) => s + (Number(w.score) || 0), 0) / words.length
      : 0.9;
  return finalizeFromText(text, words, {
    engine: 'paddle',
    model,
    api: model,
    jobId: result && result.jobId,
    confidence: Math.round(avgScore * 100),
  });
}

async function recognizePaddleModel(buf, modelName) {
  const client = getPaddleClient();
  if (!client) throw new Error('paddle_not_configured');
  const model = modelName || Model.PPOCRv5;
  const tmp = path.join(
    os.tmpdir(),
    `spine-paddle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`
  );
  fs.writeFileSync(tmp, buf);
  const t0 = Date.now();
  ocrLog('info', 'paddle_begin', { model, bytes: buf.length });
  try {
    const result = await client.ocr({
      model,
      filePath: tmp,
      options: {
        useDocOrientationClassify: true,
        useDocUnwarping: false,
        useTextlineOrientation: true,
      },
    });
    const parsed = parsePaddleResult(result, model);
    ocrLog('info', 'paddle_done', {
      model,
      ms: Date.now() - t0,
      jobId: result && result.jobId,
      spines: parsed.spines,
      best: parsed.best,
      preview: parsed.content_preview,
    });
    return parsed;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
  }
}

async function recognizePaddle(buf, modelName) {
  const retries = Number(process.env.OCR_RETRY != null ? process.env.OCR_RETRY : 1);
  const model = modelName || process.env.PADDLE_OCR_MODEL || Model.PPOCRv5;
  return withRetry(() => recognizePaddleModel(buf, model), {
    retries,
    delayMs: Number(process.env.OCR_RETRY_DELAY_MS || 1000),
    label: `paddle:${model}`,
    log: (step, d) => ocrLog(step === 'attempt_fail' ? 'warn' : 'info', `paddle_${step}`, d),
  });
}

/** 可选多模型：PP-OCRv5 / PP-OCRv6 / VL */
function paddleModelsToTry(prefer) {
  const fromEnv = String(process.env.PADDLE_OCR_MODELS || '')
    .split(/[,|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromEnv.length) return fromEnv;

  if (prefer === 'paddle_v6' || prefer === 'pp-ocrv6') return [Model.PPOCRv6];
  if (prefer === 'paddle_v5' || prefer === 'pp-ocrv5') return [Model.PPOCRv5];
  if (prefer === 'paddle_vl' || prefer === 'paddleocr-vl') return [Model.PaddleOCRVL16];
  if (prefer === 'paddle' || prefer === 'auto' || prefer === 'compare') {
    // 默认先 v5（稳+快），再 v6；VL 较贵/慢，需显式 PADDLE_OCR_MODELS 才跑
    return [Model.PPOCRv5, Model.PPOCRv6];
  }
  return [Model.PPOCRv5];
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker(['chi_sim', 'eng'], 1, { logger: () => {} });
      await worker.setParameters({
        tessedit_pageseg_mode: '6',
        preserve_interword_spaces: '1',
      });
      return worker;
    })().catch((e) => {
      workerPromise = null;
      throw e;
    });
  }
  return workerPromise;
}

async function recognizeTesseract(buf) {
  const worker = await getWorker();
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '6' });
    const result = await worker.recognize(buf, { rotateAuto: true });
    const text = (result && result.data && result.data.text) || '';
    const conf = Number((result && result.data && result.data.confidence) || 0);
    const cleaned = cleanOcrText(text, null);
    const usable = cleaned.spines.filter((t) => scoreLine(t) >= 28);
    if (!usable.length || conf < 40) {
      return {
        raw: text.slice(0, 500),
        best: '',
        lines: [],
        spines: [],
        query: '',
        spine_count: 0,
        confidence: conf,
        engine: 'tesseract',
        error: conf < 40 ? 'tesseract_low_confidence' : 'tesseract_no_clean_title',
        content_preview: text.replace(/\s+/g, ' ').slice(0, 200),
      };
    }
    return {
      ...cleaned,
      spines: usable,
      lines: usable,
      best: usable[0],
      query: usable[0],
      spine_count: usable.length,
      confidence: conf,
      engine: 'tesseract',
      content_preview: text.replace(/\s+/g, ' ').slice(0, 200),
    };
  } catch (e) {
    return {
      raw: '',
      best: '',
      lines: [],
      spines: [],
      query: '',
      spine_count: 0,
      confidence: 0,
      engine: 'tesseract',
      error: e.message || String(e),
    };
  }
}

function emptyResult(error, engine) {
  return {
    raw: '',
    best: '',
    lines: [],
    spines: [],
    query: '',
    spine_count: 0,
    error,
    engine: engine || 'none',
  };
}

/**
 * OCR_ENGINE:
 *  auto | compare | paddle | paddle_v5 | paddle_v6 | paddle_vl | aliyun | tesseract
 * compare: 并行跑配置的 paddle 模型 + 阿里，选质量最高，并返回 engines[] 对比
 */
async function recognizeBuffer(buf) {
  if (!buf || !buf.length) return emptyResult('empty_image');

  const prefer = String(process.env.OCR_ENGINE || 'auto').toLowerCase();
  const compare = prefer === 'compare' || process.env.OCR_COMPARE === '1';
  const enginesTried = [];
  const errors = [];

  ocrLog('info', 'recognize_start', {
    prefer,
    compare,
    bytes: buf.length,
    paddle: paddleConfigured(),
    aliyun: aliyunConfigured(),
    retry: process.env.OCR_RETRY != null ? process.env.OCR_RETRY : 1,
  });

  async function tryPaddle() {
    if (!paddleConfigured()) {
      ocrLog('warn', 'paddle_skip', { reason: 'no_token' });
      return null;
    }
    const models = paddleModelsToTry(prefer);
    let best = null;
    for (const model of models) {
      try {
        const r = await recognizePaddle(buf, model);
        enginesTried.push({
          engine: 'paddle',
          model,
          ok: !!(r.spines && r.spines.length),
          best: r.best,
          spines: r.spines,
          score: qualityScore(r),
          jobId: r.requestId,
        });
        if (!best || qualityScore(r) > qualityScore(best)) best = r;
        // auto 下 v5 已够好则不再打 v6（省额度）；compare 全跑
        if (!compare && r.spines && r.spines.length >= 1 && qualityScore(r) >= 40) break;
      } catch (e) {
        ocrLog('error', 'paddle_fail', { model, error: e.message || String(e) });
        errors.push(`paddle:${model}:${e.message || e}`);
        enginesTried.push({ engine: 'paddle', model, ok: false, error: e.message || String(e) });
      }
    }
    return best;
  }

  async function tryAliyun() {
    if (!aliyunConfigured()) {
      ocrLog('warn', 'aliyun_skip', { reason: 'no_key' });
      return null;
    }
    try {
      const r = await recognizeAliyun(buf);
      enginesTried.push({
        engine: 'aliyun',
        api: r.api,
        ok: !!(r.spines && r.spines.length) || !!r.raw,
        best: r.best,
        spines: r.spines,
        score: qualityScore(r),
      });
      return r;
    } catch (e) {
      ocrLog('error', 'aliyun_fail', { error: e.message || String(e) });
      errors.push(`aliyun:${e.message || e}`);
      enginesTried.push({ engine: 'aliyun', ok: false, error: e.message || String(e) });
      return null;
    }
  }

  async function tryTess() {
    try {
      const r = await recognizeTesseract(buf);
      enginesTried.push({
        engine: 'tesseract',
        ok: !!(r.spines && r.spines.length),
        best: r.best,
        score: qualityScore(r),
        error: r.error,
      });
      return r;
    } catch (e) {
      errors.push(`tesseract:${e.message || e}`);
      return null;
    }
  }

  let chosen = null;

  if (prefer === 'tesseract') {
    chosen = await tryTess();
  } else if (prefer === 'aliyun') {
    chosen = await tryAliyun();
  } else if (prefer.startsWith('paddle')) {
    chosen = await tryPaddle();
  } else if (compare) {
    const [p, a] = await Promise.all([tryPaddle(), tryAliyun()]);
    const cands = [p, a].filter(Boolean);
    cands.sort((x, y) => qualityScore(y) - qualityScore(x));
    chosen = cands[0] || null;
  } else {
    // auto: paddle → aliyun → tesseract
    chosen = await tryPaddle();
    if (!chosen || (!(chosen.spines && chosen.spines.length) && !chosen.best)) {
      const a = await tryAliyun();
      if (a && qualityScore(a) > qualityScore(chosen)) chosen = a;
      else if (!chosen) chosen = a;
    }
    if (!chosen || (!(chosen.spines && chosen.spines.length) && !chosen.best)) {
      const t = await tryTess();
      if (t && qualityScore(t) > qualityScore(chosen)) chosen = t;
      else if (!chosen) chosen = t;
    }
  }

  if (!chosen) {
    ocrLog('error', 'recognize_fail', { errors });
    return { ...emptyResult(errors.join('; ') || 'ocr_failed'), engines: enginesTried };
  }

  chosen.engines = enginesTried;
  chosen.quality = qualityScore(chosen);
  ocrLog('info', 'recognize_pick', {
    engine: chosen.engine,
    model: chosen.model || chosen.api,
    best: chosen.best,
    spines: chosen.spines,
    quality: chosen.quality,
    engines: enginesTried.map((e) => ({
      engine: e.engine,
      model: e.model || e.api,
      ok: e.ok,
      score: e.score,
      best: e.best,
    })),
  });
  return chosen;
}

async function recognizeBase64(dataUrlOrB64) {
  let s = String(dataUrlOrB64 || '').trim();
  if (!s) throw new Error('缺少图片');
  if (s.includes(',')) s = s.split(',').pop();
  s = s.replace(/\s/g, '');
  const buf = Buffer.from(s, 'base64');
  if (buf.length < 200) throw new Error('图片过小');
  if (buf.length > 3.5 * 1024 * 1024) throw new Error('图片过大（请压缩后重试）');
  return recognizeBuffer(buf);
}

module.exports = {
  recognizeBase64,
  recognizeBuffer,
  cleanOcrText,
  extractSpineQueries,
  aliyunConfigured,
  paddleConfigured,
  MAX_SPINES,
  Model,
};
