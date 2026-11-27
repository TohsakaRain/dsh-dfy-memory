// 一次性回填：把「标签里有项目名」的记忆补上 project 字段。
//
// 为什么：project 是 0.12.3 才加的字段，0.12.3 之前存的记忆一条都没有。
// 而 settle(project="白饭派") 现在虽然能回落标签匹配，但 project 字段空着有两个问题：
//   ① 按 project 过滤的召回/统计看不到它们
//   ② 以后想把「白饭派」改名，得同时改标签和 project 两处
//
// 规矩：
//   · **只回填注册表里真实存在的项目名**（works/*/projects.json），不猜
//   · 只动 tags 里明确有这个项目名、且**还没有 project 字段**的条目
//   · 改前备份 memory.json；--dry 只看会改哪些
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.DFY_DATA_ROOT || 'D:/dfy/dsh-dfy-memory';
const MEM = path.join(ROOT, 'memory', 'memory.json');
const dry = process.argv.includes('--dry');

// 注册表里真实存在的项目（text + image 去重）
const projects = new Set();
for (const cat of ['text', 'image']) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'works', cat, 'projects.json'), 'utf8'));
    for (const p of j.projects || []) if (p?.name) projects.add(String(p.name).trim());
  } catch { /* 没有就算了 */ }
}
if (!projects.size) {
  console.error('一个项目都没注册（works/*/projects.json），不猜，退出。');
  process.exit(1);
}
console.log('注册的项目：' + [...projects].join('、') + '\n');

const doc = JSON.parse(fs.readFileSync(MEM, 'utf8').replace(/^\uFEFF/, ''));
const entries = doc.entries || [];
const changes = [];

for (const e of entries) {
  if (e.project) continue;                       // 已经有 project 的不动
  const tags = (e.tags || []).map((t) => String(t).trim());
  const hit = tags.filter((t) => projects.has(t));
  if (!hit.length) continue;                     // 标签里没有项目名 → 不猜
  if (hit.length > 1) {
    console.log(`⚠️ 跳过 ${e.id}：同时命中多个项目 ${JSON.stringify(hit)}，需要人判断`);
    continue;
  }
  changes.push({ id: e.id, tier: e.tier, project: hit[0], tags, text: String(e.text).slice(0, 40) });
  if (!dry) e.project = hit[0];
}

console.log(`共 ${entries.length} 条，${changes.length} 条需要补 project：\n`);
const byProj = new Map();
for (const c of changes) {
  if (!byProj.has(c.project)) byProj.set(c.project, []);
  byProj.get(c.project).push(c);
}
for (const [proj, list] of byProj) {
  console.log(`【${proj}】${list.length} 条`);
  for (const c of list) console.log(`  [${c.tier}] ${c.id}  ${c.text}`);
  console.log();
}

if (dry) {
  console.log('（dry run，没有写）');
} else if (changes.length) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bak = `${MEM}.bak-project-${stamp}`;
  fs.copyFileSync(MEM, bak);
  fs.writeFileSync(MEM, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  console.log(`已写回 ${changes.length} 条；备份：${bak}`);
} else {
  console.log('没有需要补的。');
}
