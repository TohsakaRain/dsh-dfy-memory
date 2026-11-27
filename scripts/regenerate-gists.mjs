// 一次性回填：把 0.12.2 之前「按旧规则砍尾巴」模糊掉的正文，换成新规则的「一句事实」。
//
// 为什么需要：maintainMemories 只在 stage 变大时动手；已经模糊过的条目
// （blurStage 1/2）不会再被处理一次，于是它们永远停在旧的截断文本上。
//
// 规则：
//   · 只动「已经是模糊态（blurStage>0）」且「正文比 hook 长」的
//   · 新正文 = hook（和 gistOf 一致）；textBefore 不动（原文永远留着）
//   · 改前备份 memory.json
//   · --dry 只看会改哪些
import fs from 'node:fs';

const MEM = 'D:/dfy/dsh-dfy-memory/memory/memory.json';
const dry = process.argv.includes('--dry');

const HOOK_MAX = 24;

/** 与 lib/memory-store.js 的 gistOf 保持一致 */
function gistOf(entry) {
  const original = String(entry?.textBefore || entry?.text || '').trim();
  if (!original) return '';
  if (original.length <= HOOK_MAX) return original;
  const hook = String(entry?.hook ?? '').trim();
  return hook || '';   // 没有 hook 的不动（autoHook 已经在写入时生成过）
}

const doc = JSON.parse(fs.readFileSync(MEM, 'utf8').replace(/^\uFEFF/, ''));
const entries = doc.entries || [];
const changes = [];

for (const e of entries) {
  if (!(Number(e.blurStage) > 0)) continue;          // 没模糊过的不动
  const next = gistOf(e);
  if (!next) continue;                                // 没 hook 的不动
  const cur = String(e.text ?? '');
  if (next === cur) continue;                         // 已经是那句了
  if (next.length >= cur.length) continue;            // 不会更长（安全）
  changes.push({ id: e.id, tier: e.tier, stage: e.blurStage, from: cur, to: next });
  if (!dry) e.text = next;
}

console.log(`模糊态条目里，${changes.length} 条可以换成「一句事实」：\n`);
for (const c of changes) {
  console.log(`[${c.tier} stage=${c.stage}] ${c.id}`);
  console.log(`  旧(${c.from.length}字): ${c.from}`);
  console.log(`  新(${c.to.length}字): ${c.to}`);
  console.log();
}

if (dry) {
  console.log('（dry run，没有写）');
} else if (changes.length) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bak = `${MEM}.bak-regist-${stamp}`;
  fs.copyFileSync(MEM, bak);
  fs.writeFileSync(MEM, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  // memory.md 跟着重写（它是只读视图，但头里的统计要同步）
  try {
    const { exportMarkdown } = await import('../lib/memory-store.js');
    exportMarkdown('D:/dfy/dsh-dfy-memory/memory');
    console.log('memory.md 已同步');
  } catch (e) {
    console.log('memory.md 没同步（不影响数据）：' + (e?.message ?? e));
  }
  console.log(`\n已写回 ${changes.length} 条；备份：${bak}`);
} else {
  console.log('没有需要改的。');
}
