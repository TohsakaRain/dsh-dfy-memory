/**
 * lib/tuning.js —— 记忆调参：一个真源，两边共用
 * ============================================================================
 * 为什么真源是**桥接的 config.json**，不是插件自己的 config：
 *
 *   · 真正拼注入进 prompt 的是桥接（`injection.source = "bridge"`），
 *     它读的是自己的 `cfg.memory.*`（见 src/memory-store.js 的 recallForPrompt）；
 *   · 生命周期维护由桥接定时打插件的 `/api/dfy-memory/maintain`，参数也该是同一份；
 *   · 插件和桥接本来就写同一批数据文件，参数再分两套，"她记得几条"就会两边打架。
 *
 * 所以这里只做三件事：读那份 json（带 mtime 缓存）、合并默认值、校验范围。
 * 写也是读-改-写，只动 `memory` / `lifecycle` 两段里的目标键，
 * 不碰 `memory.dir`、`maxEntries` 这些不归 UI 管的键。
 *
 * ⚠️ 字段名刻意跟消费方对齐（不是我自己起的）：
 *   消费方在 lib/memory-store.js 的 tuningOf(cfg)：
 *     cfg.memory.injectLimit / injectMaxChars / halfLife*Days / fadeThreshold
 *     cfg.lifecycle.enabled / lifespan*Days / blurKeepDays / normalKeepDays
 *
 * ⭐ 2026-11-22 第二轮收敛（使用者提的）：半衰期和寿命本来就是"同一个天数"，
 *   原来拆成 halfLife*Days 和 lifespan*Days 两个旋钮，默认值还一样，界面上纯属让人
 *   手抄两遍。现在 UI 上只有 `importantDays` / `normalDays`，写入时多个键一起写，
 *   读的时候哪个有就用哪个（老配置里只有 halfLife*）。
 *   同理 `自动淡忘` 一个开关写 `memory.lifecycleEnabled` + `lifecycle.enabled`。
 *
 * ⭐ 2026-11-22 第三轮收敛（使用者提的）：`blurKeepDays` / `normalKeepDays`（"模糊后
 *   还能活多久"）也是同一件事的第二段而已 —— 一个层天数够用了。所以：
 *     importantDays → memory.halfLifeImportantDays
 *                   + lifecycle.lifespanImportantDays   （N 天后第一次模糊）
 *                   + lifecycle.blurKeepDays             （再过 N 天压成一句话）
 *     normalDays    → memory.halfLifeNormalDays
 *                   + lifecycle.lifespanNormalDays       （N 天后第一次模糊）
 *                   + lifecycle.normalKeepDays           （再过 N 天归档）
 *   两个天数默认都是 14。想让第二段固定天数而不是跟着走，改 toCfg / writeTuning
 *   里那两行即可。
 *
 * ⭐ `fadeThreshold`（淡出阈值，0.02）不在界面上：它只是兜底，正常情况下不触发，
 *   改坏了反而会让记忆莫名其妙地"淡"掉。它仍在默认值和 cfg 里透传，只是不可编辑。
 * ============================================================================
 */
import fs from 'node:fs';

/** 界面上能改的东西。设置页直接照这个渲染表单。 */
export const TUNING_SPEC = [
  {
    group: '注入',
    fields: [
      {
        key: 'injectLimit', label: '每轮注入几条', type: 'number',
        min: 0, max: 20, step: 1, unit: '条', def: 8,
        hint: '0 = 一条都不注入（连 core 也不带）。core（名字/身份/约定/原则）永远全带、且不压缩，不吃这几个名额',
      },
      {
        key: 'injectMaxChars', label: '注入总字数上限', type: 'number',
        min: 200, max: 2000, step: 50, unit: '字', def: 600,
        hint: '只卡 core 之外的条目；core 是整段正文进来的，不算在这 600 里',
      },
      {
        key: 'coreCompact', label: '压缩 core 记忆', type: 'bool', def: false,
        hint: '默认关。关着 = core 用完整正文（和 memory.md 一致）；开了 = core 也只留钩子一行，省 token 但对不上原文',
      },
    ],
  },
  {
    group: '淡忘',
    fields: [
      {
        key: 'importantDays', label: 'important 天数', type: 'number',
        min: 1, max: 3650, step: 1, unit: '天', def: 14,
        hint: '一个数管整段：到点模糊成 100 字，再过同样久压成一句话；之后一直留着（不归档）。被想起来会重新变清楚',
      },
      {
        key: 'normalDays', label: 'normal 天数', type: 'number',
        min: 1, max: 3650, step: 1, unit: '天', def: 7,
        hint: '到点模糊成 25 字，再过同样久进归档（归档 = 算作忘掉，之后想起来也捞不回原文）。归档前被想起来会重新变清楚',
      },
    ],
  },
  {
    group: '维护',
    fields: [
      {
        key: 'lifecycleEnabled', label: '自动淡忘', type: 'bool', def: true,
        hint: '关掉 = 记忆只增不老化，永不模糊归档',
      },
      {
        key: 'lifecycleIntervalMs', label: '检查间隔', type: 'number',
        min: 60000, max: 86400000, step: 60000, unit: '毫秒', def: 600000,
        hint: '默认 10 分钟；改完桥接下一轮就按新间隔走',
      },
    ],
  },
];

