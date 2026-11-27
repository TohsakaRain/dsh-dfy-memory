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
import { apply, createMemoryFacade, resolvePaths, describePaths, DEFAULT_DATA_ROOT, wireSelfInject } from './index.js';
import { DEFAULT_SELF_INJECT, createSnapshotProvider, matchesSession, normalizeSelfInject, readSelfInjectFile, resolveSelfInject, writeSelfInjectFile } from './lib/inject-self.js';
import { SELF_INJECT_PARTS, normalizeParts, diaryLine, promisesLine, timeLine, composeSelfInject } from './lib/inject-parts.js';
import { recallForPrompt, renderMarkdown, memoryDir } from './lib/memory-store.js';
import { relateDirs, probeDataRoot, listDir, looksLikeBridgeConfig } from './lib/webapi.mjs';
import {
  TUNING_SPEC, TUNING_DEFAULTS, readTuning, writeTuning, validatePatch, toCfg,
} from './lib/tuning.js';
import { tuningFromCfg } from './lib/memory-store.js';
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
// stats 必须给出 `fading` 数组（消费方 dfy_memory_stats / 设置页读的是它，不是 faded 计数）
ok(Array.isArray(st.fading), 'stats 返回 fading 数组（不是 undefined）', `typeof=${typeof st.fading}`);
ok(typeof st.faded === 'number' && st.faded === st.fading.length, 'faded 计数 = fading 数组长度', `faded=${st.faded} len=${st.fading.length}`);
ok(st.mostForgotten === null || st.mostForgotten?.id === st.fading[0]?.id, 'mostForgotten = fading 里最久的那条', `${st.mostForgotten?.id ?? 'null'}`);

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

// ── 5b. 数据根目录（2026-11-22 收敛成单一 dataRoot）─────────────
console.log('\n[5b] 数据根目录');
const rootX = path.join(tmp, 'rootX');
const px = resolvePaths({ dataRoot: rootX });
ok(px.dataRoot === path.resolve(rootX), 'dataRoot 决定根目录', px.dataRoot);
ok(px.memoryDir === path.join(px.dataRoot, 'memory'), 'memory 跟着根目录走');
ok(px.diaryDir === path.join(px.dataRoot, 'diary'), 'diary 跟着根目录走');
ok(px.stateDir === path.join(px.dataRoot, 'state'), 'state 跟着根目录走');
ok(px.worksDir === path.join(px.dataRoot, 'works'), 'works 跟着根目录走');
ok(px.mailDir === path.join(px.dataRoot, 'mailbox'), 'mailbox 跟着根目录走');
const pd = resolvePaths({});
ok(pd.dataRoot === DEFAULT_DATA_ROOT, '没配就用默认值（用户目录下）', DEFAULT_DATA_ROOT);

const dp = describePaths({ dataRoot: rootX });
ok(dp.source === 'config', 'describePaths 认得出「来自插件配置」', dp.source);
ok(dp.derived.context === path.join(dp.dataRoot, 'context'), 'context 也在派生列表里');
ok(dp.derived.archive === path.join(dp.dataRoot, 'archive'), 'archive 也在派生列表里');
ok(describePaths({}).source === 'default', '没配时 source = default', describePaths({}).source);

ok(relateDirs('D:\\a', 'D:\\a') === 'same', 'relateDirs：同一个目录');
ok(relateDirs('D:\\a', 'D:\\a\\b') === 'inside', 'relateDirs：子在父里面');
ok(relateDirs('D:\\a\\b', 'D:\\a') === 'contains', 'relateDirs：父在子外面');
ok(relateDirs('D:\\a', 'D:\\b') === 'other', 'relateDirs：互不相干');

const pr1 = probeDataRoot(tmp);
ok(pr1.exists && pr1.isDir && pr1.writable, '体检：临时目录存在且可写');
ok(pr1.subdirs.memory === true, '体检：认得出已有 memory 子目录');
ok(pr1.memoryTotal === 3, '体检：数得出记忆条数', String(pr1.memoryTotal));
ok(probeDataRoot(path.join(tmp, 'no-such-dir')).exists === false, '体检：不存在的目录如实说不存在');

const ld = listDir(tmp);
ok(ld.dirs.includes('memory'), '浏览：列得出子目录', ld.dirs.join(','));
ok(Array.isArray(ld.drives) && ld.drives.length > 0, '浏览：给得出盘符 / 根');

const fakeBridge = path.join(tmp, 'fake-config.json');
fs.writeFileSync(fakeBridge, JSON.stringify({ role: {}, memory: { dir: 'x' } }));
ok(looksLikeBridgeConfig(fakeBridge) === true, '认得出「像桥接配置」的文件');
fs.writeFileSync(fakeBridge, JSON.stringify({ hello: 1 }));
ok(looksLikeBridgeConfig(fakeBridge) === false, '不认识的 json 不会被当成桥接配置');

// ── 5c. 记忆调参（2026-11-22 从写死改成一份真源）────────────────
console.log('\n[5c] 记忆调参');
const specKeys = TUNING_SPEC.flatMap((g) => g.fields.map((f) => f.key));
ok(specKeys.length === 7, 'spec 7 项（每层一个天数 + core 压缩开关；淡出阈值只读）', `${specKeys.length} 项`);
ok(!specKeys.includes('fadeThreshold'), '淡出阈值不在可编辑项里');
ok(!specKeys.includes('blurKeepDays') && !specKeys.includes('normalKeepDays'), '第二段间隔不再单独暴露');
ok(specKeys.includes('importantDays') && specKeys.includes('normalDays'), '天数参数按层各一个');
ok(TUNING_DEFAULTS.importantDays === 14 && TUNING_DEFAULTS.normalDays === 7, '默认天数 important 14 / normal 7');
ok(specKeys.every((k) => k in TUNING_DEFAULTS), '每一项都有默认值');

const tuneFile = path.join(tmp, 'tune-config.json');
fs.writeFileSync(tuneFile, `${JSON.stringify({
  role: { name: '自检' },
  memory: { dir: 'D:\\x\\memory', injectLimit: 8, injectMaxChars: 600, maxEntries: 2000, lifecycleEnabled: true },
  lifecycle: { enabled: true },
}, null, 2)}\n`);
const t0 = readTuning(tuneFile);
ok(t0.found === true, '读得到配置文件');
ok(t0.values.injectLimit === 8, '读到 injectLimit = 8', String(t0.values.injectLimit));

let tuneVErr = null;
try { validatePatch({ injectLimit: 999 }); } catch (e) { tuneVErr = e; }
ok(tuneVErr !== null && /20/.test(tuneVErr.message), '越界被拒（injectLimit 上限 20）', tuneVErr?.message);
tuneVErr = null;
try { validatePatch({ nope: 1 }); } catch (e) { tuneVErr = e; }
ok(tuneVErr !== null && /不认识/.test(tuneVErr.message), '未知字段被拒', tuneVErr?.message);

const tuneW = writeTuning(tuneFile, { injectLimit: 12, importantDays: 30, lifecycleEnabled: false });
ok(tuneW.changed.length === 3, '写 3 项', tuneW.changed.join(','));
const t1 = readTuning(tuneFile);
ok(t1.values.injectLimit === 12, '回到新值', String(t1.values.injectLimit));
ok(t1.values.importantDays === 30, '天数回到新值', String(t1.values.importantDays));
ok(t1.values.lifecycleEnabled === false, '开关回到关');

const tuneDoc1 = JSON.parse(fs.readFileSync(tuneFile, 'utf8'));
ok(tuneDoc1.memory.lifecycleEnabled === false && tuneDoc1.lifecycle.enabled === false, '开关两个键一起写');
ok(tuneDoc1.memory.maxEntries === 2000, '没碰 maxEntries', String(tuneDoc1.memory.maxEntries));
ok(tuneDoc1.role.name === '自检', '别的段原样保留');

// 参数 → 消费方认的形状
const cfgX = toCfg({ ...TUNING_DEFAULTS, injectLimit: 5, normalDays: 9, lifecycleEnabled: false }, 'D:\\m');
const tunX = tuningFromCfg(cfgX);
ok(cfgX.memory.injectLimit === 5, 'toCfg 把 injectLimit 放进 memory 段');
ok(tunX.lifespanDays.normal === 9, 'tuningFromCfg 认得出寿命', String(tunX.lifespanDays.normal));
ok(tunX.blurKeepDays === TUNING_DEFAULTS.importantDays, 'important 第二段间隔 = important 天数', String(tunX.blurKeepDays));
ok(tunX.normalKeepDays === 9, 'normal 第二段间隔 = normal 天数', String(tunX.normalKeepDays));
ok(tunX.lifecycleEnabled === false, 'tuningFromCfg 认得出开关关');
ok(tunX.halfLifeDays.important === TUNING_DEFAULTS.importantDays, '半衰期跟着走', String(tunX.halfLifeDays.important));

// 门面：maintain 用配置里的开关（关掉 → disabled，一条都不动）
const fOff = createMemoryFacade(paths, { cfgProvider: () => toCfg({ ...TUNING_DEFAULTS, lifecycleEnabled: false }, paths.memoryDir) });
const mOff = fOff.memory.maintain();
ok(mOff.disabled === true && (mOff.blurred || []).length === 0, '自动淡忘关掉 → maintain 直接跳过');

