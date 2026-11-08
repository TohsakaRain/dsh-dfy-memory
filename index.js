/**
 * dsh-dfy-memory —— 大肥鱼的人格数据层（DSH 插件）
 * ============================================================================
 * v0.2（2026-10-28）：从"骨架"升级为"工具可用"
 *   · 数据层：记忆 / 心情·好感 / 承诺 / 日记（lib/ 下四个纯模块）
 *   · 工具层：14 个 DSH 原生工具（dfy_ 前缀），与旧的 MCP 工具**并存**
 *   · 注入层：**还没做**（第 ④ 步；桥接现在自己拼，靠 injection.source 切换）
 *
 * 为什么并存而不是替换：
 *   迁移期最怕"旧的删了、新的没接好 ⇒ 她突然不会用了"。所以旧的一律保留，
 *   用一个开关（`security.toolAllow.memorySource`）决定哪一套对她可见：
 *     · both（默认）两套都可见 —— 迁移期
 *     · new       只有 dfy_* —— 验证新工具
 *     · old       只有旧工具 —— 一键回滚
 *   开关由守卫读（秒级生效，不用重启 DSH）；本插件**总是注册**全部工具，
 *   是否可用交给守卫决定 —— 这样切开关不需要重启。
 *
 * 数据文件与桥接**共用同一批**（不复制、不分叉）：
 *   D:\dfy\diary\*.md           日记
 *   D:\dfy\memory\memory.json   长期记忆（+ memory.md 供人读）
 *   <stateDir>\emotion.json     心情 + 好感度
 *   <stateDir>\commitments.json 承诺
 * ============================================================================
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  loadStore, saveStore, addMemory, recallMemories, touchMemory, updateMemory,
  forgetMemory, statsMemories, recallForPrompt, renderMarkdown, TIERS, DEFAULT_TUNING,
  maintainMemories, lifecycleOf, blurText, pendingDigestDays,
} from './lib/memory-store.js';
import { mailboxDir, sendLetter, listLetters, readLetter, mailStats } from './lib/mailbox.js';
import { searchArchive, getArchive, statsArchive, archiveHint } from './lib/archive.js';
import { listWindow, readWindowFile, rollWindow, summarizeDay, windowHint, contextDir, debugInfo as windowDebugInfo } from './lib/window.js';
import { extractEvents } from './lib/chatlog.js';
import { exportDaily, archiveLogStats } from './lib/daily-archive.js';
import { loadEmotion, saveEmotion, setMood, clearMood, currentMood, setAffinity, getAffinity, listAffinity, formatEmotionLines, moodTrend, changesToday, recentGround } from './lib/emotion.js';
import {
  loadCommitments, saveCommitments, addCommitment, listCommitments,
  dueCommitment, markNotified, dropCommitment, formatCommitments,
} from './lib/commitments.js';
import {
  appendEntry as diaryAppend, readDay as diaryRead, listDays as diaryList,
  statusSnapshot as diaryStatus, todayStr as diaryToday,
} from './lib/diary.js';
import { worksDirOf, ensureDir as worksEnsure, saveTextWork, saveImageWork, listWorks, readWork, statsWorks, worksHint, CATEGORIES as WORK_CATEGORIES, archiveWork, listVersions, restoreWork, saveDraft, listDrafts, readDraft, finalizeDraft } from './lib/works.js';
import { createToolRegistrar } from './lib/toolkit.mjs';
import { handleApi } from './lib/webapi.mjs';

export const name = 'dfy-memory';

// 注册工具要 tools；设置页要 webServer。
export const inject = ['tools', 'webServer'];

// 数据默认放在用户目录下（和 douyin-browser 等第三方插件一致）：
//   ~/.dsh/dsh-dfy-memory/
//   ├── memory/   长期记忆 memory.json + memory.md
//   ├── diary/    日记
//   ├── state/    心情·好感度 emotion.json + emotion.md、承诺
//   ├── works/    作品库（text / image，各自带 archive、drafts）
//   ├── mailbox/  邮箱（电报式信件，和作品库分开）
//   └── context/  按天的对话窗口
// 想换地方：环境变量 DFY_DATA_DIR，或插件 config 里的 memoryDir / diaryDir / stateDir。
const DATA_ROOT = path.resolve(process.env.DFY_DATA_DIR || path.join(os.homedir(), '.dsh', 'dsh-dfy-memory'));
const DEFAULTS = Object.freeze({
  diaryDir: path.join(DATA_ROOT, 'diary'),
  memoryDir: path.join(DATA_ROOT, 'memory'),
  stateDir: path.join(DATA_ROOT, 'state'),
});

/** 配置解析：插件 config > 环境变量 > 默认值。 */
export function resolvePaths(config = {}) {
  const dir = (v, fallback) => (typeof v === 'string' && v.trim() ? path.resolve(v) : fallback);
  const memoryDir = dir(process.env.DFY_MEMORY_DIR || config.memoryDir, DEFAULTS.memoryDir);
  return {
    diaryDir: dir(process.env.DFY_DIARY_DIR || config.diaryDir, DEFAULTS.diaryDir),
    memoryDir,
    stateDir: dir(process.env.DFY_STATE_DIR || config.stateDir, DEFAULTS.stateDir),
    // 作品库默认跟 memory 同级（<dataRoot>/works）；也可用 config.worksDir 单独指到别处
    worksDir: dir(process.env.DFY_WORKS_DIR || config.worksDir, worksDirOf(memoryDir)),
    // 邮箱：她和执行者之间的信。<dataRoot>/mailbox，和作品库分开
    mailDir: dir(process.env.DFY_MAIL_DIR || config.mailDir, path.join(path.dirname(path.resolve(memoryDir)), 'mailbox')),
    dataRoot: path.dirname(path.resolve(memoryDir)),
  };
}

/**
 * 数据层门面：所有读写都收敛到这里。
 * 设计原则：**薄透传** —— 返回形状与 lib/ 里的原始函数完全一致，
 * 这样第 ④ 步桥接切过来是 1:1 替换，不会多出一层"形状转换"。
 */
