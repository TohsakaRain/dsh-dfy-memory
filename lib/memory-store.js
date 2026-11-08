// memory-store.js —— 长期记忆的存储与遗忘曲线（海马体 → 皮层）
//
// 这是**唯一实现**：mcp-diary.js（她的工具）和 bridge.js（唤醒提示注入）都 import 它，
// 避免"工具里算一套分、提示词里算另一套分"这种漂移。
//
// 分层（对应她自己的感觉，而不是数据库术语）：
//   core      非常重要 —— 名字、身份、约定、承诺。永不淡忘，永不自动隐藏。
//   important 重要     —— 值得记住的经历和判断。半衰期 21 天（"两三周慢慢淡"）。
//   normal    普通     —— 日常琐事。半衰期 4 天（"几天就忘"）。
//
// 遗忘曲线：
//   分数 = 强度 × 2^(-Δt / 半衰期)，Δt 是距上次被"想起/更新"的天数。
//   · 被想起（memory_touch / 在对话里被回忆）→ 强度 +0.3，同时 Δt 归零 —— 这就是间隔重复：
//     反复被提起的事会越来越牢，没人提的事按自己的速度淡下去。
//   · 分数低于阈值只是**不再出现在提示词里**，条目本身永远留在 memory.json。
//   · core 不参与衰减。
//
// 写盘：临时文件 + rename（桥接和 MCP 是两个进程，避免读到写了一半的 JSON）。
import fs from 'node:fs';
import path from 'node:path';
import { appendArchive, archiveHint, searchArchive } from './archive.js';

export const TIERS = ['core', 'important', 'normal'];

export const DEFAULT_TUNING = Object.freeze({
  // 半衰期：只影响**排序**（谁优先占注入位）
  halfLifeDays: { core: Infinity, important: 21, normal: 7 },
  // 淡出阈值：只当兜底（生死交给 lifespanDays），几乎不触发
  fadeThreshold: 0.02,
  // 寿命：决定什么时候模糊 / 归档（每条自己的时钟）
  lifespanDays: { important: 21, normal: 7 },
  blurKeepDays: 14,        // important：模糊到 100 字后再活 14 天 → 一句话 25 字
  normalKeepDays: 7,       // normal：浓缩 25 字后再活 7 天 → 归档
  blurChars: { important: 100, normal: 25 },
  blurFinalChars: 25,
  mentionBonusMaxDays: 7,  // normal 被提到，每次 +1 天，最多 +7 天
  recallStrengthStep: 0.3, // 每次被想起加多少强度
  maxStrength: 3,
  maxEntries: 2000,
  maxTextChars: 300,
  maxTags: 6,
});

const STORE_FILE = 'memory.json';
const EXPORT_FILE = 'memory.md';
const DAY = 24 * 60 * 60 * 1000;