const fakeTune = path.join(tmp, 'nope', 'config.json');
ok(readTuning(fakeTune).found === false, '文件不存在 → found=false，不抛错');
let tuneWErr = null;
try { writeTuning(null, { injectLimit: 9 }); } catch (e) { tuneWErr = e; }
ok(tuneWErr !== null, '没有配置文件时写会报错（不假装成功）');

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
ok(reg.size === 40, '注册了 40 个工具（+ context_* / mail_* / mood_trend / work_archive / versions / restore / draft / drafts / finalize / work_project / work_move）', `实际 ${reg.size}`);
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

// 天数从参数里推，别再写死（2026-11-22：每层一个天数，第二段间隔跟着它走）
const D = TUNING_DEFAULTS;
const N_BLUR = D.normalDays + 1;
const N_ARCH = D.normalDays + D.normalDays + 1;
const I_BLUR = D.importantDays + 1;
const I_FINAL = D.importantDays + D.importantDays + 1;

// normal：过了 normalDays → 浓缩到 ≤25 字
const n1 = f.memory.add({ text: longText, tier: 'normal', tags: ['吃饭'] }).entry;
// 关键：只在原文里有的词（回目名 / 细节），模糊之后必须还搜得到 ——
// 否则「搜不到 → 走不到 restoreClarity → 这条永远没机会变清楚」。
const n1Real = findIn(paths.memoryDir).find((e) => e.id === n1.id);
const onlyInText = '碰酸的';   // 只出现在正文末尾，钩子里没有
ok(!String(n1Real?.hook ?? '').includes(onlyInText), '前提：这个词只在原文里（钩子里没有）', String(n1Real?.hook));
backdate(n1.id, N_BLUR);
f.memory.maintain();
const after8 = findIn(paths.memoryDir).find((e) => e.id === n1.id);
ok(after8 && after8.blurStage === 1, `normal ${N_BLUR} 天 → 进入模糊阶段`, `stage=${after8?.blurStage}`);
ok(after8 && after8.text.length <= 25, 'normal 模糊后 ≤25 字', `${after8?.text.length} 字：${after8?.text}`);
ok(after8 && after8.textBefore && after8.textBefore.includes('牛肉面'), '模糊前的原文被保留（textBefore）');
// 2026-11-27：模糊 = 换成「一句事实」（hook），不是砍掉后半截
ok(after8 && after8.text === after8.hook, '模糊后正文 = 钩子（一句事实）', after8?.text);
// 检索链：gist 里没有、原文里有的词，仍然要能召回（并且带片段）
const onlyHits = f.memory.recall({ query: onlyInText, limit: 5 });
ok(onlyHits.some((e) => e.id === n1.id && !e.degraded), '只在原文里的词模糊后仍能召回', onlyInText);
ok(onlyHits.find((e) => e.id === n1.id)?.snippet?.includes(onlyInText), '召回时带出原文片段', String(onlyHits.find((e) => e.id === n1.id)?.snippet ?? ''));

