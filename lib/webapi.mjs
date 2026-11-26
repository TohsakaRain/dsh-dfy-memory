/**
 * lib/webapi.mjs —— 设置页（「设置 → 大肥鱼记忆」）的后端
 * ============================================================================
 * 端点：
 *
 *   GET  /api/dfy-memory/state           记忆/心情/承诺/日记/作品/信箱的概况
 *   GET  /api/dfy-memory/prompt-block    只读：长期记忆注入块（桥接按"单一权威"来取）
 *   GET  /api/dfy-memory/config          桥接配置在哪（诊断用）
 *
 *   GET  /api/dfy-memory/paths           数据根目录：当前值、默认值、来自哪一层
 *                                        ?probe=<dir> 顺带体检那个目录
 *   POST /api/dfy-memory/paths           { dataRoot } 改数据根目录
 *   GET  /api/dfy-memory/fs?path=<dir>   目录浏览（设置页的「浏览…」用）
 *   POST /api/dfy-memory/open            { path } 用系统文件管理器打开（只限数据目录内）
 *
 *   POST /api/dfy-memory/maintain        把到期的记忆模糊化 / 归档
 *   GET  /api/dfy-memory/archive?q=      搜归档
 *   POST /api/dfy-memory/window/roll     7 天窗口滚动
 *
 * 安全：
 *   · 只接受本机回环地址（127.0.0.1 / ::1）
 *   · POST 必须是 application/json（挡表单跨站）
 *   · 写 JSON 配置走「临时文件 + rename」，避免写一半把文件弄坏
 *
 * ⚠️ 2026-11-22 修掉一个真 bug：原来 bridgeConfigPath() 用
 *    `path.resolve(stateDir, '..', 'config.json')` 反推桥接配置，
 *    实际算出来是 D:\dfy\dsh-dfy-memory\config.json —— 那个文件根本不存在。
 *    后果：/config 永远报默认值（看起来"没毛病"），而 /switch 会把一个
 *    没人读的野文件写出来，使用者以为切了开关其实守卫从没收到。
 *    现在改成「由调用方找到真文件再传进来；找不到就明说，不写野文件」。
 * ============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SETTINGS_REL, resolveSelfInject, writeSelfInjectFile } from './inject-self.js';

/** 数据根目录下的标准子目录（设置页要按这个顺序列）。 */
export const SUBDIRS = ['memory', 'diary', 'state', 'works', 'mailbox', 'context', 'archive'];

/* ── 桥接 config.json：读 / 原子写 ─────────────────────────────────────── */

export function readBridgeConfig(configPath) {
  if (!configPath) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}

/** 读-改-写（原子：写临时文件再 rename）。 */
export function patchBridgeConfig(configPath, mutate) {
  if (!configPath) throw new Error('没有桥接 config.json 的路径');
  const before = readBridgeConfig(configPath);
  const doc = typeof mutate === 'function' ? mutate(JSON.parse(JSON.stringify(before))) : before;
  if (!doc) throw new Error('mutate 没有返回配置对象');
  const tmp = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, configPath);
  return doc;
}

/**
 * 认一个「像桥接配置」的 json：至少得有 role / memory / snowluma / injection 之一。
 * 用来挡住「路径算错 → 凭空写出一个空 config.json」这种事。
 */
export function looksLikeBridgeConfig(file) {
  if (!file) return false;
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
    return ['role', 'memory', 'snowluma', 'injection', 'ownerQQ', 'agentPreset'].some((k) => k in doc);
  } catch {
    return false;
  }
}

/* ── 目录体检 / 浏览 ──────────────────────────────────────────────────── */

const isDir = (p) => {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
};

const countFiles = (dir, ext, depth = 3) => {
  let n = 0;
  const walk = (d, left) => {
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.isDirectory()) { if (left > 0) walk(path.join(d, it.name), left - 1); }
      else if (it.name.toLowerCase().endsWith(ext)) n += 1;
    }
  };
  walk(dir, depth);
  return n;
};

/** Windows 盘符 / POSIX 根。 */
export function listDrives() {
  if (process.platform !== 'win32') return ['/'];
  const out = [];
  for (const ch of 'CDEFGHIJKLMNOPQRSTUVWXYZAB') {
    if (fs.existsSync(`${ch}:\\`)) out.push(`${ch}:\\`);
  }
  return out;
}

