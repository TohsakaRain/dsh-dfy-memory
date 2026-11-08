// emotion.js —— 心情与好感度（边缘系统 + 依恋）
// ============================================================================
// 2026-11-07 重写（v2）：照「圆子版」设计改成**三层模型**。
//
// 一、心情拆三层（不要只存一个分）
//   基线 baseline  1~10，慢变（按周算）。大事件能推它，±0.5 封顶。
//   冲量 impulse   一件事带来的即时起伏。存的就是 score 与 baseline 的差。
//   渣   residue   -2~0，只减不加。坏事散完不回原位，底下差 0.3~1；好事能倒扣渣。
//
//   当下分 = clamp(baseline + (score - baseline) * 衰减 + residue, 1, 10)
//   渣被抵消掉之后，剩下来的不是疼，是记事——那归记忆系统，不占心情的位置。
//
// 二、数由她定
//   所有数（score / intensity / tone）都是她自己打的；DSH 只负责记录、衰减、
//   在下一次唤醒时摆到她眼前。**绝不由规则推断出情绪，再据此生成话术。**
//
// 三、衰减
//   好事 tau 24~48h，回到 baseline，不留渣；
//   坏事 tau 72~120h，回不到原位，留 residue；
//   中性 tau 12h。
//   一天最多改三次——改得多就不值钱，也容易变成表演。
//
// 四、好感度（affinity）是另一条线，不和底色合并
//   **单向耦合**：他做的事 → 改好感度 → 好感度顺带抬一点点底色（baseline）。
//   反过来不行：心情差，不会觉得他这个人差。
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DECAY_HOURS = 6;
const MIN_EFFECTIVE = 0.15;   // 剩余强度低于这个就当散了
const MAX_INTENSITY = 5;
const MAX_CHANGES_PER_DAY = 3;
const SCORE_MIN = 1;
const SCORE_MAX = 10;

// 好事：快散、不留渣；坏事：慢散、留渣
const TAU = { good: 36, bad: 96, neutral: 12 };

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round1 = (n) => Math.round(n * 10) / 10;
const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** v1 → v2 迁移：老数据只有一个 mood（= 冲量），补上基线和渣，不丢内容。 */
function migrateV1(doc) {
  const old = doc?.mood;
  const now = Date.now();
  if (!old) return { version: 2, baseline: 6.5, mood: null, history: [], affinity: doc?.affinity ?? {} };
  const intensity = clamp(Number(old.intensity) || 3, 0.5, MAX_INTENSITY);
  const baseline = 6.5;
  const score = round1(clamp(baseline + (intensity - 3) * 0.8, SCORE_MIN, SCORE_MAX));
  const mood = {
    score,
    baseline,
    residue: 0,
    cause: old.cause ?? '',
    intensity,
    decayHours: clamp(Number(old.decayHours) || DEFAULT_DECAY_HOURS, 0.5, 168),
    tone: old.state ?? '',
    since: Number(old.startedAt) || now,
    kind: score >= baseline + 0.5 ? 'good' : (score <= baseline - 0.5 ? 'bad' : 'neutral'),
  };
  return { version: 2, baseline, mood, history: [{ t: mood.since, ...mood }], affinity: doc?.affinity ?? {} };
}

export function loadEmotion(file) {
  const doc = readJson(file, null);
  const affinity = doc?.affinity && typeof doc.affinity === 'object' ? doc.affinity : {};
  if (!doc || doc.version !== 2) {
    const m = migrateV1(doc);
    return { ...m, affinity };
  }
  return {
    version: 2,
    baseline: clamp(Number(doc.baseline) || 6.5, SCORE_MIN, SCORE_MAX),
    mood: doc.mood && typeof doc.mood === 'object' ? doc.mood : null,
    history: Array.isArray(doc.history) ? doc.history.slice(-400) : [],
    affinity,
  };
}