// normal：再过同样久 → 归档（不是删除）
backdate(n1.id, N_ARCH);
f.memory.maintain();
const stillActive = findIn(paths.memoryDir).find((e) => e.id === n1.id);
ok(!stillActive, `normal ${N_ARCH} 天 → 从活跃记忆里移走`);
const idxFile = path.join(paths.memoryDir, 'archive', 'index.jsonl');
ok(fs.existsSync(idxFile), '归档索引文件已生成');
const idxRows = fs.readFileSync(idxFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
ok(idxRows.some((r) => r.id === n1.id), '归档索引里有这条');

// 归档检索
const hits = f.archive.search({ query: '牛肉面' });
ok(hits.length >= 1, 'archive.search 能按关键词命中', `命中 ${hits.length}`);
const got = f.archive.get([hits[0].id]);
ok(got.length === 1 && String(got[0].text).includes('牛肉面'), 'archive.get 能打开原文');
// 2026-11-27：索引行只有 60 字（而且模糊后是 hook，更短），
// 只在原文里出现的词必须靠「回落月份文件」才搜得到
const onlyFull = f.archive.search({ query: '碰酸的' });
ok(onlyFull.length >= 1, '归档：只在原文里的词靠回落月份文件命中', `命中 ${onlyFull.length}`);
ok(onlyFull[0]?.from === 'full', '归档：命中来源标成 full（不是索引）', String(onlyFull[0]?.from));
const byTag = f.archive.search({ query: '吃饭' });
ok(byTag.length >= 1 && byTag[0].from === 'index', '归档：索引里有的词仍然走索引', String(byTag[0]?.from));
const as = f.archive.stats();
ok(as.total >= 1 && as.first, 'archive.stats 有统计', `共 ${as.total} 条`);

// 召回兜底：活跃里没有 → 去归档捞
const recalled = f.memory.recall({ query: '牛肉面', limit: 5 });
ok(recalled.some((e) => e.archived), 'recall 在活跃命中不足时兜底查归档');

// important：过 importantDays → 100 字；再过同样久 → 25 字；都还在活跃
const i1 = f.memory.add({ text: longText, tier: 'important', tags: ['吃饭'] }).entry;
backdate(i1.id, I_BLUR);
f.memory.maintain();
const after22 = findIn(paths.memoryDir).find((e) => e.id === i1.id);
ok(after22 && after22.blurStage === 1 && after22.text.length <= 100, `important ${I_BLUR} 天 → ≤100 字`, `${after22?.text.length} 字`);
backdate(i1.id, I_FINAL);
f.memory.maintain();
const after36 = findIn(paths.memoryDir).find((e) => e.id === i1.id);
ok(after36 && after36.blurStage === 2 && after36.text.length <= 25, `important ${I_FINAL} 天 → ≤25 字`, `${after36?.text.length} 字`);
ok(after36 !== undefined, 'important 最终模糊后仍在活跃记忆（不归档）');

// 模糊是双向的：想起来 → 原文回来、阶段清零（2026-11-22）
{
  const touched = f.memory.touch(i1.id);
  ok(Boolean(touched?.restored), 'touch 一条已模糊的记忆 → 报告「恢复了」', touched?.restored ? `stage=${touched.restored.stage}` : '没恢复');
  const back36 = findIn(paths.memoryDir).find((e) => e.id === i1.id);
  ok(back36 && back36.text.length === longText.length, '原文长度回来了', `${back36?.text.length} / ${longText.length}`);
  ok(back36 && back36.text === longText, '正文和原文完全一致');
  ok(back36 && Number(back36.blurStage) === 0, '模糊阶段清零', String(back36?.blurStage));
  ok(back36 && (Number(back36.restoreCount) || 0) >= 1, '记下了恢复次数', String(back36?.restoreCount));
  ok(back36 && back36.textBefore === longText, 'textBefore 保留（下次模糊还用这份原文）');
  // 恢复后重新计时：刚 touch 过，现在不该再模糊
  f.memory.maintain();
  const justAfter = findIn(paths.memoryDir).find((e) => e.id === i1.id);
  ok(justAfter && Number(justAfter.blurStage) === 0, '刚想起来不会被立刻又模糊掉', String(justAfter?.blurStage));
  // 没有原文可还的老数据：只清阶段，不崩
  const stale = f.memory.add({ text: longText, tier: 'important', tags: ['吃饭'] }).entry;
  backdate(stale.id, I_BLUR);
  f.memory.maintain();
  const doc0 = JSON.parse(fs.readFileSync(path.join(paths.memoryDir, 'memory.json'), 'utf8'));
  const raw0 = doc0.entries.find((e) => e.id === stale.id);
  delete raw0.textBefore; // 模拟老数据：模糊过但没有原文
  fs.writeFileSync(path.join(paths.memoryDir, 'memory.json'), JSON.stringify(doc0, null, 2), 'utf8');
  let staleThrew = null;
  let staleOut = null;
  try { staleOut = f.memory.touch(stale.id); } catch (e) { staleThrew = e; }
  ok(staleThrew === null, '没有 textBefore 的老数据 touch 不抛错', String(staleThrew?.message ?? ''));
  ok(staleOut && Number(staleOut.blurStage) === 0, '没有原文时至少把阶段清零', String(staleOut?.blurStage));
}

// 注入里要标出"记不清了"（否则她会把压缩过的内容当原话复述）
{
  const dir2 = path.join(tmp, 'blur-inject');
  fs.mkdirSync(dir2, { recursive: true });
  const now0 = Date.now();
  fs.writeFileSync(path.join(dir2, 'memory.json'), JSON.stringify({
    version: 1,
    entries: [
      { id: 'm_blur1', text: '他讨厌半夜被消息吵醒，三点以后直接别发。', tier: 'important', blurStage: 1, strength: 1, createdAt: now0, updatedAt: now0 },
      { id: 'm_ok1', text: '他喜欢下雨天。', tier: 'important', blurStage: 0, strength: 1, createdAt: now0, updatedAt: now0 },
    ],
  }, null, 2), 'utf8');
  const outInj = recallForPrompt({ memory: { dir: dir2, injectLimit: 5, injectMaxChars: 2000 } });
  ok(outInj.includes('记不清了'), '注入里标出了模糊的条目');
  const lineOk = outInj.split('\n').find((l) => l.includes('喜欢下雨天'));
  ok(lineOk && !lineOk.includes('记不清了'), '没模糊的条目不带这个标记');

  // memory.md（导出）里的天数必须跟着参数走，不能写死
  {
    const mdDefault = renderMarkdown({ entries: [] }, tuningFromCfg(toCfg(TUNING_DEFAULTS, 'D:\\m')));
    const md14 = renderMarkdown({ entries: [] }, tuningFromCfg({
      memory: {}, lifecycle: { lifespanImportantDays: 9, lifespanNormalDays: 3, blurKeepDays: 9, normalKeepDays: 3 },
    }));
    ok(mdDefault.includes('14 天后模糊'), '导出默认写 14 天', mdDefault.split('\n').find((l) => l.includes('当前节奏')) || '');
    ok(mdDefault.includes('28 天一句话') && mdDefault.includes('14 天归档'), '导出默认：important 14+14=28 / normal 7+7=14', '');
    ok(md14.includes('9 天后模糊') && md14.includes('3 天后模糊'), '换参数后导出跟着变', '');
    ok(!md14.includes('21 天'), '导出里不再出现写死的 21 天');
    ok(mdDefault.includes('模糊是双向的'), '导出的头里写明了双向');
  }

  // 模糊是空操作（原文本来就比上限短）→ 不该被标成"记不清"
  const dir3 = path.join(tmp, 'blur-noop');
  fs.mkdirSync(dir3, { recursive: true });
  fs.writeFileSync(path.join(dir3, 'memory.json'), JSON.stringify({
    version: 1,
    entries: [{
      id: 'm_noop1', text: '短短一句话，没超过一百字。', tier: 'important',
      blurStage: 1, textBefore: '短短一句话，没超过一百字。', strength: 1, createdAt: now0, updatedAt: now0,
    }],
  }, null, 2), 'utf8');
  const outNoop = recallForPrompt({ memory: { dir: dir3, injectLimit: 5, injectMaxChars: 2000 } });
  ok(!outNoop.includes('记不清了'), '原文没被压缩过 → 不标"记不清"');
  const noopTouch = createMemoryFacade({ ...paths, memoryDir: dir3 }).memory.touch('m_noop1');
  ok(noopTouch && !noopTouch.restored, '空操作的那条 touch 不会谎报"恢复了"');
  ok(noopTouch && Number(noopTouch.blurStage) === 0, '但阶段会清零', String(noopTouch?.blurStage));
}

// 「查到了 = 想起来了」：一次想起来一批（绑定 dfy_memory_recall）
{
  const dirR = path.join(tmp, 'recall-touch');
  fs.mkdirSync(dirR, { recursive: true });
  const now1 = Date.now();
  const long1 = longText;
  fs.writeFileSync(path.join(dirR, 'memory.json'), JSON.stringify({
    version: 1,
    entries: [
      {
        id: 'm_r1', text: long1.slice(0, 40) + '…', tier: 'important',
        blurStage: 1, textBefore: long1, strength: 1, createdAt: now1, updatedAt: now1,
      },
      { id: 'm_r2', text: '他喜欢下雨天。', tier: 'important', strength: 1, createdAt: now1, updatedAt: now1 },
    ],
  }, null, 2), 'utf8');
  const facR = createMemoryFacade({ ...paths, memoryDir: dirR });
  const changed = facR.memory.touchMany(['m_r1', 'm_r2']);
  ok(Array.isArray(changed) && changed.length === 1 && changed[0].id === 'm_r1', '批量想起来：只有模糊的那条算恢复', JSON.stringify(changed?.map((c) => c.id)));
  const docR = JSON.parse(fs.readFileSync(path.join(dirR, 'memory.json'), 'utf8'));
  const r1 = docR.entries.find((e) => e.id === 'm_r1');
  const r2 = docR.entries.find((e) => e.id === 'm_r2');
  ok(r1 && r1.text === long1, '批量想起来：原文回来了', `${r1?.text.length} 字`);
  ok(r1 && Number(r1.blurStage) === 0 && Number(r1.restoreCount) === 1, '批量想起来：阶段清零、记了次数');
  ok(r2 && Number(r2.recallCount) === 1, '没模糊的也会记一次「想起来」', String(r2?.recallCount));
  ok(r2 && Number(r2.lastRecalledAt) > 0, '计时起点刷新');
  ok(facR.memory.touchMany([]).length === 0, '空列表不写盘');
  ok(facR.memory.touchMany(['m_nope']).length === 0, '不存在的 id 不写盘');
}

// 模糊的条目被查到时优先冒头（否则永远挤不进前 N，就永远没机会恢复）
{
  const dirV = path.join(tmp, 'vague-boost');
  fs.mkdirSync(dirV, { recursive: true });
  const t0 = Date.now();
  const entries = [];
  for (let i = 0; i < 20; i += 1) {
    entries.push({
      id: `m_new${i}`, text: `最近的事第 ${i} 条，也提到白饭派。`, tier: 'important',
      strength: 1, createdAt: t0 - 1000, updatedAt: t0 - 1000,
    });
  }
  entries.push({
    id: 'm_old1', text: '老的那条只剩白饭派三个字…', tier: 'important',
    blurStage: 1, textBefore: '老的那条：白饭派原叫白饭斋，师父任斋主，她做灶头。',
    strength: 1, createdAt: t0 - 20 * 86400000, updatedAt: t0 - 20 * 86400000,
  });
  fs.writeFileSync(path.join(dirV, 'memory.json'), JSON.stringify({ version: 1, entries }, null, 2), 'utf8');
  const facV = createMemoryFacade({ ...paths, memoryDir: dirV });
  const hits = facV.memory.recall({ query: '白饭派', limit: 8 });
  ok(hits.some((e) => e.id === 'm_old1'), '模糊的那条被查到时进得了前 8（20 条新记录压不住它）', hits.map((h) => h.id).join(','));
  const noQ = facV.memory.recall({ limit: 8 });
  ok(!noQ.some((e) => e.id === 'm_old1'), '不填 query 时不加权（浏览只看清晰的）');
}

// 批量改 memory.json 不该给她续命（2026-11-22 修：计时不再看 updatedAt）
{
  const dirT = path.join(tmp, 'no-renew');
  fs.mkdirSync(dirT, { recursive: true });
  const tNow = Date.now();
  const old30 = tNow - 30 * 86400000;
  fs.writeFileSync(path.join(dirT, 'memory.json'), JSON.stringify({
    version: 1,
    entries: [
      // 30 天前写的，但 updatedAt 被"整理数据"顶成了现在
      { id: 'm_ren1', text: '老事一，三十天前写的。', tier: 'important', strength: 1, createdAt: old30, updatedAt: tNow, lastRecalledAt: 0 },
      // 同样 30 天前写，但真的被想起来过
      { id: 'm_ren2', text: '老事二，也被想起来过。', tier: 'important', strength: 1, createdAt: old30, updatedAt: tNow, lastRecalledAt: tNow },
    ],
  }, null, 2), 'utf8');
  const facT = createMemoryFacade({ ...paths, memoryDir: dirT });
  const lc1 = facT.memory.lifecycle('m_ren1');
  const lc2 = facT.memory.lifecycle('m_ren2');
  ok(lc1 && lc1.stage >= 1, '只改 updatedAt 不续命（照样到期）', `stage=${lc1?.stage}`);
  ok(lc2 && lc2.stage === 0, '真被想起来过 → 重新计时', `stage=${lc2?.stage}`);
  facT.memory.update('m_ren1', { text: '老事一（她后来改写过）。' });
  const lc3 = facT.memory.lifecycle('m_ren1');
  ok(lc3 && lc3.stage === 0, '她真的重写了正文 → 重新计时', `stage=${lc3?.stage}`);
  const dupAdd = facT.memory.add({ text: '老事二，也被想起来过。', tier: 'important' });
  ok(dupAdd?.duplicate === true, '重复写同一条会被判重');
  const again = JSON.parse(fs.readFileSync(path.join(dirT, 'memory.json'), 'utf8')).entries.find((e) => e.id === 'm_ren2');
  ok(Number(again?.lastRecalledAt) > 0, '重复写 = 又被提起，刷新 lastRecalledAt');
}

// 改调参后 memory.md 立刻跟着变（syncExport，2026-11-22 使用者提的）
{
  const dirE = path.join(tmp, 'sync-export');
  fs.mkdirSync(dirE, { recursive: true });
  fs.writeFileSync(path.join(dirE, 'memory.json'), JSON.stringify({ version: 1, entries: [] }, null, 2), 'utf8');
  const facE = createMemoryFacade({ ...paths, memoryDir: dirE }, {
    cfgProvider: () => toCfg({ ...TUNING_DEFAULTS, importantDays: 14, normalDays: 7 }, dirE),
  });
  const rE = facE.memory.syncExport();
  ok(rE.ok === true, 'syncExport 成功', rE.file || rE.error);
  const mdE = fs.readFileSync(path.join(dirE, 'memory.md'), 'utf8');
  ok(mdE.includes('important 14 天模糊') && mdE.includes('normal 7 天模糊'), '导出立刻写成 14 / 7', mdE.split('\n').find((l) => l.includes('当前节奏')) || '');
  // 换一组参数再同步 → 立刻变
  const facE2 = createMemoryFacade({ ...paths, memoryDir: dirE }, {
    cfgProvider: () => toCfg({ ...TUNING_DEFAULTS, importantDays: 30, normalDays: 10 }, dirE),
  });
  facE2.memory.syncExport();
  const mdE2 = fs.readFileSync(path.join(dirE, 'memory.md'), 'utf8');
  ok(mdE2.includes('important 30 天模糊') && mdE2.includes('normal 10 天模糊'), '换参数后导出立刻跟着变', mdE2.split('\n').find((l) => l.includes('当前节奏')) || '');
  ok(!mdE2.includes('24 天归档') && mdE2.includes('20 天归档'), '第二段间隔也跟着算对（30+30 / 10+10）');
  // 导出必须**确定**：同一份数据连渲两次要完全一样（否则每次重写都会换行序，diff 全是噪声）
  {
    const d1 = path.join(tmp, 'stable-md');
    fs.mkdirSync(d1, { recursive: true });
    const t1 = Date.now();
    fs.writeFileSync(path.join(d1, 'memory.json'), JSON.stringify({
      version: 1,
      entries: [
        { id: 'm_s1', text: '同分甲。', tier: 'important', strength: 1, createdAt: t1 - 86400000, updatedAt: t1 - 86400000 },
        { id: 'm_s2', text: '同分乙。', tier: 'important', strength: 1, createdAt: t1 - 86400000, updatedAt: t1 - 86400000 },
        { id: 'm_s3', text: '同分丙。', tier: 'important', strength: 1, createdAt: t1 - 86400000, updatedAt: t1 - 86400000 },
      ],
    }, null, 2), 'utf8');
    const st = JSON.parse(fs.readFileSync(path.join(d1, 'memory.json'), 'utf8'));
    const x1 = renderMarkdown(st, tuningFromCfg(toCfg(TUNING_DEFAULTS, d1)));
    await new Promise((r) => setTimeout(r, 1100));
    const x2 = renderMarkdown(st, tuningFromCfg(toCfg(TUNING_DEFAULTS, d1)));
    ok(x1 === x2, '同一份数据隔 1 秒渲两次 → 完全一致');
    // 召回顺序也要确定：分数打平时不能抖
    const d2 = path.join(tmp, 'stable-recall');
    fs.mkdirSync(d2, { recursive: true });
    const entries2 = [];
    for (let i = 0; i < 6; i += 1) {
      entries2.push({
        id: `m_tie${i}`, text: `打平第 ${i} 条，都提到白饭派。`, tier: 'important',
        strength: 1, createdAt: t1 - 86400000, updatedAt: t1 - 86400000,
      });
    }
    fs.writeFileSync(path.join(d2, 'memory.json'), JSON.stringify({ version: 1, entries: entries2 }, null, 2), 'utf8');
    const fac2 = createMemoryFacade({ ...paths, memoryDir: d2 });
    const o1 = fac2.memory.recall({ query: '白饭派', limit: 6 }).map((e) => e.id).join(',');
    await new Promise((r) => setTimeout(r, 1100));
    const o2 = fac2.memory.recall({ query: '白饭派', limit: 6 }).map((e) => e.id).join(',');
    ok(o1 === o2, '召回顺序两次一致（分数打平不抖）', o1);
    ok(o1 === 'm_tie0,m_tie1,m_tie2,m_tie3,m_tie4,m_tie5', '打平时按 id 升序兜底', o1);
  }
}

// core：永不淡忘，注入里**不压缩**、也**不占名额**
{
  const d5 = path.join(tmp, 'core-inject');
  fs.mkdirSync(d5, { recursive: true });
  const t5 = Date.now();
  const entries5 = [];
  // 一条 core：正文长、带钩子、带原话 —— 注入里必须出现完整正文，而不是钩子
  entries5.push({
    id: 'm_core1',
    text: '2026-10-25 下午，他问我想叫什么名字，我说「圆子」，他当场把昵称改成圆子，说「美滋滋」。',
    tier: 'core', strength: 1, createdAt: t5, updatedAt: t5,
    hook: '他问我叫什么，我说圆子，他当场就改了', quote: '美滋滋',
  });
  // 再来 7 条 core，把 injectLimit 塞满
  for (let i = 0; i < 7; i += 1) {
    entries5.push({ id: `m_core${i + 2}`, text: `第 ${i + 2} 条 core。`, tier: 'core', strength: 1, createdAt: t5, updatedAt: t5 });
  }
  // 4 条 important，分数低但必须有名额
  for (let i = 0; i < 4; i += 1) {
    entries5.push({ id: `m_imp${i}`, text: `第 ${i} 条重要的事。`, tier: 'important', strength: 1, createdAt: t5 - 86400000, updatedAt: t5 - 86400000 });
  }
  fs.writeFileSync(path.join(d5, 'memory.json'), JSON.stringify({ version: 1, entries: entries5 }, null, 2), 'utf8');
  const outCore = recallForPrompt({ memory: { dir: d5, injectLimit: 4, injectMaxChars: 600 } }, t5 + 1000);
  ok(outCore.includes('「美滋滋」') && outCore.includes('他问我想叫什么名字'), 'core 注入完整正文（没被钩子替换）');
  ok(!outCore.includes('他问我叫什么，我说圆子，他当场就改了'), 'core 的钩子没有顶掉正文');
  ok(outCore.includes('（原话：美滋滋）'), 'core 的原话还在');
  const coreLines = outCore.split('\n').filter((l) => /core\]/.test(l)).length;
  const impLines = outCore.split('\n').filter((l) => /important\]/.test(l)).length;
  ok(coreLines === 8, '8 条 core 全部注入', String(coreLines));
  ok(impLines === 4, 'injectLimit=4 → 还进了 4 条 important（core 不占名额）', String(impLines));
  ok(recallForPrompt({ memory: { dir: d5, injectLimit: 0, injectMaxChars: 600 } }, t5 + 1000) === '', 'injectLimit=0 → 完全不注入');
  // core 压缩开关（默认关）：开了才压缩
  const outCompact = recallForPrompt({ memory: { dir: d5, injectLimit: 4, injectMaxChars: 600, coreCompact: true } }, t5 + 1000);
  ok(outCompact.includes('他问我叫什么，我说圆子，他当场就改了'), 'coreCompact=true → core 用钩子');
  ok(!outCompact.includes('他问我想叫什么名字'), 'coreCompact=true → 正文不再进注入');
  ok(outCompact.length < outCore.length, 'coreCompact=true 注入更短', `${outCompact.length} < ${outCore.length}`);
  const outDefault = recallForPrompt({ memory: { dir: d5, injectLimit: 4, injectMaxChars: 600 } }, t5 + 1000);
  ok(outDefault.includes('他问我想叫什么名字'), '不传 coreCompact（默认）→ 仍是完整正文');
  // 压缩只影响注入，**不影响导出文件、也不改存盘数据**
  {
    const st5 = JSON.parse(fs.readFileSync(path.join(d5, 'memory.json'), 'utf8'));
    const mdOff = renderMarkdown(st5, tuningFromCfg(toCfg({ ...TUNING_DEFAULTS, coreCompact: false }, d5)));
    const mdOn = renderMarkdown(st5, tuningFromCfg(toCfg({ ...TUNING_DEFAULTS, coreCompact: true }, d5)));
    ok(mdOff === mdOn, 'coreCompact 开关不影响 memory.md 内容');
    const rawText = st5.entries.find((e) => e.id === 'm_core1').text;
    ok(rawText.includes('「圆子」') && rawText.length >= 40, 'memory.json 里仍是完整正文（压缩只是显示时的事）', `${rawText.length} 字`);
  }
}

