/**
 * lib/day-paths.js —— 按天文件的位置解析（2026-11-21 起按月分目录）
 * ============================================================================
 * 旧形状（平铺，一年 365 个）：   <dir>/2026-10-25.md
 * 新形状（按月，一年 12 个）：   <dir>/2026-10/2026-10-25.md
 *
 * 两条铁律：
 *   · **读一律走 resolveDayFile()**：先月份目录、再平铺。迁移前后都能读到，
 *     不会因为改路径把她的摘要/原声读空（这块踩过坑：D-1 守卫读错形态，
 *     把她写过的摘要删过一次，后来从 tool-calls.jsonl 里捞回来的）。
 *   · **写一律走 dayFilePath()**：固定新位置，自动建月份目录。
 *
 * 列目录别再用裸 readdirSync —— 用 listDayFiles()，它同时认平铺和分月。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 日期 → 月份目录名：'2026-10-25' → '2026-10' */
export function monthOf(day) {
  return String(day ?? '').slice(0, 7);
}

/** 写的位置：<dir>/<YYYY-MM>/<day><suffix>（不检查是否存在，调用方自己建目录） */
export function dayFilePath(dir, day, suffix = '.md') {
  return path.join(dir, monthOf(day), `${day}${suffix}`);
}

/** 读的位置：先月份目录，再平铺（兼容迁移前的存量）；都没有就返回月份目录那个（便于调用方判断不存在） */
export function resolveDayFile(dir, day, suffix = '.md') {
  const next = dayFilePath(dir, day, suffix);
  if (fs.existsSync(next)) return next;
  const legacy = path.join(dir, `${day}${suffix}`);
  if (fs.existsSync(legacy)) return legacy;
  return next;
}

/** 读之前先确保月份目录在（写的时候用） */
export function ensureDayDir(dir, day) {
  const d = path.join(dir, monthOf(day));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * 列出目录下所有「<YYYY-MM-DD><suffix>」文件，**同时认平铺和分月**。
 * @param {string} dir 根目录（如 context/ 或 archive/chat-logs/）
 * @param {string} suffix 形如 '.md' / '.s.md' / '.full.md'
 * @returns {{day:string, name:string, rel:string, abs:string}[]} rel 是相对 dir 的路径（含月份）
 */
export function listDayFiles(dir, suffix = '.md') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const esc = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})${esc}$`);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }

  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      // 只认 YYYY-MM 形状；_replaced 之类的杂目录跳过
      if (!/^\d{4}-\d{2}$/.test(ent.name)) continue;
      let inner = [];
      try { inner = fs.readdirSync(full, { withFileTypes: true }); } catch { continue; }
      for (const f of inner) {
        if (!f.isFile()) continue;
        const m = f.name.match(re);
        if (!m) continue;
        out.push({ day: m[1], name: f.name, rel: path.join(ent.name, f.name), abs: path.join(full, f.name) });
      }
    } else if (ent.isFile()) {
      const m = ent.name.match(re);
      if (!m) continue;
      out.push({ day: m[1], name: ent.name, rel: ent.name, abs: full });
    }
  }
  return out;
}

/**
 * 把一批存量文件从平铺挪进月份目录（迁移用，幂等）。
 * @returns {{moved:number, skipped:number, items:string[]}}
 */
export function migrateToMonths(dir, suffix = '.md') {
  let moved = 0, skipped = 0;
  const items = [];
  if (!fs.existsSync(dir)) return { moved, skipped, items };
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isFile()); } catch { return { moved, skipped, items }; }
  const esc = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})${esc}$`);
  for (const n of names) {
    const m = n.match(re);
    if (!m) continue;
    const target = dayFilePath(dir, m[1], suffix);
    if (fs.existsSync(target)) { skipped += 1; continue; }
    try {
      ensureDayDir(dir, m[1]);
      fs.renameSync(path.join(dir, n), target);
      moved += 1;
      items.push(n);
    } catch { skipped += 1; }
  }
  return { moved, skipped, items };
}