/**
 * 给一个候选数据目录做体检 —— 改目录前最该看的东西：
 * 这个位置存不存在、能不能写、里面是不是已经有人格数据了。
 */
export function probeDataRoot(target) {
  const out = {
    path: '', exists: false, isDir: false, writable: false,
    subdirs: {}, memoryTotal: null, diaryDays: 0,
  };
  if (!target || !String(target).trim()) return out;
  const p = path.resolve(String(target));
  out.path = p;
  try {
    const st = fs.statSync(p);
    out.exists = true;
    out.isDir = st.isDirectory();
  } catch { return out; }
  if (!out.isDir) return out;
  try { fs.accessSync(p, fs.constants.W_OK); out.writable = true; } catch { /* 只读 */ }
  for (const s of SUBDIRS) out.subdirs[s] = isDir(path.join(p, s));
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(p, 'memory', 'memory.json'), 'utf8').replace(/^\uFEFF/, ''));
    const list = Array.isArray(doc) ? doc : (Array.isArray(doc?.entries) ? doc.entries : []);
    out.memoryTotal = list.length;
  } catch { /* 没有 memory.json */ }
  out.diaryDays = countFiles(path.join(p, 'diary'), '.md');
  return out;
}

/** 两个目录的关系 —— 挡住「把新目录指到老目录里面」这种会串数据的操作。 */
export function relateDirs(from, to) {
  const a = path.resolve(String(from || ''));
  const b = path.resolve(String(to || ''));
  const norm = (s) => s.toLowerCase().replace(/[\\/]+$/, '');
  const A = norm(a); const B = norm(b);
  if (A === B) return 'same';
  if (B.startsWith(`${A}${path.sep}`) || B.startsWith(`${A}/`)) return 'inside';
  if (A.startsWith(`${B}${path.sep}`) || A.startsWith(`${B}/`)) return 'contains';
  return 'other';
}

/**
 * 用系统文件管理器打开一个目录。
 * Windows 走 explorer.exe（它的退出码经常非 0，所以不等到退出、也不看结果）；
 * macOS 用 open，Linux 用 xdg-open。打不开不该让整个请求 500，所以只 unref。
 */
export function openInFileManager(dir) {
  const target = path.resolve(String(dir));
  const [cmd, args] = process.platform === 'win32'
    ? ['explorer.exe', [target]]
    : process.platform === 'darwin'
      ? ['open', [target]]
      : ['xdg-open', [target]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => { /* 打不开就算了，别抛 */ });
  child.unref();
  return target;
}

/** 列一个目录下的子目录（设置页「浏览…」）。 */
export function listDir(target) {
  const drives = listDrives();
  if (!target || !String(target).trim()) {
    return { path: null, parent: null, dirs: [], drives };
  }
  const p = path.resolve(String(target));
  const st = fs.statSync(p); // 不存在 / 无权限时由调用方接住，给 400
  if (!st.isDirectory()) throw new Error(`${p} 不是目录`);
  const names = [];
  for (const it of fs.readdirSync(p, { withFileTypes: true })) {
    if (it.name.startsWith('$')) continue;
    if (it.name === 'System Volume Information') continue;
    if (it.isDirectory() || (it.isSymbolicLink() && isDir(path.join(p, it.name)))) names.push(it.name);
  }
  names.sort((x, y) => x.localeCompare(y, 'zh'));
  const parent = path.dirname(p);
  return { path: p, parent: parent && parent !== p ? parent : null, dirs: names, drives };
}

/**
 * 递归复制一棵目录树，返回复制了多少文件 / 目录。
 * 符号链接跳过 —— 不把别处的东西拖进数据目录。
 */
function copyTree(src, dst, acc = { files: 0, dirs: 0, links: 0, skipped: 0 }) {
  fs.mkdirSync(dst, { recursive: true });
  for (const it of fs.readdirSync(src, { withFileTypes: true })) {
    // 🚫 不搬 .git：数据目录 2026-11-22 起可能是个 git 仓库（使用者把记忆提交到私有仓库），
    // 而换数据目录时把几十 MB 的版本库连同历史一起拷过去既慢又没意义 ——
    // 新目录想要版本管理就自己 git init。
    if (it.name === '.git') { acc.skipped += 1; continue; }
    const s = path.join(src, it.name);
    const d = path.join(dst, it.name);
    if (it.isDirectory()) { acc.dirs += 1; copyTree(s, d, acc); }
    else if (it.isSymbolicLink()) { acc.links += 1; }
    else { fs.copyFileSync(s, d); acc.files += 1; }
  }
  return acc;
}