// 改写正文 = 也算回忆：旧原文作废、阶段清零
{
  const e1 = f.memory.add({ text: longText, tier: 'important', tags: ['吃饭'] }).entry;
  backdate(e1.id, I_BLUR);
  f.memory.maintain();
  const blurred1 = findIn(paths.memoryDir).find((e) => e.id === e1.id);
  ok(blurred1 && Number(blurred1.blurStage) === 1, '先把它模糊掉', String(blurred1?.blurStage));
  const newText = '他把牛肉面的醋倒多了，酸得皱眉，但还是吃完了。';
  f.memory.update(e1.id, { text: newText });
  const upd = findIn(paths.memoryDir).find((e) => e.id === e1.id);
  ok(upd && upd.text === newText, '改写后正文是新的', String(upd?.text));
  ok(upd && Number(upd.blurStage) === 0, '改写后阶段清零', String(upd?.blurStage));
  ok(upd && upd.textBefore === undefined, '改写后旧原文作废（不会再把旧的盖回来）');
}

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
const { rollWindow, listWindow, readWindowFile, writeWindowFile, summarizeDay, truncateForBudget } = await import('./lib/window.js');
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
  // 2026-11-21：按天文件改成按月分目录后，file 是含月份的相对路径，比 basename 更稳
  winList.every((w) => path.basename(w.file) === `${w.day}.${w.kind === 'full' ? 'full' : 's'}.md`),
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
const { exportDaily, archiveLogStats } = await import('./lib/daily-archive.js');
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
// 2026-11-21：按月分目录后用 resolveDayFile 定位（先月份目录、再平铺）
const { resolveDayFile } = await import('./lib/day-paths.js');
const pastFile = resolveDayFile(arcDir, pastDay, '.md');
fs.writeFileSync(pastFile, fs.readFileSync(pastFile, 'utf8') + '\n<!-- 手工标记 -->\n', 'utf8');
exportDaily({ dataRoot, events: dayEvents });
ok(fs.readFileSync(pastFile, 'utf8').includes('手工标记'), '过去的归档不被覆盖');

