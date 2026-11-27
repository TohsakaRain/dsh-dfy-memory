// 一次性回填：把 46 条记忆里「机器截的、断在半词上的」hook 换成 autoHook 的新实现。
// 规矩：
//   · 只动「hook === 旧 autoHook(text)」的那些（她手写的 hook 一个字都不碰）
//   · 改完先备份 memory.json 到 memory.json.bak-hook-<时间戳>
//   · --dry 只看会改哪些
import fs from 'node:fs';
import path from 'node:path';

const MEM = 'D:/dfy/dsh-dfy-memory/memory/memory.json';
const dry = process.argv.includes('--dry');

const HOOK_MAX = 24;
const SENTENCE_END = /[。！？；\n]/;

/** 新实现（与 lib/memory-store.js 的 autoHook 保持逐字一致） */
function autoHook(text) {
  const s = String(text ?? '').trim();
  if (!s) return '';
  const noDate = s.replace(/^\d{4}-\d{2}-\d{2}\s*[：:，,、]?\s*/, '');
  const first = (noDate.split(SENTENCE_END)[0] || '').trim();
  if (first.length >= 6 && first.length <= HOOK_MAX) return first;
  if (first.length > HOOK_MAX) {
    const head = first.slice(0, HOOK_MAX);
    let at = -1;
    for (const m of head.matchAll(/[，、：,]/g)) at = m.index;
    if (at >= 10) return head.slice(0, at).trim();
    return head.replace(/[，、：,\s—]+$/, '').trim();
  }
  if (noDate.length <= HOOK_MAX) return noDate;
  const head = noDate.slice(0, HOOK_MAX);
  let at = -1;
  for (const m of head.matchAll(/[，、：,\s]/g)) at = m.index;
  return (at >= 8 ? head.slice(0, at) : head).replace(/[，、：,\s—]+$/, '').trim();
}

/** 旧实现（用来判断"这条 hook 是不是机器截的"） */
function oldAutoHook(text) {
  const s = String(text ?? '').trim();
  if (!s) return '';
  const noDate = s.replace(/^\d{4}-\d{2}-\d{2}\s*[：:，,、]?\s*/, '');
  const first = noDate.split(/[。！？；\n]/)[0].trim();
  const base = first.length >= 6 ? first : noDate;
  return base.length > 24 ? base.slice(0, 24) : base;
}

const doc = JSON.parse(fs.readFileSync(MEM, 'utf8').replace(/^\uFEFF/, ''));
const entries = doc.entries || [];
const changes = [];

for (const e of entries) {
  const cur = String(e.hook ?? '');
  if (!cur) continue;
  // 只动机器截的（逐字等于旧 autoHook 输出）
  if (cur !== oldAutoHook(e.text)) continue;
  const next = autoHook(e.text);
  if (!next || next === cur) continue;
  changes.push({ id: e.id, tier: e.tier, text: String(e.text).slice(0, 60), from: cur, to: next });
  if (!dry) e.hook = next;
}

console.log(`共 ${entries.length} 条，机器生成的 hook ${changes.length} 条需要改：\n`);
for (const c of changes) {
  console.log(`[${c.tier}] ${c.id}`);
  console.log(`  旧: ${c.from}`);
  console.log(`  新: ${c.to}`);
}

if (dry) {
  console.log('\n（dry run，没有写）');
} else if (changes.length) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bak = `${MEM}.bak-hook-${stamp}`;
  fs.copyFileSync(MEM, bak);
  fs.writeFileSync(MEM, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  console.log(`\n已写回 ${changes.length} 条；备份：${bak}`);
} else {
  console.log('\n没有需要改的。');
}
