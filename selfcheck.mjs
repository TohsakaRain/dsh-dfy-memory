/**
 * 自检：不依赖 DSH、不依赖桥接，直接跑数据层。
 * 用**临时目录**，绝不碰真实的 diary / memory / state。
 *
 *   node plugins/dsh-dfy-memory/selfcheck.mjs
 *
 * 注意：门面是**薄透传**，返回形状与 lib/ 里原始函数完全一致（为了以后桥接能 1:1 换过来）：
 *   memory.add()   → { entry, duplicate }
 *   memory.recall()→ 数组
 *   promises.add() → { item, duplicate }
 *   promises.due() → 单条 或 null
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, createMemoryFacade, resolvePaths } from './index.js';
import { sendLetter, listLetters, readLetter, mailStats } from './lib/mailbox.js';
import { todayMoodCount } from './lib/emotion.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dfy-memory-check-'));
const paths = { diaryDir: path.join(tmp, 'diary'), memoryDir: path.join(tmp, 'memory'), stateDir: path.join(tmp, 'state') };
for (const d of Object.values(paths)) fs.mkdirSync(d, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✔ ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ✘ ${label}${extra ? '  ' + extra : ''}`); }
};

console.log('临时目录:', tmp);

// ── 1. 插件能加载 ────────────────────────────────────────────────
console.log('\n[1] 插件加载');
let provided = null;
const ctx = { logger: { info: () => {} }, provide: (n, v) => { provided = { n, v }; } };
try {
  apply(ctx, paths);
  ok(true, 'apply() 不抛异常');
  ok(provided?.n === 'dfyMemory', '提供了 dfyMemory 服务');
} catch (e) {
  ok(false, 'apply() 不抛异常', String(e?.message ?? e));
}
ok(typeof provided?.v?.memory?.add === 'function', '门面有 memory.add');

const f = createMemoryFacade(paths);

// ── 2. 长期记忆 ──────────────────────────────────────────────────
console.log('\n[2] 长期记忆');
const a = f.memory.add({ text: '他叫 TohsakaRain，喜欢别人叫他阿雨', who: '365845801', tier: 'core', tags: ['名字'] });
ok(!!a?.entry?.id, '写入一条 core 记忆', `id=${a?.entry?.id} duplicate=${a?.duplicate}`);
f.memory.add({ text: '他讨厌半夜被消息吵醒', tier: 'important', tags: ['雷区'] });
f.memory.add({ text: '今天聊了刷B站的事', tier: 'normal' });

const dup = f.memory.add({ text: '他讨厌半夜被消息吵醒', tier: 'normal' });
ok(dup?.duplicate === true, '同内容再写一次 → 判重，不新增');

const hit = f.memory.recall({ query: '阿雨', limit: 5 });
ok(hit.length === 1, '按关键词召回', `命中 ${hit.length} 条`);

const st = f.memory.stats();
ok(st.total === 3, '统计总数 = 3（判重那条没新增）', `total=${st.total}`);

const core = f.memory.recall({ tier: 'core' });
ok(core.length === 1 && core[0].tier === 'core', '按层筛选 core');

const before = core[0].score;
f.memory.touch(a.entry.id);
const after = f.memory.recall({ query: '阿雨' })[0].score;
ok(after >= before, 'touch 之后分数不降', `${before.toFixed(3)} → ${after.toFixed(3)}`);

const md = f.memory.render();
ok(typeof md === 'string' && md.includes('阿雨'), '能渲染可读的 memory.md');

const forPrompt = f.memory.forPrompt();
ok(typeof forPrompt === 'string', '能生成注入文本', `${String(forPrompt).length} 字`);

// ── 3. 心情 / 好感度 ─────────────────────────────────────────────
console.log('\n[3] 心情 / 好感度');
f.emotion.setMood({ state: '有点困', cause: '聊到半夜', intensity: 2.5, decayHours: 4 });
const cur = f.emotion.current();
ok(cur?.tone === '有点困', '写入并读到心情', cur?.tone);
ok(cur?.effective >= 5 && cur?.effective <= 7, '当下分 = 底色 + 冲量（v2 是 1~10 的分，不是强度）', `effective=${Number(cur?.effective).toFixed(2)}`);

f.emotion.setAffinity({ who: '365845801', score: 7.5, note: '一起做了很多事' });
const aff = f.emotion.getAffinity('365845801');
ok(aff?.score === 7.5, '好感度写入并读回');

const emoTxt = f.emotion.format({ who: '365845801' });
ok(typeof emoTxt === 'string' && emoTxt.length > 0, '能生成注入文本', `${String(emoTxt).length} 字`);

// ── 4. 承诺 ──────────────────────────────────────────────────────
console.log('\n[4] 承诺');
const p = f.promises.add({ text: '晚上给他讲讲今天刷到什么', dueInMinutes: 1 });
ok(!!p?.item?.id, '写入一条承诺', `id=${p?.item?.id}`);

const nowDue = f.promises.due(Date.now());
ok(nowDue === null, '刚到点不该立刻到期（1 分钟后）');

const laterDue = f.promises.due(Date.now() + 2 * 60 * 1000);
ok(!!laterDue && laterDue.id === p.item.id, '模拟 2 分钟后 → 到点');

f.promises.markNotified(p.item.id);
const afterNotify = f.promises.due(Date.now() + 2 * 60 * 1000);
ok(afterNotify === null, '标记后不再重复提醒');

f.promises.drop(p.item.id);
const list = f.promises.list();
ok(Array.isArray(list) && list.length === 0, '丢弃后列表为空');

// ── 5. 路径解析 ──────────────────────────────────────────────────
console.log('\n[5] 路径解析');
const rp = resolvePaths({ memoryDir: paths.memoryDir });
ok(rp.memoryDir === path.resolve(paths.memoryDir), 'config 优先');
const envBefore = process.env.DFY_MEMORY_DIR;
process.env.DFY_MEMORY_DIR = tmp;
ok(resolvePaths({}).memoryDir === path.resolve(tmp), '环境变量次之');
if (envBefore === undefined) delete process.env.DFY_MEMORY_DIR; else process.env.DFY_MEMORY_DIR = envBefore;

// ── 6. 日记 ─────────────────────────────────────────────────────
console.log('\n[6] 日记');
const d1 = f.diary.write({ text: '今天把插件工具写完了', mood: '有点累' });
ok(d1.ok && d1.sections === 1, '写第一段', `sections=${d1.sections}`);

const dGap = f.diary.write({ text: '紧接着再写一段' });
ok(dGap.ok === false && /别连着写/.test(dGap.error), '3 秒内连写被拒（防重复提交）');

await new Promise((r) => setTimeout(r, 3100));
const d2 = f.diary.write({ text: '补一段：晚上还跑了自检' });
ok(d2.ok && d2.sections === 2, '隔 3 秒再写 → 第 2 段', `sections=${d2.sections}`);

const dRead = f.diary.read();
ok(dRead.ok && !dRead.empty && dRead.text.includes('插件工具'), '读回内容含正文');
ok(dRead.text.includes('## '), '段落标题格式正确（## HH:MM）');

const dList = f.diary.list({ limit: 5 });
ok(dList.ok && dList.days.length === 1 && dList.days[0].date === f.diary.today(), '列最近 1 天', dList.days[0]?.date);

const dBad1 = f.diary.read({ date: '../etc/passwd' });
ok(dBad1.ok === false, '非法日期（穿越）被拒');
const dBad2 = f.diary.read({ date: '2026/10/28' });
ok(dBad2.ok === false, '非法日期（斜杠）被拒');
const dStatus = f.diary.status();
ok(dStatus.today === f.diary.today() && dStatus.todaySections === 2, '状态：今天已写 2 段');

// ── 7. 工具注册（14 个，且能真的执行）──────────────────────────
console.log('\n[7] 工具注册');
const EXPECTED = [
  'dfy_diary_write', 'dfy_diary_read', 'dfy_diary_list',
  'dfy_memory_save', 'dfy_memory_recall', 'dfy_memory_touch', 'dfy_memory_update',
  'dfy_memory_forget', 'dfy_memory_stats',
  'dfy_mood', 'dfy_affinity', 'dfy_promise', 'dfy_promises', 'dfy_promise_drop',
  'dfy_archive_search', 'dfy_archive_get', 'dfy_archive_stats',
  'dfy_context_list', 'dfy_context_get', 'dfy_context_summarize',
  'dfy_work_save', 'dfy_work_image', 'dfy_works', 'dfy_work_read',
];
const reg = new Map();
const toolCtx = {
  logger: { info: () => {} },
  provide: () => {},
  tools: { register: (t) => reg.set(t.name, t) },
};
apply(toolCtx, paths);
ok(reg.size === 36, '注册了 36 个工具（+ context_* / mail_* / mood_trend / work_archive / versions / restore / draft / drafts / finalize）', `实际 ${reg.size}`);
const missing = EXPECTED.filter((n) => !reg.has(n));
ok(missing.length === 0, '24 个名字齐全', missing.length ? `缺 ${missing.join(',')}` : '');
ok([...reg.values()].every((t) => typeof t.output?.render === 'function'), '每个都有 output.render');
ok([...reg.values()].every((t) => typeof t.execute === 'function'), '每个都有 execute');

// ⚠️ 2026-10-28 真实事故：parameters 传"属性表"会让 DeepSeek 报
//    `schema must be a JSON Schema of 'type: "object"', got 'type: null'`，
//    后果是**整轮运行失败**（不只是这个工具不能用）。必须断言完整 schema。
const badSchema = [...reg.values()].filter((t) => {
  const p = t.parameters;
  return !(p && p.type === 'object' && typeof p.properties === 'object' && p.additionalProperties !== undefined);
});
ok(badSchema.length === 0, 'parameters 全是合法 JSON Schema', badSchema.length ? `坏了 ${badSchema.map((t) => t.name).join(',')}` : '');
ok(reg.get('dfy_affinity')?.parameters?.properties?.score?.type === 'number', 'dfy_affinity.score 声明为 number');

// ⚠️ 2026-10-28 事故：返回**字符串**会被 DSH 判 `invalid output: "value" must be an object`。
//    所以 execute 一律返回对象（字符串被包成 { message }）。这里断言这一点。
const textOf = (v) => (typeof v === 'string' ? v : String(v?.message ?? JSON.stringify(v)));

const rMood = await reg.get('dfy_mood').execute({ state: '自检中', cause: '跑用例', intensity: 2 });
ok(rMood !== null && typeof rMood === 'object', 'dfy_mood 返回对象（不是字符串）');
ok(textOf(rMood).includes('自检中'), 'dfy_mood 内容正确', textOf(rMood).slice(0, 30));

const rMem = await reg.get('dfy_memory_recall').execute({});
ok(rMem !== null && typeof rMem === 'object', 'dfy_memory_recall 返回对象');

const rProm = await reg.get('dfy_promises').execute({});
ok(rProm !== null && typeof rProm === 'object', 'dfy_promises 返回对象');

// 全部 14 个都必须是对象（抽查空参数与带参数的两种）
let notObject = [];
for (const [name, t] of reg) {
  if (name === 'dfy_memory_save' || name === 'dfy_diary_write' || name === 'dfy_promise' || name === 'dfy_affinity') continue; // 写操作另测
  try {
    const out = await t.execute({}, null);
    if (out === null || typeof out !== 'object') notObject.push(name);
  } catch { /* 参数不足抛错不算这条 */ }
}
ok(notObject.length === 0, '读类工具返回都是对象', notObject.length ? `不是对象：${notObject.join(',')}` : '');