const stampNow = () => {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/**
 * 换数据目录 = **搬数据**，不是让使用者自己拷。
 *
 * 顺序刻意是「先复制 → 校验 → 再动旧目录」，任何一步失败都不会让数据只剩一份：
 *   1. 目标已存在且有数据 → 直接拒绝（两份人格不能合并）
 *   2. 递归复制
 *   3. 校验记忆条数一致
 *   4. 旧目录**改名留底**（`<旧路径>.moved-<时间戳>`），不删
 *      —— 改名的意思是"它不再是活的那份"，但随时能拿回来
 *
 * 改名失败（有文件被占用）时旧目录原地不动，并在结果里如实说明。
 */
export function moveDataRoot(from, to) {
  const src = path.resolve(String(from || ''));
  const dst = path.resolve(String(to || ''));
  if (!src || !dst || relateDirs(src, dst) === 'same') return { moved: false, reason: 'same' };
  if (!fs.existsSync(src)) return { moved: false, reason: 'missing' };
  if (!isDir(src)) throw new Error(`${src} 不是目录`);

  const before = probeDataRoot(src);
  const dstP = probeDataRoot(dst);
  if (dstP.exists && !dstP.isDir) throw new Error(`${dst} 是个文件，不是目录`);
  if (dstP.exists) {
    const hasData = (typeof dstP.memoryTotal === 'number' && dstP.memoryTotal > 0)
      || dstP.diaryDays > 0
      || Boolean(dstP.subdirs.works || dstP.subdirs.state || dstP.subdirs.mailbox);
    if (hasData) {
      throw new Error(`目标目录里已经有数据了（记忆 ${dstP.memoryTotal ?? 0} 条 · 日记 ${dstP.diaryDays} 天）。`
        + '两份人格不能合并，换个空目录吧。');
    }
  }

  const acc = copyTree(src, dst);
  const after = probeDataRoot(dst);
  if (typeof before.memoryTotal === 'number' && after.memoryTotal !== before.memoryTotal) {
    throw new Error(`复制校验失败：记忆条数 ${before.memoryTotal} → ${after.memoryTotal ?? 0}，配置没改，原位没动`);
  }

  const backup = `${src}.moved-${stampNow()}`;
  let renamed = false;
  try { fs.renameSync(src, backup); renamed = true; } catch { /* 有文件被占用 */ }

  return {
    moved: true,
    files: acc.files,
    dirs: acc.dirs,
    links: acc.links,
    skipped: acc.skipped,   // 跳过的 .git（数据目录现在是 git 仓库）
    from: src,
    to: dst,
    backup: renamed ? backup : null,
    leftInPlace: renamed ? null : src,
  };
}

/* ── 状态汇总 ─────────────────────────────────────────────────────────── */

const isLoopback = (req) => {
  const a = req?.socket?.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
};

const sendJson = (res, code, obj) => {
  try {
    res.statusCode = code;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(obj));
  } catch { /* 连接已断 */ }
};

const readBody = (req, limit = 64 * 1024) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) { reject(new Error('请求体太大')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
    catch { reject(new Error('请求体不是合法 JSON')); }
  });
  req.on('error', reject);
});