const arcSt = archiveLogStats(dataRoot);
ok(arcSt.days === 3 && arcSt.first && arcSt.last, 'archiveLogStats 统计正确', JSON.stringify(arcSt));

// ── 11. 作品库（文字 / 图片，文件名 = 标题）──────────────────────
console.log('\n[11] 作品库');
const {
  worksDirOf, saveTextWork, saveImageWork, listWorks, readWork, statsWorks, worksHint, sanitizeTitle,
  moveWork, createProject,
} = await import('./lib/works.js');
const { listVersions, archiveWork, restoreWork, saveDraft, listDrafts, readDraft, finalizeDraft } = await import('./lib/works.js');

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
  // 2026-11-15 起的实现：心情偏离底色 ≥0.5 才联动，心情差会往下压（下调不减速），
// 但被 band 夹在基线 ±1.5 之内。所以断言改成"下降但不超兜底"，而不是"一点都不动"。
ok(affAfter < affBefore && affAfter >= affBefore - 1.5,
  '心情 v2：心情差会往下压，但有兜底（不低于基线 −1.5）', `${affBefore} → ${affAfter}`);


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

// ── 心情配额不被好感联动吃掉（2026-11-27 实测：记 1 次 + 2 次联动 → 第 3 次被拒）──
{
  const stateQ = path.join(tmp, 'state-quota');
  const fQ = createMemoryFacade({ ...paths, stateDir: stateQ });
  fs.mkdirSync(stateQ, { recursive: true });
  fQ.emotion.setAffinity({ who: 'x', score: 5, note: '起手' });

  const r1 = fQ.emotion.setMood({ score: 8, tone: '好', cause: '一', intensity: 3 });
  ok(!r1.rejected && r1.changes === 1, '心情配额：第 1 次记数正确（联动记录不算）', JSON.stringify({ changes: r1.changes }));

  // 好感度上升两次：每次都会往 history 里塞一条 source='affinity'
  fQ.emotion.setAffinity({ who: 'x', score: 7, note: '二' });
  fQ.emotion.setAffinity({ who: 'x', score: 8, note: '三' });
  ok(fQ.emotion.load().history.filter((h) => h.source === 'affinity').length === 2, '心情配额：好感联动确实写进了 history');

  const r2 = fQ.emotion.setMood({ score: 8, tone: '好2', cause: '二', intensity: 3 });
  ok(!r2.rejected && r2.changes === 2, '心情配额：记 2 次仍然算 2（没被联动记录顶上去）', JSON.stringify({ rejected: r2.rejected, changes: r2.changes }));
  const r3 = fQ.emotion.setMood({ score: 8, tone: '好3', cause: '三', intensity: 3 });
  ok(!r3.rejected && r3.changes === 3, '心情配额：第 3 次还能记', JSON.stringify({ rejected: r3.rejected, changes: r3.changes }));
  const r4 = fQ.emotion.setMood({ score: 8, tone: '好4', cause: '四', intensity: 3 });
  ok(r4.rejected === 'freq', '心情配额：第 4 次才被拒（一天三次仍然生效）', String(r4.rejected));

  // 提醒也别被联动记录骗成「今天记过」
  const stateQ2 = path.join(tmp, 'state-quota2');
  const fQ2 = createMemoryFacade({ ...paths, stateDir: stateQ2 });
  fs.mkdirSync(stateQ2, { recursive: true });
  fQ2.emotion.setAffinity({ who: 'y', score: 7, note: '抬一点' });
  ok(todayMoodCount(fQ2.emotion.load()) === 0, '心情配额：只有联动记录时，今天计数仍是 0');
  ok(/记一笔/.test(fQ2.emotion.format({ who: 'y' })), '心情配额：只有联动记录时仍然提醒「记一笔」');
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

  // 路径穿越：id 直接拼文件名，必须锁死（2026-11-27 实测过能读邮箱外的文件）
  const outside = path.join(tmp, 'mail-outside.md');
  fs.writeFileSync(outside, '---\nid: x\nread: false\n---\n外面的文件\n', 'utf8');
  ok(readLetter(mailRoot, '../../mail-outside') === null, 'mail：id 里的 ../ 被挡住');
  ok(/read: false/.test(fs.readFileSync(outside, 'utf8')), 'mail：邮箱外的文件没被改');
  ok(readLetter(mailRoot, '') === null && readLetter(mailRoot, '..') === null, 'mail：空 id / .. 直接返回 null');
}

