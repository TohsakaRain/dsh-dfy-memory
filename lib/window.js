/**
 * lib/window.js —— 7 天滑动窗口（永远 6 个文件）
 * ============================================================================
 *   D-0 今天    （不存文件：正在聊，内容本来就在会话里）
 *   D-1 昨天    .full   全量
 *   D-2 ~ D-6   .s      摘要，字数递减 800 / 500 / 300 / 150 / 80
 *   D-7 更早    → 删（归档里永远还在）
 *   → 文件数恒为 6（1 个全量 + 5 个摘要）
 *
 * 文件头写明来源，用来判断"能不能被机械摘要覆盖"：
 *   <!-- dfy-window: v1 day=2026-10-29 kind=full by=auto -->
 * 她重写过的摘要带 by=agent ⇒ 再 roll **不覆盖**。
 * ============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { dayOf, renderDay, findSessions, extractEvents, sessionsRoot } from './chatlog.js';

const DAY = 24 * 60 * 60 * 1000;
export const WINDOW_DAYS = 7;          // 今天 + 昨天 + 5 天摘要
export const SUMMARY_BUDGETS = { 2: 1200, 3: 900, 4: 600, 5: 400, 6: 300 };
const HEADER_RE = /^<!-- dfy-window: v1 day=(\d{4}-\d{2}-\d{2}) kind=(full|summary) by=(\w+) -->/;

export function contextDir(memoryDir) {
  return path.join(path.dirname(path.resolve(memoryDir)), 'context');
}

export function ensureContextDir(ctxDir) {
  fs.mkdirSync(ctxDir, { recursive: true });
  return ctxDir;
}

const fileName = (day, kind) => `${day}.${kind === 'full' ? 'full' : 's'}.md`;

/** 一眼看出这句值不值得留的关键词（决定/承诺/情绪/时间点） */
const KEY_SIGNAL_RE = /(决定|答应|约|承诺|以后|下次|明天|下周|记得|别忘了|辞职|搬家|生日|生病|难过|哭了|生气|喜欢|讨厌|害怕|后悔|担心|开心|好累|熬夜|面试|offer|不许|必须)/i;
const MSG_HEAD_RE = /^\*\*\d{2}:\d{2}:\d{2}\*\*/;

/**
 * 摘要裁剪（2026-11-06 换掉"砍尾巴"的旧做法）
 *
 * 旧做法：只留开头，后面全丢 —— 一天里"前半晚有、后半晚没了"，越久的天留得越少。
 * 新做法：元信息 + 第一条 + 最后一条必留，中间按重要性挑，跳过处留「省略 N 条」。
 */
