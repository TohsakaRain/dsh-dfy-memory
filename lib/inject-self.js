/**
 * lib/inject-self.js —— 自注入（把记忆块挂进 system prompt）
 * ============================================================================
 * 默认**关**。开关有两处来源，优先级：设置文件 > cordis.patch.yml 的 config.selfInject > 默认。
 *
 *   <dataRoot>/state/self-inject.json   ← 设置页「注入」tab 写的（热生效，不用重启）
 *   cordis.patch.yml 的 selfInject      ← 首次部署/无设置文件时的兜底
 *
 * 为什么设置文件优先：设置页要能**即时**开关；改 cordis.patch.yml 得重启 DSH。
 *
 * 刷新频率（对齐 QQ 桥接：每条消息算一次，同一轮里不重复算）：
 *   · 桥接那边是「每次唤醒拼一次」= 你每发一条消息，注入刷新一次；
 *     那一轮里她调多少次工具、跑多少步，读到的都是同一份。
 *   · 这里用 `agent/inbox/spliced`（有新输入进 inbox）当"来消息了"的信号 → 标脏；
 *     下一次 assembly 才真算，之后这一轮所有步都用这份快照。
 *   · 再加 refreshMs（默认 60 秒）兜底：长时间挂机时让它慢慢追上淡忘变化。
 */
import fs from 'node:fs';
import path from 'node:path';
import { SELF_INJECT_PARTS, normalizeParts } from './inject-parts.js';

/** 设置文件名（放在 <dataRoot>/state 下）。 */
export const SETTINGS_REL = path.join('state', 'self-inject.json');

/** 默认值。文档、设置页、cordis.patch.yml 的注释都以这份为准。 */
export const DEFAULT_SELF_INJECT = Object.freeze({
  enabled: false,      // 默认关
  order: 10150,        // 排在 first-party 段之后（10000 harness / 10100 web / 10200 persona）
  refreshMs: 60000,    // 兜底刷新间隔
  presets: [],         // 只给这些 agent preset 注入；空 = 所有会话
  cwdContains: [],     // 或者按会话工作目录包含关系匹配；空 = 不按目录筛
  parts: [...SELF_INJECT_PARTS],   // 注入哪几块：diary / memory / mood / promises / time
});

const clamp = (n, lo, hi, fallback) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(v)));
};

const strList = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [])
  .map((s) => String(s ?? '').trim())
  .filter(Boolean);

/** 校验/收敛一份设置（设置页和 config 都过这里，保证落盘的东西永远是合法的）。 */
export function normalizeSelfInject(input = {}, fallback = DEFAULT_SELF_INJECT) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    enabled: src.enabled === undefined ? fallback.enabled === true : src.enabled === true,
    order: clamp(src.order, 0, 20000, fallback.order),
    refreshMs: clamp(src.refreshMs, 5000, 60 * 60 * 1000, fallback.refreshMs),
    presets: src.presets === undefined ? [...fallback.presets] : strList(src.presets),
    cwdContains: src.cwdContains === undefined ? [...fallback.cwdContains] : strList(src.cwdContains),
    parts: normalizeParts(src.parts === undefined ? fallback.parts : src.parts),
  };
}

/**
 * 读设置文件；不存在/坏了就返回 null（交给 config 兜底）。
 * @returns {{settings?: object, ok: boolean, error?: string}}
 */
export function readSelfInjectFile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return { ok: true, settings: normalizeSelfInject(raw) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, error: 'missing' };
    return { ok: false, error: `bad-json: ${error?.message ?? error}` };
  }
}

/** 原子写设置文件（临时文件 + rename）。 */
export function writeSelfInjectFile(file, patch = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const current = readSelfInjectFile(file);
  const base = current.ok ? current.settings : DEFAULT_SELF_INJECT;
  const next = normalizeSelfInject({ ...base, ...patch }, base);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, updatedAt: Date.now(), ...next }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return next;
}

/**
 * 合并来源：设置文件 > 插件 config.selfInject > 默认。
 * @returns {{settings: object, source: 'file'|'config'|'default', fileError?: string}}
 */
export function resolveSelfInject({ file, config = {} } = {}) {
  const cfgRaw = config && typeof config === 'object' ? config : {};
  const fromConfig = cfgRaw.enabled !== undefined || cfgRaw.order !== undefined
    || cfgRaw.refreshMs !== undefined || cfgRaw.presets !== undefined || cfgRaw.cwdContains !== undefined;
  const fallback = normalizeSelfInject(cfgRaw, DEFAULT_SELF_INJECT);
  const got = file ? readSelfInjectFile(file) : { ok: false, error: 'no-file' };
  if (got.ok) return { settings: got.settings, source: 'file' };
  return {
    settings: fallback,
    source: fromConfig ? 'config' : 'default',
    fileError: got.error,
  };
}

/**
 * 这个会话该不该注入。
 * @param {{preset?: string, cwd?: string}} session
 * @param {object} cfg
 */
export function matchesSession(session = {}, cfg = {}) {
  const presets = strList(cfg.presets);
  const cwds = strList(cfg.cwdContains).map((s) => s.toLowerCase());
  if (!presets.length && !cwds.length) return true;   // 没配 = 所有会话都注入
  const preset = String(session.preset ?? '').trim();
  if (presets.length && presets.includes(preset)) return true;
  const cwd = String(session.cwd ?? '').toLowerCase();
  if (cwds.length && cwds.some((needle) => cwd.includes(needle))) return true;
  return false;
}