function pad(n) { return String(n).padStart(2, '0'); }
function ymd(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function tuningOf(cfg) {
  const t = cfg?.memory ?? {};
  const lc = cfg?.lifecycle ?? {};
  return {
    ...DEFAULT_TUNING,
    halfLifeDays: {
      core: Infinity,
      important: Number(t.halfLifeImportantDays) > 0 ? Number(t.halfLifeImportantDays) : DEFAULT_TUNING.halfLifeDays.important,
      normal: Number(t.halfLifeNormalDays) > 0 ? Number(t.halfLifeNormalDays) : DEFAULT_TUNING.halfLifeDays.normal,
    },
    lifespanDays: {
      important: Number(lc.lifespanImportantDays) > 0 ? Number(lc.lifespanImportantDays) : DEFAULT_TUNING.lifespanDays.important,
      normal: Number(lc.lifespanNormalDays) > 0 ? Number(lc.lifespanNormalDays) : DEFAULT_TUNING.lifespanDays.normal,
    },
    blurKeepDays: Number(lc.blurKeepDays) > 0 ? Number(lc.blurKeepDays) : DEFAULT_TUNING.blurKeepDays,
    normalKeepDays: Number(lc.normalKeepDays) > 0 ? Number(lc.normalKeepDays) : DEFAULT_TUNING.normalKeepDays,
    fadeThreshold: Number(t.fadeThreshold) > 0 ? Number(t.fadeThreshold) : DEFAULT_TUNING.fadeThreshold,
    maxEntries: Number(t.maxEntries) > 0 ? Number(t.maxEntries) : DEFAULT_TUNING.maxEntries,
    lifecycleEnabled: lc.enabled === false ? false : true,
  };
}

export function memoryDir(cfg) {
  return path.resolve(cfg?.memory?.dir || 'D:\\dfy\\memory');
}

/** 把 config.json 的 memory 段换算成打分参数（MCP 工具与桥接注入共用同一套）。 */
export function tuningFromCfg(cfg) {
  return tuningOf(cfg);
}

// ── 读写 ────────────────────────────────────────────────────────────────
function storePath(dir) { return path.join(dir, STORE_FILE); }

export function loadStore(dir) {
  try {
    const raw = fs.readFileSync(storePath(dir), 'utf8').replace(/^\uFEFF/, '');
    const doc = JSON.parse(raw);
    const entries = Array.isArray(doc?.entries) ? doc.entries : [];
    return { version: 1, entries: entries.filter((e) => e && typeof e.text === 'string' && e.text.trim()) };
  } catch {
    return { version: 1, entries: [] };
  }
}

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

export function saveStore(dir, store, tuning = DEFAULT_TUNING) {
  fs.mkdirSync(dir, { recursive: true });
  const entries = store.entries.slice(-tuning.maxEntries);
  atomicWrite(storePath(dir), `${JSON.stringify({ version: 1, updatedAt: Date.now(), entries }, null, 2)}\n`);
  try { atomicWrite(path.join(dir, EXPORT_FILE), renderMarkdown({ entries }, tuning)); } catch { /* 导出失败不影响主存储 */ }
}

// ── 打分 ────────────────────────────────────────────────────────────────
export function scoreEntry(entry, now = Date.now(), tuning = DEFAULT_TUNING) {
  const tier = TIERS.includes(entry?.tier) ? entry.tier : 'normal';
  const strength = Math.max(0.1, Number(entry?.strength) || 1);
  if (tier === 'core') return 10; // 永远排在最前，不衰减
  const lastTouch = Math.max(Number(entry?.lastRecalledAt) || 0, Number(entry?.updatedAt) || 0, Number(entry?.createdAt) || 0);
  const ageDays = Math.max(0, (now - lastTouch) / DAY);
  const halfLife = tuning.halfLifeDays[tier] ?? 4;
  return strength * Math.pow(2, -ageDays / halfLife);
}

/** 附上算好的分数与"多久没想起"，方便工具/提示词直接用。 */
export function decorate(entry, now = Date.now(), tuning = DEFAULT_TUNING) {
  const score = scoreEntry(entry, now, tuning);
  const lastTouch = Math.max(Number(entry?.lastRecalledAt) || 0, Number(entry?.updatedAt) || 0, Number(entry?.createdAt) || 0);
  return {
    ...entry,
    score: Math.round(score * 1000) / 1000,
    ageDays: Math.round(Math.max(0, (now - lastTouch) / DAY) * 10) / 10,
    faded: score < tuning.fadeThreshold,
  };
}

// ── 增删改查 ────────────────────────────────────────────────────────────
function nextId(entries) {
  const used = new Set(entries.map((e) => e?.id));
  for (let i = 0; i < 500; i += 1) {
    const id = `m_${Math.random().toString(36).slice(2, 8)}`;
    if (!used.has(id)) return id;
  }
  return `m_${Date.now().toString(36)}`;
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((t) => String(t ?? '').trim()).filter(Boolean))].slice(0, DEFAULT_TUNING.maxTags);
}