export function smartTrim(text, max) {
  const s = String(text == null ? '' : text).trim();
  const limit = Math.max(60, Number(max) || 300);
  if (s.length <= limit) return s;

  const lines = s.split('\n');
  const head = [];
  let i = 0;
  while (i < lines.length && !MSG_HEAD_RE.test(lines[i].trim())) { head.push(lines[i]); i += 1; }

  const blocks = [];
  let cur = [];
  for (; i < lines.length; i += 1) {
    if (MSG_HEAD_RE.test(lines[i].trim()) && cur.length) { blocks.push(cur); cur = []; }
    cur.push(lines[i]);
  }
  if (cur.length) blocks.push(cur);
  if (!blocks.length) return s.slice(0, limit) + '…';

  const meta = head.join('\n');
  const budget = Math.max(120, limit - meta.length - 70);

  // 按「连续窗口」打分，而不是单条打分：
  // 单条打分会让留下的话一句一句散着，读起来一堆"省略 N 条"，反而更碎。
  const WIN = 3;
  const texts = blocks.map((b) => b.join('\n'));
  const lens = texts.map((x) => x.length + 1);
  const windows = [];
  for (let st = 0; st < blocks.length; st += 1) {
    const en = Math.min(blocks.length - 1, st + WIN - 1);
    let len = 0;
    let sc = 0;
    for (let k = st; k <= en; k += 1) {
      len += lens[k];
      if (KEY_SIGNAL_RE.test(texts[k])) sc += 4;
      if (texts[k].trim().length > 60) sc += 1;
    }
    sc += (en / Math.max(1, blocks.length - 1)) * 1.2;   // 略偏向当天后段
    windows.push({ st, en, len, sc });
  }
  // 头尾两个窗口必留
  const chosen = [];
  const lastWin = blocks.length - 1;
  for (const w of windows) {
    if (w.st === 0 || w.en === lastWin) { chosen.push(w); }
  }
  let used = chosen.reduce((a, w) => a + w.len, 0);
  for (const w of [...windows].sort((a, b) => b.sc - a.sc)) {
    if (used + w.len > budget) continue;
    const overlap = chosen.some((c) => !(w.en < c.st || w.st > c.en));
    if (overlap) continue;
    chosen.push(w);
    used += w.len;
  }

  // 合并成连续的 keep 区间
  chosen.sort((a, b) => a.st - b.st);
  const runs = [];
  for (const w of chosen) {
    const last = runs[runs.length - 1];
    if (last && w.st <= last[1] + 1) last[1] = Math.max(last[1], w.en);
    else runs.push([w.st, w.en]);
  }

  const out = meta ? [meta, ''] : [];
  let cursor = 0;
  for (const [st, en] of runs) {
    if (st > cursor) out.push('（省略 ' + (st - cursor) + ' 条，原文在归档）', '');
    for (let k = st; k <= en; k += 1) out.push(...blocks[k]);
    cursor = en + 1;
  }
  if (cursor < blocks.length) out.push('（末尾省略 ' + (blocks.length - cursor) + ' 条，原文在归档）');

  let result = out.join('\n');
  if (result.length > limit) {
    // 宁可短一点，也不要断在半句：从 limit 往前找最近的句末/换行
    const head = result.slice(0, limit);
    const cut = Math.max(
      head.lastIndexOf('\n'),
      head.lastIndexOf('。'),
      head.lastIndexOf('！'),
      head.lastIndexOf('？'),
      head.lastIndexOf('…'),
    );
    result = cut > Math.floor(limit * 0.55) ? head.slice(0, cut + 1) : head.slice(0, limit - 1);
    if (!result.endsWith('…')) result = result.replace(/\s+$/, '') + '…';
  }
  return result;
}

/** 机械摘要：按预算截断，尽量在句末/逗号处切 */
export function truncateForBudget(text, max) {
  const s = String(text ?? '').trim();
  const limit = Math.max(20, Number(max) || 80);
  if (s.length <= limit) return s;
  const head = s.slice(0, limit);
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('，'), head.lastIndexOf('\n'));
  if (cut >= Math.floor(limit * 0.5)) return `${head.slice(0, cut).trim()}…`;
  return `${head.trim()}…`;
}

/**
 * 读一个窗口文件（含头部元信息）。
 * @param {'full'|'summary'} [only] 只读这一种形态；不传就按 full → summary 顺序找
 *   （不传是给"随便读一天"的调用方用的；列表必须传，否则同一天有两份时会读到同一份 ✗）
 */
export function readWindowFile(ctxDir, day, only) {
  for (const kind of only ? [only] : ['full', 'summary']) {
    const file = path.join(ctxDir, fileName(day, kind));
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    const m = raw.match(HEADER_RE);
    const body = raw.replace(HEADER_RE, '').replace(/^\n+/, '');
    return {
      day,
      kind,
      by: m?.[3] ?? 'unknown',
      file: path.basename(file),
      text: body,
      chars: body.length,
    };
  }
  return null;
}

