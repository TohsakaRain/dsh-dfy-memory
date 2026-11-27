/**
 * lib/archive.js —— 归档（"删除"其实是归档，只追加不删）
 * ============================================================================
 * 三层检索里的第 2、3 层：
 *
 *   第 1 级  注入（memory.json，每轮 ≤8 条）
 *   第 2 级  索引（archive/index.jsonl，一行 ~40 字，她查才看）
 *   第 3 级  全文（archive/YYYY-MM.jsonl，她要那条才打开）
 *
 * 为什么索引不再生成一次摘要：归档**之前**条目已经被模糊到 ≤25 字了，
 * 那 25 字就是天然的索引摘要 ⇒ 零模型成本。
 *
 * 文件格式：
 *   index.jsonl          {"id","d","tier","tags","s"}       一行一条
 *   2026-10.jsonl        完整条目 + archivedAt / archiveReason
 * ============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';

const INDEX_FILE = 'index.jsonl';
const pad = (n) => String(n).padStart(2, '0');
const ymd = (ts) => {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const ym = (ts) => ymd(ts).slice(0, 7);

export function archiveDir(memoryDir) {
  return path.join(memoryDir, 'archive');
}

export function ensureArchive(memoryDir) {
  const dir = archiveDir(memoryDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const readJsonl = (file) => {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
};

/**
 * 追加一条到归档。
 * @returns {{id, monthFile, indexLine}}
 */
export function appendArchive(memoryDir, entry, { reason = 'expired', now = Date.now(), summary = null } = {}) {
  const dir = ensureArchive(memoryDir);
  const id = String(entry?.id ?? `a_${Math.random().toString(36).slice(2, 8)}`);
  const text = String(entry?.text ?? '').trim();
  const indexLine = {
    id,
    d: ymd(entry?.createdAt ?? now),
    tier: String(entry?.tier ?? 'normal'),
    tags: Array.isArray(entry?.tags) ? entry.tags.slice(0, 3) : [],
    s: String(summary ?? text).slice(0, 60),
  };
  fs.appendFileSync(path.join(dir, INDEX_FILE), `${JSON.stringify(indexLine)}\n`, 'utf8');

  const full = {
    ...entry,
    id,
    text,
    archivedAt: now,
    archiveReason: reason,
  };
  const monthFile = path.join(dir, `${ym(entry?.createdAt ?? now)}.jsonl`);
  fs.appendFileSync(monthFile, `${JSON.stringify(full)}\n`, 'utf8');
  return { id, monthFile: path.basename(monthFile), indexLine };
}

export function readIndex(memoryDir) {
  return readJsonl(path.join(archiveDir(memoryDir), INDEX_FILE));
}

/** 所有月份文件（YYYY-MM.jsonl），新的在前。 */
function monthFiles(memoryDir) {
  try {
    return fs.readdirSync(archiveDir(memoryDir))
      .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
      .sort().reverse()
      .map((f) => path.join(archiveDir(memoryDir), f));
  } catch {
    return [];
  }
}

/** 归档里的完整条目（扫所有月份文件）。 */
function readAllFull(memoryDir) {
  const out = [];
  for (const f of monthFiles(memoryDir)) out.push(...readJsonl(f));
  return out;
}

/**
 * 关键词搜索（与 recall 同款朴素匹配）。
 *
 * ⚠️ 2026-11-27：索引行 `s` 只有 60 字（而且现在是 gist，更短），
 *   只在原文里出现的词（回目名、《标题》、细节）在索引里永远搜不到。
 *   所以：**先搜索引；索引一条都没命中时，回落到月份文件里搜全文**。
 *   为什么不把全文塞进索引：索引是"一行一条"的速览，撑肥了就失去意义；
 *   而归档搜索是"她查才看"的低频操作，扫几个月份文件（一年 < 100 KB）完全够。
 *
 * 命中时返回索引行形状（id / d / tier / tags / s），并带 `hits` 与 `from`：
 *   from = 'index'   索引里就命中了
 *   from = 'full'    回落月份文件才命中的（s 用原文截 60 字）
 */
export function searchArchive(memoryDir, { query = '', limit = 5 } = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  const rows = readIndex(memoryDir);
  const lim = Math.min(20, Math.max(1, Number(limit) || 5));
  if (!q) return rows.slice(-lim).reverse();
  const needles = [...new Set(q.split(/\s+/).filter(Boolean))];
  const hayOf = (r) => `${r.s ?? ''} ${r.text ?? ''} ${r.textBefore ?? ''} ${(r.tags || []).join(' ')} ${r.tier ?? ''}`.toLowerCase();
  // OR 匹配 + 命中数排序（和 recall 保持一致；AND 在口语问法下经常一个都搜不到）
  const scored = [];
  for (const r of rows) {
    const hits = needles.filter((n) => hayOf(r).includes(n)).length;
    if (hits) scored.push({ r, hits, from: 'index' });
  }
  // 索引没命中（或命中太少）→ 去月份文件里找全文
  if (scored.length < lim) {
    const have = new Set(scored.map((x) => String(x.r.id)));
    for (const e of readAllFull(memoryDir)) {
      if (have.has(String(e?.id))) continue;
      const hits = needles.filter((n) => hayOf(e).includes(n)).length;
      if (!hits) continue;
      const text = String(e.textBefore || e.text || '');
      scored.push({
        r: {
          id: e.id,
          d: ymd(e.archivedAt ?? e.createdAt),
          tier: String(e.tier ?? 'normal'),
          tags: Array.isArray(e.tags) ? e.tags.slice(0, 3) : [],
          s: (String(e.text ?? '') || text).slice(0, 60),
        },
        hits,
        from: 'full',
      });
    }
  }
  if (!scored.length) return [];
  scored.sort((a, b) => (b.hits - a.hits) || (String(b.r.d).localeCompare(String(a.r.d))));
  return scored.slice(0, lim).map((x) => ({ ...x.r, hits: x.hits, from: x.from }));
}

/** 按 id 取全文（扫所有月份文件；归档条目一般不多，够快） */
export function getArchive(memoryDir, ids = []) {
  const want = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
  if (!want.size) return [];
  const dir = archiveDir(memoryDir);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    for (const e of readJsonl(path.join(dir, f))) {
      if (want.has(String(e?.id))) out.push(e);
    }
    if (out.length >= want.size) break;
  }
  return out;
}

export function statsArchive(memoryDir) {
  const rows = readIndex(memoryDir);
  const dates = rows.map((r) => r.d).filter(Boolean).sort();
  return {
    total: rows.length,
    first: dates[0] ?? null,
    last: dates[dates.length - 1] ?? null,
  };
}

/** 给注入用的那一行提示（归档为空时返回 ''） */
export function archiveHint(memoryDir) {
  const s = statsArchive(memoryDir);
  if (!s.total) return '';
  const range = s.first && s.last && s.first !== s.last ? `${s.first} ~ ${s.last}` : (s.first ?? '');
  return `（还有一个归档：${s.total} 条${range ? `，${range}` : ''}。想翻旧事用 dfy_archive_search）`;
}