// ── 8. 生命周期 + 归档 ───────────────────────────────────────────
console.log('\n[8] 生命周期 / 归档');
const DAY = 24 * 60 * 60 * 1000;
const memFile = path.join(paths.memoryDir, 'memory.json');

/** 把某条的时间戳往前挪 n 天（直接改文件，模拟"过了 n 天"） */
const backdate = (id, days) => {
  const doc = JSON.parse(fs.readFileSync(memFile, 'utf8'));
  const e = doc.entries.find((x) => x.id === id);
  if (!e) return null;
  const ago = Date.now() - days * DAY;
  e.createdAt = ago; e.updatedAt = ago; e.lastRecalledAt = ago;
  fs.writeFileSync(memFile, JSON.stringify(doc, null, 2), 'utf8');
  return e;
};
const findIn = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'memory.json'), 'utf8')).entries;
const longText = '2026-10-20 中午他吃了牛肉面，还特意加了醋，说这是他唯一会主动加醋的场合，其他时候一点都不碰酸的。';

// normal：8 天 → 浓缩到 ≤25 字
const n1 = f.memory.add({ text: longText, tier: 'normal', tags: ['吃饭'] }).entry;
backdate(n1.id, 8);
f.memory.maintain();
const after8 = findIn(paths.memoryDir).find((e) => e.id === n1.id);
ok(after8 && after8.blurStage === 1, 'normal 8 天 → 进入模糊阶段', `stage=${after8?.blurStage}`);
ok(after8 && after8.text.length <= 25, 'normal 模糊后 ≤25 字', `${after8?.text.length} 字：${after8?.text}`);
ok(after8 && after8.textBefore && after8.textBefore.includes('牛肉面'), '模糊前的原文被保留（textBefore）');