// ── 作品库 v4：保存不掉组 / 草稿清理 / 覆盖式搬家 / 总览（2026-11-22）────
{
  const vDir = path.join(tmp, 'works-v4');
  const W = await import('./lib/works.js');
  const { createProject, cleanDrafts, moveWork, overviewWorks, checkWorks, repairWorks } = W;

  createProject(vDir, { name: '测试项目', category: 'text' });

  // ① 不传 sub → 跟着旧稿原来的位置走（不再掉到项目根）
  const a1 = saveTextWork(vDir, { title: '第一回', text: 'v1', project: '测试项目', sub: '前传' });
  ok(a1.file === '测试项目/前传/第一回.md', 'v4：带 sub 存进子分类', a1.file);
  const a2 = saveTextWork(vDir, { title: '第一回', text: 'v2', project: '测试项目' });
  ok(a2.file === '测试项目/前传/第一回.md', 'v4：不传 sub 跟着旧稿留在子分类', a2.file);
  ok(a2.inheritedSub === true, 'v4：明确说位置是继承来的', String(a2.inheritedSub));
  ok(a2.archivedOld === 1, 'v4：旧稿还是先归档', String(a2.archivedOld));
  ok(listWorks(vDir, { project: '测试项目' }).total === 1, 'v4：项目里只剩一份当前稿', String(listWorks(vDir, { project: '测试项目' }).total));

  // ② 显式换层：别处的同名旧稿一样归档 → 还是只有一份
  const a3 = saveTextWork(vDir, { title: '第一回', text: 'v3', project: '测试项目', sub: '正传' });
  ok(a3.file === '测试项目/正传/第一回.md', 'v4：显式 sub 能换层', a3.file);
  ok(listWorks(vDir, { project: '测试项目' }).total === 1, 'v4：换层后不会多出一份', String(listWorks(vDir, { project: '测试项目' }).total));
  ok(!fs.existsSync(path.join(vDir, 'text', '测试项目', '前传', '第一回.md')), 'v4：旧层那份真的挪走了');
  ok(fs.existsSync(path.join(vDir, 'text', '测试项目', 'archive')), 'v4：旧稿落在项目自己的 archive/');

  // ③ 定稿也跟着旧稿的位置走
  saveDraft(vDir, { title: '第二回', text: '草稿版', project: '测试项目' });
  const b1 = saveTextWork(vDir, { title: '第二回', text: '旧正文', project: '测试项目', sub: '前传' });
  ok(b1.file === '测试项目/前传/第二回.md', 'v4：先放一份在子分类', b1.file);
  const fin2 = finalizeDraft(vDir, { title: '第二回', project: '测试项目' });
  ok(fin2.finalized && fin2.work.file === '测试项目/前传/第二回.md', 'v4：定稿跟着旧稿留在子分类', fin2.work?.file ?? fin2.reason);
  ok(!fs.existsSync(path.join(vDir, 'text', '测试项目', '第二回.md')), 'v4：定稿没掉到项目根');

  // ④ 草稿清理：每个标题只留最新 keep 版，其余进项目 archive（不删）
  for (let i = 1; i <= 4; i += 1) saveDraft(vDir, { title: '攒了很多版', text: `第${i}版`, project: '测试项目' });
  const pv = cleanDrafts(vDir, { project: '测试项目', title: '攒了很多版', keep: 2, preview: true });
  ok(pv.preview === true && pv.wouldArchive === 2, 'v4：清理可以先 preview', 'would=' + pv.wouldArchive);
  ok(listDrafts(vDir, { title: '攒了很多版' }).total === 4, 'v4：preview 不动文件');
  const cl = cleanDrafts(vDir, { project: '测试项目', title: '攒了很多版', keep: 2 });
  ok(cl.archived === 2, 'v4：多出来的 2 版挪进归档', String(cl.archived));
  const dNow = listDrafts(vDir, { title: '攒了很多版' });
  ok(dNow.total === 2, 'v4：草稿箱里只剩最新 2 版', String(dNow.total));
  ok(dNow.items.every((x) => /攒了很多版@/.test(x.file)), 'v4：留下的是原来那几个文件');
  ok(fs.readFileSync(path.join(vDir, 'text', dNow.items[0].file), 'utf8').includes('第4版'), 'v4：留的是最新一版（第4版）');
  const archRows = listWorks(vDir, { kind: 'archive', project: '测试项目' });
  const oldDrafts = archRows.items.filter((x) => x.archivedDraft);
  ok(oldDrafts.length === 2, 'v4：归档里的旧草稿认得出来', String(oldDrafts.length));
  ok(fs.existsSync(path.join(vDir, 'text', oldDrafts[0].file)), 'v4：旧草稿文件真的在 archive/ 里', oldDrafts[0].file);
  ok(listWorks(vDir, { project: '测试项目' }).total === 2, 'v4：旧草稿不算作品也不算当前稿', String(listWorks(vDir, { project: '测试项目' }).total));
  const st4 = statsWorks(vDir);
  ok(st4.drafts === 3, 'v4：统计里草稿只数箱子里的（4 份减掉被收走的 2 份 + 第二回那 1 份）', 'drafts=' + st4.drafts);

  // ⑤ 搬家：同名三种处理
  createProject(vDir, { name: '乙项目', category: 'text' });
  saveTextWork(vDir, { title: '撞名', text: '散件这一份', project: '' });
  saveTextWork(vDir, { title: '撞名', text: '乙项目那一份', project: '乙项目', sub: '正传' });
  const skip = moveWork(vDir, { items: ['撞名'], from: 'root', to: 'project', project: '乙项目', sub: '正传', onConflict: 'skip' });
  ok(skip.moved === 0 && skip.skipped === 1, 'v4：默认 skip——同名就跳过', JSON.stringify({ moved: skip.moved, skipped: skip.skipped }));
  ok(/overwrite/.test(skip.skippedItems[0].reason), 'v4：跳过时告诉它怎么改（onConflict="overwrite"）', skip.skippedItems[0].reason);
  const ow = moveWork(vDir, { items: ['撞名'], from: 'root', to: 'project', project: '乙项目', sub: '正传', onConflict: 'overwrite' });
  ok(ow.moved === 1 && ow.overwritten === 1, 'v4：overwrite——搬进去，并记下盖掉了几个', JSON.stringify({ moved: ow.moved, overwritten: ow.overwritten }));
  const afterOw = listWorks(vDir, { project: '乙项目' }).items.filter((x) => x.title === '撞名');
  ok(afterOw.length === 1, 'v4：overwrite 之后只剩一份当前稿', String(afterOw.length));
  ok(fs.readFileSync(path.join(vDir, 'text', afterOw[0].file), 'utf8').includes('散件这一份'), 'v4：留下来的是搬过去的那份');
  ok(listWorks(vDir, { kind: 'archive', project: '乙项目' }).items.filter((x) => x.title === '撞名').length === 1, 'v4：被盖掉的那份进了 archive（没删）');

  saveTextWork(vDir, { title: '改名的', text: '散件', project: '' });
  saveTextWork(vDir, { title: '改名的', text: '已有的', project: '乙项目', sub: '设定' });
  const rn = moveWork(vDir, { items: ['改名的'], from: 'root', to: 'project', project: '乙项目', sub: '设定', onConflict: 'rename' });
  ok(rn.moved === 1 && rn.items[0].renamed === true, 'v4：rename 会改名', JSON.stringify(rn.items[0] ?? {}));
  ok(rn.items[0].to === '乙项目/设定/改名的 (2).md', 'v4：改成「标题 (2)」', rn.items[0].to);
  ok(listWorks(vDir, { project: '乙项目' }).items.filter((x) => x.title === '改名的').length === 2, 'v4：两份都还在（原名 + (2)）');

  // ⑥ 搬完以后标记和位置一致（这条以前是歪的，列表因此认不出稿子）
  const clean0 = checkWorks(vDir);
  ok(clean0.mismarked === 0, 'v4：搬完之后没有「标记和位置不一致」的记录', JSON.stringify(clean0.items.mismarked.slice(0, 2)));
  ok(clean0.missing === 0 && clean0.duplicated === 0, 'v4：也没丢文件、没重复', JSON.stringify({ m: clean0.missing, d: clean0.duplicated }));

  // ⑦ 总览
  const ov = overviewWorks(vDir, { recent: 5 });
  ok(ov.totals.work === listWorks(vDir, { limit: 200 }).total, 'v4：总览的当前稿数和列表一致', `${ov.totals.work} / ${listWorks(vDir, { limit: 200 }).total}`);
  ok(ov.totals.draft === listDrafts(vDir, { limit: 200 }).total, 'v4：总览的草稿数和草稿箱一致', `${ov.totals.draft} / ${listDrafts(vDir, { limit: 200 }).total}`);
  const projB = ov.projects.find((p) => p.name === '乙项目');
  ok(projB && projB.work === 3, 'v4：总览里有乙项目且件数对', JSON.stringify(projB ?? {}));
  ok(projB.subdirs.some((s) => s.name === '设定' && s.work === 2), 'v4：总览列出子分类和件数', JSON.stringify(projB?.subdirs ?? []));
  ok(ov.recent.length === 5, 'v4：最近动过给 5 条', String(ov.recent.length));
  ok(ov.recent.every((r, i) => i === 0 || String(ov.recent[i - 1].at) >= String(r.at)), 'v4：最近动过是倒序', JSON.stringify(ov.recent.map((r) => r.at)));
  ok(ov.issues.missing === 0 && ov.issues.duplicated === 0 && ov.issues.mismarked === 0, 'v4：总览里的对账数字是 0', JSON.stringify(ov.issues));
  ok(ov.totals.archive >= 4, 'v4：总览数得出历史版本', String(ov.totals.archive));

  // ⑧ 对账 + 修账
  const idxF = path.join(vDir, 'index.jsonl');
  fs.appendFileSync(idxF, JSON.stringify({ id: 'w_bad_1', title: '幽灵', category: 'text', file: '测试项目/幽灵.md', created: '2026-11-22T10:00:00' }) + '\n', 'utf8');
  fs.appendFileSync(idxF, JSON.stringify({ id: 'w_bad_2', title: '第一回', category: 'text', file: '测试项目/正传/第一回.md', created: '1999-01-01T00:00:00', archived: true }) + '\n', 'utf8');
  const c1 = checkWorks(vDir);
  ok(c1.missing === 1, 'v4：对账能查出「文件不在了」', String(c1.missing));
  ok(c1.duplicated === 1, 'v4：对账能查出「同一文件重复」', String(c1.duplicated));
  const rep = repairWorks(vDir);
  ok(rep.removed === 2, 'v4：修账删掉 2 条坏记录', String(rep.removed));
  const c2 = checkWorks(vDir);
  ok(c2.ok === true, 'v4：修完就对得上 ✓', JSON.stringify(c2.items));
  ok(listWorks(vDir, { project: '测试项目' }).total === 2, 'v4：修账不动真作品', String(listWorks(vDir, { project: '测试项目' }).total));

  // ⑨ 磁盘上有、索引里没有（她手工搬文件）→ 认出来，修账时补登记
  const manualFile = path.join(vDir, 'text', '测试项目', '设定', '手工搬的.md');
  fs.mkdirSync(path.dirname(manualFile), { recursive: true });
  fs.writeFileSync(manualFile, '---\ntitle: 手工搬的\n---\n\n手工放进来的\n', 'utf8');
  const c3 = checkWorks(vDir);
  ok(c3.orphans === 1, 'v4：对账能查出「磁盘上有、索引里没有」', String(c3.orphans));
  ok(c3.items.orphans[0].file === '测试项目/设定/手工搬的.md', 'v4：漏登记的文件路径对', c3.items.orphans[0]?.file);
  ok(listWorks(vDir, { project: '测试项目' }).items.every((x) => x.title !== '手工搬的'), 'v4：漏登记的确实在列表里看不见');
  const rep2 = repairWorks(vDir);
  ok(rep2.adopted === 1, 'v4：修账把漏登记的补进索引', String(rep2.adopted));
  const gotManual = readWork(vDir, { title: '手工搬的' });
  ok(gotManual.found && gotManual.project === '测试项目' && gotManual.sub === '设定', 'v4：补登记的项目/子分类是从路径推的', JSON.stringify({ p: gotManual.project, s: gotManual.sub }));
  ok(checkWorks(vDir).ok === true, 'v4：补完就对得上 ✓');

  // ⑩ 索引里的坏行（半截 JSON / 被打断的 append）不该被"改别的条目"顺手抹掉。
  // 用独立 tmp 目录，不碰上面的 vDir。
  {
    const bDir = path.join(tmp, 'works-badline');
    fs.mkdirSync(bDir, { recursive: true });
    const idxF2 = path.join(bDir, 'index.jsonl');
    const BAD = '{"id":"w_half","title":"半截';   // 解析不了的一行
    saveTextWork(bDir, { title: '垫底用的', text: '随便写点', project: '测试项目' });
    fs.appendFileSync(idxF2, BAD + '\n', 'utf8');
    // 触发一次「读-改-写」：搬一件作品（会 readIndex → 改 rows → rewriteIndex）
    moveWork(bDir, { items: ['垫底用的'], from: 'project', to: 'root', project: '测试项目' });
    const after = fs.readFileSync(idxF2, 'utf8');
    ok(after.includes(BAD), '索引坏行在改动后仍然保留（不被幸存行覆盖抹掉）', `含坏行=${after.includes(BAD)}`);
    // 坏行不该把好行带崩：正常作品仍读得到
    ok(listWorks(bDir, {}).total >= 1, '坏行存在时正常作品仍可列出', String(listWorks(bDir, {}).total));
  }
}