export function createMemoryFacade(paths) {
  const ctxDir = contextDir(paths.memoryDir);
  const dataRoot = path.dirname(path.resolve(paths.memoryDir));
  const emotionFile = path.join(paths.stateDir, 'emotion.json');
  const commitmentsFile = path.join(paths.stateDir, 'commitments.json');
  const tuningCfg = {
    memory: {
      dir: paths.memoryDir,
      injectLimit: 8,
      injectMaxChars: 600,
      halfLifeImportantDays: 21,
      halfLifeNormalDays: 7,
      fadeThreshold: 0.02,
    },
    lifecycle: { enabled: true },
  };

  return {
    paths,
    memory: {
      add: (input) => addMemory(paths.memoryDir, input),
      recall: (opts) => recallMemories(paths.memoryDir, opts),
      touch: (id) => touchMemory(paths.memoryDir, id),
      update: (id, patch) => updateMemory(paths.memoryDir, id, patch),
      forget: (id) => forgetMemory(paths.memoryDir, id),
      stats: () => statsMemories(paths.memoryDir),
      forPrompt: (now = Date.now()) => recallForPrompt(tuningCfg, now),
      render: () => renderMarkdown(loadStore(paths.memoryDir)),
      // 生命周期：把到期的模糊化 / 归档（"删除"= 归档，只追加不删）
      maintain: (now = Date.now()) => maintainMemories(paths.memoryDir, DEFAULT_TUNING, now),
      lifecycle: (id) => {
        const e = loadStore(paths.memoryDir).entries.find((x) => x.id === id);
        return e ? lifecycleOf(e) : null;
      },
      blur: blurText,
      tiers: TIERS,
      tuning: DEFAULT_TUNING,
    },
    emotion: {
      setMood: (input) => setMood(emotionFile, input),
      clearMood: () => clearMood(emotionFile),
      current: (now = Date.now()) => currentMood(loadEmotion(emotionFile), now),
      setAffinity: (input) => setAffinity(emotionFile, input),
      getAffinity: (who) => getAffinity(loadEmotion(emotionFile), who),
      listAffinity: () => listAffinity(loadEmotion(emotionFile)),
      format: (opts) => formatEmotionLines(emotionFile, opts),
    trend: (opts) => moodTrend(loadEmotion(emotionFile), opts),
    changesToday: (now) => changesToday(loadEmotion(emotionFile), now),
    ground: (opts) => recentGround(loadEmotion(emotionFile), opts),
      load: () => loadEmotion(emotionFile),
      save: (doc) => saveEmotion(emotionFile, doc),
    },
    promises: {
      add: (input) => addCommitment(commitmentsFile, input),
      list: (opts) => listCommitments(commitmentsFile, opts),
      due: (now = Date.now()) => dueCommitment(commitmentsFile, now),
      markNotified: (id) => markNotified(commitmentsFile, id),
      drop: (id) => dropCommitment(commitmentsFile, id),
      format: (items, opts) => formatCommitments(items, opts),
      load: () => loadCommitments(commitmentsFile),
      save: (store) => saveCommitments(commitmentsFile, store),
    },
    diary: {
      write: (input) => diaryAppend(paths.diaryDir, input),
      read: (opts) => diaryRead(paths.diaryDir, opts),
      list: (opts) => diaryList(paths.diaryDir, opts),
      status: (now = new Date()) => diaryStatus(paths.diaryDir, now),
      today: () => diaryToday(),
      dir: paths.diaryDir,
    },
    mail: {
      dir: paths.mailDir,
      send: (input) => sendLetter(paths.mailDir, input),
      list: (opts) => listLetters(paths.mailDir, opts),
      read: (id) => readLetter(paths.mailDir, id),
      stats: () => mailStats(paths.mailDir),
    },
    works: {
      dir: paths.worksDir,
      categories: WORK_CATEGORIES,
      ensure: () => worksEnsure(paths.worksDir),
      saveText: (input) => saveTextWork(paths.worksDir, input),
      saveImage: (input) => saveImageWork(paths.worksDir, input),
      list: (opts) => listWorks(paths.worksDir, opts),
      archive: (input) => archiveWork(paths.worksDir, input),
      versions: (opts) => listVersions(paths.worksDir, opts),
      restore: (input) => restoreWork(paths.worksDir, input),
      saveDraft: (input) => saveDraft(paths.worksDir, input),
      drafts: (opts) => listDrafts(paths.worksDir, opts),
      readDraft: (opts) => readDraft(paths.worksDir, opts),
      finalize: (input) => finalizeDraft(paths.worksDir, input),
      read: (opts) => readWork(paths.worksDir, opts),
      stats: () => statsWorks(paths.worksDir),
      hint: () => worksHint(paths.worksDir),
    },
    archive: {
      search: (opts) => searchArchive(paths.memoryDir, opts),
      get: (ids) => getArchive(paths.memoryDir, ids),
      stats: () => statsArchive(paths.memoryDir),
      hint: () => archiveHint(paths.memoryDir),
    },
    window: {
      dir: ctxDir,
      list: () => listWindow(ctxDir),
      get: (day) => readWindowFile(ctxDir, day),
      // 一次做两件事：滚窗口 + 导出按天归档（都只读会话日志，抽取一次共用）
      roll: (events) => {
        const ev = events ?? extractEvents({});
        const w = rollWindow({ ctxDir, events: ev });
        let a = { written: [], skipped: [], days: 0 };
        try { a = exportDaily({ dataRoot, events: ev }); } catch (e) { a = { error: String(e?.message ?? e) }; }
        return { ...w, archiveLog: a, events: ev.length };
      },
      summarize: (day, text) => summarizeDay({ ctxDir, day, text }),
      hint: () => windowHint(ctxDir),
      debug: () => windowDebugInfo(),
      archiveLog: () => archiveLogStats(dataRoot),
    },
  };
}

/**
 * 注册 14 个工具。
 * ⚠️ 无论开关是 both/new/old，这里**总是注册全部** —— 可用性由守卫的
 *    `security.toolAllow.memorySource` 决定，这样切开关不需要重启 DSH。
 */
