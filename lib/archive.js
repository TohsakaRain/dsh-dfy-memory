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

/** 关键词 AND 搜索（与 recall 同款朴素匹配：正文 + 标签） */
export function searchArchive(memoryDir, { query = '', limit = 5 } = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  const rows = readIndex(memoryDir);
  const lim = Math.min(20, Math.max(1, Number(limit) || 5));
  if (!q) return rows.slice(-lim).reverse();
  const needles = [...new Set(q.split(/\s+/).filter(Boolean))];
  // OR 匹配 + 命中数排序（和 recall 保持一致；AND 在口语问法下经常一个都搜不到）
  const scored = [];
  for (const r of rows) {
    const hay = `${r.s ?? ''} ${(r.tags || []).join(' ')} ${r.tier ?? ''}`.toLowerCase();
    const hits = needles.filter((n) => hay.includes(n)).length;
    if (hits) scored.push({ r, hits });
  }
  if (!scored.length) return [];
  scored.sort((a, b) => (b.hits - a.hits) || (String(b.r.d).localeCompare(String(a.r.d))));
  return scored.slice(0, lim).map((x) => ({ ...x.r, hits: x.hits }));
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
