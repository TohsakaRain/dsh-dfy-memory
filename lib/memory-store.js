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
import os from 'node:os';
import { appendArchive, archiveHint, searchArchive } from './archive.js';
import { listDayFiles } from './day-paths.js';
// 只取「路径 → 算草稿/归档/当前稿」这一条判定（works.js 不 import 本文件，没有循环）
import { rowKind } from './works.js';

export const TIERS = ['core', 'important', 'normal'];

export const DEFAULT_TUNING = Object.freeze({
  // 半衰期：只影响**排序**（谁优先占注入位）
  // ⚠️ 2026-11-22：important 14 天 / normal 7 天（配置里两个天数各管排序/寿命/第二段间隔）。
  // 这里只是**最后兜底**——真正的值是 config.json 的 memory.* / lifecycle.*，
  // 由 lib/tuning.js 读出来传进去。两边保持一致，免得"没传参数"时跟界面对不上。
  halfLifeDays: { core: Infinity, important: 14, normal: 7 },
  // 淡出阈值：只当兜底（生死交给 lifespanDays），几乎不触发
  fadeThreshold: 0.02,
  // 寿命：决定什么时候模糊 / 归档（每条自己的时钟）
  lifespanDays: { important: 14, normal: 7 },
  // ⚠️ 2026-11-27：模糊不再按"砍到 N 字"来做（blurChars / blurFinalChars 已删除），
  //    而是整条换成**一句事实**（hook）。这两个天数现在只管"什么时候开始不清楚"：
  //      important: 到 blurKeepDays 后停在一句话上，永久活跃（不归档）
  //      normal:    到 normalKeepDays 后归档
  blurKeepDays: 14,        // important：模糊之后再过 14 天 → 阶段 2（正文已经是 hook，不再变短）
  normalKeepDays: 7,       // normal：模糊之后再过 7 天 → 归档
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
  const raw = cfg?.memory?.dir || cfg?.memoryDir || cfg?.paths?.memoryDir || '';
  if (raw) return path.resolve(raw);
  // 兜底跟 resolvePaths 的默认保持一致；**不要写死某台机器的路径**
  // （以前写死 D:\dfy\memory：换机器/没传 cfg 时会静默读空库，只剩一行提示）
  return path.join(os.homedir(), '.dsh', 'dsh-dfy-memory', 'memory');
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

/**
 * 「最后一次被碰」= 什么时候该重新计时。
 *
 * ⚠️ 2026-11-22：**不再看 updatedAt**。
 * `updatedAt` 会被任何一次写盘顺手改掉 —— 脚本批量补钩子、改标签、跑一次维护……
 * 全都在"续命"，而她根本没想起来过。实测她 28 条 important 里有 14 条被这样续过
 * （10 月写下的记忆显示只老了 6.5 天，"还有 7 天就模糊"）。
 * 现在只认三件事：
 *   · lastRecalledAt —— 真的被想起来（dfy_memory_touch / dfy_memory_recall 查到）
 *   · revisedAt     —— 她真的重写过正文（updateMemory 改 text 时才写这个字段）
 *   · createdAt     —— 写下那天
 * 这样"整理数据"不会再偷偷延长任何一条记忆的寿命。
 */
function lastTouchOf(entry) {
  return Math.max(
    Number(entry?.lastRecalledAt) || 0,
    Number(entry?.revisedAt) || 0,
    Number(entry?.createdAt) || 0,
  );
}

// ── 打分 ────────────────────────────────────────────────────────────────
export function scoreEntry(entry, now = Date.now(), tuning = DEFAULT_TUNING) {
  const tier = TIERS.includes(entry?.tier) ? entry.tier : 'normal';
  const strength = Math.max(0.1, Number(entry?.strength) || 1);
  if (tier === 'core') return 10; // 永远排在最前，不衰减
  const lastTouch = lastTouchOf(entry);
  const ageDays = Math.max(0, (now - lastTouch) / DAY);
  const halfLife = tuning.halfLifeDays[tier] ?? 4;
  return strength * Math.pow(2, -ageDays / halfLife);
}

/** 附上算好的分数与"多久没想起"，方便工具/提示词直接用。 */
export function decorate(entry, now = Date.now(), tuning = DEFAULT_TUNING) {
  const score = scoreEntry(entry, now, tuning);
  const lastTouch = lastTouchOf(entry);
  return {
    ...entry,
    score: Math.round(score * 1000) / 1000,
    ageDays: Math.round(Math.max(0, (now - lastTouch) / DAY) * 10) / 10,
    faded: score < tuning.fadeThreshold,
  };
}

/**
 * 排序比较器：**分数 → 时间新的在前 → id 字典序**。
 *
 * ⚠️ 2026-11-22：以前只比 `score`。而 score 是随时间连续衰减的浮点数，两条分数接近的
 * 条目在相邻两次排序里就会翻位 —— 导出文件白白产生 diff，召回顺序也会抖。
 * 后面两级让排序变成**确定**的：同一份数据，任何时候排出来都一样。
 */
export function byScoreThenTime(a, b) {
  return (b.score - a.score)
    || ((Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
    || String(a.id).localeCompare(String(b.id));
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
  // 2026-11-21：有过把 tags 当 JSON 字符串传进来的情况（'["生日","owner"]'），
  // 按元素拆会得到 ['["生日"', '"owner"]']，注入里就显示成 [["生日"。
  // 拼起来像数组就先试一次 JSON.parse；解析不了按原样。
  const joined = tags.map((t) => String(t ?? '')).join(',');
  if (/^\s*\[/.test(joined)) {
    try {
      const parsed = JSON.parse(joined);
      if (Array.isArray(parsed)) tags = parsed;
    } catch { /* 解析不了就按原样 */ }
  }
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
    // 又说了一遍 = 又被提了一次 → 重新计时。
    // ⚠️ 这里写 lastRecalledAt 而不是 updatedAt：计时起点已经不看 updatedAt 了，
    // 光改 updatedAt 会让"重复写一条"变成完全不生效。
    dup.updatedAt = now;
    dup.lastRecalledAt = now;
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
    // 2026-11-21：没给钩子就从正文第一句自动生成一个（≤24 字），别让它 fallback 到长正文
    hook: (String(input.hook ?? '').trim() || autoHook(input.text)).slice(0, 80),
  };
  store.entries.push(entry);
  saveStore(dir, store, tuning);
  return { entry, duplicate: false };
}

const HOOK_MAX = 24;
const SENTENCE_END = /[。！？；\n]/;
const CLAUSE_END = /[，、：,]/;

/**
 * 从正文里截一个「读得通」的摘要（≤24 字）。
 *
 * ⚠️ 2026-11-27：以前是 `s.slice(0, 24)` 硬切 —— 实测 46 条钩子里 5 条断在半个词上
 *   （「先把睡前这段时」「二十三张收」「老大翻出 11-22 的旧记录，那」「…老大教的，」）。
 *   这种钩子一旦当摘要用（模糊后正文 = 钩子），检索就跟着废掉。
 *
 * 现在的规则只有两条，**不乱拼**（拼首尾会切出「15:48，白饭派·前…7 开工」这种东西）：
 *   ① 第一句 ≤24 字 → 直接用（最常见，也最像人写的摘要）
 *   ② 第一句太长 → 在 24 字内最后一个从句边界（，、：）处切；边界太靠前（<10 字）
 *      就不切，直接 24 字硬截，再去掉结尾的半个标点
 *
 * 这仍然是机械兜底：真正好的钩子是她写的。autoHook 只保证「不读成半截话」。
 */
function autoHook(text) {
  const s = String(text ?? '').trim();
  if (!s) return '';
  // 她的正文常以 "2026-11-15 " 开头，不去掉的话钩子全是日期
  const noDate = s.replace(/^\d{4}-\d{2}-\d{2}\s*[：:，,、]?\s*/, '');
  const first = (noDate.split(SENTENCE_END)[0] || '').trim();
  if (first.length >= 6 && first.length <= HOOK_MAX) return first;
  if (first.length > HOOK_MAX) {
    const head = first.slice(0, HOOK_MAX);
    let at = -1;
    for (const m of head.matchAll(/[，、：,]/g)) at = m.index;   // 最后一个从句边界
    if (at >= 10) return head.slice(0, at).trim();
    return head.replace(/[，、：,\s—]+$/, '').trim();
  }
  // 第一句太短（<6 字，像「好的」）→ 取正文开头，尽量在标点处收
  if (noDate.length <= HOOK_MAX) return noDate;
  const head = noDate.slice(0, HOOK_MAX);
  let at = -1;
  for (const m of head.matchAll(/[，、：,\s]/g)) at = m.index;
  return (at >= 8 ? head.slice(0, at) : head).replace(/[，、：,\s—]+$/, '').trim();
}

/**
 * 取命中词附近的一小段原文，让人一眼看出"是在哪句里命中的"。
 * 命中点太靠后时就从后面切，保证片段里一定包含关键词。
 *
 * ⚠️ 2026-11-27：模糊过的条目，关键词常常只在 `textBefore`（原文）里。
 * 正文（gist）里找不到时去原文里找 —— 不然会显示「命中」却没有片段。
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

/** 命中片段：先看正文（gist），没有再回落原文（textBefore）。 */
function snippetOf(entry, needles) {
  return makeSnippet(entry?.text, needles) || makeSnippet(entry?.textBefore, needles);
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
    // ⚠️ 2026-11-27：haystack 必须带上 `textBefore`（被模糊掉的那份原文）。
    //    模糊后正文只剩一句事实，只在原文里有的词（回目名、《标题》、细节）
    //    否则永远搜不到 —— 而"搜不到"就意味着走不到 restoreClarity，
    //    这条记忆再也没有变清楚的机会（检索链在第 2 层就断了）。
    for (const e of pool) {
      const hay = `${e.text} ${e.textBefore ?? ''} ${(e.tags || []).join(' ')} ${(e.who || []).join(' ')}`.toLowerCase();
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
      // ⭐ 2026-11-22：模糊的条目被查到时优先冒头。
      // 不然会死循环：越模糊 → 分数越低 → 越挤不进前 N → 越没机会被恢复。
      // 只乘在"有 query 且命中"的路径上；注入不传 query，不受影响。
      if (isVague(e)) {
        d.score = Math.round(d.score * 2 * 1000) / 1000;
        d.vagueHit = true;
      }
      d.snippet = snippetOf(e, hit);
    }
    if (degraded) d.degraded = true;
    return d;
  });

  const take = (arr) => arr.sort(byScoreThenTime).slice(0, limit);
  if (opts.includeFaded) {
    const active = take(scored);
    return withArchiveFallback(dir, active, opts, limit);
  }
  const visible = scored.filter((e) => !e.faded);
  let active = take(visible.length ? visible : scored);
  // ⭐ 2026-11-22：模糊的命中**保底**进结果（最多 2 条）。
  // 光靠加权不够：20 条新鲜记录能把一条 20 天前的模糊记忆压到 1.0 出头。
  // 而"越模糊越挤不进前 N → 越没机会被想清楚"是个死循环，必须打断。
  if (q && !degraded) {
    const pinned = scored
      .filter((e) => e.vagueHit && !active.some((a) => a.id === e.id))
      .sort(byScoreThenTime)
      .slice(0, 2);
    if (pinned.length) {
      const keep = active.slice(0, Math.max(0, limit - pinned.length));
      active = [...pinned, ...keep];
    }
  }
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

/**
 * 把一条已经模糊的记忆恢复成原文 —— "久远的记忆被想起来，又会变清晰"。
 *
 * 为什么要这个（2026-11-22，使用者提的）：原来模糊是**单向**的。一条 important 模糊到
 * 100 字之后，就算第 30 天被她想起来、计时重来，`blurStage` 已经是 1，
 * 正文永远停在 100 字 / 25 字，回不去。真人的记忆是双向的：常被想起的清晰，
 * 久不碰的才糊。所以想起来（touch / 改写正文）时要把原文还回去。
 *
 * `textBefore` 保留不删：下次再模糊时用的还是同一份原文，不会越糊越短。
 * @returns {null | {from: string, to: string, stage: number}} 真的恢复了才有返回值
 */
function restoreClarity(entry) {
  const stage = Number(entry?.blurStage) || 0;
  if (!stage) return null;
  const original = typeof entry.textBefore === 'string' && entry.textBefore.trim() ? entry.textBefore : null;
  const from = String(entry.text ?? '');
  // "模糊"可能是个空操作：原文本来就比上限短（比如 92 字的 important 对 100 字上限），
  // 那时 blurText 原样返回，blurStage 却照样 +1 —— 这种不算"记不清"，只把阶段清零。
  if (!original || from === original) {
    entry.blurStage = 0;
    return null;
  }
  entry.text = original;
  entry.blurStage = 0;
  entry.restoredAt = Date.now();
  entry.restoreCount = (Number(entry.restoreCount) || 0) + 1;
  return { from, to: original, stage };
}

/** 这条是不是"真的记不清了"：压缩阶段走过，而且正文确实比原文短。 */
export function isVague(entry) {
  if (!(Number(entry?.blurStage) > 0)) return false;
  const before = typeof entry?.textBefore === 'string' ? entry.textBefore : '';
  if (!before) return true; // 没有原文可对照，按记不清处理（偏保守）
  return String(entry?.text ?? '').length < before.length;
}

/** 强化一次（touch 和"查到了"共用同一套动作，别让两条路走岔）。 */
function bumpTouch(entry, tuning = DEFAULT_TUNING, now = Date.now()) {
  const step = tuning.recallStrengthStep;
  entry.strength = Math.min(tuning.maxStrength, Math.max(0.1, (Number(entry.strength) || 1) + step));
  entry.lastRecalledAt = now;
  entry.recallCount = (Number(entry.recallCount) || 0) + 1;
  // normal：每被提到一次，寿命 +1 天（上限见 mentionBonusMaxDays）
  if ((entry.tier || 'normal') === 'normal') {
    const cap = tuning.mentionBonusMaxDays * DAY;
    entry.mentionBonus = Math.min(cap, (Number(entry.mentionBonus) || 0) + DAY);
  }
}

export function touchMemory(dir, id, tuning = DEFAULT_TUNING, delta = null) {
  const store = loadStore(dir);
  const entry = store.entries.find((e) => e.id === id);
  if (!entry) return null;
  if (delta == null) bumpTouch(entry, tuning);
  else {
    entry.strength = Math.min(tuning.maxStrength, Math.max(0.1, (Number(entry.strength) || 1) + Number(delta)));
    entry.lastRecalledAt = Date.now();
    entry.recallCount = (Number(entry.recallCount) || 0) + 1;
  }
  // ⭐ 模糊是双向的：想起来一条已经模糊的记忆，它重新变清晰
  const restored = restoreClarity(entry);
  saveStore(dir, store, tuning);
  return restored ? { ...entry, restored } : entry;
}

/**
 * 一次"想起来"一批 —— 她调 dfy_memory_recall 查到的东西，就算她想起来了。
 *
 * 为什么绑在这里（2026-11-22 使用者定的）：`dfy_memory_touch` 十天里一次都没被调过
 * （38 条记忆里 lastRecalledAt 全是 0），所以"靠她主动 touch 来恢复"等于没做。
 * 查记忆是她本来就会做的动作，语义也对："查到了 = 想起来了"。
 *
 * @param {string[]} ids 要算作想起来的条目
 * @returns {Array<{id, from, to}>} 真的恢复了原文的那些（没恢复的不返回）
 */
export function touchMany(dir, ids, tuning = DEFAULT_TUNING) {
  const list = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string' && x) : [];
  if (!list.length) return [];
  const store = loadStore(dir);
  const want = new Set(list);
  const now = Date.now();
  const changed = [];
  let hit = false;
  for (const entry of store.entries) {
    if (!want.has(entry.id)) continue;
    hit = true;
    bumpTouch(entry, tuning, now);
    const restored = restoreClarity(entry);
    if (restored) changed.push({ id: entry.id, from: restored.from, to: restored.to, tier: entry.tier });
  }
  if (!hit) return [];
  saveStore(dir, store, tuning);
  return changed;
}

export function updateMemory(dir, id, patch = {}, tuning = DEFAULT_TUNING) {
  const store = loadStore(dir);
  const entry = store.entries.find((e) => e.id === id);
  if (!entry) return null;
  if (typeof patch.text === 'string' && patch.text.trim()) {
    entry.text = patch.text.trim().slice(0, tuning.maxTextChars);
    // 换了正文：旧的原文作废（否则下次模糊会拿老原文覆盖新写的），阶段也重置
    delete entry.textBefore;
    entry.blurStage = 0;
    entry.restoredAt = Date.now();
    // ⭐ 只有"她真的重写了正文"才推进计时起点（updatedAt 不算，见 lastTouchOf）
    entry.revisedAt = Date.now();
  }
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
  // 已经淡出（分数低于阈值）的条目：久的排前面。
  // ⚠️ 消费方（dfy_memory_stats / 设置页面板）读的是 `fading` 这个数组字段，
  //    之前这里只给 `faded`（计数）+ `mostForgotten`，`fading` 从来不存在 ⇒
  //    "快淡掉的"那一行永远显示空。补上数组，同时保留计数和"最久"那条。
  const fading = [];
  for (const e of store.entries) {
    const tier = TIERS.includes(e.tier) ? e.tier : 'normal';
    byTier[tier] += 1;
    const d = decorate(e, now, tuning);
    if (d.faded) fading.push({ id: e.id, text: String(e.text).slice(0, 40), ageDays: d.ageDays });
  }
  fading.sort((a, b) => b.ageDays - a.ageDays);
  return {
    total: store.entries.length,
    byTier,
    faded: fading.length,
    fading,
    mostForgotten: fading[0] ?? null,
    dir,
  };
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
    rawDays = listDayFiles(rawDir, '.md').map((x) => x.day);
  } catch { return []; }
  const done = new Set();
  // 2026-11-21：按月分目录后要递归列，平铺的存量也认
  for (const x of listDayFiles(ctxDir, '.s.md')) {
    try {
      if (/by=agent/.test(fs.readFileSync(x.abs, 'utf8').slice(0, 120))) done.add(x.day);
    } catch { /* 忽略 */ }
  }
  return rawDays.filter((d) => !done.has(d) && d < today).sort();
}

/**
 * 作品库概览（注入里那一行「【我的作品】N 件」）。
 *
 * ⚠️ 2026-11-27：以前直接数 index.jsonl 的行数 —— 而那是 append-only 的，
 *    同一份稿子改名/归档/多版本都会各留一行。实测 3 件当前稿 + 2 条归档记录
 *    会报「5 件」，和 dfy_works / 设置页的 statsWorks 对不上（同一个数字两套说法）。
 *    现在和 works.js 的 listWorks 用同一套判据：
 *      · 同一个 <category>/<file> 只算一条（留 created 最新的）
 *      · 只算**当前稿**（路径不在 drafts/ 或 archive/ 下）
 *      · 磁盘上真有的才算（索引可能比磁盘旧）
 *    契约没变：数据根下的 <dataRoot>/works/（custom worksDir 不在这里，属宿主配置）。
 */
function worksHintLine(dir) {
  try {
    const base = path.dirname(dir);
    const file = path.join(base, 'works', 'index.jsonl');
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (!rows.length) return '';
    const byFile = new Map();
    for (const line of rows) {
      let e = null;
      try { e = JSON.parse(line); } catch { continue; /* 跳过坏行 */ }
      if (!e || !e.title || typeof e.file !== 'string' || !e.file.trim()) continue;
      const category = e.category === 'image' ? 'image' : 'text';
      const key = `${category}/${e.file}`;
      const prev = byFile.get(key);
      if (!prev || String(e.created || '') > String(prev.created || '')) byFile.set(key, { ...e, category });
    }
    const byCat = { text: 0, image: 0 };
    let latest = null;
    for (const e of byFile.values()) {
      if (rowKind(e) !== 'work') continue;
      if (!fs.existsSync(path.join(base, 'works', e.category, e.file))) continue;
      byCat[e.category] += 1;
      if (!latest || String(e.created || '') > String(latest.created || '')) latest = e;
    }
    const total = byCat.text + byCat.image;
    if (!total) return '';
    const tail = latest ? `，最近「${latest.title}」` : '';
    return `【我的作品】${total} 件（文字 ${byCat.text} · 图片 ${byCat.image}${tail}）想留的用 dfy_work_save / dfy_work_image`;
  } catch {
    return '';
  }
}

function buildHintLines(dir) {
  const out = [];
  try { const w = worksHintLine(dir); if (w) out.push(w); } catch { /* 忽略 */ }
  try { const a = archiveHint(dir); if (a) out.push(a); } catch { /* 忽略 */ }
  try {
    const ctxDir = path.join(path.dirname(dir), 'context');
    const items = [...listDayFiles(ctxDir, '.full.md'), ...listDayFiles(ctxDir, '.s.md')];
    if (items.length) {
      const days = items.map((x) => x.day).sort();
      const first = days[0];
      const last = days[days.length - 1];
      const range = first === last ? first : `${first.slice(5)}~${last.slice(5)}`;
      out.push(`（手上还有 ${range} 的对话窗口，越远越粗略。要翻用 dfy_context_list）`);
    }
  } catch { /* 忽略 */ }
  try {
    const rawDir = path.join(path.dirname(dir), 'archive', 'chat-logs');
    const ctxDir2 = path.join(path.dirname(dir), 'context');
    const rawDays = listDayFiles(rawDir, '.md').map((x) => x.day);
    const done = new Set();
    for (const x of listDayFiles(ctxDir2, '.s.md')) {
      try {
        if (/by=agent/.test(fs.readFileSync(x.abs, 'utf8').slice(0, 120))) done.add(x.day);
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
  // ⚠️ 原来写的是 `Number(...) || 8` —— 而 `0 || 8` 等于 8，所以界面上
  // 「0 = 不注入」从来就没生效过（永远注入 8 条）。现在显式区分「没配」和「配了 0」。
  const rawInject = cfg?.memory?.injectLimit;
  const injectNum = (rawInject === undefined || rawInject === null || rawInject === '')
    ? 8
    : Number(rawInject);
  const limit = Math.min(20, Math.max(0, Number.isFinite(injectNum) ? injectNum : 8));
  if (limit === 0) return '';
  const maxChars = Math.min(2000, Math.max(200, Number(cfg?.memory?.injectMaxChars) || 600));
  const picked = recallMemories(dir, { limit: Math.min(50, limit + 20), now }, tuning);
  const hints = buildHintLines(dir);
  if (!picked.length) return hints.length ? `【你记得的事】\n${hints.join('\n')}` : '';

  // ── core：永不淡忘，**不压缩、不占名额** ───────────────────────────────
  // 2026-11-22 修的两个毛病：
  //   ① core 正文也被 `hook` 替换 + 58 字截断 → 她说"「美滋滋」找不着了，
  //      那条被压成一句概括了"。core 是本该一字不差记住的东西，不许压。
  //   ② core 的分数写死 10，8 条 core 就把 injectLimit（默认 8）占满 →
  //      28 条 important 一条都进不了 prompt。现在 injectLimit 只管 core 之外。
  const cores = picked.filter((e) => (e.tier || 'normal') === 'core');
  const others = picked.filter((e) => (e.tier || 'normal') !== 'core').slice(0, limit);

  const lines = [];
  // core 压缩开关（设置页「记忆参数 → 维护」，默认关）。
  // 关着 = 完整正文（和 memory.md 一致）；开了 = 也只留钩子一行，省 token 但和原文对不上。
  const coreCompact = cfg?.memory?.coreCompact === true;
  for (const e of cores) {
    const tag = (e.tags || [])[0] ? `${(e.tags || [])[0]}·` : '';
    const count = Number(e.recallCount) > 0 ? `〔想起 ${e.recallCount} 次〕` : '';
    const q = e.quote ? `（原话：${e.quote}）` : '';
    if (coreCompact) {
      const body = e.hook ? e.hook : (e.text.length > 60 ? `${e.text.slice(0, 58)}…` : e.text);
      let line = `- [${ymd(e.createdAt || now)} ${tag}core] ${body}${q}${count}`;
      if (line.length > 150) line = `${line.slice(0, 148)}…`;
      lines.push(line);
    } else {
      // 完整正文 + 原话，不套钩子、不截长度
      lines.push(`- [${ymd(e.createdAt || now)} ${tag}core] ${e.text}${q}${count}`);
    }
  }
  // 字数预算只卡 important / normal；core 已经整段进来了，不再参与（也不该把它挤掉）
  let extraUsed = 0;

  for (const e of others) {
    const tag = (e.tags || [])[0] ? `${(e.tags || [])[0]}·` : '';
    const count = Number(e.recallCount) > 0 ? `〔想起 ${e.recallCount} 次〕` : '';
    // 2026-11-06（她提的）：有钩子就只用钩子——注入预算要给更多条，不是给更长的段落。
    // 正文留给 dfy_memory_recall 去展开，注入里不重复贴一遍。
    const body = e.hook ? e.hook : (e.text.length > 60 ? e.text.slice(0, 58) + '…' : e.text);
    const q = e.quote ? `（原话：${e.quote}）` : '';
    // 已经模糊过的：明确标出来，别让她把"只剩个大概"当成原话去复述。
    // 判据是"正文真的比原文短"，不是 blurStage>0 —— 原文本来就短时模糊是空操作。
    const vague = isVague(e) ? '（记不清了，只剩个大概；用 dfy_memory_recall 查一下会变清楚）' : '';
    let line = `- [${ymd(e.createdAt || now)} ${tag}${e.tier}] ${body}${q}${count}${vague}`;
    if (line.length > 150) line = `${line.slice(0, 148)}…`;
    if (extraUsed + line.length > maxChars) break;
    lines.push(line);
    extraUsed += line.length + 1;
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
  // ⚠️ 2026-11-22：这两个数字原来是写死在 label 里的（"21 天后开始模糊"/"7 天后浓缩"），
  // 配置改成 14 天了它还是写 21 —— 导出文件跟真实节奏对不上。现在从 tuning 取。
  const lif = tuning.lifespanDays ?? DEFAULT_TUNING.lifespanDays;
  const keepBlur = Number(tuning.blurKeepDays) || DEFAULT_TUNING.blurKeepDays;
  const keepNormal = Number(tuning.normalKeepDays) || DEFAULT_TUNING.normalKeepDays;
  const label = {
    core: '永不淡忘（名字/身份/承诺/约定/大事）',
    important: `重要（有情绪有后续；${lif.important} 天后模糊，再过 ${keepBlur} 天压成一句话，之后一直留着）`,
    normal: `日常琐事（${lif.normal} 天后模糊，再过 ${keepNormal} 天归档）`,
  };
  const out = [
    `# 大肥鱼的长期记忆`,
    '',
    `> ⚠️ 这是生成文件：每次写记忆都会整篇重写，手改的内容会被覆盖。要改某条记忆请用工具，或告诉执行者。共 ${store.entries.length} 条。`,
    `> 当前节奏：important ${lif.important} 天模糊 / ${lif.important + keepBlur} 天一句话；`
    + `normal ${lif.normal} 天模糊 / ${lif.normal + keepNormal} 天归档；core 永不淡忘。`,
    `> 模糊是双向的：被 dfy_memory_recall 查到（或 dfy_memory_touch）会把原文还回来。`,
    '',
  ];
  for (const tier of TIERS) {
    // ⚠️ 排序必须**确定**：只看 score 的话，两条分数接近的条目会因为浮点误差在
    // 相邻两次导出里互换位置，diff 全是噪声（2026-11-22 实测：只重写一次就换了 2 对行）。
    // 所以补两级 tiebreak：时间新的在前 → id 字典序。
    const list = byTier[tier]
      .map((e) => decorate(e, now, tuning))
      .sort(byScoreThenTime);
    out.push(`## ${label[tier]}（${list.length}）`, '');
    for (const e of list) {
      const flags = [
        Number(e.blurStage) > 0 ? (isVague(e) ? ' · 记不清了' : ' · 走过模糊（没丢字）') : '',
        Number(e.restoreCount) ? ` · 想起来变清楚${e.restoreCount}次` : '',
        e.faded ? ' · 快忘了' : '',
        Number(e.recallCount) ? ` · 想起${e.recallCount}次` : '',
      ].join('');
      out.push(`- \`${ymd(e.createdAt || now)}\` ${e.text}${flags}`);
    }
    if (!list.length) out.push('_（空）_');
    out.push('');
  }
  return out.join('\n');
}

/**
 * 只重写导出文件（memory.md），不动 memory.json。
 *
 * 为什么需要它（2026-11-22 使用者提的）：memory.md 的头里写着"当前节奏……"，
 * 而它只在**写记忆**的时候顺带重写。设置页里把天数改了之后，config.json 立刻变了、
 * 注入立刻变了，但 memory.md 还印着旧节奏，直到下一次写记忆才纠正 —— 中间那段时间它会骗人。
 * @returns {{ok:boolean, file?:string, entries?:number, error?:string}}
 */
export function exportMarkdown(dir, tuning = DEFAULT_TUNING) {
  try {
    const store = loadStore(dir);
    const file = path.join(dir, EXPORT_FILE);
    atomicWrite(file, renderMarkdown(store, tuning));
    return { ok: true, file, entries: store.entries.length };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// ── 生命周期：模糊化 / 归档 ─────────────────────────────────────────────
//
// 每一条**按自己的时钟**算（不是按层批处理）：
//
//   important   T+21 天 → 模糊到 ≤100 字 → T+35 天 → 一句话 ≤25 字 → 永久活跃
//   normal      T+7 天(+mentionBonus) → 浓缩 ≤25 字 → +7 天 → 归档（不删）
//   core        永不处理
//
// 计时起点 = 最后一次被真正碰到（lastRecalledAt / revisedAt / createdAt 取最大）。
// ⚠️ 故意**不含 updatedAt**：那是"文件被动过"，不是"她想起来了"（见 lastTouchOf）。
export function lifecycleOf(entry, tuning = DEFAULT_TUNING, now = Date.now()) {
  const tier = TIERS.includes(entry?.tier) ? entry.tier : 'normal';
  const stage = Number(entry?.blurStage) || 0;
  if (tier === 'core') return { tier, stage: 0, due: false, keep: null };
  const DAY_MS = DAY;
  const lastTouch = lastTouchOf(entry);
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
 * 这条记忆的「一句事实」—— 模糊之后留在正文位置上的东西。
 *
 * 为什么是 hook 而不是 blurText（2026-11-27 定的）：
 *   人的记忆是**记得结论、忘了铺垫**，`blurText` 恰好反着 —— 它只会砍尾巴，
 *   于是「晚上定下来的事：白饭派改成连载…已写完：第一回《断线》…」被切成
 *   「晚上定下来的事：白饭派改成连载，一天写一回，把当天经历和刷到的东西…」，
 *   真正有用的回目全丢了。hook 正是为「一眼能把整件事拉出来」写的（≤24 字）。
 *
 * 没有 hook 才退化成 autoHook（从正文首句截，保证读得通）。
 * 原文永远留在 `textBefore` 里 —— 想起来（recall 查到 / touch）会整段还回去。
 */
export function gistOf(entry) {
  const original = String(entry?.textBefore || entry?.text || '').trim();
  if (!original) return '';
  // 本来就短 → 它已经是一句事实了，模糊是空操作（别为了"模糊"再砍一刀）
  if (original.length <= HOOK_MAX) return original;
  const hook = String(entry?.hook ?? '').trim();
  return hook || autoHook(original);
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
      const before = String(entry.text ?? '');
      entry.textBefore = entry.textBefore || before;
      // ⭐ 2026-11-27：模糊 = 换成「一句事实」，不是砍掉后半截。
      // 两个阶段都是同一句（gist 就是最终形态）；stage 只负责"已经不清楚了"这个标记。
      entry.text = gistOf(entry);
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
