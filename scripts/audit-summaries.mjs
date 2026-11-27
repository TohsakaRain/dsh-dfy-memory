// 只读审计：33 天的对话摘要是「纪要」还是「第二份日记」。
//
// 背景（2026-11-27）：dfy_context_summarize 的契约改成了「第三人称、只记事实」，
// 但这只影响**以后**写的。历史 33 篇全是她按老契约写的，人称混着来。
// 那些是她亲手写的稿子（by=agent），机器**不替她改** —— 这个脚本只负责指出哪几篇值得重写。
//
// 用法：
//   node scripts/audit-summaries.mjs              # 列表
//   node scripts/audit-summaries.mjs --json       # 给机器看
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.DFY_CONTEXT_DIR || 'D:/dfy/dsh-dfy-memory/context';
const asJson = process.argv.includes('--json');

/** 评价性/主观词——这些出现在摘要里，查的时候分不清哪句是事实。 */
const JUDGE_WORDS = [
  '那是他的', '活该', '不值得', '太差', '过分', '恶心', '讨厌',
  '我觉得他', '他就是', '他根本', '他从来', '反正他', '不像话',
];
/** 否定/引用用法：「没毛病」「没问题的」是夸，不是评价 —— 先剔掉再查。 */
const NEGATED = /没毛病|没问题|没意见|不算毛病|不是毛病/g;
/** 明显的日记句式（第一人称 + 情绪）。 */
const DIARY_RE = /(我(心里|觉得|怕|想|难受|高兴|有点|终于)|让我|我说|我说了)/;

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (ent.name.endsWith('.s.md')) out.push(p);
  }
  return out;
}

const rows = [];
for (const abs of walk(ROOT).sort()) {
  const raw = fs.readFileSync(abs, 'utf8');
  const head = (raw.match(/^<!--[^>]*-->/) || [''])[0];
  const by = (head.match(/by=(\w+)/) || [])[1] || 'unknown';
  const day = (head.match(/day=(\d{4}-\d{2}-\d{2})/) || [])[1] || path.basename(abs, '.s.md');
  const body = raw.replace(/^<!--[\s\S]*?-->\n?/, '').trim();

  const me = (body.match(/我/g) || []).length;
  const other = (body.match(/[他她你]/g) || []).length;
  // 先剔掉「没毛病」这类否定用法，再看评价词
  const judgeText = body.replace(NEGATED, '');
  const judge = JUDGE_WORDS.filter((w) => judgeText.includes(w));
  const diaryish = DIARY_RE.test(body);
  // 打分：0 = 像纪要，越高越像日记
  let score = 0;
  if (me >= 8) score += 2; else if (me >= 4) score += 1;
  if (other > 0 && me / Math.max(1, other) > 0.35) score += 1;
  if (diaryish) score += 1;
  if (judge.length) score += 1;

  rows.push({
    day, by, chars: body.length, me, other,
    judge, diaryish, score,
    file: path.relative(ROOT, abs).replace(/\\/g, '/'),
    first: (body.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '').slice(0, 60),
  });
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const agent = rows.filter((r) => r.by === 'agent').length;
  console.log(`共 ${rows.length} 篇（by=agent ${agent} / 其它 ${rows.length - agent}），按「像日记」程度排序：\n`);
  const flagged = rows.filter((r) => r.score >= 2).sort((a, b) => b.score - a.score || b.chars - a.chars);
  if (!flagged.length) {
    console.log('没有明显像日记的——都读得出是纪要。');
  } else {
    for (const r of flagged) {
      console.log(`[${r.score}] ${r.day}  ${r.chars} 字  「我」${r.me} / 他她你${r.other}${r.judge.length ? '  ⚠️ 评价词：' + r.judge.join('、') : ''}`);
      console.log(`      ${r.first}`);
    }
  }
  const ok = rows.filter((r) => r.score < 2);
  console.log(`\n剩下 ${ok.length} 篇读起来是纪要，不用动。`);
  console.log('\n⚠️ 这些是她亲手写的（by=agent），机器不改。要重写就她自己用：');
  console.log('   dfy_context_summarize(day="YYYY-MM-DD", text="第三人称、只记事实…")');
}
