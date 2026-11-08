/**
 * lib/diary.js —— 日记（纯数据层，不依赖 DSH / 桥接 / MCP）
 * ============================================================================
 * 从 qq-bridge 的 src/mcp-diary.js 原样搬过来，只把「目录」从模块常量改成参数，
 * 这样同一个模块能被插件、自检脚本、桥接三处复用。
 *
 * 设计守则（与原来一致）：
 *   · **路径锁死**：日期必须匹配 YYYY-MM-DD，解析后必须落在 diaryDir 内，杜绝 ../ 穿越
 *   · 一天可写多段，每段带 HH:MM（+ 可选心情标签）
 *   · 写出去不能删 —— 写错只能在后面追加一段更正
 *   · 单段 ≤20000 字、单日文件 ≤400KB、同进程两次写间隔 ≥3 秒（挡模型重试造成的重复段）
 */
import fs from 'node:fs';
import path from 'node:path';

export const MAX_ENTRY_CHARS = 20000;
export const MAX_FILE_BYTES = 400000;
export const MIN_WRITE_GAP_MS = 3000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

let lastWriteAt = 0;   // 模块级：只防重复提交，不做"每天只能写一次"这种蠢限制

const pad = (n) => String(n).padStart(2, '0');
export const todayStr = (now = new Date()) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const hhmm = (now = new Date()) => `${pad(now.getHours())}:${pad(now.getMinutes())}`;
const weekdayOf = (dateStr) => {
  const d = new Date(`${dateStr}T00:00:00`);
  return Number.isNaN(d.getTime()) ? '' : `星期${WEEKDAY[d.getDay()]}`;
};

/** 唯一允许拼路径的地方：先校验格式，再校验解析结果仍在 dir 内。 */
export function fileFor(dir, dateStr) {
  const base = path.resolve(dir);
  const s = String(dateStr ?? '').trim();
  if (!DAY_RE.test(s)) return { error: `日期格式必须是 YYYY-MM-DD，收到：${s || '(空)'}` };
  const abs = path.resolve(base, `${s}.md`);
  if (abs !== path.join(base, `${s}.md`)) return { error: '日期不合法' };
  if (!abs.startsWith(base + path.sep)) return { error: '日期不合法' };
  return { file: abs, date: s };
}

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
};

const sectionCount = (text) => (text ? (text.match(/^## /gm) ?? []).length : 0);

/** 「今天写了没 / 最近一次是哪天」——给唤醒提示用（只读、不建目录）。 */
export function statusSnapshot(dir, now = new Date()) {
  const base = path.resolve(dir);
  const today = todayStr(now);
  const todayText = readText(path.join(base, `${today}.md`));
  const todaySections = sectionCount(todayText);
  let lastDate = null;
  let lastMtimeMs = 0;
  try {
    for (const name of fs.readdirSync(base)) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
      const st = fs.statSync(path.join(base, name));
      if (st.mtimeMs > lastMtimeMs) {
        lastMtimeMs = st.mtimeMs;
        lastDate = name.slice(0, 10);
      }
    }
  } catch { /* 目录还没有，就是没写过 */ }
  return { dir: base, today, todaySections, lastDate };
}

/**
 * 追加一段日记。
 * @returns {{ok:true, date:string, sections:number, created:boolean, bytes:number, file:string}
 *          | {ok:false, error:string}}
 */
export function appendEntry(dir, { text, mood = '', date = '' } = {}) {
  const body = String(text ?? '');
  if (!body.trim()) return { ok: false, error: '日记正文是空的' };
  if (body.length > MAX_ENTRY_CHARS) {
    return { ok: false, error: `这段太长了（${body.length} 字），上限 ${MAX_ENTRY_CHARS} 字。分几次写，或者写重点。` };
  }
  const now = Date.now();
  if (now - lastWriteAt < MIN_WRITE_GAP_MS) {
    return { ok: false, error: '刚写过一段了，别连着写（防止同一段被重复提交）。' };
  }
  const target = fileFor(dir, date || todayStr());
  if (target.error) return { ok: false, error: target.error };
  try {
    fs.mkdirSync(path.dirname(target.file), { recursive: true });
    const existing = readText(target.file) ?? '';
    if (Buffer.byteLength(existing, 'utf8') > MAX_FILE_BYTES) {
      return { ok: false, error: `这一天已经写了很多了（${Math.round(Buffer.byteLength(existing, 'utf8') / 1024)}KB），换一天或写在今天吧。` };
    }
    const created = existing.length === 0;
    const header = created ? `# ${target.date} ${weekdayOf(target.date)}\n` : '';
    const label = mood && String(mood).trim() ? `${hhmm()} · ${String(mood).trim()}` : hhmm();
    fs.appendFileSync(target.file, `${header}\n## ${label}\n${body.trim()}\n`, 'utf8');
    lastWriteAt = now;
    const after = readText(target.file) ?? '';
    return {
      ok: true,
      date: target.date,
      created,
      sections: sectionCount(after),
      bytes: Buffer.byteLength(after, 'utf8'),
      file: target.file,
    };
  } catch (e) {
    return { ok: false, error: `写日记失败：${e?.message ?? e}` };
  }
}

/** 读某一天的日记（默认今天）。太大的只给最后 12000 字。 */
export function readDay(dir, { date = '', maxChars = 12000 } = {}) {
  const target = fileFor(dir, date || todayStr());
  if (target.error) return { ok: false, error: target.error };
  const content = readText(target.file);
  if (content == null) return { ok: true, date: target.date, empty: true, text: '', sections: 0 };
  const truncated = content.length > maxChars;
  return {
    ok: true,
    date: target.date,
    empty: false,
    truncated,
    sections: sectionCount(content),
    text: truncated ? `（只显示最后 ${maxChars} 字）\n${content.slice(-maxChars)}` : content,
  };
}

/** 列最近 N 天：日期 · 大小 · 当天最后一段的开头。 */
export function listDays(dir, { limit = 10, now = new Date() } = {}) {
  const base = path.resolve(dir);
  const n = Math.max(1, Math.min(60, Number(limit) || 10));
  let names = [];
  try {
    names = fs.readdirSync(base).filter((x) => /^\d{4}-\d{2}-\d{2}\.md$/.test(x)).sort().reverse();
  } catch {
    return { ok: true, days: [], status: statusSnapshot(base, now) };
  }
  const days = names.slice(0, n).map((name) => {
    const file = path.join(base, name);
    const body = readText(file) ?? '';
    let size = 0;
    try { size = fs.statSync(file).size } catch { /* 读不到就算 0 */ }
    const lastSection = body.split(/^## /m).pop() ?? '';
    return {
      date: name.slice(0, 10),
      kb: Math.round(size / 102.4) / 10,
      preview: lastSection.replace(/\s+/g, ' ').trim().slice(0, 40),
    };
  });
  return { ok: true, days, status: statusSnapshot(base, now) };
}