export function registerTools(ctx, facade, log = () => {}) {
  const registered = [];
  const tool = createToolRegistrar(ctx, undefined, registered);
  const f = facade;

  // ── 日记（3）────────────────────────────────────────────────
  tool({
    name: 'dfy_diary_write',
    description: '写今天（或指定某天）的日记。日记存在她自己的目录里，只有她自己和管理员看得到。可以一天写多段（每段带时间戳）；写出去就不能删，写错只能再追加一段更正。',
    parameters: {
      text: { type: 'string', description: '日记正文。写真实的感受和具体的事，不要流水账，也不必汇报给谁' },
      mood: { type: 'string', description: '可选：一两个词的心情/天气标签，如「有点累」「下雨」' },
      date: { type: 'string', description: '可选：补写某一天，格式 YYYY-MM-DD；不填就是今天' },
    },
    async execute(args) {
      const r = f.diary.write({ text: args.text, mood: args.mood, date: args.date });
      if (!r.ok) return `写日记没成功：${r.error}`;
      const base = `写好了 ✓ ${r.date}${r.created ? '（新建）' : ''} 第 ${r.sections} 段 · ${Math.round(r.bytes / 102.4) / 10}KB`;
      // 顺手提醒：昨天的对话窗口还是机械摘要，要不要她自己压一遍（不强迫）
      try {
        const y = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const ymd = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
        const w = f.window.get(ymd);
        if (w && w.by === 'auto') {
          return `${base}\n\n（${ymd} 的对话窗口还是自动摘要。想自己压一遍的话：dfy_context_summarize('${ymd}', '…')）`;
        }
      } catch { /* 窗口还没建好就算了 */ }
      return base;
    },
  });

  tool({
    name: 'dfy_diary_read',
    description: '读日记。不填 date 读今天；填了读那一天。想看自己前几天写了什么、或者核对某件事时用。',
    parameters: { date: { type: 'string', description: 'YYYY-MM-DD；不填=今天' } },
    async execute(args) {
      const r = f.diary.read({ date: args.date });
      if (!r.ok) return `读日记没成功：${r.error}`;
      if (r.empty) return `${r.date} 还没有日记。`;
      return r.text;
    },
  });

// ── 邮箱（2026-11-06）：她和"桌面上那个执行者"之间的信 ──────────────
  tool({
    name: 'dfy_mail_send',
    description: '给「我」（桌面上那个帮我修东西、写代码的执行者）写一封信。信箱和作品库是分开的两个文件夹：作品是她做的东西，信是两个人说的话。',
    parameters: {
      text: { type: 'string', description: '信的内容' },
      subject: { type: 'string', description: '可选：标题，一句话' },
      from: { type: 'string', description: "可选：谁写的。默认 her（你自己）；如果是替「我」发，写 me" },
      to: { type: 'string', description: "可选：写给谁。默认 me" },
    },
    async execute(args = {}) {
      const text = String(args.text ?? '').trim();
      if (!text) return '信是空的，写点什么再寄。';
      try {
        const r = f.mail.send({
          from: String(args.from ?? 'her').trim() || 'her',
          to: String(args.to ?? 'me').trim() || 'me',
          text,
          subject: String(args.subject ?? '').trim(),
        });
        return `寄出去了 ✓ ${r.id}（${r.day}）`;
      } catch (e) {
        return '没寄成：' + String(e?.message ?? e);
      }
    },
  });

  tool({
    name: 'dfy_mail_list',
    description: '看信箱里有什么信（新的在前）。默认只列最近 10 封；想只看没读过的传 unreadOnly。',
    parameters: {
      limit: { type: 'number', description: '最多列几封，默认 10' },
      unreadOnly: { type: 'boolean', description: '只看没读过的' },
      as: { type: 'string', description: "可选：以谁的身份看（her=你自己，me=执行者），默认 her" },
    },
    async execute(args = {}) {
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
      const items = f.mail.list({ limit, unreadOnly: args.unreadOnly === true });
      if (!items.length) {
        const s = f.mail.stats();
        return args.unreadOnly === true
          ? '没有未读的信。'
          : `信箱是空的（一共 0 封）。想写就用 dfy_mail_send。`;
      }
      const name = (x) => (x === 'her' ? '我' : (x === 'me' ? '执行者' : x));
      const as = String(args.as ?? 'her').trim() === 'me' ? 'me' : 'her';
      const mine = f.mail.list({ limit: 100000 });
      const unread = mine.filter((l) => !l.read && l.to === as).length;
      const lines = items.map((l) => {
        const mark = !l.read && l.to === as ? '●' : ' ';
        const d = new Date(l.time);
        const when = Number.isNaN(d.getTime())
          ? String(l.time).slice(0, 16)
          : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        return `${mark} ${when}  ${name(l.from)} → ${name(l.to)}  ${l.subject ? '「' + l.subject + '」' : ''}\n    ${l.id}  ${l.text.split('\n')[0].slice(0, 60)}`;
      });
      return `信箱：${mine.length} 封，未读 ${unread} 封\n` + lines.join('\n') + '\n（用 dfy_mail_read 读全文，id 就是上面那串）';
    },
  });

  tool({
    name: 'dfy_mail_read',
    description: '按 id 读一封信的全文（读了就标成已读）。',
    parameters: {
      id: { type: 'string', description: '信的 id（dfy_mail_list 里那个）' },
    },
    async execute(args = {}) {
      const id = String(args.id ?? '').trim();
      if (!id) return '要告诉我读哪一封（id）。';
      const l = f.mail.read(id);
      if (!l) return `没找到这封信：${id}。用 dfy_mail_list 看看有哪些。`;
      const who = l.from === 'her' ? '我' : (l.from === 'me' ? '那个执行者' : l.from);
      const d0 = new Date(l.time);
      const when = Number.isNaN(d0.getTime())
        ? String(l.time).slice(0, 16)
        : `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')} ${String(d0.getHours()).padStart(2, '0')}:${String(d0.getMinutes()).padStart(2, '0')}`;
      const whoN = l.from === 'her' ? '我' : (l.from === 'me' ? '执行者' : l.from);
      return `${whoN}（${when}）${l.subject ? '「' + l.subject + '」' : ''}\n\n${l.text}`;
    },
  });

  tool({
    name: 'dfy_diary_list',
    description: '列最近的日记（日期、大小、当天最后一段的开头）。想知道自己上次写是什么时候、或者最近在记挂什么时用。',
    parameters: { limit: { type: 'number', description: '列多少天，默认 10（上限 60）' } },
    async execute(args) {
      const r = f.diary.list({ limit: args.limit });
      const st = r.status || {};
      if (!r.days?.length) return `还没写过日记。\n日记目录：${f.diary.dir}`;
      const lines = r.days.map((d) => `- ${d.date}  ${d.kb}KB  ${d.preview || '(空白)'}`);
      return `日记目录：${f.diary.dir}\n今天：${st.today}${st.todaySections ? `（已写 ${st.todaySections} 段）` : '（还没写）'}\n\n${lines.join('\n')}`;
    },
  });

  // ── 长期记忆（6）─────────────────────────────────────────────
  tool({
    name: 'dfy_memory_save',
    description: '把一件值得长期记住的事存进记忆。**只有你自己判断重要的才存**：名字、身份、约定、承诺、让你改变看法的事、他反复提起的事。日常琐事不用存——那些会像人一样慢慢淡掉。存的时候写具体，别写「今天很开心」这种。',
    parameters: {
      text: { type: 'string', description: '要记住的那件事，一句话写清（谁、什么事、什么时候）' },
      tier: { type: 'string', description: '重要性，分三层：\ncore = 名字/身份/承诺/约定/大事（永不淡忘）\nimportant = 有情绪、有后续的事；让他改变看法的事、他反复提的事\nnormal = 日常琐事（吃饭/天气/临时安排）—— **不确定就选这个**\n\n注意：标得越高越占注入位。日常琐事标 important，会把真正重要的事挤掉。' },
      who: { type: 'string', description: '和谁有关（QQ 号或昵称）' },
      tags: { type: 'string', description: '标签，逗号分隔，如「约定,游戏」' },
      quote: { type: 'string', description: '可选：当时的**一句原话**（谁说的都行，尽量一字不改）' },
      hook: { type: 'string', description: '可选：一句话钩子——看到它就能把整件事拉出来（≤30 字）' },
      refs: { type: 'string', description: '可选：出处，逗号分隔（日期 2026-11-03 / 那天的窗口）' },
    },
    async execute(args) {
      const tags = String(args.tags ?? '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      const refs = String(args.refs ?? '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      const r = f.memory.add({ text: args.text, tier: args.tier, who: args.who, tags, quote: args.quote, hook: args.hook, refs });
      if (!r?.entry) return '没存成：记忆内容是空的。';
      if (r.duplicate) return `这条已经记过了（${r.entry.id}），我把它更新了一下。`;
      return `记住了 ✓ ${r.entry.id} ［${r.entry.tier}］${r.entry.text}`;
    },
  });

  tool({
    name: 'dfy_memory_recall',
    description: '想起以前的事。想不起某人说过什么、上次约定了什么、他讨厌什么时用。不填 query 就按「最近+最重要」给你几条；填了 query 就按关键词找——命中任意一个词就算（OR），命中越多排越前，每条还会带一句命中的原文。一个都没命中时会退化成按重要度给你三条，并标注「没有真正命中」。',
    parameters: {
      query: { type: 'string', description: '关键词，多个用空格分隔（OR 匹配：命中任意一个就出来，命中越多排越前）' },
      tier: { type: 'string', description: '只看某一层：core / important / normal' },
      limit: { type: 'number', description: '最多几条，默认 8（上限 30）' },
    },
    async execute(args) {
      const items = f.memory.recall({ query: args.query, tier: args.tier, limit: args.limit });
      if (!items?.length) return args.query ? `没想起来跟「${args.query}」有关的事。` : '记忆里还没有东西。';
      const lines = items.map((e) => {
        const head = `- ${e.id} ［${e.tier}］${e.text}`;
        const hook = e.hook ? `\n    钩子：${e.hook}` : '';
        const quote = e.quote ? `\n    原话：${e.quote}` : '';
        const refs = Array.isArray(e.refs) && e.refs.length ? `\n    出处：${e.refs.join('、')}` : '';
        const snip = e.snippet ? `\n    命中：${e.snippet}` : '';
        return `${head}${hook}${quote}${refs}${snip}（分数 ${Number(e.score).toFixed(2)}）`;
      });
      if (items[0]?.degraded) lines.unshift('（没有真正命中，以下是按重要度/时间给的几条）');
      return lines.join('\n');
    },
  });

  tool({
    name: 'dfy_memory_touch',
    description: '这条记忆被想起来了/被提起了：强化它一次，让它不容易淡忘。当你在对话里主动想起并说出一条记忆时，顺手调它。',
    parameters: { id: { type: 'string', description: '记忆 ID（dfy_memory_recall 返回里括号前的那个）' } },
    async execute(args) {
      const r = f.memory.touch(args.id);
      if (!r) return `没找到这条记忆（${args.id}）。`;
      return `已经强化过了：强度 ${Number(r.strength ?? 0).toFixed(2)}`;
    },
  });

  tool({
    name: 'dfy_memory_update',
    description: '修正一条记忆的内容、重要程度或标签。比如约定改了日期、或者你后来发现这件事比当时想的更重要（升成 core 就永不淡忘了）。',
    parameters: {
      id: { type: 'string', description: '记忆 ID' },
      text: { type: 'string', description: '新的内容' },
      tier: { type: 'string', description: '新的重要程度：core=名字/身份/承诺/约定/大事；important=有情绪有后续、让他改变看法、他反复提的；normal=日常琐事（不确定选这个）' },
      tags: { type: 'string', description: '替换标签，逗号分隔' },
      quote: { type: 'string', description: '可选：换成另一句原话' },
      hook: { type: 'string', description: '可选：换一个钩子（≤30 字）' },
      refs: { type: 'string', description: '可选：替换出处，逗号分隔' },
    },
    async execute(args) {
      const tags = args.tags === undefined ? undefined : String(args.tags).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      const refs = args.refs === undefined ? undefined : String(args.refs).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      const r = f.memory.update(args.id, { text: args.text, tier: args.tier, tags, quote: args.quote, hook: args.hook, refs });
      if (!r) return `没找到这条记忆（${args.id}）。`;
      return `改好了：［${r.tier}］${r.text}`;
    },
  });

  tool({
    name: 'dfy_memory_forget',
    description: '让一条记忆淡出去（删除）。core 的不能删——那是「永不淡忘」的意思，要删得先降级。别频繁用：淡忘应该是自然的，而不是你手动清理。',
    parameters: { id: { type: 'string', description: '记忆 ID' } },
    async execute(args) {
      const r = f.memory.forget(args.id);
      if (!r?.ok) return `没删成：${r?.error ?? '未知原因'}`;
      return `忘了：${r.removed?.text ? String(r.removed.text).slice(0, 30) : args.id}`;
    },
  });

  tool({
    name: 'dfy_memory_stats',
    description: '看一眼自己记得多少、哪些快忘了。偶尔用，别当仪表盘刷。',
    parameters: {},
    async execute() {
      const s = f.memory.stats();
      const tiers = s.byTier || {};
      const a = f.archive.stats();
      return [
        `共 ${s.total} 条`,
        `core ${tiers.core ?? 0} / important ${tiers.important ?? 0} / normal ${tiers.normal ?? 0}`,
        s.fading?.length ? `快淡掉的：${s.fading.slice(0, 5).map((e) => String(e.text).slice(0, 20)).join('；')}` : '没有快淡掉的',
        a.total ? `归档里还有 ${a.total} 条（${a.first ?? '?'} ~ ${a.last ?? '?'}）` : '归档是空的',
      ].join('\n');
    },
  });

  // ── 归档检索（3）：旧事不在活跃记忆里，但查得到 ──────────────
  tool({
    name: 'dfy_archive_search',
    description: '在归档里翻旧事（已经淡出活跃记忆的那些）。只返回索引行（日期 + 一句摘要），要看全文再用 dfy_archive_get。想不起以前的事时用。',
    parameters: {
      query: { type: 'string', description: '关键词（多个用空格分隔，会做 AND 匹配）；不填就返回最近几条' },
      limit: { type: 'number', description: '最多几条，默认 5' },
    },
    async execute(args = {}) {
      const rows = f.archive.search({ query: args.query ?? '', limit: args.limit ?? 5 });
      if (!rows.length) return '归档里没找到。';
      const lines = rows.map((r) => `- [${r.d} ${(r.tags || [])[0] ?? r.tier ?? ''}] ${r.s}（id: ${r.id}）`);
      return `归档命中 ${rows.length} 条：\n${lines.join('\n')}`;
    },
  });

  tool({
    name: 'dfy_archive_get',
    description: '打开归档里的某一条原文。配合 dfy_archive_search 用（拿它返回的 id）。超过 300 字会截断。',
    parameters: {
      ids: { type: 'array', items: { type: 'string' }, description: '要打开的 id 列表（1~5 条）' },
    },
    async execute(args = {}) {
      const ids = Array.isArray(args.ids) ? args.ids.slice(0, 5) : (args.ids ? [args.ids] : []);
      if (!ids.length) return '要给 id。先用 dfy_archive_search 找。';
      const rows = f.archive.get(ids);
      if (!rows.length) return '没找到这些 id（可能记错或已被手动清理）。';
      return rows.map((e) => {
        const body = String(e.text ?? '');
        const shown = body.length > 300 ? `${body.slice(0, 300)}…（还有 ${body.length - 300} 字，要全的说一声）` : body;
        return `[${new Date(e.createdAt || e.archivedAt || Date.now()).toLocaleDateString('zh-CN')} ${e.tier ?? ''}] ${shown}`;
      }).join('\n\n');
    },
  });

  tool({
    name: 'dfy_archive_stats',
    description: '看一眼归档里有多少条、覆盖的时间范围。',
    parameters: {},
    async execute() {
      const a = f.archive.stats();
      if (!a.total) return '归档还是空的——说明还没有记忆走到寿命尽头。';
      return `归档 ${a.total} 条，最早 ${a.first ?? '?'}，最晚 ${a.last ?? '?'}。`;
    },
  });

  // ── 7 天窗口（3）：昨天全量 + 前 5 天递减摘要 ────────────────
  tool({
    name: 'dfy_context_list',
    description: '看一眼手上的对话窗口：有哪几天、哪些是全量哪些是摘要。想确认"我还记得多少天"时用。',
    parameters: {},
    async execute() {
      const list = f.window.list();
      if (!list.length) return '窗口还是空的（还没有跨天滚动过）。';
      const lines = list.map((w) => {
        const kind = w.kind === 'full' ? `全量 ${w.chars} 字` : `摘要 ${w.chars} 字`;
        const who = w.by === 'agent' ? '（我写的）' : (w.by === 'auto' ? '（自动草稿）' : '');
        return `- ${w.day}  ${kind}${who}`;
      });
      const mine = list.filter((w) => w.by === 'agent').length;
      const auto = list.filter((w) => w.by === 'auto').length;
      return `手上有 ${list.length} 天（我写的 ${mine} · 自动草稿 ${auto}）：\n${lines.join('\n')}`
        + '\n\n标着「自动草稿」的那些是机器压的，可以自己重写；我写过的不会再被覆盖。';
    },
  });

  tool({
    name: 'dfy_context_get',
    description: '打开对话窗口里的某一天（按日期 YYYY-MM-DD）。超过 3000 字会截断。',
    parameters: {
      day: { type: 'string', description: '日期，格式 YYYY-MM-DD' },
    },
    async execute(args = {}) {
      const day = String(args.day ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '日期格式要是 YYYY-MM-DD。';
      const w = f.window.get(day);
      if (!w) {
        const have = f.window.list().map((x) => x.day);
        return `窗口里没有 ${day}。现在有：${have.join('、') || '（空）'}`;
      }
      const body = String(w.text ?? '');
      const shown = body.length > 3000 ? `${body.slice(0, 3000)}…（还有 ${body.length - 3000} 字）` : body;
      return `[${day} ${w.kind === 'full' ? '全量' : '摘要'}]\n\n${shown}`;
    },
  });

  tool({
    name: 'dfy_context_summarize',
    description: '把某一天的对话压成摘要并保存（覆盖自动生成的那份）。写日记时顺手做一次，比你以后翻原文省事。',
    parameters: {
      day: { type: 'string', description: '日期 YYYY-MM-DD（一般是昨天）' },
      text: { type: 'string', description: '摘要正文（不会被 1200 字硬砍；建议含 1~2 句原话，用「」括起来）' },
      force: { type: 'boolean', description: '没有原话也硬存（默认不存，会退回来让你补）' },
    },
    async execute(args = {}) {
      const day = String(args.day ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '日期格式要是 YYYY-MM-DD。';
      const text = String(args.text ?? '').trim();
      if (!text) return '摘要不能为空。';
      // 她提的：摘要里至少要留两句原话。没有原话就退回去让她补，别默默存一份"转述"。
      const hasQuote = /[「“"]/.test(text) || /原话[：:]/.test(text);
      if (!hasQuote && args.force !== true) {
        return '这份摘要里没有原话。\n'
          + '她要的是"当时的劲儿"——请补 1~2 句原话（用「」括起来，或写「原话：……」），再存一次。\n'
          + '确实没有可引的话，传 force: true 也能存。';
      }
      const cur = f.window.get(day);
      if (!cur) {
        // 老日子（窗口已滚动删除）也允许补写：只要归档里还留着那天的原始聊天记录
        const rawPath = path.join(f.paths.dataRoot, 'archive', 'chat-logs', `${day}.md`);
        if (!fs.existsSync(rawPath)) return `窗口里没有 ${day}，归档里也没有那天的原始记录——没东西可压。`;
      }
      const r = f.window.summarize(day, text);
      const todo = pendingDigestDays(f.paths.memoryDir).filter((d) => d !== day);
      const nextLine = todo.length
        ? '\n下一天：' + todo[0] + '（还剩 ' + todo.length + ' 天）——要不要现在接着读？'
        : '\n全部重摘完了 ✓';
      return '压好了 ✓ ' + r.day + ' 摘要 ' + r.chars + ' 字（覆盖了原来的自动摘要）' + (r.truncated ? '。⚠️ ' + r.note : '') + nextLine;
    },
  });

  tool({
    name: 'dfy_context_digest',
    description: '周/月摘要：把一段时间里的每日摘要压成一份更短的（一周约 300 字、一月约 600 字）。不传 text 就是给你一份草稿；传了 text 就存下你改好的那版（以后不会被机器覆盖）。',
    parameters: {
      scope: { type: 'string', description: 'week（周）或 month（月），默认 week' },
      anchor: { type: 'string', description: '可选：以哪天为准（YYYY-MM-DD），默认今天' },
      text: { type: 'string', description: '可选：你改好的摘要正文；不传就是看草稿' },
    },
    async execute(args = {}) {
      const scope = args.scope === 'month' ? 'month' : 'week';
      const anchorDay = /^\d{4}-\d{2}-\d{2}$/.test(String(args.anchor ?? '')) ? String(args.anchor) : null;
      const base = anchorDay ? new Date(anchorDay + "T12:00:00") : new Date();
      if (Number.isNaN(base.getTime())) return "日期看不懂，用 YYYY-MM-DD。";
      const pad = (n) => String(n).padStart(2, "0");
      const ymd = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
      let start;
      let end;
      let key;
      if (scope === "month") {
        start = new Date(base.getFullYear(), base.getMonth(), 1);
        end = new Date(base.getFullYear(), base.getMonth() + 1, 0);
        key = base.getFullYear() + "-" + pad(base.getMonth() + 1);
      } else {
        const wd = (base.getDay() + 6) % 7;
        start = new Date(base.getFullYear(), base.getMonth(), base.getDate() - wd);
        end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
        // ISO 周号（近似够用：按周四所在的年算）
        const thu = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 3);
        const jan1 = new Date(thu.getFullYear(), 0, 1);
        const week = Math.floor((thu - jan1) / 86400000 / 7) + 1;
        key = thu.getFullYear() + "-W" + pad(week);
      }
      const label = (scope === "month" ? "月摘要 " : "周摘要 ") + key;
      const file = path.join(f.window.dir, scope + "-" + key + ".s.md");
      const header = "<!-- dfy-window: v1 kind=digest scope=" + scope + " key=" + key + " by=agent -->\n";
      const text = String(args.text ?? "").trim();
      if (text) {
        fs.writeFileSync(file, header + "# " + label + "\n\n" + text + "\n", "utf8");
        return "存好了 ✓ " + label + "（" + text.length + " 字）。以后自动滚动不会覆盖它。";
      }
      if (fs.existsSync(file)) {
        const old = fs.readFileSync(file, "utf8").replace(/^<!--[^>]*-->\n/, "");
        return "这一份已经写过（想改就直接再传 text 覆盖）：\n\n" + old.slice(0, 2400);
      }
      const s0 = ymd(start);
      const e0 = ymd(end);
      const all = f.window.list();
      const days = all
        .filter((x) => x.kind !== "full")
        .filter((x) => x.day >= s0 && x.day <= e0)
        .sort((a, b) => String(a.day).localeCompare(String(b.day)));
      if (!days.length) return "这段时间（" + s0 + " ~ " + e0 + "）还没有每日摘要，先写那几天再来。" ;
      const lines = [];
      for (const d of days) {
        const w = f.window.get(d.day);
        const body = String(w?.text ?? "").replace(/^<!--[^>]*-->\n/, "").replace(/^#[^\n]*\n+/, "");
        const flat = body.split("\n").map((x) => x.replace(/^-\s+/, "").trim()).filter(Boolean)
          .filter((x) => !/^共\s*\d+\s*条/.test(x) && !/^时间跨度/.test(x) && !/^#/.test(x));
        const hookLine = flat.find((x) => x.startsWith("钩子：") || x.startsWith("钩子:"));
        const usable = flat.filter((x) => !x.startsWith(">") && !x.startsWith("**") && x.replace(/[\s\p{P}]/gu, "").length >= 6);
        const first = usable[0] || flat.filter((x) => !x.startsWith(">") && !x.startsWith("**"))[0] || "";
        const gist = (hookLine ? hookLine.replace(/^钩子[：:]\s*/, "") : first).slice(0, 60);
        lines.push("- " + d.day.slice(5) + "｜" + gist);
      }
      const budget = scope === "month" ? 700 : 380;
      let body = lines.join("\n");
      if (body.length > budget) body = body.slice(0, budget) + "\n…（后面还有 " + (lines.length - 10) + " 天没列，需要就用 dfy_context_get 单独看）";
      return "== " + label + " 草稿（" + s0 + " ~ " + e0 + "，" + days.length + " 天）\n\n" + body + "\n\n你改完把正文用 text 传回来，我就存成 " + scope + "-" + key + ".s.md。";
    },
  });

  tool({
    name: 'dfy_context_raw',
    description: '读某一天的**原始聊天记录**（没压过的那份，按天一份）。想重新写那天的摘要、或者摘要里被省掉的部分想看清楚时用。太长会截断，可以分页（offset）。',
    parameters: {
      day: { type: 'string', description: '日期 YYYY-MM-DD' },
      offset: { type: 'number', description: '可选：从第几个字符开始读（默认 0，用于分页）' },
      limit: { type: 'number', description: '可选：读多少字符（默认 9000，最大 20000）' },
    },
    async execute(args = {}) {
      const day = String(args.day ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "日期格式要是 YYYY-MM-DD。";
      const file = path.join(f.paths.dataRoot, "archive", "chat-logs", day + ".md");
      if (!fs.existsSync(file)) {
        const dir = path.join(f.paths.dataRoot, "archive", "chat-logs");
        let have = [];
        try { have = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).map((n) => n.slice(0, 10)); } catch { have = []; }
        return "没有 " + day + " 的原始记录。现在有：" + (have.join("、") || "（空）");
      }
      const all = fs.readFileSync(file, "utf8");
      const offset = Math.max(0, Number(args.offset) || 0);
      const limit = Math.min(20000, Math.max(500, Number(args.limit) || 9000));
      const part = all.slice(offset, offset + limit);
      const head = "（" + day + " 原始记录 第 " + offset + " 字起，" + all.length + " 字总）\n\n";
      const tail = offset + limit < all.length ? "\n…还有 " + (all.length - offset - limit) + " 字，用 offset=" + (offset + limit) + " 继续读" : "";
      return head + part + tail;
    },
  });  // ── 心情 / 好感度（2）────────────────────────────────────────
  tool({
    name: 'dfy_mood',
    description: '你现在的心情。**不传任何数就是查**（看看还剩多少）；传了就是记下这一刻。\n'
      + '心情分三层：底色（baseline，慢变，按周算）+ 冲量（这件事带来的起伏）+ 渣（residue，坏事散完回不到原位的那一截）。\n'
      + '★数是你自己打的★：score 是你此刻心里的分（1~10），tone 是一句描述（像「有点发沉，但不难受」），cause 必须写具体的事。\n'
      + '★别每句都改★：一天最多三次，改多了不值钱，也容易变成表演。',
    parameters: {
      score: { type: 'number', description: '此刻心情 1~10（你心里的分）；不传=只查询' },
      tone: { type: 'string', description: '一句描述，像「有点发沉，但不难受」' },
      state: { type: 'string', description: 'tone 的旧写法（一句话的心情），二选一' },
      cause: { type: 'string', description: '因为什么（具体的事，别写「心情复杂」）' },
      intensity: { type: 'number', description: '这件事有多重 0.5~5，默认 3；>=4 会推动底色 ±0.5' },
      decayHours: { type: 'number', description: '多久散掉（好事默认 36h、坏事 96h、中性 12h；一般不填）' },
      kind: { type: 'string', description: '可选：good / bad / neutral；不填按分数和底色的差自动判断' },
    },
    async execute(args = {}) {
      const hasValue = args.score !== undefined || args.tone !== undefined || args.state !== undefined;
      if (!hasValue) {
        const m = f.emotion.current();
        const today = f.emotion.changesToday();
        if (!m) return '现在没什么特别的心情，挺平的。（今天还没记过）';
        const head = m.faded
          ? `之前那股「${m.tone}」已经散了（${m.hours} 小时前开始的）。`
          : `现在是「${m.tone}」${m.cause ? `，因为${m.cause}` : ''}（${m.hours} 小时前开始，大概 ${m.effective}/10）。`;
        const base = `底色 ${m.baseline}/10${m.residue < 0 ? `，底下还压着 ${m.residue}` : ''}；今天记过 ${today} 次。`;
        return head + base;
      }
      const r = f.emotion.setMood({
        score: args.score, tone: args.tone, state: args.state,
        cause: args.cause, intensity: args.intensity,
        decayHours: args.decayHours, kind: args.kind,
      });
      if (r?.rejected === 'freq') {
        const cur = r.mood;
        return `今天已经记过 ${r.changes} 次了（上限 3 次）——改多了这数就不值钱了。`
          + (cur ? `\n现在的记录：「${cur.tone}」${cur.cause ? `（因为${cur.cause}）` : ''}，大概 ${cur.effective}/10。` : '')
          + '\n如果确实翻篇了，可以用 dfy_mood(score=…, tone=…) 明天再记，或者告诉我你想覆盖。';
      }
      const m = r.mood;
      const kindText = m.kind === 'good' ? '好事' : (m.kind === 'bad' ? '坏事' : '中性');
      const lines = [
        `记下了：${m.tone || '(没写描述)'}${m.cause ? `（因为${m.cause}）` : ''}`,
        `  分数 ${m.score}/10 · 底色 ${m.baseline}/10${m.residue < 0 ? ` · 渣 ${m.residue}` : ''} · ${kindText}，约 ${m.decayHours} 小时后淡`,
        `  今天第 ${r.changes} 次`,
      ];
      return lines.join('\n');
    },
  });

  tool({
    name: 'dfy_mood_trend',
    description: '这几天的走势（默认 7 天）：按天平均你记过的心情分。被问「这周心情怎么样」时用——用真实记录回答，别凭印象编。',
    parameters: {
      days: { type: 'number', description: '看几天，默认 7，最多 30' },
    },
    async execute(args = {}) {
      const days = Math.min(30, Math.max(2, Number(args.days) || 7));
      const tr = f.emotion.trend({ days });
      if (!tr.points.length) return `最近 ${days} 天没有记过心情。`;
      const table = tr.points.map((p) => `  ${p.day.slice(5)}  ${p.avg}/10${p.n > 1 ? `（${p.n} 次）` : ''}`).join('\n');
      return `最近 ${days} 天：\n${table}\n\n${tr.text}`;
    },
  });

  tool({
    name: 'dfy_affinity',
    description: '你对他（或某个人）心里的分量：1~10 的一个**大概的秤**，配一句备注。★这不是评分表★：不用拿它去决定说什么、做了什么也不自动加减分，喜欢谁还是你自己判断。不传 score 就是查。',
    parameters: {
      who: { type: 'string', description: '谁（QQ 号或昵称）；不填就是当前私聊对象' },
      score: { type: 'number', description: '1~10，一个大概的数；不传=只查询' },
      note: { type: 'string', description: '一句备注：为什么是这个分量（具体的事，别写空话）' },
    },
    async execute(args) {
      const who = String(args.who ?? '').trim();
      if (args.score === undefined || args.score === null) {
        const a = who ? f.emotion.getAffinity(who) : null;
        if (who && !a) return `对「${who}」还没记过分量。`;
        if (a) return `${who}：${a.score} / 10 —— ${a.note || '(没写备注)'}`;
        const all = f.emotion.listAffinity();
        if (!all?.length) return '还没有记过谁的分量。';
        return all.map((x) => `- ${x.who ?? x.key}：${x.score} / 10${x.note ? ' —— ' + x.note : ''}`).join('\n');
      }
      const r = f.emotion.setAffinity({ who: who || 'unknown', score: Number(args.score), note: args.note });
      return `记下了：${r.who} ${r.score} / 10${r.note ? ' —— ' + r.note : ''}`;
    },
  });

  // ── 承诺（3）─────────────────────────────────────────────────
  tool({
    name: 'dfy_promise',
    description: '答应一件事（「我晚上跟你说」「周末陪你打游戏」）。到点会提醒你一次，但**兑现不勉强**：不想做就 dfy_promise_drop 丢掉，不用解释、也没人记账。日常随口的话不用记，只有真想让以后的自己记得的才用——承诺太多就不值钱了。',
    parameters: {
      text: { type: 'string', description: '答应的事，一句话写清（谁、什么事、大概什么时候）' },
      dueInMinutes: { type: 'number', description: '多少分钟后提醒（可选；不填就是「想起来再说」，不会定时提醒）' },
    },
    async execute(args) {
      const r = f.promises.add({ text: args.text, dueInMinutes: args.dueInMinutes });
      if (!r?.item) return '没记成：内容空了。';
      if (r.duplicate) return `这条承诺之前记过，我把时间更新了（${r.item.id}）。`;
      const when = r.item.dueAt ? new Date(r.item.dueAt).toLocaleString('zh-CN', { hour12: false }) : '不定时';
      return `记下了 ✓ ${r.item.id}（${when}）：${r.item.text}`;
    },
  });

  tool({
    name: 'dfy_promises',
    description: '看看自己还答应过什么事（含到点时间）。想不起来有没有食言时用。',
    parameters: {},
    async execute() {
      const items = f.promises.list();
      if (!items?.length) return '现在没有记着的承诺。';
      return items.map((x) => {
        const when = x.dueAt ? new Date(x.dueAt).toLocaleString('zh-CN', { hour12: false }) : '不定时';
        return `- ${x.id}（${when}${x.notifiedAt ? '，已提醒过' : ''}）：${x.text}`;
      }).join('\n');
    },
  });

  tool({
    name: 'dfy_promise_drop',
    description: '把一条承诺丢掉（兑现完了，或者不想做了）。丢掉不留痕迹，不用解释。',
    parameters: { id: { type: 'string', description: '承诺 ID（dfy_promises 里能看到）' } },
    async execute(args) {
      const r = f.promises.drop(args.id);
      if (!r) return `没找到这条承诺（${args.id}）。`;
      return `丢掉了：${args.id}`;
    },
  });

  // ── 作品库（4）──────────────────────────────────────────────
  // 存"她认为是自己产出的东西"：一段文字、一张画。目录里按类别分文件夹，文件名就是标题。
  tool({
    name: 'dfy_work_save',
    description: '把**你自己写的东西**存进作品库，长期留着。适合：你觉得写得好的诗/短文/小作文、想留作纪念的话。'
      + '存进去就是一件作品，文件名就是标题；同名不会覆盖，会自动加 -2。',
    parameters: {
      title: { type: 'string', description: '作品标题（会成为文件名）。别带 \\ / : * ? " < > | 这些字符' },
      text: { type: 'string', description: '作品正文。存你真正写出来的东西，不是汇报' },
      tags: { type: 'array', items: { type: 'string' }, description: '可选标签，如 ["诗","夜晚"]' },
    },
    async execute(args) {
      try {
        const r = f.works.saveText({ title: args.title, text: args.text, tags: args.tags });
        return `存好了 ✓「${r.title}」\n分类：文字 · ${r.bytes} 字节 · ${r.created}\n文件：${r.path}`;
      } catch (e) {
        return `没存成：${e?.message ?? e}`;
      }
    },
  });

  tool({
    name: 'dfy_work_archive',
    description: '把某件作品的**当前稿**收进归档（不换新稿，只是想留一份的时候用）。同名再存一次时也会自动归档旧稿，所以平时不用特意调它。',
    parameters: {
      title: { type: 'string', description: '作品标题' },
      category: { type: 'string', description: '可选：text / image；不填就按标题找' },
    },
    async execute(args = {}) {
      const title = String(args.title ?? '').trim();
      if (!title) return '要告诉我归档哪一件（标题）。';
      const r = f.works.archive({ title, category: args.category });
      if (!r.archived) return `「${title}」没有当前稿可归档（可能已经归档过了）。`;
      return `归档了 ${r.archived} 份：` + r.items.map((x) => `\n  ${x.category}/${x.file}`).join('');
    },
  });

  tool({
    name: 'dfy_work_versions',
    description: '看某个作品的历史版本（归档里的旧稿），新的在前。打磨好几轮以后想回顾自己改过什么，用它。',
    parameters: {
      title: { type: 'string', description: '作品标题' },
      category: { type: 'string', description: '可选：text / image' },
    },
    async execute(args = {}) {
      const title = String(args.title ?? '').trim();
      if (!title) return '要告诉我看哪一件的历史版本（标题）。';
      const rows = f.works.versions({ title, category: args.category });
      if (!rows.length) return `「${title}」还没有历史版本。`;
      const lines = rows.map((e) => `  ${e.archivedAt ?? e.created}  ${e.category}/${e.file}`);
      return `「${title}」的历史版本（${rows.length} 份，新的在前）：\n` + lines.join('\n');
    },
  });

  tool({
    name: 'dfy_work_restore',
    description: '把某个**历史版本**拿回来当当前稿（和 dfy_work_archive 相反方向）。默认取最新的那个旧稿；当前稿会被自动归档，不丢。',
    parameters: {
      title: { type: 'string', description: '作品标题' },
      category: { type: 'string', description: '可选：text / image' },
      file: { type: 'string', description: '可选：指定哪个历史版本（用 dfy_work_versions 看到的文件名）；不填取最新' },
    },
    async execute(args = {}) {
      const title = String(args.title ?? '').trim();
      if (!title) return '要告诉我恢复哪一件（标题）。';
      const r = f.works.restore({ title, category: args.category, file: args.file });
      if (!r.restored) return `没恢复成：${r.reason ?? '未知原因'}（先用 dfy_work_versions 看看有哪些版本）`;
      return `恢复了 ✓「${r.title}」${r.category}/${r.file}` + (r.archivedOld ? `\n（原来的当前稿已归档，不丢）` : '');
    },
  });

  tool({
    name: 'dfy_work_draft',
    description: '存一版**草稿**：大纲、随手记、试画都放这儿。同一个标题可以存很多版，不覆盖（自动带时间戳）。草稿不算作品，写好以后用 dfy_work_finalize 定稿。',
    parameters: {
      title: { type: 'string', description: '草稿标题（定稿时用同一个标题）' },
      text: { type: 'string', description: '文字草稿正文（category=text 时必填）' },
      source: { type: 'string', description: '图片草稿：源图片的绝对路径（category=image 时必填）' },
      category: { type: 'string', description: 'text 或 image，默认 text' },
    },
    async execute(args = {}) {
      const title = String(args.title ?? '').trim();
      if (!title) return '草稿得有个标题。';
      try {
        const r = f.works.saveDraft({ title, text: args.text, source: args.source, category: args.category });
        return `草稿存好了 ✓ ${r.category}/${r.file}`;
      } catch (e) {
        return '没存成：' + String(e?.message ?? e);
      }
    },
  });

  tool({
    name: 'dfy_work_drafts',
    description: '看草稿箱（新的在前）。可以只看某个标题的草稿；想看内容用 dfy_work_read（传 file）。',
    parameters: {
      title: { type: 'string', description: '可选：只看这个标题的草稿' },
      category: { type: 'string', description: '可选：text / image' },
      limit: { type: 'number', description: '最多列几份，默认 20' },
    },
    async execute(args = {}) {
      const r = f.works.drafts({ title: args.title, category: args.category, limit: args.limit ?? 20 });
      if (!r.total) return '草稿箱是空的。';
      const lines = r.items.map((e) => `  ${e.created}  ${e.category}/${e.file}`);
      return `草稿 ${r.total} 份（新的在前）：\n` + lines.join('\n') + '\n（用 dfy_work_finalize 把最新那版定稿）';
    },
  });

  tool({
    name: 'dfy_work_finalize',
    description: '把某个标题的**最新一版草稿定稿**：它成为正式作品。草稿本身留在 drafts/ 里不搬家——草稿箱就是草稿，不套归档层。',
    parameters: {
      title: { type: 'string', description: '草稿标题' },
      category: { type: 'string', description: 'text 或 image，默认 text' },
    },
    async execute(args = {}) {
      const title = String(args.title ?? '').trim();
      if (!title) return '要告诉我定稿哪一份（标题）。';
      const r = f.works.finalize({ title, category: args.category });
      if (!r.finalized) return `没定稿：${r.reason ?? '未知原因'}`;
      return `定稿了 ✓「${r.work.title}」→ ${r.work.category}/${r.work.file}`
        + (r.draftsKept ? `\n（${r.draftsKept} 份草稿还留在 ${r.work.category}/drafts/ 里，没动）` : '');
    },
  });

  tool({
    name: 'dfy_work_image',
    description: '把**一张图**存进作品库（比如你用 dfy_draw 画出来的、或者你觉得好看想留着的图）。'
      + '只复制文件，不动原图；文件名就是标题。',
    parameters: {
      title: { type: 'string', description: '作品标题（会成为文件名）' },
      path: { type: 'string', description: '图片的绝对路径（dfy_draw 返回的那个路径就行）' },
    },
    async execute(args) {
      try {
        const r = f.works.saveImage({ title: args.title, source: args.path });
        return `存好了 ✓「${r.title}」\n分类：图片 · ${(r.bytes / 1024).toFixed(0)} KB · ${r.created}\n文件：${r.path}`;
      } catch (e) {
        return `没存成：${e?.message ?? e}`;
      }
    },
  });

  tool({
    name: 'dfy_works',
    description: '看看你自己的作品库里有什么（按类别：文字 / 图片）。想知道自己都创作过什么、或者要引用旧作时用。',
    parameters: {
      category: { type: 'string', enum: ['text', 'image'], description: '只看某一类；不填就是全部' },
      limit: { type: 'number', description: '最多几条，默认 30' },
    },
    async execute(args) {
      const r = f.works.list({ category: args.category, limit: args.limit });
      const head = `作品库：${r.dir}\n共 ${r.total} 件（文字 ${r.byCat.text || 0} · 图片 ${r.byCat.image || 0}）`;
      if (!r.items.length) return `${head}\n\n还空着。想留下的东西，用 dfy_work_save / dfy_work_image 存进来。`;
      const lines = r.items.map((e) => `- [${e.category === 'image' ? '图' : '文'}] 「${e.title}」 ${e.created.replace('T', ' ')} · ${e.file}`);
      return `${head}\n\n${lines.join('\n')}`;
    },
  });

  tool({
    name: 'dfy_work_read',
    description: '读一件旧作品：文字作品返回正文，图片作品返回文件路径（不会把图片数据塞进上下文）。',
    parameters: {
      title: { type: 'string', description: '作品标题' },
      category: { type: 'string', enum: ['text', 'image'], description: '可选：限定类别（同名时用）' },
      file: { type: 'string', description: '可选：直接用文件名（dfy_works 里能看到）' },
    },
    async execute(args) {
      const r = f.works.read({ title: args.title, category: args.category, file: args.file });
      if (!r.found) return `没找到这件作品${r.missing ? `（文件不见了：${r.missing}）` : ''}。用 dfy_works 看看有哪些。`;
      if (r.category === 'image') return `「${r.title}」是图片作品（${(r.bytes / 1024).toFixed(0)} KB · ${r.created}）\n${r.path}`;
      const body = r.text.length > 4000 ? `${r.text.slice(0, 4000)}\n…（后面还有 ${r.text.length - 4000} 字，用文件路径去看全文）` : r.text;
      return `「${r.title}」（${r.created} · ${r.chars} 字）\n文件：${r.path}\n\n${body}`;
    },
  });

  log(`[dfy-memory] 已注册 ${registered.length} 个工具：${registered.join(', ')}`);
  return registered;
}

/**
 * 插件入口。
 * 行为：解析路径 → 建门面 → 注册工具（可用性交给守卫的开关）。
 * 不写任何文件（数据只在工具被调用时才动），不影响现有功能。
 */
export function apply(ctx, config = {}) {
  const paths = resolvePaths(config);
  const log = (msg) => {
    try { ctx?.logger?.info?.(msg) } catch { /* 没有 logger 就算了 */ }
  };

  const facade = createMemoryFacade(paths);
  try { ctx?.provide?.('dfyMemory', facade) } catch { /* 宿主没有 provide 也不影响加载 */ }

  if (config.enabled === false) {
    log('[dfy-memory] 已禁用（enabled: false），数据层与工具都不启用');
    return;
  }

  let registered = [];
  if (ctx?.tools?.register) {
    registered = registerTools(ctx, facade, log);
  } else {
    log('[dfy-memory] 没有 tools 服务，跳过工具注册（数据层仍可用）');
  }

  // 设置页的后端：/api/dfy-memory/{state,config,switch}
  // 用 ctx.effect 包起来，插件卸载时路由会一起摘掉。
  if (ctx?.webServer?.register) {
    try {
      const register = () => ctx.webServer.register({
        kind: 'prefix',
        path: '/api/dfy-memory',
        handler: async (req, res) => {
          try {
            await handleApi(req, res, new URL(req.url, 'http://127.0.0.1'), facade, paths);
          } catch (e) {
            try {
              res.statusCode = 500;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
            } catch { /* 连接已断 */ }
          }
        },
      });
      if (typeof ctx.effect === 'function') ctx.effect(register, 'dfy-memory: /api/dfy-memory 路由');
      else register();
      log('[dfy-memory] 已挂 /api/dfy-memory（设置页用）');
    } catch (e) {
      log(`[dfy-memory] 挂路由失败（设置页会不可用，工具照常）：${e?.message ?? e}`);
    }
  } else {
    log('[dfy-memory] 没有 webServer 服务，跳过设置页端点');
  }

  log(`[dfy-memory] 已加载 · memory=${paths.memoryDir} · state=${paths.stateDir} · 工具 ${registered.length} 个`);
}