export function writeWindowFile(ctxDir, day, kind, text, { by = 'auto' } = {}) {
  ensureContextDir(ctxDir);
  // 保底：如果这次要用 auto 盖掉她写的（by=agent），先把旧稿复制到 _replaced/
  // ——哪怕将来又出现新的覆盖路径，字也还在，能手动找回。
  try {
    const target = path.join(ctxDir, fileName(day, kind));
    if (by === 'auto' && fs.existsSync(target)) {
      const rawOld = fs.readFileSync(target, 'utf8');
      const head = rawOld.match(/^<!--[^>]*-->/);
      if (head && /by=agent/.test(head[0])) {
        const dir = path.join(ctxDir, '_replaced');
        fs.mkdirSync(dir, { recursive: true });
        const p = (n) => String(n).padStart(2, '0');
        const d = new Date();
        const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
        fs.writeFileSync(path.join(dir, `${fileName(day, kind)}.${stamp}`), rawOld, 'utf8');
      }
    }
  } catch { /* 备份失败不阻止写入 */ }
  const header = `<!-- dfy-window: v1 day=${day} kind=${kind} by=${by} -->\n`;
  fs.writeFileSync(path.join(ctxDir, fileName(day, kind)), `${header}${text.trim()}\n`, 'utf8');
}

/** 列出窗口里现有的天（按日期升序）。按**文件名**精确读取，同一天两份时各算各的。 */
export function listWindow(ctxDir) {
  if (!fs.existsSync(ctxDir)) return [];
  return fs.readdirSync(ctxDir)
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.(full|s)\.md$/.test(n))
    .map((n) => n.match(/^(\d{4}-\d{2}-\d{2})\.(full|s)\.md$/))
    .map((m) => readWindowFile(ctxDir, m[1], m[2] === 'full' ? 'full' : 'summary'))
    .filter(Boolean)
    .sort((a, b) => (a.day < b.day ? -1 : (a.day > b.day ? 1 : (a.kind === b.kind ? 0 : (a.kind === 'full' ? -1 : 1)))));
}

/**
 * 删掉某一天的另一种形态：一天只能留 full 或 summary 中的一种。
 * 这是"窗口只留 6 个文件"的关键一步 —— 之前漏了，导致 .full.md 缩成 .s.md 之后两份并存。
 */
function removeKind(ctxDir, day, kind, removed = null) {
  const file = fileName(day, kind);
  try {
    if (fs.existsSync(path.join(ctxDir, file))) {
      fs.rmSync(path.join(ctxDir, file), { force: true });
      if (removed) removed.push(file);
    }
  } catch { /* 删不掉下次再删，不影响本轮 */ }
}

/**
 * 滚动：按事件重建窗口。
 * @returns {{written: string[], kept: string[], removed: string[]}}
 */
