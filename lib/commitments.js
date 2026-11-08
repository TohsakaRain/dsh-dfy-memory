// commitments.js —— 她答应过的事
//
// 为什么要单独存：「承诺」和「进行中的话题」不是一回事。话题是"聊到一半的东西"，
// 24 小时不提起就该忘；承诺是"我说过要做的事"，可能跨天、跨周，而且**兑现与否由她自己决定**
// （图里的口径：承诺兑现看心情，不勉强）。混进 activeTopics 会被 24 小时清理规则误杀。
//
// 状态机很简单，就三个字段：
//   createdAt  什么时候答应的
//   dueAt      希望什么时候兑现（可选；没有就是"哪天想起来再说"）
//   notifiedAt 到点提醒过她没有（只提醒一次，避免变成每日打卡）
//
// 没有"完成"状态：兑现了就把这条丢掉（drop）。留着"已完成"的条目除了占地方没别的用。
import fs from 'node:fs';
import path from 'node:path';

const MAX_ITEMS = 50;
const MAX_TEXT = 200;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function normText(s) {
  return String(s ?? '').trim().slice(0, MAX_TEXT);
}

function nextId(items) {
  const used = new Set(items.map((x) => x?.id));
  for (let i = 0; i < 500; i += 1) {
    const id = `p_${Math.random().toString(36).slice(2, 8)}`;
    if (!used.has(id)) return id;
  }
  return `p_${Date.now().toString(36)}`;
}

export function loadCommitments(file) {
  const doc = readJson(file, null);
  const items = Array.isArray(doc?.items) ? doc.items : [];
  return {
    items: items.filter((x) => x && typeof x.text === 'string' && x.text.trim()).slice(-MAX_ITEMS)
  };
}

export function saveCommitments(file, store) {
  writeJson(file, { version: 1, updatedAt: Date.now(), items: store.items.slice(-MAX_ITEMS) });
}

/** 答应一件事。dueInMinutes 省略 = 没有明确时间点。 */
export function addCommitment(file, { text, dueInMinutes = null, key = '' } = {}) {
  const body = normText(text);
  if (!body) throw new Error('承诺的内容是空的');
  const store = loadCommitments(file);
  const now = Date.now();
  const mins = Number(dueInMinutes);
  const dueAt = Number.isFinite(mins) && mins > 0 ? now + Math.round(mins) * 60 * 1000 : null;
  const dup = store.items.find((x) => String(x.text).trim() === body);
  if (dup) {
    dup.dueAt = dueAt;
    dup.notifiedAt = 0;
    dup.updatedAt = now;
    saveCommitments(file, store);
    return { item: dup, duplicate: true };
  }
  const item = {
    id: nextId(store.items),
    text: body,
    key: String(key || '').slice(0, 40),
    createdAt: now,
    updatedAt: now,
    dueAt,
    notifiedAt: 0
  };
  store.items.push(item);
  saveCommitments(file, store);
  return { item, duplicate: false };
}

export function listCommitments(file, { includeNotified = true } = {}) {
  const store = loadCommitments(file);
  const items = includeNotified ? store.items : store.items.filter((x) => !x.notifiedAt);
  return items.slice().sort((a, b) => (Number(a.dueAt) || Number(a.createdAt)) - (Number(b.dueAt) || Number(b.createdAt)));
}

/** 到点且还没提醒过的承诺（只取一条，一次叫醒只提一件事）。 */
export function dueCommitment(file, now = Date.now()) {
  const store = loadCommitments(file);
  return store.items.find((x) => x.dueAt && Number(x.dueAt) <= now && !x.notifiedAt) ?? null;
}

export function markNotified(file, id, now = Date.now()) {
  const store = loadCommitments(file);
  const item = store.items.find((x) => x.id === id);
  if (!item) return null;
  item.notifiedAt = now;
  item.updatedAt = now;
  saveCommitments(file, store);
  return item;
}

export function dropCommitment(file, id) {
  const store = loadCommitments(file);
  const idx = store.items.findIndex((x) => x.id === id);
  if (idx < 0) return null;
  const [removed] = store.items.splice(idx, 1);
  saveCommitments(file, store);
  return removed;
}

/** 唤醒提示里用的一行摘要（最多 max 条，不给全文就够她认出来）。 */
export function formatCommitments(items, { max = 3, now = Date.now() } = {}) {
  if (!Array.isArray(items) || !items.length) return '';
  const lines = items.slice(0, max).map((x) => {
    const due = Number(x.dueAt);
    let when = '';
    if (due) {
      const diffMin = Math.round((due - now) / 60000);
      if (diffMin <= 0) when = `（到点了${x.notifiedAt ? '，已经提醒过' : ''}）`;
      else if (diffMin < 60) when = `（约 ${diffMin} 分钟后）`;
      else if (diffMin < 60 * 24) when = `（约 ${Math.round(diffMin / 60)} 小时后）`;
      else when = `（约 ${Math.round(diffMin / 1440)} 天后）`;
    }
    return `- ${x.text}${when}`;
  });
  return lines.join('\n');
}
