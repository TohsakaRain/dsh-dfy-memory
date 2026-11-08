/**
 * lib/daily-archive.js —— 按天归档（只写不改）
 * ============================================================================
 * 输出：<dataRoot>/archive/chat-logs/<YYYY-MM-DD>.md
 *   · 过去的日期：文件已存在就**跳过**，绝不覆盖（DSH 日志可能被清理，
 *     一旦清理，那天的记录就补不回来了 —— 归档是唯一留存）
 *   · 今天：允许重写（这天还在长）
 *   · README.md：每次都按磁盘现状重建（它只是目录，不是数据）
 *
 * 格式与历史文件保持一致（`**HH:MM:SS** You/Her`），这样新旧混着看不会别扭。
 * ============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { dayOf, clockOf } from './chatlog.js';

export function archiveLogDir(dataRoot) {
  return path.join(dataRoot, 'archive', 'chat-logs');
}

function render(day, events) {
  const me = events.filter((e) => e.who === 'me').length;
  const her = events.filter((e) => e.who === 'her').length;
  const head = [
    `# ${day}`,
    '',
    `- 共 ${events.length} 条（你 ${me} / 她 ${her}）`,
    `- 时间跨度：${clockOf(events[0].ts)} → ${clockOf(events[events.length - 1].ts)}`,
    '',
    '> 原始内容，未改写。你那条来自消息快照（时间 = 唤醒时间 − ago）；',
    '> 她那条来自实际发送的工具调用（发送失败的不计入）。',
    '> `--- session switch ---` 表示桥接换了会话。',
    '',
    '---',
    '',
  ].join('\n');

  let dropped = false;
  const body = events.map((e) => {
    let mark = '';
    if (!dropped && e.session !== events[0].session) {
      mark = '\n--- session switch ---\n\n';
      dropped = true;
    }
    return `${mark}**${clockOf(e.ts)}** ${e.who === 'me' ? 'You' : 'Her'}\n\n${e.text.split('\n').map((l) => `  ${l}`).join('\n')}`;
  }).join('\n\n');
  return `${head}${body}\n`;
}

/** 从已有文件里读回统计（用于重建索引） */
function statsOf(file) {
  try {
    const t = fs.readFileSync(file, 'utf8');
    const m = t.match(/- 共 (\d+) 条（你 (\d+) \/ 她 (\d+)）/);
    return m ? { total: Number(m[1]), me: Number(m[2]), her: Number(m[3]) } : null;
  } catch {
    return null;
  }
}

/**
 * 导出（只写不改）。
 * @returns {{dir, written: string[], skipped: string[], days: number}}
 */
export function exportDaily({ dataRoot, events, now = Date.now() }) {
  const dir = archiveLogDir(dataRoot);
  fs.mkdirSync(dir, { recursive: true });

  const today = dayOf(now);
  const byDay = new Map();
  for (const e of events) {
    const d = dayOf(e.ts);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(e);
  }

  const written = [];
  const skipped = [];
  for (const [day, list] of [...byDay.entries()].sort()) {
    const file = path.join(dir, `${day}.md`);
    // 过去的日期：已存在就不动
    if (day !== today && fs.existsSync(file)) { skipped.push(day); continue; }
    fs.writeFileSync(file, render(day, list), 'utf8');
    written.push(day);
  }

  // 重建索引（磁盘现状为准，包含"这次没导出但还在"的存档）
  const days = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort();
  const rows = ['# Chat logs index', '', `Updated: ${new Date(now).toLocaleString('zh-CN', { hour12: false })}`, '', '| Day | You | Her | Total |', '|---|---|---|---|'];
  for (const f of days) {
    const day = f.replace(/\.md$/, '');
    const s = statsOf(path.join(dir, f));
    const tail = byDay.has(day) ? '' : ' ⚠️ 存档（本次未重新导出）';
    rows.push(s ? `| ${day} | ${s.me} | ${s.her} | ${s.total} |${tail}` : `| ${day} | ? | ? | ? |${tail}`);
  }
  fs.writeFileSync(path.join(dir, 'README.md'), `${rows.join('\n')}\n`, 'utf8');

  return { dir, written, skipped, days: days.length };
}

/** 只看现状 */
export function archiveLogStats(dataRoot) {
  const dir = archiveLogDir(dataRoot);
  try {
    const days = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort();
    return { days: days.length, first: days[0]?.replace(/\.md$/, '') ?? null, last: days[days.length - 1]?.replace(/\.md$/, '') ?? null, dir };
  } catch {
    return { days: 0, first: null, last: null, dir };
  }
}