console.log('\n[N] 自注入（默认关，设置页可热开关）');
{
  // 默认值
  ok(DEFAULT_SELF_INJECT.enabled === false, '默认不开启自注入');
  ok(DEFAULT_SELF_INJECT.order === 10150, '默认插在 first-party 段之后', String(DEFAULT_SELF_INJECT.order));

  // 归一化 / 校验
  const n1 = normalizeSelfInject({ enabled: 'yes', order: 99999, refreshMs: 1, presets: 'qq-chat, qq-chat-v2', cwdContains: ' qq-bridge ' });
  ok(n1.enabled === false, 'enabled 只认 true（字符串不算）');
  ok(n1.order === 20000 && n1.refreshMs === 5000, '数值被夹到合法区间', `${n1.order}/${n1.refreshMs}`);
  ok(n1.presets.length === 2 && n1.presets[1] === 'qq-chat-v2', 'presets 支持逗号字符串', JSON.stringify(n1.presets));
  ok(n1.cwdContains[0] === 'qq-bridge', 'cwdContains 会 trim');

  // 会话匹配
  ok(matchesSession({ preset: 'qq-chat-v2', cwd: 'D:/x' }, {}) === true, '没配匹配规则 → 所有会话都注入');
  ok(matchesSession({ preset: 'qq-chat-v2' }, { presets: ['qq-chat-v2'] }) === true, '按 preset 命中');
  ok(matchesSession({ preset: 'other' }, { presets: ['qq-chat-v2'] }) === false, 'preset 不匹配 → 跳过');
  ok(matchesSession({ cwd: 'D:/dfy/qq-bridge/state/agents' }, { cwdContains: ['qq-bridge'] }) === true, '按 cwd 包含关系命中');

  // 设置文件：写 / 读 / 优先级（文件 > config > 默认）
  const injDir = path.join(tmp, 'self-inject');
  fs.mkdirSync(injDir, { recursive: true });
  const injFile = path.join(injDir, 'self-inject.json');
  ok(resolveSelfInject({ file: injFile, config: {} }).source === 'default', '没有设置文件也没有 config → default');
  ok(resolveSelfInject({ file: injFile, config: { enabled: true } }).source === 'config', '有 config → config 兜底');
  const written = writeSelfInjectFile(injFile, { enabled: true, presets: ['qq-chat-v2'] });
  ok(written.enabled === true && written.presets[0] === 'qq-chat-v2', '写进设置文件', JSON.stringify(written));
  ok(readSelfInjectFile(injFile).settings.enabled === true, '读回来是开的');
  ok(resolveSelfInject({ file: injFile, config: { enabled: false } }).settings.enabled === true, '文件优先于 config');
  writeSelfInjectFile(injFile, { enabled: false });
  ok(readSelfInjectFile(injFile).settings.enabled === false, '再写成关');
  fs.writeFileSync(injFile, '{ 坏 json', 'utf8');
  ok(readSelfInjectFile(injFile).ok === false, '坏 json → 当没有设置文件');

  // 设置页只改一个字段时：文件还没建，基底必须是 config 里那份（不能冲回默认）
  const injFile3 = path.join(injDir, 'merge-from-config.json');
  const cfgOn = { enabled: true, presets: ['qq-chat'] };
  const merged = writeSelfInjectFile(injFile3, { refreshMs: 45000 }, cfgOn);
  ok(merged.enabled === true && merged.presets[0] === 'qq-chat' && merged.refreshMs === 45000,
    '设置页改 refreshMs 不会把 config 里的 enabled/presets 冲掉', JSON.stringify(merged));
  ok(resolveSelfInject({ file: injFile3, config: cfgOn }).settings.enabled === true, '合并后读回来仍是开的');

  // 快照：同一轮里不重复算
  let builds = 0;
  let clock = 1000;
  const p = createSnapshotProvider({ getBlock: () => { builds += 1; return `块${builds}`; }, refreshMs: 60000, now: () => clock });
  ok(p.text() === '块1' && builds === 1, '第一次求值真的算一次', p.text());
  ok(p.text() === '块1' && builds === 1, '同一轮内第二步用快照，不重算', `builds=${builds}`);
  p.markDirty();
  ok(p.text() === '块2' && builds === 2, '来了新消息（标脏）→ 重算', `builds=${builds}`);
  clock += 61000;
  ok(p.text() === '块3' && builds === 3, '超过 refreshMs 兜底重算', `builds=${builds}`);

  // 接线：section 常驻，开关现读 → 热生效
  const injFile2 = path.join(injDir, 'hot.json');
  writeSelfInjectFile(injFile2, { enabled: true, presets: ['qq-chat-v2'] });
  const sections = [];
  const agentHandlers = {};
  const fakeAgent = {
    id: 'session-test-1',
    session: { header: { agentPreset: 'qq-chat-v2', cwd: 'D:/dfy/qq-bridge/state/agents' } },
    ctx: {
      systemPrompt: { section: (def) => { sections.push(def); return () => {}; } },
      on: (event, fn) => { agentHandlers[event] = fn; return () => {}; },
      effect: (fn) => { fn(); return () => {}; },
    },
  };
  const created = [];
  const fakeCtx = { on: (event, fn) => { if (event === 'agent/created') created.push(fn); return () => {}; } };
  const fakeFacade = { memory: { forPrompt: () => '【你记得的事】\n- 一条测试记忆' } };
  const wired = wireSelfInject(fakeCtx, { file: injFile2, config: {} }, fakeFacade, () => {});
  ok(wired.ok === true, 'wireSelfInject 接线成功');
  ok(created.length === 1, '监听了 agent/created');
  created[0]({ agent: fakeAgent });
  ok(sections.length === 1, '给这个 agent 注册了一个 section', `sections=${sections.length}`);
  ok(sections[0].name === 'dfy:memory' && sections[0].order === 10150, 'section 名字与位置对', `${sections[0].name}@${sections[0].order}`);
  ok(String(sections[0].text()).includes('一条测试记忆'), '开着 → 返回记忆块', JSON.stringify(String(sections[0].text()).slice(0, 16)));
  writeSelfInjectFile(injFile2, { enabled: false });
  ok(sections[0].text() === '', '设置页一关 → 立刻返回空串（不用重启）');
  writeSelfInjectFile(injFile2, { enabled: true });
  ok(String(sections[0].text()).includes('一条测试记忆'), '再打开 → 又有了');
  ok(typeof agentHandlers['agent/inbox/spliced'] === 'function', '监听了 agent/inbox/spliced（来消息就标脏）');
  // presets 热生效：已经挂着的会话，改匹配规则立刻按新规则走
  writeSelfInjectFile(injFile2, { enabled: true, presets: ['别的 preset'] });
  ok(sections[0].text() === '', 'presets 改成不匹配 → 已挂载的会话立刻不再注入');
  writeSelfInjectFile(injFile2, { enabled: true, presets: ['qq-chat-v2'] });
  ok(String(sections[0].text()).includes('一条测试记忆'), 'presets 改回来 → 又注入');

  // 不匹配的会话不挂（桌面端）
  const sections2 = [];
  created[0]({ agent: {
    id: 'session-test-2',
    session: { header: { agentPreset: 'desktop' } },
    ctx: { systemPrompt: { section: (def) => sections2.push(def) }, on: () => () => {}, effect: (fn) => fn() },
  } });
  ok(sections2.length === 1 && sections2[0].text() === '', '不匹配的会话也注册了 section，但返回空串（桌面端不受影响）');

  // 状态（设置页要显示的东西）
  const st = wired.status();
  ok(st.enabled === true && Array.isArray(st.mounted) && st.mounted.length === 2, 'status() 有开关与已挂载列表（两个会话都注册了，匹配在求值时判）', JSON.stringify({ enabled: st.enabled, mounted: st.mounted.length }));
  ok(st.source === 'file', 'status() 说明来源是设置文件', st.source);
}

