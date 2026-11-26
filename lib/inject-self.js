/**
 * lib/inject-self.js —— 自注入（把记忆块挂进 system prompt）
 * ============================================================================
 * 默认**关**。开关是 config.selfInject.enabled === true。
 *
 * 为什么要这个文件而不是直接写在 index.js 里：刷新策略（什么时候重算、什么时候用快照）
 * 是唯一需要单独讲清楚的逻辑，抽出来就能脱离 DSH 单测。
 *
 * 刷新频率（对齐 QQ 桥接：每条消息算一次，同一轮里不重复算）：
 *   · 桥接那边是「每次唤醒拼一次」= 你每发一条消息，注入刷新一次；
 *     那一轮里她调多少次工具、跑多少步，读到的都是同一份。
 *   · 这里用 `agent/inbox/spliced`（有新输入进 inbox）当"来消息了"的信号 → 标脏；
 *     下一次 assembly 才真算，之后这一轮所有步都用这份快照。
 *   · 再加 refreshMs（默认 60 秒）兜底：长时间挂机时让它慢慢追上淡忘变化。
 */

/** 默认值。文档和 cordis.patch.yml 里的注释都以这份为准。 */
export const DEFAULT_SELF_INJECT = Object.freeze({
  enabled: false,      // 默认关
  order: 10150,        // 排在 first-party 段之后（10000 harness / 10100 web / 10200 persona）
  refreshMs: 60000,    // 兜底刷新间隔
  presets: [],         // 只给这些 agent preset 注入；空 = 所有会话
  cwdContains: [],     // 或者按会话工作目录包含关系匹配；空 = 不按目录筛
  header: '',          // 可选：块前面加一行（默认什么都不加）
});

/**
 * 这个会话该不该注入。
 * @param {{preset?: string, cwd?: string}} session
 * @param {object} cfg
 */
export function matchesSession(session = {}, cfg = {}) {
  const presets = (Array.isArray(cfg.presets) ? cfg.presets : []).map((s) => String(s).trim()).filter(Boolean);
  const cwds = (Array.isArray(cfg.cwdContains) ? cfg.cwdContains : []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  if (!presets.length && !cwds.length) return true;   // 没配 = 所有会话都注入
  const preset = String(session.preset ?? '').trim();
  if (presets.length && presets.includes(preset)) return true;
  const cwd = String(session.cwd ?? '').toLowerCase();
  if (cwds.length && cwds.some((needle) => cwd.includes(needle))) return true;
  return false;
}

/**
 * 快照提供器：每步都会被调一次，但只有「标脏了」或「超过 refreshMs」才真去算。
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
    text() {
      const t = now();
      if (dirty || t - at >= refreshMs) {
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