/** 汇总面板要显示的状态。 */
export function collectState(facade, describe) {
  const mem = facade.memory.stats();
  const byTier = mem.byTier || {};
  const mood = facade.emotion.current();
  const promises = facade.promises.list() || [];
  const diary = facade.diary.status();
  const info = typeof describe === 'function' ? describe() : null;
  return {
    ok: true,
    memory: {
      total: mem.total ?? 0,
      core: byTier.core ?? 0,
      important: byTier.important ?? 0,
      normal: byTier.normal ?? 0,
      fading: (mem.fading || []).length,
    },
    archive: facade.archive?.stats?.() ?? { total: 0, first: null, last: null },
    window: (facade.window?.list?.() ?? []).map((w) => ({ day: w.day, kind: w.kind, by: w.by, chars: w.chars })),
    windowDebug: (() => { try { return facade.window?.debug?.() ?? null; } catch (e) { return { error: String(e?.message ?? e) }; } })(),
    archiveLog: (() => { try { return facade.window?.archiveLog?.() ?? null; } catch (e) { return { error: String(e?.message ?? e) }; } })(),
    mood: mood ? {
      // ⚠️ currentMood() 返回的字段叫 tone，不叫 state。
      // 2026-11-22 之前这里映射成 mood.state ⇒ 界面上「现在的心情」永远显示 undefined。
      tone: mood.tone || '',
      score: mood.score,
      baseline: mood.baseline,
      cause: mood.cause,
      effective: mood.effective,
      impulse: mood.impulse,
      hours: mood.hours,
      faded: mood.faded,
    } : null,
    promises: {
      total: promises.length,
      due: promises.filter((x) => x.dueAt && !x.notifiedAt && Number(x.dueAt) <= Date.now()).length,
    },
    diary: {
      today: diary.today,
      todaySections: diary.todaySections,
      lastDate: diary.lastDate,
    },
    works: (() => {
      try {
        const w = facade.works.stats();
        return { total: w.total, text: w.text, image: w.image, drafts: w.drafts, versions: w.versions, projects: w.projects };
      } catch { return null; }
    })(),
    mail: (() => {
      try { return facade.mail.stats(); } catch { return null; }
    })(),
    paths: info
      ? { ...info.derived, dataRoot: info.dataRoot }
      : {
        diary: facade.paths.diaryDir,
        memory: facade.paths.memoryDir,
        state: facade.paths.stateDir,
        works: facade.paths.worksDir,
      },
  };
}

/* ── 请求分发 ─────────────────────────────────────────────────────────── */

/**
 * 处理一个请求。
 * @param {object} hub 宿主给的上下文：
 *   { describe(), saveDataRoot(next|null), bridgeConfig, defaultDataRoot, envDataRoot }
 * @returns {Promise<boolean>} 是否已处理（未命中的路径返回 false，交回给宿主）
 */
