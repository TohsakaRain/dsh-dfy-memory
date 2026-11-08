/**
 * mailbox.js —— 邮箱：她和"我"（桌面上的那个执行者）之间的信件。
 * ============================================================================
 * 为什么单独一个文件夹：作品库（works/）放的是她创作的东西——诗、图、小作文。
 * 信是**对话**：一来一往、有收信人、有读没读。混在作品里就分不清哪个是作品、
 * 哪个是话。
 *
 * 存储：
 *   <dataRoot>\mailbox\<YYYY-MM-DD>\<HHMMSS>-<from>.md
 *
 * 一封信长这样（front-matter + 正文）：
 *   ---
 *   id: 215233-her
 *   from: her          her / me / 别的人名
 *   to: me
 *   time: 2026-11-06T21:52:33.000Z
 *   read: false
 *   subject: 今天的新记忆
 *   ---
 *   正文……
 *
 * 设计原则：全部纯文件，不依赖数据库；坏了一封信不影响别的信。
 */
import fs from 'node:fs';
import path from 'node:path';

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stampOf = (d) => `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** 邮箱根目录：<dataRoot>/mailbox，可用 config.mailDir 覆盖。 */
export function mailboxDir(dataRoot, cfg = {}) {
  return cfg.mailDir || path.join(dataRoot, 'mailbox');
}

function parseLetter(raw, file) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  const meta = {};
  let body = raw;
  if (m) {
    body = raw.slice(m[0].length);
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return {
    id: meta.id || path.basename(file, '.md'),
    from: meta.from || '?',
    to: meta.to || '?',
    time: meta.time || '',
    read: meta.read === 'true',
    subject: meta.subject || '',
    text: body.trim(),
    file,
  };
}

/** 写一封信。from 默认 'her'（她用工具时就是她自己写的）。 */
export function sendLetter(dir, { from = 'her', to = 'me', text, subject = '' } = {}) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('信是空的，写点什么再寄');
  const now = new Date();
  const day = dayOf(now);
  const sub = path.join(dir, day);
  fs.mkdirSync(sub, { recursive: true });
  // 同一秒同一个人写两封：加序号，别覆盖
  let id = `${stampOf(now)}-${from}`;
  let file = path.join(sub, `${id}.md`);
  let n = 2;
  while (fs.existsSync(file)) {
    id = `${stampOf(now)}-${from}-${n}`;
    file = path.join(sub, `${id}.md`);
    n += 1;
  }
  const head = [
    '---',
    `id: ${id}`,
    `from: ${from}`,
    `to: ${to}`,
    `time: ${now.toISOString()}`,
    `read: ${from === to ? 'true' : 'false'}`,
    `subject: ${String(subject ?? '').replace(/\n/g, ' ').slice(0, 60)}`,
    '---',
    '',
    body,
    '',
  ].join('\n');
  fs.writeFileSync(file, head, 'utf8');
  return { id, day, file };
}

/** 列出信（新的在前）。unreadOnly 只看没读过的。 */
export function listLetters(dir, { limit = 10, unreadOnly = false } = {}) {
  if (!fs.existsSync(dir)) return [];
  const days = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().reverse();
  const out = [];
  for (const day of days) {
    const files = fs.readdirSync(path.join(dir, day)).filter((n) => n.endsWith('.md')).sort().reverse();
    for (const f of files) {
      try {
        const letter = parseLetter(fs.readFileSync(path.join(dir, day, f), 'utf8'), path.join(dir, day, f));
        if (unreadOnly && letter.read) continue;
        out.push({ ...letter, day });
      } catch { /* 坏掉的一封跳过 */ }
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** 按 id 找一封信；找到就顺手把它标成已读。 */
export function readLetter(dir, id) {
  if (!fs.existsSync(dir)) return null;
  const want = String(id ?? '').trim();
  for (const day of fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().reverse()) {
    const file = path.join(dir, day, `${want}.md`);
    if (!fs.existsSync(file)) continue;
    const letter = parseLetter(fs.readFileSync(file, 'utf8'), file);
    if (!letter.read) {
      const raw = fs.readFileSync(file, 'utf8').replace(/^read: .*$/m, 'read: true');
      try { fs.writeFileSync(file, raw, 'utf8'); } catch { /* 标不上已读也不影响读信 */ }
      letter.read = true;
    }
    return { ...letter, day };
  }
  return null;
}

/** 统计：一共几封、几封没读。 */
export function mailStats(dir) {
  const all = listLetters(dir, { limit: 100000 });
  return { total: all.length, unread: all.filter((l) => !l.read).length };
}