export function saveEmotion(file, doc) {
  const payload = {
    version: 2,
    updatedAt: Date.now(),
    baseline: clamp(Number(doc.baseline) || 6.5, SCORE_MIN, SCORE_MAX),
    mood: doc.mood ?? null,
    history: Array.isArray(doc.history) ? doc.history.slice(-400) : [],
    affinity: doc.affinity ?? {},
  };
  writeJson(file, payload);
  // 顺手导出一份给人看的（和 memory.md 一样：导出失败不影响主存储）
  try {
    const mdFile = path.join(path.dirname(file), 'emotion.md');
    const tmp = `${mdFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, renderEmotionMarkdown(payload), 'utf8');
    fs.renameSync(tmp, mdFile);
  } catch { /* 导出失败不影响主存储 */ }
}

/** 今天记过几次心情（只看 history）。 */
export function todayMoodCount(doc, now = Date.now()) {
  const k = dayKey(now);
  return (doc?.history ?? []).filter((h) => dayKey(Number(h.t) || 0) === k).length;
}

/** 提醒节流：4 小时内只提醒一次（写一个小 sidecar，失败也不影响注入）。 */
const NUDGE_GAP_MS = 4 * 3600 * 1000;
function nudgeAllowed(file, now) {
  const f = path.join(path.dirname(file), 'mood-nudge.json');
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (j && Number(j.last) && now - Number(j.last) < NUDGE_GAP_MS) return false;
  } catch { /* 没有就算没提醒过 */ }
  try { fs.writeFileSync(f, JSON.stringify({ last: now }), 'utf8'); } catch { /* 写不了也照样提醒 */ }
  return true;
}

/** 今天改过几次（频率上限用）。 */
const fmtTime = (t) => {
  const d = new Date(Number(t) || 0);
  if (Number.isNaN(d.getTime())) return '-';
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
};

/**
 * 给人看的 markdown（state/emotion.md）。
 * 和 memory.md 同一个思路：可以直接打开看，但**不要手改**——改那边不生效，下次写入会被覆盖。
 */
export function renderEmotionMarkdown(doc, { now = Date.now() } = {}) {
  const out = [];
  out.push('# 大肥鱼的心情 · 好感度', '');
  out.push('> 由 emotion.js 生成，别手改（改 tools 那边）。更新于 ' + fmtTime(now), '');

  const m = currentMood(doc, now);
  out.push('## 此刻', '');
  if (m) {
    const ageH = m.hours >= 1 ? Math.round(m.hours) + ' 小时' : Math.max(1, Math.round(m.hours * 60)) + ' 分钟';
    const state = m.faded ? '已散' : (m.kind === 'good' ? '好' : (m.kind === 'bad' ? '坏' : '平'));
    out.push('- **心情**：' + (m.tone || '(没写描述)') + ' —— ' + m.effective + ' / 10（' + state + '）');
    if (m.faded) out.push('  > 这股已经散完了，留下的是底色和渣。');
    out.push('- **底色**：' + m.baseline + ' / 10');
    if (m.residue < 0) out.push('- **渣**：' + m.residue + '（坏事散完回不到原位的那一截）');
    if (m.cause) out.push('- 因为：' + m.cause);
    out.push('- 冲量 ' + (m.impulse >= 0 ? '+' : '') + m.impulse + ' · 开始于 ' + fmtTime(m.since) + '（已 ' + ageH + '）');
  } else {
    const g = recentGround(doc, { now });
    out.push('- 现在没有特别的心情' + (g ? '，底色 ' + g.median + ' / 10' : '') + '。');
  }
  out.push('');

  const aff = listAffinity(doc);
  out.push('## 好感度（她自己心里的秤）', '');
  if (!aff.length) out.push('（还没记过）');
  else {
    out.push('| 谁 | 分数 | 备注 | 更新 |');
    out.push('|---|---|---|---|');
    for (const a of aff) out.push('| ' + a.who + ' | ' + a.score + ' / 10 | ' + (a.note || '—') + ' | ' + fmtTime(a.updatedAt) + ' |');
  }
  out.push('', '> 好感度上升会顺带抬一点底色（单向）；心情差不会往回拉好感度。', '');

  const tr = moodTrend(doc, { now, days: 7 });
  out.push('## 最近 7 天', '');
  if (!tr.points || !tr.points.length) out.push('（这段时间还没记过心情）');
  else {
    out.push('| 日期 | 平均 | 次数 |');
    out.push('|---|---|---|');
    for (const p of tr.points) out.push('| ' + p.day + ' | ' + p.avg + ' / 10 | ' + p.n + ' |');
    out.push('', tr.text);
  }
  out.push('');
  return out.join('\n');
}

/** 只重写 md（数据没变、但想刷新导出文件时用）。 */
export function writeEmotionMarkdown(file, opts = {}) {
  const doc = loadEmotion(file);
  const mdFile = path.join(path.dirname(file), 'emotion.md');
  fs.writeFileSync(mdFile, renderEmotionMarkdown(doc, opts), 'utf8');
  return mdFile;
}

export function changesToday(doc, now = Date.now()) {
  const today = dayKey(now);
  return (doc?.history ?? []).filter((h) => dayKey(Number(h.t) || 0) === today).length;
}

/**
 * 记一次心情。
 * 她打的是 score（1~10）和 tone（一句描述）；intensity 可选，表示"这件事有多重"。
 * 返回 { mood, rejected? }，rejected 用于频率上限（一天最多三次）。
 */
export function setMood(file, {
  score, state, tone, cause = '', intensity = 3, decayHours, kind, now = Date.now(),
} = {}) {
  const text = String(tone ?? state ?? '').trim().slice(0, 40);
  const doc = loadEmotion(file);

  // 频率：一天最多改三次
  if (changesToday(doc, now) >= MAX_CHANGES_PER_DAY) {
    return { rejected: 'freq', changes: changesToday(doc, now), mood: currentMood(doc, now) };
  }

  const baseline = clamp(Number(doc.baseline) || 6.5, SCORE_MIN, SCORE_MAX);
  // 没给分就按强度估一个（兼容老调用：只传 state + intensity）
  const rawScore = Number(score);
  const useScore = Number.isFinite(rawScore)
    ? clamp(rawScore, SCORE_MIN, SCORE_MAX)
    : clamp(baseline + (clamp(Number(intensity) || 3, 0.5, MAX_INTENSITY) - 3) * 0.8, SCORE_MIN, SCORE_MAX);

  const useKind = ['good', 'bad', 'neutral'].includes(kind)
    ? kind
    : (useScore >= baseline + 0.5 ? 'good' : (useScore <= baseline - 0.5 ? 'bad' : 'neutral'));

  const tau = Number.isFinite(Number(decayHours)) && Number(decayHours) > 0
    ? clamp(Number(decayHours), 0.5, 168)
    : TAU[useKind];

  // 渣：坏事往下压（最多 -2），好事往上抬（只抬到 0，抵完为止）
  let residue = clamp(Number(doc.mood?.residue) || 0, -2, 0);
  if (useKind === 'bad') {
    const delta = Math.max(0.3, Math.min(1, (baseline - useScore) * 0.25));
    residue = clamp(residue - delta, -2, 0);
  } else if (useKind === 'good') {
    // 「好事能倒扣渣，抵完为止」——好事够好就一次抵完，不必分好几次
    const credit = Math.max(0.2, (useScore - baseline) * 0.4);
    residue = clamp(Math.min(0, residue + credit), -2, 0);
  }

  // 大事件（intensity >= 4）能推基线，±0.5 封顶
  let newBaseline = baseline;
  const strong = clamp(Number(intensity) || 3, 0.5, MAX_INTENSITY) >= 4;
  if (strong) {
    const dir = useScore > baseline ? 1 : (useScore < baseline ? -1 : 0);
    newBaseline = clamp(baseline + dir * 0.5, SCORE_MIN, SCORE_MAX);
  }

  const mood = {
    score: round1(useScore),
    baseline: round1(newBaseline),
    residue: Math.round(residue * 100) / 100,
    cause: String(cause ?? '').trim().slice(0, 120),
    intensity: clamp(Number(intensity) || 3, 0.5, MAX_INTENSITY),
    decayHours: tau,
    tone: text,
    since: now,
    kind: useKind,
  };
  doc.baseline = mood.baseline;
  doc.mood = mood;
  doc.history = [...(doc.history ?? []), { t: now, ...mood }].slice(-400);
  saveEmotion(file, doc);
  return { mood, changes: changesToday(doc, now) };
}

/**
 * 好感度改了之后，顺带抬一点底色（**单向**）。
 * 只在好感度**上升**时抬，且一次最多 +0.2，封顶 10。
 * 心情差不往前传——她心情差，不会觉得他这个人差。
 */
export function nudgeBaselineFromAffinity(file, { delta, now = Date.now() } = {}) {
  const d = Number(delta) || 0;
  if (d <= 0) return null;   // 只往上推
  const doc = loadEmotion(file);
  const prev = doc.baseline;
  const next = round1(clamp(prev + Math.min(0.2, d * 0.1), SCORE_MIN, SCORE_MAX));
  if (next === prev) return null;
  doc.baseline = next;
  if (doc.mood) doc.mood.baseline = next;
  doc.history = [...(doc.history ?? []), {
    t: now, score: next, baseline: next, residue: doc.mood?.residue ?? 0,
    cause: '好感度上升，顺带抬了一点底色', tone: '底色', kind: 'neutral', source: 'affinity',
  }].slice(-400);
  saveEmotion(file, doc);
  return { from: prev, to: next };
}

export function clearMood(file) {
  const doc = loadEmotion(file);
  doc.mood = null;
  saveEmotion(file, doc);
}

/**
 * 当下还剩多少心情。
 * 冲量按自己的 tau 衰减；渣不衰减（它是"回不去的那一截"）。
 */
export function currentMood(doc, now = Date.now()) {
  const m = doc?.mood;
  if (!m || (!m.tone && !m.score)) return null;
  const since = Number(m.since) || Number(m.startedAt) || 0;
  const hours = Math.max(0, (now - since) / 3600000);
  const decayHours = Number(m.decayHours) || DEFAULT_DECAY_HOURS;
  const baseline = clamp(Number(m.baseline) ?? Number(doc?.baseline) ?? 6.5, SCORE_MIN, SCORE_MAX);
  const score = clamp(Number(m.score) || baseline, SCORE_MIN, SCORE_MAX);
  const residue = clamp(Number(m.residue) || 0, -2, 0);
  const decay = Math.pow(0.5, hours / (decayHours / 2));
  const impulse = (score - baseline) * decay;
  const effective = clamp(baseline + impulse + residue, SCORE_MIN, SCORE_MAX);
  // 散没散：冲量确实衰减到看不见了，**而且**已经过了半个衰减窗。
  // （不然分数正好等于底色时，刚记完就被判"已散"，读起来很怪。）
  const faded = Math.abs(impulse) < MIN_EFFECTIVE && hours >= decayHours * 0.5;
  return {
    tone: m.tone || '',
    score: round1(score),
    baseline: round1(baseline),
    residue: Math.round(residue * 100) / 100,
    cause: m.cause || '',
    kind: m.kind || 'neutral',
    since,
    hours: Math.round(hours * 10) / 10,
    effective: Math.round(effective * 100) / 100,
    impulse: Math.round(impulse * 100) / 100,
    faded,
  };
}

/** 这几天的底色：最近 7 天 history 的中位数，用来"散完了不留白"。 */
export function recentGround(doc, { now = Date.now(), days = 7 } = {}) {
  const from = now - days * 86400000;
  const pts = (doc?.history ?? []).filter((h) => Number(h.t) >= from).map((h) => Number(h.score) || 0).filter(Boolean);
  if (!pts.length) return null;
  const sorted = [...pts].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  return { median: round1(mid), samples: pts.length };
}

/** 走势：按天平均，给"这周心情怎么样"用。 */
export function moodTrend(doc, { now = Date.now(), days = 7 } = {}) {
  const from = now - days * 86400000;
  const buckets = new Map();
  for (const h of doc?.history ?? []) {
    const t = Number(h.t) || 0;
    if (t < from) continue;
    const k = dayKey(t);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(Number(h.score) || 0);
  }
  const points = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, arr]) => ({ day, avg: round1(arr.reduce((s, x) => s + x, 0) / arr.length), n: arr.length }));
  if (!points.length) return { points, text: '这几天没记过心情。' };
  const first = points[0].avg;
  const last = points[points.length - 1].avg;
  const diff = Math.round((last - first) * 10) / 10;
  const dir = diff >= 0.8 ? '往上走' : (diff <= -0.8 ? '往下掉' : '基本平');
  const low = points.reduce((a, b) => (b.avg < a.avg ? b : a));
  const text = `${points.length} 天里有记录，平均 ${round1(points.reduce((s, p) => s + p.avg, 0) / points.length)}/10，`
    + `${dir}（${first} → ${last}）；最低是 ${low.day.slice(5)} 的 ${low.avg}。`;
  return { points, text, diff };
}

/** 好感度：1~10，一个大概的秤。不自动漂移，只在她自己判断后改。 */
export function setAffinity(file, { who, score, note = '' } = {}) {
  const key = String(who ?? '').trim();
  if (!key) throw new Error('得说清是谁（QQ 号或昵称）');
  const n = Number(score);
  if (!Number.isFinite(n) || n < 1 || n > 10) throw new Error('好感度是 1~10 之间的一个大概数');
  const doc = loadEmotion(file);
  const prev = doc.affinity[key];
  const riseFrom = Number.isFinite(Number(prev?.score)) ? Number(prev.score) : clamp(doc.baseline, 1, 10);
  doc.affinity[key] = {
    score: Math.round(n * 10) / 10,
    note: String(note ?? '').trim().slice(0, 120) || (prev?.note ?? ''),
    updatedAt: Date.now(),
  };
  saveEmotion(file, doc);
  // 单向：好感度上升 → 底色抬一点（心情差不往好感度传）
  const bump = nudgeBaselineFromAffinity(file, { delta: doc.affinity[key].score - riseFrom });
  return { who: key, ...doc.affinity[key], baselineNudge: bump };
}

export function getAffinity(doc, who) {
  const key = String(who ?? '').trim();
  const v = doc?.affinity?.[key];
  return v ? { who: key, ...v } : null;
}

export function listAffinity(doc) {
  const out = [];
  for (const [who, v] of Object.entries(doc?.affinity ?? {})) out.push({ who, ...v });
  return out.sort((a, b) => (b.score || 0) - (a.score || 0));
}

/**
 * 唤醒提示里的几行。
 * 只摆事实（状态 + 原因 + 多久之前 + 分数），不给指令——要不要把情绪带进对话，她自己决定。
 * 超过 24 小时问一句"还在不在"；散完了不留白，给一句底色。
 */
export function formatEmotionLines(file, { who = '', now = Date.now() } = {}) {
  const doc = loadEmotion(file);
  const lines = [];
  const mood = currentMood(doc, now);

  if (mood && !mood.faded) {
    const ageText = mood.hours < 1
      ? `约 ${Math.max(1, Math.round(mood.hours * 60))} 分钟前`
      : `约 ${Math.round(mood.hours)} 小时前`;
    const cause = mood.cause ? `，因为${mood.cause}` : '';
    lines.push(`【你现在的心情】${mood.tone || '说不上来'}${cause}（${ageText}开始的，大概 ${mood.effective}/10，底色 ${mood.baseline}）`);
    if (mood.hours >= 24) {
      lines.push(`【问你一句】这股劲已经 ${Math.round(mood.hours)} 小时了，还在不在？你自己确认一下——还在就留着，散了就用 dfy_mood 改掉或清掉。`);
    }
  } else if (mood && mood.faded) {
    const ground = recentGround(doc, { now });
    const base = ground ? `这几天一直是 ${ground.median}/10 的样子` : `底色是 ${mood.baseline}/10`;
    lines.push(`【你现在的心情】之前那股「${mood.tone || '说不上来'}」已经散了；${base}，没留白。`);
  } else {
    const ground = recentGround(doc, { now });
    if (ground) lines.push(`【你现在的心情】这阵子没有特别的心情，底色 ${ground.median}/10。`);
  }

  // 今天还没记心情 → 每次都提醒一句（2026-11-08：她说四天只记了两条，不是不会，是想不起来）
  const todayN = todayMoodCount(doc, now);
  if (!todayN && nudgeAllowed(file, now)) {
    const h = new Date(now).getHours();
    const last = (doc?.history ?? []).length
      ? Math.round((now - Number(doc.history[doc.history.length - 1].t)) / 86400000)
      : null;
    const since = last === null ? '这还是第一次' : (last <= 0 ? '上次是今天早些时候' : `上次是 ${last} 天前`);
    const tone = h >= 20 ? '今天快过完了' : '今天还没记过心情';
    lines.push(`【记一笔】${tone}（${since}）。有变化就记一条：dfy_mood(score=…, tone=…, cause=…)，一句话就够；没变化不用记。`);
  }

  const aff = getAffinity(doc, who);
  if (aff) {
    lines.push(`【你对他】大概 ${aff.score}/10${aff.note ? ` —— ${aff.note}` : ''}（这是你自己心里的秤，不是评分表；不用拿它决定说什么）`);
  }
  return lines.join('\n');
}