/** 不可编辑、但仍要透传给消费方的参数（只读兜底）。 */
export const HIDDEN_DEFAULTS = Object.freeze({ fadeThreshold: 0.02 });

const FIELD = new Map();
for (const g of TUNING_SPEC) for (const f of g.fields) FIELD.set(f.key, f);

export const TUNING_DEFAULTS = Object.freeze({
  ...HIDDEN_DEFAULTS,
  ...Object.fromEntries([...FIELD].map(([k, f]) => [k, f.def])),
});

/* ── 读 ─────────────────────────────────────────────────────────────── */

const cache = new Map(); // file -> { mtimeMs, doc }

/** 读 config.json（mtime 变了才重读，热路径上一轮也就一次 stat）。 */
export function readConfigDoc(file) {
  if (!file) return null;
  try {
    const st = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.doc;
    const doc = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    cache.set(file, { mtimeMs: st.mtimeMs, doc });
    return doc;
  } catch {
    return null;
  }
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 从 config.json 里读出扁平的一组参数。
 * @returns {{found:boolean, file:string|null, values:object, fromFile:object}}
 */
export function readTuning(file) {
  const doc = readConfigDoc(file);
  const mem = (doc && typeof doc.memory === 'object' && doc.memory) || {};
  const lc = (doc && typeof doc.lifecycle === 'object' && doc.lifecycle) || {};
  const values = { ...TUNING_DEFAULTS };
  const fromFile = {};

  const take = (key, raw) => {
    const n = num(raw);
    if (n === null) return false;
    values[key] = n;
    fromFile[key] = n;
    return true;
  };

  take('injectLimit', mem.injectLimit);
  take('injectMaxChars', mem.injectMaxChars);
  // 一个天数两个键：老配置只有 memory.halfLife*，新配置两个都写
  if (!take('importantDays', mem.halfLifeImportantDays)) take('importantDays', lc.lifespanImportantDays);
  if (!take('normalDays', mem.halfLifeNormalDays)) take('normalDays', lc.lifespanNormalDays);
  take('lifecycleIntervalMs', mem.lifecycleIntervalMs);
  take('fadeThreshold', mem.fadeThreshold);

  // 开关两个键各在一处；任一显式为 false 就算关（偏保守：宁可少动她的记忆）
  const enabledRaw = [mem.lifecycleEnabled, lc.enabled].find((v) => v !== undefined && v !== null);
  if (enabledRaw !== undefined) {
    values.lifecycleEnabled = enabledRaw !== false;
    fromFile.lifecycleEnabled = values.lifecycleEnabled;
  }

  // core 压缩开关：只有显式 true 才开（默认关）
  if (mem.coreCompact !== undefined && mem.coreCompact !== null) {
    values.coreCompact = mem.coreCompact === true;
    fromFile.coreCompact = values.coreCompact;
  }

  return { found: Boolean(doc), file: file || null, values, fromFile };
}

/**
 * 把扁平参数换算成消费方认的 cfg 形状（memory / lifecycle 两段）。
 * @param {object} values 扁平参数
 * @param {string} memoryDir 记忆目录（放进 memory.dir，消费方会用它）
 */
export function toCfg(values, memoryDir) {
  const v = { ...TUNING_DEFAULTS, ...(values || {}) };
  return {
    memory: {
      dir: memoryDir,
      injectLimit: v.injectLimit,
      injectMaxChars: v.injectMaxChars,
      halfLifeImportantDays: v.importantDays,
      halfLifeNormalDays: v.normalDays,
      fadeThreshold: v.fadeThreshold,
      maxEntries: 2000,
      // core 压缩开关（默认关）：关着时 recallForPrompt 用完整正文
      coreCompact: v.coreCompact === true,
      lifecycleEnabled: v.lifecycleEnabled,
      lifecycleIntervalMs: v.lifecycleIntervalMs,
    },
    lifecycle: {
      enabled: v.lifecycleEnabled,
      lifespanImportantDays: v.importantDays,
      lifespanNormalDays: v.normalDays,
      // 第二段间隔 = 这一层自己的天数（"统一成一个数"）。
      // 想改回"固定 14 天"的话，把这两行换成常数即可。
      blurKeepDays: v.importantDays,
      normalKeepDays: v.normalDays,
    },
  };
}

/* ── 写 ─────────────────────────────────────────────────────────────── */

/**
 * 校验一组改动。越界直接报错（而不是悄悄夹到边界）——
 * 界面给了范围，越界说明前端或调用方有 bug，不该被掩盖。
 */
export function validatePatch(patch = {}) {
  const clean = {};
  for (const [k, raw] of Object.entries(patch)) {
    const f = FIELD.get(k);
    if (!f) throw new Error(`不认识的参数 ${k}${k === 'fadeThreshold' ? '（淡出阈值是只读兜底，界面上不给改）' : ''}`);
    if (f.type === 'bool') {
      if (typeof raw !== 'boolean') throw new Error(`${f.label} 只能是 true / false`);
      clean[k] = raw;
      continue;
    }
    const n = num(raw);
    if (n === null) throw new Error(`${f.label} 要是数字（收到 ${JSON.stringify(raw)}）`);
    if (n < f.min || n > f.max) {
      throw new Error(`${f.label} 要在 ${f.min}~${f.max} 之间（收到 ${n}）`);
    }
    if ((f.step || 1) >= 1 && !Number.isInteger(n)) throw new Error(`${f.label} 要整数（收到 ${n}）`);
    clean[k] = n;
  }
  return clean;
}

/**
 * 读-改-写 config.json：只动目标键，别的原样保留；写临时文件再 rename。
 * @returns {{ok:boolean, file:string, values:object, changed:string[]}}
 */
export function writeTuning(file, patch = {}) {
  if (!file) throw new Error('找不到桥接的 config.json，参数改不了');
  const clean = validatePatch(patch);
  const doc = readConfigDoc(file);
  if (!doc) throw new Error(`读不到 ${file}`);
  const next = JSON.parse(JSON.stringify(doc));
  next.memory = (next.memory && typeof next.memory === 'object') ? next.memory : {};
  next.lifecycle = (next.lifecycle && typeof next.lifecycle === 'object') ? next.lifecycle : {};

  const changed = [];
  for (const [k, v] of Object.entries(clean)) {
    if (k === 'importantDays') {
      // 一个天数写三处：memory.halfLife* 管排序衰减，lifecycle.lifespan* 管第一次模糊，
      // lifecycle.blurKeepDays 管"模糊之后再撑多久压成一句话"
      next.memory.halfLifeImportantDays = v;
      next.lifecycle.lifespanImportantDays = v;
      next.lifecycle.blurKeepDays = v;
    } else if (k === 'normalDays') {
      next.memory.halfLifeNormalDays = v;
      next.lifecycle.lifespanNormalDays = v;
      next.lifecycle.normalKeepDays = v;
    } else if (k === 'lifecycleEnabled') {
      next.memory.lifecycleEnabled = v;
      next.lifecycle.enabled = v;
    } else if (k === 'lifecycleIntervalMs') {
      next.memory.lifecycleIntervalMs = v;
    } else {
      next.memory[k] = v;
    }
    changed.push(k);
  }
  if (!changed.length) return { ok: true, file, values: readTuning(file).values, changed: [] };

  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  cache.delete(file); // 下一次读走真文件
  return { ok: true, file, values: readTuning(file).values, changed };
}