export function addMemory(dir, input = {}, tuning = DEFAULT_TUNING) {
  const store = loadStore(dir);
  const text = String(input.text ?? '').trim().slice(0, tuning.maxTextChars);
  if (!text) throw new Error('记忆内容是空的');
  const tier = TIERS.includes(input.tier) ? input.tier : 'normal';
  const now = Date.now();
  const dup = store.entries.find((e) => String(e.text).trim() === text);
  if (dup) {
    dup.tier = tier;
    dup.updatedAt = now;
    dup.tags = normalizeTags([...(dup.tags || []), ...(input.tags || [])]);
    if (input.quote) dup.quote = String(input.quote).trim().slice(0, 200);
    if (input.hook) dup.hook = String(input.hook).trim().slice(0, 80);
    if (Array.isArray(input.refs) && input.refs.length) dup.refs = input.refs.slice(0, 4).map((x) => String(x).slice(0, 40));
    if (input.who) dup.who = [...new Set([...(dup.who || []), String(input.who)])].slice(0, 5);
    saveStore(dir, store, tuning);
    return { entry: dup, duplicate: true };
  }
  const entry = {
    id: nextId(store.entries),
    text,
    tier,
    tags: normalizeTags(input.tags),
    who: input.who ? [String(input.who)].slice(0, 5) : [],
    source: String(input.source || 'chat').slice(0, 20),
    createdAt: now,
    updatedAt: now,
    lastRecalledAt: 0,
    recallCount: 0,
    strength: 1,
    blurStage: 0,
    mentionBonus: 0,
    // 2026-11-06：她提的三样（原话 / 出处 / 钩子）
    quote: String(input.quote ?? '').trim().slice(0, 200),
    refs: Array.isArray(input.refs) ? input.refs.slice(0, 4).map((x) => String(x).slice(0, 40)) : [],
    hook: String(input.hook ?? '').trim().slice(0, 80),
  };
  store.entries.push(entry);
  saveStore(dir, store, tuning);
  return { entry, duplicate: false };
}

/**
 * 取命中词附近的一小段原文，让人一眼看出"是在哪句里命中的"。
 * 命中点太靠后时就从后面切，保证片段里一定包含关键词。
 */
