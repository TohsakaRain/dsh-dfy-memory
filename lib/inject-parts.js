/**
 * lib/inject-parts.js —— 自注入的内容块
 * ============================================================================
 * 插件自己往 system prompt 里拼的几段，全部来自**插件自己的数据根**：
 *
 *   diary      今天日记写没写       <dataRoot>/diary/
 *   memory     长期记忆             <dataRoot>/memory/memory.json
 *   mood       心情 + 好感度        <dataRoot>/state/emotion.json
 *   promises   答应过的事           <dataRoot>/state/commitments.json
 *   time       时间感（星期/节假日） <dataRoot>/state/holidays.json
 *
 * 措辞对齐 QQ 桥接里那几段（同一批数据、同一套话说），这样切过来读起来没差别。
 *
 * ⚠️ 桥接的时间感还多一句「最新一条消息是多久以前发的」——那需要消息状态，
 *    属于宿主，不在插件里；这里只给「现在几点、星期几、是不是工作日」。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 可选的块（顺序 = 拼进提示词的顺序，跟桥接那边一致：日记 → 记忆 → 心情 → 承诺 → 时间感）。 */
export const SELF_INJECT_PARTS = Object.freeze(['diary', 'memory', 'mood', 'promises', 'time']);

/** 给设置页用的中文名。 */
export const PART_LABELS = Object.freeze({
  diary: '今天日记',
  memory: '长期记忆',
  mood: '心情 + 好感度',
  promises: '答应过的事',
  time: '时间感',
});

/** 归一化 parts：去重、只认已知名字、空 → 全开。 */
export function normalizeParts(input, fallback = SELF_INJECT_PARTS) {
  const list = (Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : [])
    .map((s) => String(s ?? '').trim())
    .filter(Boolean);
  if (!list.length) return [...fallback];
  const valid = [...new Set(list.filter((n) => SELF_INJECT_PARTS.includes(n)))];
  return valid.length ? valid : [...fallback];
}

/* ── 时间感（数据：<dataRoot>/state/holidays.json）────────────────────── */

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const pad2 = (n) => String(n).padStart(2, '0');

export function loadHolidays(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return { years: raw && typeof raw.years === 'object' ? raw.years : {}, ok: true };
  } catch {
    return { years: {}, ok: false };
  }
}

export function ymd(ms) {
  const d = new Date(Number(ms));
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function dayInfo(ms, table) {
  const d = new Date(Number(ms));
  const date = ymd(ms);
  const weekday = WEEK[d.getDay()];
  const year = table?.years?.[String(d.getFullYear())];
  if (!year) {
    const off = d.getDay() === 0 || d.getDay() === 6;
    return { date, weekday, kind: off ? 'weekend' : 'workday', label: '', off, knownYear: false };
  }
  const holiday = year.holidays?.[date];
  if (holiday) return { date, weekday, kind: 'holiday', label: holiday, off: true, knownYear: true };
  const makeup = year.workdays?.[date];
  if (makeup) return { date, weekday, kind: 'makeup', label: makeup, off: false, knownYear: true };
  const weekend = d.getDay() === 0 || d.getDay() === 6;
  return { date, weekday, kind: weekend ? 'weekend' : 'workday', label: '', off: weekend, knownYear: true };
}

export function statusText(info, { short = false } = {}) {
  switch (info?.kind) {
    case 'holiday': return short ? `${info.label}·假` : `${info.label}·放假`;
    case 'makeup': return short ? `${info.label}·班` : `${info.label}·调休上班`;
    case 'weekend': return '周末';
    default: return '工作日';
  }
}

export function formatNow(ms = Date.now(), table = null) {
  const d = new Date(Number(ms));
  const info = dayInfo(ms, table);
  return `${info.date} 星期${info.weekday} ${pad2(d.getHours())}:${pad2(d.getMinutes())}（${statusText(info)}）`;
}

export function timeLine(now = Date.now(), table = null) {
  return `【时间感】现在 ${formatNow(now, table)}`;
}

/* ── 今天日记 ─────────────────────────────────────────────────────── */

export function diaryLine(snap = {}) {
  const n = Number(snap?.todaySections) || 0;
  if (n > 0) return `【今天日记】已写 ${n} 段`;
  return snap?.lastDate ? `【今天日记】还没写（上次 ${snap.lastDate}）` : '【今天日记】还没写';
}

/* ── 答应过的事 ───────────────────────────────────────────────────── */

export function promisesLine(items, format, now = Date.now()) {
  if (!Array.isArray(items) || !items.length) return '';
  const txt = typeof format === 'function' ? format(items.slice(-3), { max: 3, now }) : '';
  if (!txt) return '';
  return `【你答应过的事】\n${txt}\n（兑现不勉强：不想做就 qq_promise_drop 丢掉，不用解释）`;
}

/* ── 拼装 ─────────────────────────────────────────────────────────── */

/**
 * 把选中的块拼成一段文本（顺序固定：日记 → 记忆 → 心情 → 承诺 → 时间感）。
 * 任何一块出错都跳过它，不影响别的块。
 *
 * @param {object} opts
 * @param {string[]} opts.parts        要哪些块（空 = 全开）
 * @param {number}   opts.now
 * @param {object}   opts.facade       插件的门面（memory/emotion/promises/diary）
 * @param {string}   opts.who          好感度用谁（一般是桥接 config 的 ownerQQ）
 * @param {string}   opts.holidaysFile <dataRoot>/state/holidays.json
 * @param {Function} [opts.log]
 */
export function composeSelfInject({ parts, now = Date.now(), facade, who = '', holidaysFile = '', log = () => {} } = {}) {
  const want = new Set(normalizeParts(parts));
  const segs = [];

  if (want.has('diary')) {
    try { const t = diaryLine(facade?.diary?.status?.(new Date(now))); if (t) segs.push(t); }
    catch (e) { log('[dfy-memory] 日记块跳过：' + (e?.message ?? e)); }
  }
  if (want.has('memory')) {
    try { const t = String(facade?.memory?.forPrompt?.() ?? '').trim(); if (t) segs.push(t); }
    catch (e) { log('[dfy-memory] 记忆块跳过：' + (e?.message ?? e)); }
  }
  if (want.has('mood')) {
    try {
      const t = String(facade?.emotion?.format?.({ who, now }) ?? '').trim();
      if (t) segs.push(t);
    } catch (e) { log('[dfy-memory] 心情块跳过：' + (e?.message ?? e)); }
  }
  if (want.has('promises')) {
    try {
      const items = (facade?.promises?.list?.() ?? []).filter((x) => x && x.text);
      const t = promisesLine(items, facade?.promises?.format?.bind(facade.promises), now);
      if (t) segs.push(t);
    } catch (e) { log('[dfy-memory] 承诺块跳过：' + (e?.message ?? e)); }
  }
  if (want.has('time')) {
    try {
      const table = holidaysFile ? loadHolidays(holidaysFile) : null;
      const t = timeLine(now, table);
      if (t) segs.push(t);
    } catch (e) { log('[dfy-memory] 时间感块跳过：' + (e?.message ?? e)); }
  }

  return segs.join('\n\n');
}