/**
 * 快照提供器：每步都会被调一次，但只有「标脏了」「超过 refreshMs」「设置变了」才真去算。
 * @param {{getBlock: () => string, refreshMs?: number, now?: () => number}} opts
 */
export function createSnapshotProvider({ getBlock, refreshMs = 60000, now = () => Date.now() } = {}) {
  if (typeof getBlock !== 'function') throw new Error('createSnapshotProvider 需要 getBlock');
  let text = '';
  let at = 0;
  let dirty = true;
  let computes = 0;

  return {
    /** 有新输入（新一轮消息）→ 下一次求值时重算。 */
    markDirty() { dirty = true; },
    /** 每步调用；返回这一轮固定的那份文本。 */
    text(overrideRefreshMs) {
      const t = now();
      const ms = Number(overrideRefreshMs) > 0 ? Number(overrideRefreshMs) : refreshMs;
      if (dirty || t - at >= ms) {
        text = String(getBlock() ?? '');
        at = t;
        dirty = false;
        computes += 1;
      }
      return text;
    },
    /** 调试/自检用：现在这份是什么、算过几次。 */
    peek() { return { text, at, dirty, computes }; },
  };
}

/**
 * 把自注入挂进 DSH。**不按开关门控**：开关在每次求值时现读（设置页改了立刻生效）。
 * 关着的时候 section 返回空串，DSH 会把空 section 丢掉，等于没有。
 *
 * @param ctx       DSH 插件的 ctx
 * @param opts.file 设置文件（<dataRoot>/state/self-inject.json）
 * @param opts.config cordis.patch.yml 里的 selfInject（设置文件缺失时的兜底）
 * @returns {{ ok: boolean, status?: () => object, why?: string }}
 */
export function wireSelfInject(ctx, opts = {}, facade, log = () => {}, now = () => Date.now()) {
  if (typeof ctx?.on !== 'function') return { ok: false, why: 'no-events' };
  const file = opts.file || null;
  // build(now, settings) 由调用方给：默认只拼记忆，index.js 会传一个拼多块的
  const build = typeof opts.build === 'function'
    ? opts.build
    : (now) => String(facade?.memory?.forPrompt?.() ?? '');
  const settingsNow = () => {
    const r = resolveSelfInject({ file, config: opts.config });
    const sig = JSON.stringify(r.settings);
    if (sig !== lastSig) { lastSig = sig; provider.markDirty(); }
    return { ...r.settings, source: r.source, fileError: r.fileError };
  };

  const provider = createSnapshotProvider({ getBlock: () => build(now(), settingsNow()), now });
  const mounted = new Map();
  let lastSig = '';


  const onCreated = (payload = {}) => {
    const agent = payload?.agent;
    if (!agent?.ctx) return;
    try {
      const sess = agent.session || {};
      const preset = String(sess.header?.agentPreset ?? sess.meta?.agentPreset ?? '');
      const cwd = String(sess.header?.cwd ?? sess.meta?.cwd ?? '');
      const s = settingsNow();
      // ⚠️ 注册时**不**按 presets 过滤：section 常驻，匹配放到每次求值时判。
      //    否则"先关着、后来才配上 preset"的会话永远挂不上。
      if (typeof agent.ctx.systemPrompt?.section !== 'function') {
        log('[dfy-memory] 这个 agent 没有 systemPrompt 服务，自注入跳过');
        return;
      }
      const attached = { preset, cwd };
      const attach = () => {
        agent.ctx.systemPrompt.section({
          name: 'dfy:memory',
          order: s.order,
          text: () => {
            const cur = settingsNow();
            if (!cur.enabled) return '';
            // ⚠️ 匹配**每次现判**：改 presets / cwdContains 立刻生效，不用重建会话。
            //    也能防止"注册时没配、后来配上了"或反过来的错挂。
            if (!matchesSession(attached, cur)) return '';
            return provider.text(cur.refreshMs);
          },
        });
        if (typeof agent.ctx.on === 'function') {
          agent.ctx.on('agent/inbox/spliced', () => provider.markDirty());
        }
        return () => { /* 归 agent.ctx，随 agent 销毁自动摘掉 */ };
      };
      if (typeof agent.ctx.effect === 'function') agent.ctx.effect(attach);
      else attach();
      const id = String(agent.id ?? '?');
      mounted.set(id, { preset, cwd, at: now() });
      log('[dfy-memory] 自注入已挂到 ' + id + '（preset=' + (preset || '任意') + '，开关=' + (s.enabled ? '开' : '关') + '）');
    } catch (error) {
      log('[dfy-memory] 自注入挂载失败：' + (error?.message ?? error));
    }
  };

  ctx.on('agent/created', onCreated);
  log('[dfy-memory] 自注入已就绪（开关现读设置文件，默认关）');

  return {
    ok: true,
    status: () => ({
      ...settingsNow(),
      mounted: [...mounted].map(([id, v]) => ({ id, ...v })),
      last: provider.peek(),
      file,
    }),
  };
}