console.log('\n[O] 自注入的内容块（日记/记忆/心情/承诺/时间感）');
{
  ok(SELF_INJECT_PARTS.length === 5, '五块：diary/memory/mood/promises/time', SELF_INJECT_PARTS.join(','));
  ok(normalizeParts([]).length === 5, '空 parts → 全开');
  ok(normalizeParts(['memory', 'mood']).join(',') === 'memory,mood', '只留选中的');
  ok(normalizeParts(['memory', 'bogus']).join(',') === 'memory', '不认识的块被丢掉');
  ok(normalizeParts(['bogus']).length === 5, '全不认识 → 退回全开');
  ok(normalizeParts('memory,time').length === 2, '支持逗号字符串');

  ok(diaryLine({ todaySections: 2 }) === '【今天日记】已写 2 段', '日记：写过了');
  ok(diaryLine({ todaySections: 0, lastDate: '2026-11-20' }) === '【今天日记】还没写（上次 2026-11-20）', '日记：没写但有上次');
  ok(diaryLine({}) === '【今天日记】还没写', '日记：从来没写');

  const fmt = (items) => items.map((x) => '- ' + x.text).join('\n');
  const pl = promisesLine([{ text: '周末陪他打游戏' }], fmt);
  ok(pl.includes('【你答应过的事】') && pl.includes('周末陪他打游戏') && pl.includes('兑现不勉强'), '承诺块措辞对');
  ok(promisesLine([], fmt) === '', '没有承诺 → 空');

  const table = { years: { 2026: { holidays: { '2026-10-01': '国庆节' }, workdays: { '2026-10-10': '国庆调休' } } } };
  ok(timeLine(Date.parse('2026-10-01T10:00:00+08:00'), table).includes('国庆节·放假'), '时间感：节假日');
  ok(timeLine(Date.parse('2026-10-10T10:00:00+08:00'), table).includes('国庆调休·调休上班'), '时间感：调休上班');
  ok(/【时间感】现在 \d{4}-\d{2}-\d{2} 星期./.test(timeLine(Date.parse('2026-11-26T22:05:00+08:00'), null)), '时间感：没数据也能报星期');

  const fakeFacade = {
    memory: { forPrompt: () => '【你记得的事】\n- 一条记忆' },
    emotion: { format: () => '【你现在的心情】还行' },
    promises: { list: () => [{ id: 'p1', text: '陪他吃饭' }], format: fmt },
    diary: { status: () => ({ todaySections: 1, lastDate: '2026-11-26' }) },
  };
  const NOW = Date.parse('2026-11-26T22:05:00+08:00');
  const all = composeSelfInject({ parts: [], now: NOW, facade: fakeFacade, who: '365845801', holidaysFile: '' });
  ok(all.includes('【今天日记】已写 1 段'), '全开：日记在');
  ok(all.includes('【你记得的事】'), '全开：记忆在');
  ok(all.includes('【你现在的心情】'), '全开：心情在');
  ok(all.includes('【你答应过的事】'), '全开：承诺在');
  ok(all.includes('【时间感】'), '全开：时间感在');
  ok(all.indexOf('【今天日记】') < all.indexOf('【你记得的事】'), '顺序：日记在记忆前面');
  ok(all.indexOf('【你记得的事】') < all.indexOf('【时间感】'), '顺序：时间感在最后');

  const only = composeSelfInject({ parts: ['memory'], now: NOW, facade: fakeFacade, who: 'x' });
  ok(only.includes('【你记得的事】') && !only.includes('【时间感】') && !only.includes('【今天日记】'), '只开记忆 → 别的块不出现');
  const moodOnly = composeSelfInject({ parts: ['mood'], now: NOW, facade: { emotion: { format: () => '' } } });
  ok(moodOnly === '', '块返回空串 → 整段为空');
  const broken = composeSelfInject({ parts: ['memory', 'diary'], now: NOW, facade: { memory: { forPrompt: () => '【你记得的事】\n- ok' }, diary: { status: () => { throw new Error('坏了'); } } } });
  ok(broken.includes('【你记得的事】'), '某块抛错不影响别的块');
}

console.log('\n[P] memoryDir 的解析（跨机器不能靠写死路径）');
{
  const byMemoryDir = memoryDir({ memory: { dir: 'D:/a/memory' } });
  const byTop = memoryDir({ memoryDir: 'D:/b/memory' });
  const byPaths = memoryDir({ paths: { memoryDir: 'D:/c/memory' } });
  const def = memoryDir({});
  ok(byMemoryDir === path.resolve('D:/a/memory'), 'cfg.memory.dir 优先', byMemoryDir);
  ok(byTop === path.resolve('D:/b/memory'), '也认 cfg.memoryDir', byTop);
  ok(byPaths === path.resolve('D:/c/memory'), '也认 cfg.paths.memoryDir', byPaths);
  ok(path.isAbsolute(def) && def.includes('dsh-dfy-memory'), '没传 cfg → 落到用户目录下的默认根', def);
  ok(!/^[A-Za-z]:\\?dfy\\memory$/i.test(def), '兜底不再写死 D:\\dfy\\memory', def);
}

console.log('\n[Q] 注入里的【我的作品】提示行（跟老桥接对齐）');
{
  const wroot = path.join(tmp, 'works-hint');
  fs.mkdirSync(path.join(wroot, 'works', 'text'), { recursive: true });
  fs.writeFileSync(path.join(wroot, 'works', 'text', 'a.md'), '# a\n', 'utf8');
  fs.writeFileSync(path.join(wroot, 'works', 'text', 'b.md'), '# b\n', 'utf8');
  fs.writeFileSync(path.join(wroot, 'works', 'index.jsonl'), [
    JSON.stringify({ title: '甲', category: 'text', file: 'a.md', created: '2026-11-01' }),
    JSON.stringify({ title: '乙', category: 'text', file: 'b.md', created: '2026-11-20' }),
    JSON.stringify({ title: '幽灵', category: 'text', file: 'gone.md', created: '2026-11-25' }),
  ].join('\n'), 'utf8');
  const text = recallForPrompt({ memory: { dir: path.join(wroot, 'memory') }, lifecycle: {} });
  ok(text.includes('【我的作品】2 件（文字 2 · 图片 0'), '注入里有【我的作品】，且只数磁盘上真有的', (text.split('\n').find((l) => l.includes('【我的作品】')) || '').slice(0, 80));
  ok(text.includes('最近「乙」'), '最近一件取 created 最新的那个存在的文件');
  ok(!text.includes('幽灵'), '索引里有、磁盘上没有的不算');

  // 归档 / 草稿 / 重复索引行都不该算进「件数」——注入里的数要和 dfy_works 一致
  fs.mkdirSync(path.join(wroot, 'works', 'text', 'archive'), { recursive: true });
  fs.writeFileSync(path.join(wroot, 'works', 'text', 'archive', 'a@20261110-1010.md'), '# a old\n', 'utf8');
  const idxF = path.join(wroot, 'works', 'index.jsonl');
  fs.appendFileSync(idxF, [
    JSON.stringify({ title: '甲', category: 'text', file: 'archive/a@20261110-1010.md', created: '2026-11-10', archived: true }),
    JSON.stringify({ title: '甲', category: 'text', file: 'a.md', created: '2026-11-01' }),   // 重复索引行
  ].join('\n') + '\n', 'utf8');
  const text2 = recallForPrompt({ memory: { dir: path.join(wroot, 'memory') }, lifecycle: {} });
  ok(text2.includes('【我的作品】2 件（文字 2 · 图片 0'),
    '注入件数：归档稿和重复索引行都不算', (text2.split('\n').find((l) => l.includes('【我的作品】')) || '').slice(0, 60));
}

console.log('\n[R] 记忆摘要（模糊 = 一句事实，不是砍尾巴）');
{
  const { gistOf } = await import('./lib/memory-store.js');
  // autoHook 的三种典型形态（之前实测断在半词上的那几条）
  ok(gistOf({ text: '晚上定下来的事：白饭派改成连载，一天写一回，把当天经历和刷到的东西移花接木写进去。' })
    === '晚上定下来的事：白饭派改成连载，一天写一回', '长句：在从句边界收（不切半个词）');
  ok(gistOf({ text: '15:48，白饭派·前传完结了，共 24 回——从 11-07 开工到写完。' })
    === '15:48，白饭派·前传完结了', '带数字开头的长句：按最后一个从句边界切');
  ok(gistOf({ text: '他讨厌半夜被消息吵醒。' }) === '他讨厌半夜被消息吵醒。', '短句原样保留（不做空操作）');
  // 有 hook 就用 hook —— 这才是"摘要由她写"的入口
  ok(gistOf({ text: '晚上定下来的事：白饭派改成连载，一天写一回，把当天经历和刷到的东西移花接木写进去。', hook: '白饭派改连载，已写完前三回' })
    === '白饭派改连载，已写完前三回', '有钩子时摘要 = 钩子（不是从正文截）');
  // 已经是短句的不再被砍
  ok(gistOf({ text: '他喜欢下雨天。', textBefore: '他喜欢下雨天。' }) === '他喜欢下雨天。', 'textBefore 短就原样用');
  // 结果永远不超过 24 字（注入预算）
  const cases = [
    '一二三四五六七八九十，一二三四五六七八九十，一二三四五六七八九十。',
    '没有标点的一段很长的文字一直写下去写到超过二十四个字还在继续写',
    '（特殊）2026-11-19 深夜定的形象设定，永不能忘',
  ];
  ok(cases.every((c) => { const g = gistOf({ text: c }); return g.length > 0 && g.length <= 24; }),
    '任何输入都给出 1~24 字的摘要', cases.map((c) => `${gistOf({ text: c })}(${gistOf({ text: c }).length})`).join(' | '));
  const oddEnd = cases.filter((c) => /[，、：,（(—]$/.test(gistOf({ text: c })));
  ok(oddEnd.length === 0, '摘要不以半个标点结尾', oddEnd.join(' | '));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);