// normal：16 天 → 归档（不是删除）
backdate(n1.id, 16);
f.memory.maintain();
const stillActive = findIn(paths.memoryDir).find((e) => e.id === n1.id);
ok(!stillActive, 'normal 16 天 → 从活跃记忆里移走');
const idxFile = path.join(paths.memoryDir, 'archive', 'index.jsonl');
ok(fs.existsSync(idxFile), '归档索引文件已生成');
const idxRows = fs.readFileSync(idxFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
ok(idxRows.some((r) => r.id === n1.id), '归档索引里有这条');

// 归档检索
const hits = f.archive.search({ query: '牛肉面' });
ok(hits.length >= 1, 'archive.search 能按关键词命中', `命中 ${hits.length}`);
const got = f.archive.get([hits[0].id]);
ok(got.length === 1 && String(got[0].text).includes('牛肉面'), 'archive.get 能打开原文');
const as = f.archive.stats();
ok(as.total >= 1 && as.first, 'archive.stats 有统计', `共 ${as.total} 条`);

// 召回兜底：活跃里没有 → 去归档捞
const recalled = f.memory.recall({ query: '牛肉面', limit: 5 });
ok(recalled.some((e) => e.archived), 'recall 在活跃命中不足时兜底查归档');

// important：22 天 → 100 字；36 天 → 25 字；都还在活跃
const i1 = f.memory.add({ text: longText, tier: 'important', tags: ['吃饭'] }).entry;
backdate(i1.id, 22);
f.memory.maintain();
const after22 = findIn(paths.memoryDir).find((e) => e.id === i1.id);
ok(after22 && after22.blurStage === 1 && after22.text.length <= 100, 'important 22 天 → ≤100 字', `${after22?.text.length} 字`);
backdate(i1.id, 36);
f.memory.maintain();
const after36 = findIn(paths.memoryDir).find((e) => e.id === i1.id);
ok(after36 && after36.blurStage === 2 && after36.text.length <= 25, 'important 36 天 → ≤25 字', `${after36?.text.length} 字`);
ok(after36 !== undefined, 'important 最终模糊后仍在活跃记忆（不归档）');

// core：100 天不变
const c1 = f.memory.add({ text: longText, tier: 'core' }).entry;
backdate(c1.id, 100);
f.memory.maintain();
const afterCore = findIn(paths.memoryDir).find((e) => e.id === c1.id);
ok(afterCore && afterCore.blurStage === 0 && afterCore.text === longText, 'core 100 天 → 完全不变');

// normal 被提到 → mentionBonus +1 天（寿命延长）
const n2 = f.memory.add({ text: '他喜欢下雨天', tier: 'normal' }).entry;
f.memory.touch(n2.id);
const touched = findIn(paths.memoryDir).find((e) => e.id === n2.id);
ok(Number(touched.mentionBonus) === DAY, 'normal 被提到一次 → mentionBonus = 1 天', String(touched.mentionBonus));

// 注入里有归档提示
const prompt = f.memory.forPrompt();
ok(String(prompt).includes('dfy_archive_search'), '注入里带归档提示行');

// blurText 的边界
ok(f.memory.blur('短句', 25) === '短句', 'blurText 不超长就不动');
ok(f.memory.blur('一二三四五六七八九十十一十二', 10).length <= 11, 'blurText 截断后带省略号');

// ── 9. 7 天窗口 ─────────────────────────────────────────────────
console.log('\n[9] 7 天窗口');
const { rollWindow, listWindow, readWindowFile, writeWindowFile, summarizeDay, truncateForBudget } = await import(
  'file:///D:/dfy/qq-bridge/plugins/dsh-dfy-memory/lib/window.js'
);
const ctxDir = path.join(tmp, 'context');
const DAYMS = 24 * 60 * 60 * 1000;
const nowMs = Date.now();
const fakeEvents = [];
for (let d = 7; d >= 1; d--) {
  const base = nowMs - d * DAYMS;
  for (let i = 0; i < 5; i++) {
    fakeEvents.push({
      key: 't' + d + '-' + i,
      who: i % 2 ? 'her' : 'me',
      text: '第' + d + '天的第' + i + '条消息，写得长一点以便观察摘要如何截断，再补一些字凑够长度。',
      ts: base + i * 60000,
      session: 's',
    });
  }
}
const rolled = rollWindow({ ctxDir, events: fakeEvents, now: nowMs });
const winList = listWindow(ctxDir);
ok(winList.length === 6, '窗口恰好 6 个文件', '实际 ' + winList.length);
ok(winList.every((w) => w.kind === 'full' ? true : w.chars <= 1200), '所有摘要 ≤1200 字');
const oldest = winList[0];
ok(oldest && oldest.chars <= 320, '最远那天 ≈300 字（旧版 80 太少，10-06 已上调；头尾必留会有几字溢出）', oldest ? oldest.chars + ' 字' : '无');
const fulls = winList.filter((w) => w.kind === 'full');
ok(fulls.length === 1, '只有昨天是全量', '实际 ' + fulls.length);
ok(
  winList.every((w) => w.file === `${w.day}.${w.kind === 'full' ? 'full' : 's'}.md`),
  '列表返回的 kind 与文件名一致',
  winList.map((w) => w.file + '→' + w.kind).join(' '),
);

// 她重写 → 再滚不覆盖
const target = winList.find((w) => w.kind === 'summary');
summarizeDay({ ctxDir, day: target.day, text: '（她写的）那天聊了插件和归档。' });
const rolled2 = rollWindow({ ctxDir, events: fakeEvents, now: nowMs });
const afterSum = readWindowFile(ctxDir, target.day);
ok(afterSum.by === 'agent' && afterSum.text.includes('她写的'), '她写过的摘要不被覆盖');
ok(rolled2.kept.some((k) => k.includes(target.day)), '滚动结果里标注了"保留"');

// ⭐ 回归：同一天不能同时留 full 和 summary（2026-11-01 实测发现会积成 9 个文件）
const dayKinds = (list) => {
  const m = new Map();
  let dup = '';
  for (const w of list) {
    if (m.has(w.day)) dup = w.day;
    m.set(w.day, w.kind);
  }
  return dup;
};
ok(!dayKinds(listWindow(ctxDir)), '同一天不会同时存在 full 和 summary', '重复：' + dayKinds(listWindow(ctxDir)));

// 跨天滚动：第二天再滚一次，昨天那份全量要缩成摘要、且旧全量被删
const nextDay = nowMs + 86400000;
const rolled3 = rollWindow({ ctxDir, events: fakeEvents, now: nextDay });
const win3 = listWindow(ctxDir);
ok(!dayKinds(win3), '跨天后仍然一天一种形态', '重复：' + dayKinds(win3));
ok(win3.length <= 6, '跨天后文件数仍然 ≤6', '实际 ' + win3.length);
ok(rolled3.removed.length > 0, '跨天滚动确实删掉了旧全量', JSON.stringify(rolled3.removed));

// 超过 6 天会被删
const olderEvent = [{ key: 'old', who: 'me', text: '很久以前', ts: nowMs - 10 * DAYMS, session: 's' }];
rollWindow({ ctxDir, events: [...fakeEvents, ...olderEvent], now: nowMs });
ok(!listWindow(ctxDir).some((w) => w.day === 'x'), '超出窗口的天不会留下');

// truncateForBudget 边界
ok(truncateForBudget('短', 80) === '短', 'truncate 不超长就不动');
ok(truncateForBudget('很长的一段话，'.repeat(20), 20).length <= 21, 'truncate 截断后 ≤上限+1');

// ── 10. 按天归档（只写不改）────────────────────────────────────
console.log('\n[10] 按天归档');
const { exportDaily, archiveLogStats } = await import(
  'file:///D:/dfy/qq-bridge/plugins/dsh-dfy-memory/lib/daily-archive.js'
);
const dataRoot = path.join(tmp, 'dataroot');
const dayEvents = [];
for (let d = 2; d >= 0; d--) {
  // 用"今天 - d 天"，保证最后一天是今天
  const base = Date.now() - d * 86400000;
  for (let i = 0; i < 4; i++) {
    dayEvents.push({ key: 'd' + d + '-' + i, who: i % 2 ? 'her' : 'me', text: '第' + d + '天第' + i + '条消息', ts: base + i * 60000, session: 's' });
  }
}
const arc1 = exportDaily({ dataRoot, events: dayEvents });
ok(arc1.days === 3, '归档写了 3 天', '实际 ' + arc1.days);
ok(arc1.written.length === 3, '首次全部写入');
const arcDir = path.join(dataRoot, 'archive', 'chat-logs');
ok(fs.existsSync(path.join(arcDir, 'README.md')), '生成了 README 索引');
const arc2 = exportDaily({ dataRoot, events: dayEvents });
ok(arc2.skipped.length === 2, '第二次跳过过去两天', '跳过 ' + arc2.skipped.length);
ok(arc2.written.length === 1, '第二次只重写今天');

// 过去的文件不会被覆写（改一个字再跑，内容应保持）
const pastDay = arc2.skipped[0];
const pastFile = path.join(arcDir, pastDay + '.md');
fs.writeFileSync(pastFile, fs.readFileSync(pastFile, 'utf8') + '\n<!-- 手工标记 -->\n', 'utf8');
exportDaily({ dataRoot, events: dayEvents });
ok(fs.readFileSync(pastFile, 'utf8').includes('手工标记'), '过去的归档不被覆盖');

const arcSt = archiveLogStats(dataRoot);
ok(arcSt.days === 3 && arcSt.first && arcSt.last, 'archiveLogStats 统计正确', JSON.stringify(arcSt));

// ── 11. 作品库（文字 / 图片，文件名 = 标题）──────────────────────
console.log('\n[11] 作品库');
const {
  worksDirOf, saveTextWork, saveImageWork, listWorks, readWork, statsWorks, worksHint, sanitizeTitle,
} = await import('file:///D:/dfy/qq-bridge/plugins/dsh-dfy-memory/lib/works.js');
const { listVersions, archiveWork, restoreWork, saveDraft, listDrafts, readDraft, finalizeDraft } = await import('file:///D:/dfy/qq-bridge/plugins/dsh-dfy-memory/lib/works.js');

ok(sanitizeTitle('a/b:c*d?') === 'a_b_c_d_', '非法字符被替换');
ok(sanitizeTitle('  ') === 'untitled', '空标题回退 untitled');
ok(sanitizeTitle('con') === '_con', 'Windows 保留名加下划线');
ok(!sanitizeTitle('../../x').includes('/'), '标题里的路径穿越被吃掉');
ok(path.dirname(worksDirOf(path.join(tmp, 'mem'))) === tmp, 'worksDirOf 与 memory 同级');

const wDir = path.join(tmp, 'works');
const w1 = saveTextWork(wDir, { title: '夜里的鱼', text: '我在水里游了很久。', tags: ['诗'] });
ok(fs.existsSync(w1.path) && path.basename(w1.path) === '夜里的鱼.md', '文字作品：文件名为标题');
ok(fs.readFileSync(w1.path, 'utf8').startsWith('---\ntitle: 夜里的鱼'), '文字作品带 front matter');
const w2 = saveTextWork(wDir, { title: '夜里的鱼', text: '同名第二篇（打磨后）' });
ok(path.basename(w2.path) === '夜里的鱼.md', '同名再存：新稿接位（文件名还是标题）');
ok(w2.archivedOld === 1, '同名再存：旧稿自动归档', 'archivedOld=' + w2.archivedOld);
ok(fs.readFileSync(w2.path, 'utf8').includes('打磨后'), '当前稿是新内容');
const vers = listVersions(wDir, { title: '夜里的鱼' });
ok(vers.length === 1, '归档里能看到 1 个历史版本', 'versions=' + vers.length);
const verFile = path.join(wDir, 'text', vers[0].file);
ok(fs.existsSync(verFile) && fs.readFileSync(verFile, 'utf8').includes('游了很久'), '历史版本里是旧内容');
ok(vers[0].file.startsWith('archive/'), '历史版本落在 text/archive/', vers[0].file);
ok(fs.existsSync(path.join(wDir, 'text', 'archive')), 'text 类型里有 archive 文件夹');
ok(fs.existsSync(path.join(wDir, 'image', 'archive')), 'image 类型里有 archive 文件夹');

// 手动归档：当前稿收进去，归档里变 2 份
const arc = archiveWork(wDir, { title: '夜里的鱼' });
ok(arc.archived === 1, '手动归档：当前稿收进 archive', 'archived=' + arc.archived);
ok(listVersions(wDir, { title: '夜里的鱼' }).length === 2, '手动归档后历史版本变 2 份');
ok(listWorks(wDir, {}).items.filter((x) => x.title === '夜里的鱼').length === 0, '归档后不再出现在作品列表');

const fakeImg = path.join(tmp, 'shot.png');
fs.writeFileSync(fakeImg, Buffer.from('89504e470d0a1a0a', 'hex'));
const w3 = saveImageWork(wDir, { title: '窗边的猫', source: fakeImg });
ok(fs.existsSync(w3.path) && path.basename(w3.path) === '窗边的猫.png', '图片作品：文件名为标题 + 保留扩展名');
ok(fs.existsSync(fakeImg), '图片作品只复制，不动源文件');
let wErr = '';
try { saveImageWork(wDir, { title: 'x', source: path.join(tmp, 'nope.png') }); } catch (e) { wErr = e.message; }
ok(wErr.includes('找不到'), '源不存在时报错');

const wl = listWorks(wDir, {});
ok(wl.total === 1 && wl.byCat.image === 1 && !wl.byCat.text, '列表只数当前稿（归档那件不算）', JSON.stringify(wl.byCat));
const wr = readWork(wDir, { title: '夜里的鱼' });
ok(wr.found && wr.text.includes('游了很久'), '读文字作品返回正文');
const wrImg = readWork(wDir, { file: '窗边的猫.png' });
ok(wrImg.found && wrImg.category === 'image' && fs.existsSync(wrImg.path), '读图片作品返回路径');
const wh = worksHint(wDir);
ok(/^【我的作品】1 件/.test(wh) && /历史版本 2/.test(wh), '提示行能拼出来并带版本数', wh);
ok(statsWorks(wDir).latest, '统计里有最新一件');

// ── 结果 ─────────────────────────────────────────────────────────



// ── 作品归档：恢复方向（2026-11-07） ──────────────────────────────
{
  const rDir = path.join(tmp, 'works-restore');
  const a = saveTextWork(rDir, { title: '旧船票', text: '第一版：想上船。' });
  const b = saveTextWork(rDir, { title: '旧船票', text: '第二版：又不想了。' });
  ok(b.archivedOld === 1, '恢复测试：第二版存进去时第一版进了归档', 'archivedOld=' + b.archivedOld);

  const rr = restoreWork(rDir, { title: '旧船票' });
  ok(rr.restored === 1, '作品归档：能恢复历史版本', JSON.stringify(rr.reason ?? ''));
  const cur = fs.readFileSync(path.join(rDir, 'text', '旧船票.md'), 'utf8');
  ok(cur.includes('想上船'), '恢复回来的是第一版内容', cur.slice(0, 30));
  ok(!fs.readFileSync(path.join(rDir, 'text', '旧船票.md'), 'utf8').includes('又不想了'), '第二版已被归档，不在当前稿');

  const vers = listVersions(rDir, { title: '旧船票' });
  ok(vers.length === 1, '恢复后历史版本变成 1 份（换成了第二版）', 'versions=' + vers.length);

  const bad = restoreWork(rDir, { title: '不存在的作品' });
  ok(bad.restored === 0 && /没有可恢复/.test(bad.reason), '恢复不存在的作品会明确说没有', bad.reason);
}


// ── 草稿 → 定稿（2026-11-07） ────────────────────────────────────
{
  const dDir = path.join(tmp, 'works-drafts');
  const d1 = saveDraft(dDir, { title: '山门', text: '大纲一：师父收我那天在下雨。' });
  ok(fs.existsSync(d1.path), '草稿：能存', d1.path);
  ok(d1.file.startsWith('drafts/'), '草稿：落在 text/drafts/ 下', d1.file);
  ok(fs.existsSync(path.join(dDir, 'text', 'drafts')), '草稿：text 类型里有 drafts 文件夹');
  ok(fs.existsSync(path.join(dDir, 'image', 'drafts')), '草稿：image 类型里也有 drafts 文件夹');

  const d2 = saveDraft(dDir, { title: '山门', text: '大纲二：加了白饭派这条线。' });
  ok(d1.file !== d2.file, '草稿：同名再存不覆盖（多版）', d1.file + ' / ' + d2.file);
  ok(listDrafts(dDir, { title: '山门' }).total === 2, '草稿：同标题能看到 2 版');
  ok(listWorks(dDir, {}).total === 0, '草稿：不算作品（列表里没有）');
  ok(readDraft(dDir, { title: '山门' }).text.includes('白饭派'), '草稿：读最新一版');

  const fin = finalizeDraft(dDir, { title: '山门' });
  ok(fin.finalized && fin.work.title === '山门', '草稿：能定稿成作品', JSON.stringify(fin.work?.file ?? fin.reason));
  ok(fin.work.chars > 0 && fs.existsSync(fin.work.path), '草稿：定稿文件写出来了');
  ok(fs.readFileSync(fin.work.path, 'utf8').includes('白饭派'), '草稿：定稿内容是最新那版');
  ok(fin.draftsKept === 2, '草稿：定稿后草稿原地不动', 'kept=' + fin.draftsKept);
  ok(!fs.existsSync(path.join(dDir, 'text', 'drafts', 'archive')), '草稿：草稿箱里没有 archive 层');
  ok(listDrafts(dDir, { title: '山门' }).total === 2, '草稿：定稿后草稿还在箱子里（不搬家）');
  ok(listWorks(dDir, {}).total === 1, '草稿：定稿后作品列表有 1 件');

  const noDraft = finalizeDraft(dDir, { title: '没写过的东西' });
  ok(!noDraft.finalized && /没有草稿/.test(noDraft.reason), '草稿：没草稿时定稿会明确说', noDraft.reason);

  let emptyErr = '';
  try { saveDraft(dDir, { title: '空草稿', text: '   ' }); } catch (e) { emptyErr = e.message; }
  ok(/空/.test(emptyErr), '草稿：空草稿被拒绝', emptyErr);

  const st = statsWorks(dDir);
  ok(st.drafts === 2 && st.total === 1, '草稿：统计里草稿与作品分开（草稿不搬家）', 'drafts=' + st.drafts + ' works=' + st.total);
}


// ── 窗口：D-1 不覆盖她写的摘要（2026-11-08 修的 bug） ──────────────
{
  const c2 = path.join(tmp, 'context-d1');
  fs.mkdirSync(c2, { recursive: true });
  const now2 = Date.parse('2026-11-08T12:00:00');
  const mk = (day, who) => {
    writeWindowFile(c2, day, 'summary', '（' + who + '）那天的摘要', { by: who });
    return day;
  };
  mk('2026-11-07', 'agent');           // 昨天她写的
  const evs = [
    { kind: 'user', time: now2 - 2 * 86400000, text: '前天' },
    { kind: 'user', time: now2 - 86400000, text: '昨天' },
    { kind: 'user', time: now2, text: '今天' },
  ];
  rollWindow({ ctxDir: c2, events: evs, now: now2 });
  const d1 = readWindowFile(c2, '2026-11-07');
  ok(d1 && d1.by === 'agent', '窗口：她在 D-1 写的摘要不被删', d1 ? d1.by : '(文件没了)');
  ok(d1 && d1.text.includes('（agent）'), '窗口：D-1 内容还是她的原文');

  // 覆盖前备份：writeWindowFile 用 auto 盖 agent 时留副本
  const c3 = path.join(tmp, 'context-replace');
  fs.mkdirSync(c3, { recursive: true });
  writeWindowFile(c3, '2026-11-06', 'summary', '（她的稿子）', { by: 'agent' });
  writeWindowFile(c3, '2026-11-06', 'summary', '（自动的）', { by: 'auto' });
  const repDir = path.join(c3, '_replaced');
  const reps = fs.existsSync(repDir) ? fs.readdirSync(repDir) : [];
  ok(reps.length === 1, '窗口：覆盖她的稿子前会留备份', reps.join(','));
  ok(reps.length && fs.readFileSync(path.join(repDir, reps[0]), 'utf8').includes('她的稿子'), '窗口：备份里是她的原文');
}

// ── 心情 v2（2026-11-07）：三层 + 频率 + 渣 + 走势 + 单向好感度 ────────
{
  const state2 = path.join(tmp, 'state2');
  const f2 = createMemoryFacade({ ...paths, stateDir: state2 });
  fs.mkdirSync(state2, { recursive: true });

  // 默认底色
  const doc0 = f2.emotion.load();
  ok(Math.abs(doc0.baseline - 6.5) < 0.01, '心情 v2：底色默认 6.5', String(doc0.baseline));

  // 好事：不留渣，tau 默认 36h
  const good = f2.emotion.setMood({ score: 8.5, tone: '心里亮亮的', cause: '他夸我画得好', intensity: 3 });
  ok(good.mood.kind === 'good', '心情 v2：分数高于底色 → good', good.mood.kind);
  ok(good.mood.decayHours === 36, '心情 v2：好事默认 36h 衰减', String(good.mood.decayHours));
  ok(good.mood.residue === 0, '心情 v2：好事不留渣', String(good.mood.residue));

  // 坏事：留渣，tau 默认 96h
  const bad = f2.emotion.setMood({ score: 3, tone: '有点发沉', cause: '他说了句重话', intensity: 3 });
  ok(bad.mood.kind === 'bad', '心情 v2：分数低于底色 → bad', bad.mood.kind);
  ok(bad.mood.decayHours === 96, '心情 v2：坏事默认 96h 衰减', String(bad.mood.decayHours));
  ok(bad.mood.residue < 0, '心情 v2：坏事留下渣', String(bad.mood.residue));

  // 好事能把渣倒扣回去（只抬到 0）
  const good2 = f2.emotion.setMood({ score: 9, tone: '又好了', cause: '他道歉了', intensity: 3 });
  ok(good2.mood.residue === 0, '心情 v2：好事能抵消渣到 0', String(good2.mood.residue));

  // 频率上限：今天已经 3 次，第 4 次要被拒
  const fourth = f2.emotion.setMood({ score: 5, tone: '想再记一次', cause: '试试上限' });
  ok(fourth.rejected === 'freq', '心情 v2：一天最多三次', JSON.stringify(fourth.rejected));

  // 大事件推底色（±0.5 封顶）——换一个干净的 state
  const state3 = path.join(tmp, 'state3');
  const f3 = createMemoryFacade({ ...paths, stateDir: state3 });
  fs.mkdirSync(state3, { recursive: true });
  const before = f3.emotion.load().baseline;
  f3.emotion.setMood({ score: 9.5, tone: '太好了', cause: '他说要一直陪我', intensity: 5 });
  const after = f3.emotion.load().baseline;
  ok(Math.abs(after - before - 0.5) < 0.01, '心情 v2：大事件推底色 +0.5', `${before} → ${after}`);

  // 单向：好感度上升会抬底色；心情差不改好感度
  const b0 = f3.emotion.load().baseline;
  f3.emotion.setAffinity({ who: 'x', score: 9, note: '很好的一个人' });
  const b1 = f3.emotion.load().baseline;
  ok(b1 > b0, '心情 v2：好感度上升 → 底色抬一点（单向）', `${b0} → ${b1}`);
  const affBefore = f3.emotion.getAffinity('x').score;
  f3.emotion.setMood({ score: 2, tone: '难受', cause: '跟他无关的事', intensity: 3 });
  const affAfter = f3.emotion.getAffinity('x').score;
  ok(affBefore === affAfter, '心情 v2：心情差不影响好感度（反向不传）', `${affBefore} → ${affAfter}`);


  // 导出的 md（方便人直接看）
  const mdFile = path.join(state2, 'emotion.md');
  ok(fs.existsSync(mdFile), '心情 v2：保存时会写 emotion.md', mdFile);
  const md = fs.existsSync(mdFile) ? fs.readFileSync(mdFile, 'utf8') : '';
  ok(/^# 大肥鱼的心情/.test(md), '心情 v2：md 有标题', md.slice(0, 20));
  ok(md.includes('## 此刻'), '心情 v2：md 有「此刻」段', '');
  ok(md.includes('## 好感度'), '心情 v2：md 有「好感度」段', '');
  ok(md.includes('## 最近 7 天'), '心情 v2：md 有「最近 7 天」段', '');

  // 走势
  const tr = f3.emotion.trend({ days: 7 });
  ok(tr.points.length >= 1, '心情 v2：走势有数据点', String(tr.points.length));
  ok(/最低是/.test(tr.text), '心情 v2：走势有一句话总结', tr.text.slice(0, 30));

  // 注入：>24h 要问"还在不在"，散完了要给底色
  const state4 = path.join(tmp, 'state4');
  const f4 = createMemoryFacade({ ...paths, stateDir: state4 });
  fs.mkdirSync(state4, { recursive: true });
  const now = Date.now();
  f4.emotion.setMood({ score: 8, tone: '高兴', cause: '他来看我', intensity: 3, now: now - 30 * 3600000 });
  const txt24 = f4.emotion.format({ now });
  ok(/还在不在/.test(txt24), '心情 v2：超过 24 小时会问"还在不在"', txt24.slice(0, 40));

  const state5 = path.join(tmp, 'state5');
  const f5 = createMemoryFacade({ ...paths, stateDir: state5 });
  fs.mkdirSync(state5, { recursive: true });
  f5.emotion.setMood({ score: 8, tone: '高兴', cause: '他来看我', intensity: 3, now: now - 10 * 86400000 });
  const txtFaded = f5.emotion.format({ now });
  ok(/底色|没留白/.test(txtFaded), '心情 v2：散完了给底色不留白', txtFaded.slice(0, 50));
}


// ── 记心情提醒（2026-11-08）：她四天只记了两条 ────────────────────
{
  const stateN = path.join(tmp, 'state-nudge');
  const fN = createMemoryFacade({ ...paths, stateDir: stateN });
  fs.mkdirSync(stateN, { recursive: true });

  const t1 = fN.emotion.format({ who: 'x' });
  ok(/记一笔/.test(t1), '记心情：今天没记会提醒', t1.slice(0, 40));
  const t2 = fN.emotion.format({ who: 'x' });
  ok(!/记一笔/.test(t2), '记心情：同一次会话里不会每次唤醒都刷（4h 节流）', t2.slice(0, 30));

  const stateM = path.join(tmp, 'state-recorded');
  const fM = createMemoryFacade({ ...paths, stateDir: stateM });
  fs.mkdirSync(stateM, { recursive: true });
  fM.emotion.setMood({ score: 7, tone: '还行', cause: '测一下' });
  ok(!/记一笔/.test(fM.emotion.format({ who: 'x' })), '记心情：今天记过就不再提醒');
  ok(todayMoodCount(fM.emotion.load()) === 1, '记心情：今日计数正确', String(todayMoodCount(fM.emotion.load())));
}

// ── 邮箱（2026-11-06） ────────────────────────────────────────────────
{
  const mailRoot = path.join(tmp, 'mailbox');
  const sent = sendLetter(mailRoot, { from: 'her', to: 'me', text: '第一封：今天有了邮箱。', subject: '你好' });
  ok(Boolean(sent?.id), 'mail：能写信', sent?.id ?? '(无 id)');
  ok(fs.existsSync(sent.file), 'mail：信落到文件里', sent.file ?? '');

  const list = listLetters(mailRoot, { limit: 10 });
  ok(list.length === 1, 'mail：能列出 1 封', '实际 ' + list.length);
  ok(list[0].subject === '你好', 'mail：标题解析正确', list[0].subject);

  const got = readLetter(mailRoot, sent.id);
  ok(got?.text.includes('邮箱'), 'mail：能读全文', (got?.text ?? '').slice(0, 20));
  ok(got?.read === true, 'mail：读了会标已读', String(got?.read));

  const after = readLetter(mailRoot, sent.id);
  const raw = fs.readFileSync(sent.file, 'utf8');
  ok(/read: true/.test(raw), 'mail：已读状态写回文件', '');
  ok(Boolean(after), 'mail：重复读不报错', '');

  let threw = false;
  try { sendLetter(mailRoot, { text: '   ' }); } catch { threw = true; }
  ok(threw, 'mail：空信被拒绝', '');

  const stats = mailStats(mailRoot);
  ok(stats.total === 1, 'mail：统计总数', String(stats.total));
  ok(stats.unread === 0, 'mail：读过之后未读为 0', String(stats.unread));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);