export function rollWindow({ ctxDir, events, now = Date.now() }) {
  ensureContextDir(ctxDir);
  const today = dayOf(now);
  const dayMs = (d) => Date.parse(`${d}T00:00:00`);
  const distance = (d) => Math.round((dayMs(today) - dayMs(d)) / DAY);

  const byDay = new Map();
  for (const e of events) {
    const d = dayOf(e.ts);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(e);
  }

  const written = [];
  const kept = [];
  const removed = [];

  // ① 今天 + 昨天：全量
  for (const [day, list] of byDay) {
    const dist = distance(day);
    if (dist > 6 || dist < 0) continue;
    // 今天不存文件：正在聊，内容本来就在会话里（也符合"只留 6 个文件"）
    if (dist === 0) continue;
    if (dist === 1) {
      // 全量一直刷新（这一天还在长）；同一天如果还留着旧的摘要，删掉——一天只能有一种形态。
      // **但是**：她自己写过的摘要（by=agent）不能删。2026-11-08 的 bug：
      // 她写了某天的摘要，隔天这天变成 D-1，removeKind 把她的稿子删了，
      // 再过几天又按 auto 生成一份——她的字就这么没了（11-04 那次丢了 829 字）。
      const curY = readWindowFile(ctxDir, day);
      if (curY && curY.by === 'agent') {
        kept.push(`${day}.s（她写过，D-1 也不覆盖；全量在 archive/chat-logs 里）`);
        continue;
      }
      removeKind(ctxDir, day, 'summary', removed);
      writeWindowFile(ctxDir, day, 'full', renderDay(day, list), { by: 'auto' });
      written.push(`${day}.full`);
      continue;
    }
    // ② D-2..D-6：摘要（她重写过就不动）
    const cur = readWindowFile(ctxDir, day);
    // 已经缩成摘要了，就把当初那份全量删掉（以前漏了这一步 ⇒ 同一天两份、越积越多）
    removeKind(ctxDir, day, 'full', removed);
    if (cur && cur.by === 'agent') { kept.push(`${day}.s（她写过，不覆盖）`); continue; }
    const budget = SUMMARY_BUDGETS[dist] ?? 80;
    const full = renderDay(day, list);
    // 标一句"这是草稿"：她一看就知道可以覆盖，不会被当成定稿
    const DRAFT_HEAD = '> 自动摘要草稿（可以用 dfy_context_summarize 重写）\n\n';
    const summary = DRAFT_HEAD + smartTrim(full, Math.max(120, budget - DRAFT_HEAD.length));
    writeWindowFile(ctxDir, day, 'summary', summary, { by: 'auto' });
    written.push(`${day}.s`);
  }

  // ③ 删掉超过 6 天的（归档里还在）
  for (const item of listWindow(ctxDir)) {
    const dist = distance(item.day);
    if (dist > 6) {
      // 她自己写/重写过的摘要（by=agent）不删：那是她的稿子，删了等于把她写的东西扔掉
      if (item.by === 'agent') { kept.push(`${item.file}（她写的，超过 6 天也留）`); continue; }
      fs.rmSync(path.join(ctxDir, item.file), { force: true });
      removed.push(item.file);
    }
  }

  return { written, kept, removed, window: listWindow(ctxDir).map((x) => ({ day: x.day, kind: x.kind, by: x.by, chars: x.chars })) };
}

/** 她重写某天的摘要 */
export function summarizeDay({ ctxDir, day, text, maxChars = 6000 }) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('摘要内容是空的');
  // 她自己写的稿子只设一个很宽的上限，不按"机械摘要"的 1200 去砍。
  const clipped = body.length > maxChars ? body.slice(0, maxChars) : body;
  writeWindowFile(ctxDir, day, 'summary', clipped, { by: 'agent' });
  return {
    day,
    chars: clipped.length,
    text: clipped,
    truncated: clipped.length < body.length,
    note: clipped.length < body.length ? ('超过 ' + maxChars + ' 字符，只存了前面一段') : '',
  };
}

/** 注入用的那一行（窗口为空返回 ''） */
/** 自检用：窗口为什么是空的 */
export function debugInfo() {
  const root = sessionsRoot();
  let exists = false;
  try { exists = fs.statSync(root).isDirectory(); } catch (e) { exists = false; }
  const sessions = findSessions({ root: root });
  const debugArr = [];
  const events = extractEvents({ root: root, debugArr: debugArr });
  const days = [...new Set(events.map((e) => dayOf(e.ts)))].sort();
  return {
    sessionsRoot: root,
    exists,
    sessions: sessions.length,
    sessionIds: sessions.slice(0, 4).map((s) => s.sessionId.slice(0, 20)),
    events: events.length,
    days,
    zstd: debugArr[0] ? debugArr[0].zstd : null,
    perSession: debugArr[0] ? debugArr[0].perSession : [],
  };
}

export function windowHint(ctxDir) {
  const list = listWindow(ctxDir);
  if (!list.length) return '';
  const first = list[0].day;
  const last = list[list.length - 1].day;
  const range = first === last ? first : `${first.slice(5)}~${last.slice(5)}`;
  return `（手上还有 ${range} 的对话窗口，越远越粗略。要翻用 dfy_context_list）`;
}