function makeSnippet(text, needles, radius = 26) {
  const s = String(text ?? '');
  const low = s.toLowerCase();
  let at = -1;
  for (const n of needles) {
    const i = low.indexOf(n);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return '';
  const start = Math.max(0, at - radius);
  const end = Math.min(s.length, at + radius + 20);
  return `${start > 0 ? '…' : ''}${s.slice(start, end).trim()}${end < s.length ? '…' : ''}`;
}

export function recallMemories(dir, opts = {}, tuning = DEFAULT_TUNING) {
  const now = Number(opts.now) || Date.now();
  let limit = Math.min(50, Math.max(1, Number(opts.limit) || 8));
  const store = loadStore(dir);
  let pool = store.entries;
  if (TIERS.includes(opts.tier)) pool = pool.filter((e) => (e.tier || 'normal') === opts.tier);

  const q = String(opts.query ?? '').trim().toLowerCase();
  const needles = q ? [...new Set(q.split(/\s+/).filter(Boolean))] : [];
  const hitMap = new Map();   // id → 命中的词
  let degraded = false;

  if (q) {
    // OR 匹配：命中任意一个词就进来（人的说法不会刚好凑齐词表）
    for (const e of pool) {
      const hay = `${e.text} ${(e.tags || []).join(' ')} ${(e.who || []).join(' ')}`.toLowerCase();
      const hit = needles.filter((n) => hay.includes(n));
      if (hit.length) hitMap.set(e.id, hit);
    }
    if (hitMap.size) {
      pool = pool.filter((e) => hitMap.has(e.id));
    } else {
      // 一个都没命中：不退化成"空"，改成按重要度+时间给几条，并标明是退化结果
      degraded = true;
      limit = Math.min(limit, 3);
    }
  }

  const scored = pool.map((e) => {
    const d = decorate(e, now, tuning);
    if (q && hitMap.has(e.id)) {
      const hit = hitMap.get(e.id);
      const ratio = hit.length / Math.max(1, needles.length);
      d.matched = hit;
      d.matchRatio = Math.round(ratio * 100) / 100;
      // 命中越多越靠前；但重要度/新鲜度仍然参与（乘以 0.4~1.4 的系数）
      d.score = Math.round(d.score * (0.4 + ratio) * 1000) / 1000;
      d.snippet = makeSnippet(e.text, hit);
    }
    if (degraded) d.degraded = true;
    return d;
  });

  const take = (arr) => arr.sort((a, b) => b.score - a.score).slice(0, limit);
  if (opts.includeFaded) {
    const active = take(scored);
    return withArchiveFallback(dir, active, opts, limit);
  }
  const visible = scored.filter((e) => !e.faded);
  const active = take(visible.length ? visible : scored);
  if (degraded && q) {
    // 退化出来的只是"按重要度凑几条"，不代表真命中；
    // 归档里可能有真正提到这件事的记录，得单独捞一次再接在后面。
    const arch = withArchiveFallback(dir, [], { ...opts, query: q }, limit);
    return [...arch, ...active].slice(0, Math.max(limit, 3));
  }
  return withArchiveFallback(dir, active, opts, limit);
}

/**
 * 归档兜底：活跃里命中太少（<2）且有 query 时，再去归档索引里捞。
 * 捞到的是索引行（只有 25 字摘要），标 archived:true，供她决定要不要 archive_get。
 */
function withArchiveFallback(dir, active, opts, limit) {
  const q = String(opts?.query ?? '').trim();
  if (opts?.includeArchived === false || !q) return active;
  if (active.length >= 2) return active;
  const rows = searchArchive(dir, { query: q, limit: Math.max(1, limit - active.length) });
  if (!rows.length) return active;
  const extra = rows.map((r) => ({
    id: r.id,
    text: r.s,
    tier: r.tier,
    tags: r.tags ?? [],
    createdAt: Date.parse(`${r.d}T00:00:00`) || 0,
    score: 0,
    ageDays: 0,
    faded: false,
    archived: true,
    recallCount: 0,
    strength: 0,
  }));
  return [...active, ...extra].slice(0, Math.max(limit, active.length + extra.length));
}

export function touchMemory(dir, id, tuning = DEFAULT_TUNING, delta = null) {
  const store = loadStore(dir);
  const entry = store.entries.find((e) => e.id === id);
  if (!entry) return null;
  const step = delta == null ? tuning.recallStrengthStep : Number(delta);
  entry.strength = Math.min(tuning.maxStrength, Math.max(0.1, (Number(entry.strength) || 1) + step));
  entry.lastRecalledAt = Date.now();
  entry.recallCount = (Number(entry.recallCount) || 0) + 1;
  // normal：每被提到一次，寿命 +1 天（上限见 mentionBonusMaxDays）
  if ((entry.tier || 'normal') === 'normal') {
    const cap = tuning.mentionBonusMaxDays * DAY;
    entry.mentionBonus = Math.min(cap, (Number(entry.mentionBonus) || 0) + DAY);
  }
  saveStore(dir, store, tuning);
  return entry;
}

export function updateMemory(dir, id, patch = {}, tuning = DEFAULT_TUNING) {
  const store = loadStore(dir);
  const entry = store.entries.find((e) => e.id === id);
  if (!entry) return null;
  if (typeof patch.text === 'string' && patch.text.trim()) entry.text = patch.text.trim().slice(0, tuning.maxTextChars);
  if (TIERS.includes(patch.tier)) entry.tier = patch.tier;
  if (Array.isArray(patch.tags)) entry.tags = normalizeTags(patch.tags);
  if (typeof patch.quote === 'string') entry.quote = patch.quote.trim().slice(0, 200);
  if (typeof patch.hook === 'string') entry.hook = patch.hook.trim().slice(0, 80);
  if (Array.isArray(patch.refs)) entry.refs = patch.refs.slice(0, 4).map((x) => String(x).slice(0, 40));
  entry.updatedAt = Date.now();
  saveStore(dir, store, tuning);
  return entry;
}

/** 淡忘（软删）。core 拒绝删除——那正是"永不删"的意思。 */
export function forgetMemory(dir, id, tuning = DEFAULT_TUNING) {
  const store = loadStore(dir);
  const idx = store.entries.findIndex((e) => e.id === id);
  if (idx < 0) return { ok: false, error: '没有这条记忆' };
  const entry = store.entries[idx];
  if ((entry.tier || 'normal') === 'core') {
    return { ok: false, error: '这是 core（非常重要）的记忆，不能删。要淡出请先降级成 important。' };
  }
  store.entries.splice(idx, 1);
  saveStore(dir, store, tuning);
  return { ok: true, removed: entry };
}

export function statsMemories(dir, tuning = DEFAULT_TUNING) {
  const store = loadStore(dir);
  const now = Date.now();
  const byTier = { core: 0, important: 0, normal: 0 };
  let oldest = null;
  for (const e of store.entries) {
    const tier = TIERS.includes(e.tier) ? e.tier : 'normal';
    byTier[tier] += 1;
    const d = decorate(e, now, tuning);
    if (d.faded && (!oldest || d.ageDays > oldest.ageDays)) oldest = { id: e.id, text: e.text.slice(0, 40), ageDays: d.ageDays };
  }
  const faded = store.entries.map((e) => decorate(e, now, tuning)).filter((e) => e.faded).length;
  return { total: store.entries.length, byTier, faded, mostForgotten: oldest, dir };
}

// ── 唤醒提示注入 ────────────────────────────────────────────────────────
//
// 只在有内容时返回字符串；调用方负责拼进 prompt。**只给事实，不给指令**
// （写成"你应该记得…"就变成任务了）。
/** 注入尾部的提示行：归档范围 + 对话窗口范围 + 检索顺序 */

/**
 * 还有哪些天没"重摘"（原始日志在、但没有 by=agent 的摘要），只算今天以前。
 * 2026-11-06：她改成"一次一个文件连着做"，所以这个列表要能被工具返回直接引用。
 */
export function pendingDigestDays(dir) {
  const root = path.dirname(path.resolve(dir));
  const rawDir = path.join(root, 'archive', 'chat-logs');
  const ctxDir = path.join(root, 'context');
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const today = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  let rawDays = [];
  try {
    rawDays = fs.readdirSync(rawDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).map((n) => n.slice(0, 10));
  } catch { return []; }
  const done = new Set();
  try {
    for (const n of fs.readdirSync(ctxDir).filter((x) => /^\d{4}-\d{2}-\d{2}\.s\.md$/.test(x))) {
      try {
        if (/by=agent/.test(fs.readFileSync(path.join(ctxDir, n), 'utf8').slice(0, 120))) done.add(n.slice(0, 10));
      } catch { /* 忽略 */ }
    }
  } catch { /* 忽略 */ }
  return rawDays.filter((d) => !done.has(d) && d < today).sort();
}

function buildHintLines(dir) {
  const out = [];
  try { const a = archiveHint(dir); if (a) out.push(a); } catch { /* 忽略 */ }
  try {
    const ctxDir = path.join(path.dirname(dir), 'context');
    const names = fs.readdirSync(ctxDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.(full|s)\.md$/.test(n));
    if (names.length) {
      const days = names.map((n) => n.slice(0, 10)).sort();
      const first = days[0];
      const last = days[days.length - 1];
      const range = first === last ? first : `${first.slice(5)}~${last.slice(5)}`;
      out.push(`（手上还有 ${range} 的对话窗口，越远越粗略。要翻用 dfy_context_list）`);
    }
  } catch { /* 忽略 */ }
  try {
    const rawDir = path.join(path.dirname(dir), 'archive', 'chat-logs');
    const ctxDir2 = path.join(path.dirname(dir), 'context');
    const rawDays = fs.readdirSync(rawDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).map((n) => n.slice(0, 10));
    const done = new Set();
    for (const n of fs.readdirSync(ctxDir2).filter((x) => /^\d{4}-\d{2}-\d{2}\.s\.md$/.test(x))) {
      try {
        if (/by=agent/.test(fs.readFileSync(path.join(ctxDir2, n), 'utf8').slice(0, 120))) done.add(n.slice(0, 10));
      } catch { /* 忽略 */ }
    }
    // 只算"今天以前"的日子（今天没过完，不算欠着）
    const todo = pendingDigestDays(dir);
    if (todo.length) {
      const shown = todo.length > 6 ? todo.slice(0, 6) : todo;
      const tail = todo.length > 6 ? " 等 " + todo.length + " 天" : "";
      out.push("（还没重摘：" + shown.map((d) => d.slice(5)).join("、") + tail + "——用 dfy_context_raw 读原文，写完用 dfy_context_summarize 存）");
    }

  } catch { /* 忽略 */ }
  out.push('（想不起旧事：先 dfy_memory_recall，再 dfy_context_get(日期)，最后 dfy_archive_search + dfy_archive_get）');
  return out;
}

export function recallForPrompt(cfg, now = Date.now()) {
  const tuning = tuningOf(cfg);
  const dir = memoryDir(cfg);
  const limit = Math.min(20, Math.max(0, Number(cfg?.memory?.injectLimit) || 8));
  if (!limit) return '';
  const maxChars = Math.min(2000, Math.max(200, Number(cfg?.memory?.injectMaxChars) || 600));
  const picked = recallMemories(dir, { limit, now }, tuning);
  const hints = buildHintLines(dir);
  if (!picked.length) return hints.length ? `【你记得的事】\n${hints.join('\n')}` : '';
  const lines = [];
  let used = 0;
  for (const e of picked) {
    const tag = (e.tags || [])[0] ? `${(e.tags || [])[0]}·` : '';
    const count = Number(e.recallCount) > 0 ? `〔想起 ${e.recallCount} 次〕` : '';
    // 2026-11-06（她提的）：有钩子就只用钩子——注入预算要给更多条，不是给更长的段落。
    // 正文留给 dfy_memory_recall 去展开，注入里不重复贴一遍。
    const body = e.hook ? e.hook : (e.text.length > 60 ? e.text.slice(0, 58) + '…' : e.text);
    const q = e.quote ? `（原话：${e.quote}）` : '';
    let line = `- [${ymd(e.createdAt || now)} ${tag}${e.tier}] ${body}${q}${count}`;
    if (line.length > 150) line = `${line.slice(0, 148)}…`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return hints.length ? `【你记得的事】\n${hints.join('\n')}` : '';
  let out = `【你记得的事】\n${lines.join('\n')}`;
  if (hints.length) out += `\n${hints.join('\n')}`;
  return out;
}

// ── 人类可读导出 ────────────────────────────────────────────────────────
export function renderMarkdown(store, tuning = DEFAULT_TUNING) {
  const now = Date.now();
  const byTier = { core: [], important: [], normal: [] };
  for (const e of store.entries) byTier[TIERS.includes(e.tier) ? e.tier : 'normal'].push(e);
  const label = { core: '永不淡忘（名字/身份/承诺/约定/大事）', important: '重要（有情绪有后续；21 天后开始模糊）', normal: '日常琐事（7 天后浓缩，再 7 天归档）' };
  const out = [`# 大肥鱼的长期记忆`, ``, `> 由 memory-store.js 生成，别手改（改 tools 那边）。共 ${store.entries.length} 条。`, ''];
  for (const tier of TIERS) {
    const list = byTier[tier].map((e) => decorate(e, now, tuning)).sort((a, b) => b.score - a.score);
    out.push(`## ${label[tier]}（${list.length}）`, '');
    for (const e of list) {
      const flags = `${e.faded ? ' · 快忘了' : ''}${Number(e.recallCount) ? ` · 想起${e.recallCount}次` : ''}`;
      out.push(`- \`${ymd(e.createdAt || now)}\` ${e.text}${flags}`);
    }
    if (!list.length) out.push('_（空）_');
    out.push('');
  }
  return out.join('\n');
}

// ── 生命周期：模糊化 / 归档 ─────────────────────────────────────────────
//
// 每一条**按自己的时钟**算（不是按层批处理）：
//
//   important   T+21 天 → 模糊到 ≤100 字 → T+35 天 → 一句话 ≤25 字 → 永久活跃
//   normal      T+7 天(+mentionBonus) → 浓缩 ≤25 字 → +7 天 → 归档（不删）
//   core        永不处理
//
// 计时起点 = 最后一次被提到/更新（lastRecalledAt / updatedAt / createdAt 取最大）。
export function lifecycleOf(entry, tuning = DEFAULT_TUNING, now = Date.now()) {
  const tier = TIERS.includes(entry?.tier) ? entry.tier : 'normal';
  const stage = Number(entry?.blurStage) || 0;
  if (tier === 'core') return { tier, stage: 0, due: false, keep: null };
  const DAY_MS = DAY;
  const lastTouch = Math.max(
    Number(entry?.lastRecalledAt) || 0,
    Number(entry?.updatedAt) || 0,
    Number(entry?.createdAt) || 0,
  );
  if (tier === 'important') {
    const blurAt = lastTouch + tuning.lifespanDays.important * DAY_MS;
    const finalAt = blurAt + tuning.blurKeepDays * DAY_MS;
    if (now >= finalAt) return { tier, stage: 2, due: stage < 2, keep: 'forever', nextAt: null };
    if (now >= blurAt) return { tier, stage: 1, due: stage < 1, keep: 'forever', nextAt: finalAt };
    return { tier, stage: 0, due: false, keep: 'forever', nextAt: blurAt };
  }
  // normal
  const bonus = Math.min(tuning.mentionBonusMaxDays * DAY_MS, Number(entry?.mentionBonus) || 0);
  const blurAt = lastTouch + tuning.lifespanDays.normal * DAY_MS + bonus;
  const archiveAt = blurAt + tuning.normalKeepDays * DAY_MS;
  if (now >= archiveAt) return { tier, stage: 2, due: true, keep: 'archive', nextAt: null };
  if (now >= blurAt) return { tier, stage: 1, due: stage < 1, keep: 'archive', nextAt: archiveAt };
  return { tier, stage: 0, due: false, keep: 'archive', nextAt: blurAt };
}

/** 机械模糊化：在句末/逗号处切，避免半句话。超过 2 倍长度才硬截。 */
export function blurText(text, maxChars) {
  const s = String(text ?? '').trim();
  const max = Math.max(8, Number(maxChars) || 25);
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const cut = Math.max(
    head.lastIndexOf('。'),
    head.lastIndexOf('；'),
    head.lastIndexOf('，'),
    head.lastIndexOf('、'),
    head.lastIndexOf(' '),
  );
  if (cut >= Math.floor(max * 0.5)) return `${head.slice(0, cut).trim()}…`;
  return `${head.trim()}…`;
}

/**
 * 维护一遍：把到期的条目模糊化 / 归档。
 * @returns {{blurred: Array, archived: Array, disabled?: boolean}}
 */
export function maintainMemories(dir, tuning = DEFAULT_TUNING, now = Date.now()) {
  if (tuning.lifecycleEnabled === false) return { blurred: [], archived: [], disabled: true };
  const store = loadStore(dir);
  const blurred = [];
  const archived = [];
  const keep = [];

  for (const entry of store.entries) {
    const lc = lifecycleOf(entry, tuning, now);
    if (lc.stage > (Number(entry.blurStage) || 0)) {
      const cap = lc.stage === 1 ? tuning.blurChars[entry.tier] ?? tuning.blurChars.normal : tuning.blurFinalChars;
      const before = String(entry.text ?? '');
      entry.textBefore = entry.textBefore || before;
      entry.text = blurText(before, cap);
      entry.blurStage = lc.stage;
      entry.blurredAt = now;
      blurred.push({ id: entry.id, tier: entry.tier, stage: lc.stage, chars: entry.text.length, text: entry.text });
    }
    // normal 走到 stage 2 → 归档（不是删除）
    if (lc.tier === 'normal' && lc.stage === 2 && lc.keep === 'archive') {
      const res = appendArchive(dir, entry, { reason: 'normal-expired', now, summary: entry.text });
      archived.push({ id: entry.id, archiveId: res.id, monthFile: res.monthFile });
      continue; // 从活跃里摘掉
    }
    keep.push(entry);
  }

  if (blurred.length || archived.length) {
    store.entries = keep;
    saveStore(dir, store, tuning);
  }
  return { blurred, archived };
}