export async function handleApi(req, res, url, facade, paths, hub = {}) {
  if (!isLoopback(req)) { sendJson(res, 403, { ok: false, error: '只接受本机请求' }); return true; }

  const p = url.pathname;
  const bridgeConfig = hub.bridgeConfig || null;
  const describe = typeof hub.describe === 'function' ? hub.describe : null;

  // 自注入：开关与参数（设置页「注入」tab）。设置文件优先于 cordis.patch.yml。
  if (p === '/api/dfy-memory/self-inject') {
    const file = path.join(paths.dataRoot, SETTINGS_REL);
    if (req.method === 'GET') {
      const resolved = resolveSelfInject({ file, config: {} });
      const wire = typeof hub?.selfInject === 'function' ? hub.selfInject() : null;
      const runtime = wire && typeof wire.status === 'function' ? wire.status() : null;
      sendJson(res, 200, {
        ok: true,
        settings: resolved.settings,
        source: resolved.source,
        file,
        runtime,
      });
      return true;
    }
    if (req.method === 'POST') {
      const ctype = String(req.headers['content-type'] || '').toLowerCase();
      if (!ctype.includes('application/json')) {
        sendJson(res, 415, { ok: false, error: '请求必须是 application/json' });
        return true;
      }
      let body;
      try { body = await readBody(req); } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
        return true;
      }
      try {
        const saved = writeSelfInjectFile(file, body?.patch ?? body ?? {});
        const wire = typeof hub?.selfInject === 'function' ? hub.selfInject() : null;
        const runtime = wire && typeof wire.status === 'function' ? wire.status() : null;
        sendJson(res, 200, { ok: true, settings: saved, source: 'file', file, runtime, note: '全部立刻生效：开关、refreshMs、presets/cwdContains 的匹配' });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
      }
      return true;
    }
  }

  if (req.method === 'GET' && p === '/api/dfy-memory/state') {
    try { sendJson(res, 200, collectState(facade, describe)); }
    catch (e) { sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }); }
    return true;
  }

  // 只读：给桥接用的「长期记忆注入块」。
  // 目的（2026-11-26）：记忆的淡忘/压缩/注入格式只保留这一份实现，
  // 桥接不再自己 import memory-store —— 它每轮来要一段文本就行。
  // 限额（memory.injectLimit / injectMaxChars）走插件自己的配置，这里不接受参数覆盖。
  if (req.method === 'GET' && p === '/api/dfy-memory/prompt-block') {
    try {
      const text = String(facade.memory.forPrompt() ?? '');
      sendJson(res, 200, { ok: true, text, chars: text.length });
    } catch (e) { sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }); }
    return true;
  }

  if (req.method === 'GET' && p === '/api/dfy-memory/config') {
    const cfg = readBridgeConfig(bridgeConfig);
    sendJson(res, 200, {
      ok: true,
      // null = 没找到桥接配置，别把默认值当事实报
      bridgeConfig: bridgeConfig || null,
      bridgeConfigFound: Boolean(bridgeConfig),
      configPath: bridgeConfig || null,
      memorySource: bridgeConfig ? String(cfg?.security?.toolAllow?.memorySource ?? 'both') : null,
    });
    return true;
  }

  // 打开数据目录（在系统文件管理器里）。
  // 只允许打开「当前数据根目录」或它下面的目录 —— 不给它变成一个「打开任意路径」的口子。
  if (req.method === 'POST' && p === '/api/dfy-memory/open') {
    const ctype = String(req.headers['content-type'] || '').toLowerCase();
    if (!ctype.includes('application/json')) {
      sendJson(res, 415, { ok: false, error: '请求必须是 application/json' });
      return true;
    }
    let body;
    try { body = await readBody(req); } catch (e) {
      sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
      return true;
    }
    const info = describe ? describe() : null;
    if (!info?.dataRoot) { sendJson(res, 503, { ok: false, error: '不知道数据根目录' }); return true; }
    const target = path.resolve(String(body?.path ?? info.dataRoot));
    const rel = relateDirs(info.dataRoot, target);
    if (rel !== 'same' && rel !== 'inside') {
      sendJson(res, 400, { ok: false, error: '只能打开数据目录里面的路径' });
      return true;
    }
    if (!isDir(target)) { sendJson(res, 400, { ok: false, error: `${target} 不是目录` }); return true; }
    try {
      openInFileManager(target);
      sendJson(res, 200, { ok: true, path: target });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
    return true;
  }

  /* ── 数据根目录 ───────────────────────────────────────────────────── */

  if (req.method === 'GET' && p === '/api/dfy-memory/paths') {
    if (!describe) {
      sendJson(res, 503, { ok: false, error: '插件没提供路径信息（describe 缺失）' });
      return true;
    }
    try {
      const info = describe();
      const probeQ = url.searchParams.get('probe');
      const out = {
        ok: true,
        ...info,
        canSave: typeof hub.saveDataRoot === 'function',
        bridgeConfig: bridgeConfig || null,
        bridgeConfigFound: Boolean(bridgeConfig),
        probe: {},
      };
      const targets = [];
      if (probeQ) targets.push(['candidate', probeQ]);
      targets.push(['current', info.dataRoot]);
      if (info.defaultDataRoot && info.defaultDataRoot !== info.dataRoot) targets.push(['default', info.defaultDataRoot]);
      for (const [k, dir] of targets) {
        out.probe[k] = { ...probeDataRoot(dir), relation: relateDirs(info.dataRoot, dir) };
      }
      sendJson(res, 200, out);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
    return true;
  }

  if (req.method === 'POST' && p === '/api/dfy-memory/paths') {
    const ctype = String(req.headers['content-type'] || '').toLowerCase();
    if (!ctype.includes('application/json')) {
      sendJson(res, 415, { ok: false, error: '请求必须是 application/json' });
      return true;
    }
    let body;
    try { body = await readBody(req); } catch (e) {
      sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
      return true;
    }
    const raw = body?.dataRoot;
    // 空 = 用默认位置（用户目录下），不是"清掉覆盖"。
    // 清掉覆盖会退回 bundle patch 里写死的 D:\dfy，那不是使用者心里的"默认"。
    const fallback = hub.defaultDataRoot ? path.resolve(hub.defaultDataRoot) : null;
    const next = (raw === null || raw === undefined || String(raw).trim() === '')
      ? fallback
      : path.resolve(String(raw).trim());
    if (!next) { sendJson(res, 400, { ok: false, error: 'dataRoot 不能为空' }); return true; }

    {
      if (!path.isAbsolute(next)) { sendJson(res, 400, { ok: false, error: `要绝对路径（收到 ${next}）` }); return true; }
      const info = describe ? describe() : null;
      if (info && relateDirs(info.dataRoot, next) === 'inside') {
        sendJson(res, 400, {
          ok: false,
          error: `新目录不能是当前目录的子目录（${next} 在 ${info.dataRoot} 里面）—— 那样两边的数据会串在一起。`,
        });
        return true;
      }
      const pr = probeDataRoot(next);
      if (pr.exists && !pr.isDir) { sendJson(res, 400, { ok: false, error: `${next} 是个文件，不是目录` }); return true; }
      if (pr.exists && !pr.writable) { sendJson(res, 400, { ok: false, error: `${next} 不可写` }); return true; }
    }

    // 先校验目标、再报「存不了」—— 校验错是使用者当下就能改的，存不了不是
    if (typeof hub.saveDataRoot !== 'function') {
      sendJson(res, 501, { ok: false, error: '这个 profile 里存不了配置（没有 configEditor）' });
      return true;
    }

    // 换目录 = 搬数据。搬不动就别改配置（配置一改、数据没搬过来，她当场失忆）。
    const infoNow = describe ? describe() : null;
    let move = null;
    if (infoNow && relateDirs(infoNow.dataRoot, next) !== 'same') {
      try {
        move = moveDataRoot(infoNow.dataRoot, next);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: `搬数据失败，配置没改：${e?.message ?? e}` });
        return true;
      }
    }

    try {
      await hub.saveDataRoot(next);
    } catch (e) {
      // 配置没存上 → 把旧目录名字改回去，别留下"数据搬走了但插件还指着旧路径"的局面
      let undo = '';
      if (move?.moved && move.backup) {
        try {
          fs.renameSync(move.backup, move.from);
          undo = '；数据已搬回原位';
        } catch {
          undo = `；数据搬不回来了，在 ${move.backup}`;
        }
      }
      sendJson(res, 400, { ok: false, error: `${String(e?.message ?? e)}${undo}` });
      return true;
    }

    // 桥接那边也跟上（它是独立进程，重启才读新值）
    const notes = [];
    let bridge = { ok: false, reason: '没找到桥接的 config.json，桥接那边没改' };
    if (bridgeConfig) {
      try {
        patchBridgeConfig(bridgeConfig, (doc) => {
          doc.memory = (doc.memory && typeof doc.memory === 'object') ? doc.memory : {};
          doc.memory.dir = path.join(next, 'memory');
          doc.diary = (doc.diary && typeof doc.diary === 'object') ? doc.diary : {};
          doc.diary.dir = path.join(next, 'diary');
          return doc;
        });
        bridge = { ok: true, path: bridgeConfig, root: next };
        notes.push('桥接配置里的 memory.dir / diary.dir 也改了 —— 桥接要重启才读新值');
      } catch (e) {
        bridge = { ok: false, reason: String(e?.message ?? e) };
      }
    }
    // 搬数据的结果（2026-11-22 起：换目录自动搬，不用使用者自己拷）
    if (move?.moved) {
      notes.push(`已搬 ${move.files} 个文件到新目录`
        + (move.links ? `（跳过 ${move.links} 个符号链接）` : ''));
      if (move.backup) notes.push(`旧目录改名留底：${move.backup}（确认没问题再删）`);
      else notes.push(`旧目录没删成（可能有文件被占用），还在 ${move.leftInPlace}`);
    } else if (move?.reason === 'missing') {
      notes.push('旧目录本来就不存在，没有什么要搬的');
    }

    notes.push('插件会自己重启一次并改用新目录（不用重启 DSH）');

    // 重启之后才真正生效，所以这里报的是"将要生效"的值
    let effective = null;
    if (typeof hub.previewPaths === 'function') {
      try { effective = hub.previewPaths(next); } catch { /* 预览失败就算了 */ }
    }

    sendJson(res, 200, {
      ok: true,
      dataRoot: next,
      effective,
      move,
      bridge,
      notes,
    });
    return true;
  }

  if (req.method === 'GET' && p === '/api/dfy-memory/fs') {
    try {
      const q = url.searchParams.get('path');
      const out = listDir(q);
      const info = describe ? describe() : null;
      out.currentDataRoot = info?.dataRoot ?? null;
      out.probe = {};
      if (out.path) out.probe = { ...probeDataRoot(out.path), relation: info ? relateDirs(info.dataRoot, out.path) : 'other' };
      sendJson(res, 200, { ok: true, ...out });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
    }
    return true;
  }

  /* ── 记忆调参 ─────────────────────────────────────────────────────── */

  // 真源是桥接 config.json 的 memory / lifecycle 两段（见 lib/tuning.js）。
  if (req.method === 'GET' && p === '/api/dfy-memory/tuning') {
    if (typeof hub.tuning !== 'function') {
      sendJson(res, 503, { ok: false, error: '插件没提供调参入口' });
      return true;
    }
    try {
      const t = hub.tuning();
      sendJson(res, 200, {
        ok: true,
        found: t.found,
        file: t.file,
        values: t.values,
        fromFile: t.fromFile,
        spec: typeof hub.spec === 'function' ? hub.spec() : [],
        defaults: typeof hub.defaults === 'function' ? hub.defaults() : {},
      });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
    return true;
  }

  if (req.method === 'POST' && p === '/api/dfy-memory/tuning') {
    const ctype = String(req.headers['content-type'] || '').toLowerCase();
    if (!ctype.includes('application/json')) {
      sendJson(res, 415, { ok: false, error: '请求必须是 application/json' });
      return true;
    }
    if (typeof hub.saveTuning !== 'function' || !bridgeConfig) {
      sendJson(res, 500, {
        ok: false,
        error: '找不到桥接的 config.json —— 参数存在那里，没文件就改不了。',
      });
      return true;
    }
    let body;
    try { body = await readBody(req); } catch (e) {
      sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
      return true;
    }
    const patch = body?.patch && typeof body.patch === 'object' ? body.patch : body;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) {
      sendJson(res, 400, { ok: false, error: '没有要改的字段' });
      return true;
    }
    try {
      const r = hub.saveTuning(patch);
      const t = hub.tuning();
      // 改完调参立刻把导出文件重写一遍：memory.md 的头里印着"当前节奏"，
      // 不同步的话它会一直说旧天数，直到下次写记忆。
      let syncExport = { ok: false, reason: '没有导出入口' };
      try {
        const fn = facade?.memory?.syncExport;
        if (typeof fn === 'function') syncExport = fn();
      } catch (e) {
        syncExport = { ok: false, error: String(e?.message ?? e) };
      }
      sendJson(res, 200, {
        ok: true,
        file: r.file,
        changed: r.changed,
        values: t.values,
        fromFile: t.fromFile,
        syncExport,
        note: '已写入桥接 config.json，并重写了 memory.md；注入和淡忘都现读现用，不用重启。',
      });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
    }
    return true;
  }

  /* ── 维护 ─────────────────────────────────────────────────────────── */

  // 把到期的记忆模糊化 / 归档（"删除"= 归档，只追加不删）。
  // 桥接每 10 分钟打一次；手动也能调。
  if (req.method === 'POST' && p === '/api/dfy-memory/maintain') {
    try {
      const out = facade.memory.maintain();
      const a = facade.archive.stats();
      sendJson(res, 200, {
        ok: true,
        blurred: out.blurred ?? [],
        archived: out.archived ?? [],
        disabled: out.disabled ?? false,
        archive: a,
      });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
    return true;
  }

  if (req.method === 'GET' && p === '/api/dfy-memory/archive') {
    try {
      const q = url.searchParams.get('q') ?? '';
      const rows = facade.archive.search({ query: q, limit: Number(url.searchParams.get('limit')) || 5 });
      sendJson(res, 200, { ok: true, query: q, hits: rows });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
    return true;
  }

  // 7 天窗口滚动：读 DSH 会话日志 → 生成 context\ 的 6 个文件。
  // 跨天时由桥接定时器调一次；手动也能调。
  if (req.method === 'POST' && p === '/api/dfy-memory/window/roll') {
    try {
      const out = facade.window.roll();
      sendJson(res, 200, {
        ok: true,
        events: out.events ?? null,
        written: out.written ?? [],
        kept: out.kept ?? [],
        removed: out.removed ?? [],
        archiveLog: out.archiveLog ?? null,
        window: out.window ?? [],
      });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
    return true;
  }

  sendJson(res, 404, { ok: false, error: `未知端点 ${p}` });
  return true;
}
