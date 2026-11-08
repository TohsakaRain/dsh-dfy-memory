/**
 * lib/webapi.mjs —— 给设置页用的几个只读/轻写端点
 * ============================================================================
 * 面板（client.js）只做两件事：看状态、切开关。所以这里只有三个端点：
 *
 *   GET  /api/dfy-memory/state   记忆/心情/承诺/日记的概况
 *   GET  /api/dfy-memory/config  两个开关的当前值
 *   POST /api/dfy-memory/switch  { memorySource: 'both'|'new'|'old' }
 *
 * 安全：
 *   · 只接受本机回环地址（127.0.0.1 / ::1）
 *   · POST 必须是 application/json（挡表单跨站）
 *   · 写配置走「临时文件 + rename」，避免写一半把 config.json 弄坏
 * ============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';

/** 从 stateDir 反推桥接的 config.json（…/qq-bridge/state → …/qq-bridge/config.json）。 */
export function bridgeConfigPath(paths) {
  return path.resolve(paths.stateDir, '..', 'config.json');
}

export function readBridgeConfig(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}

/** 读-改-写（原子：写临时文件再 rename）。 */
export function patchBridgeConfig(configPath, mutate) {
  const before = readBridgeConfig(configPath);
  const doc = typeof mutate === 'function' ? mutate(JSON.parse(JSON.stringify(before))) : before;
  if (!doc) throw new Error('mutate 没有返回配置对象');
  const tmp = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, configPath);
  return doc;
}

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
export function collectState(facade) {
  const mem = facade.memory.stats();
  const byTier = mem.byTier || {};
  const mood = facade.emotion.current();
  const promises = facade.promises.list() || [];
  const diary = facade.diary.status();
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
      state: mood.state,
      cause: mood.cause,
      effective: mood.effective,
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
    paths: {
      diary: facade.paths.diaryDir,
      memory: facade.paths.memoryDir,
      state: facade.paths.stateDir,
    },
  };
}

/**
 * 处理一个请求。
 * @returns {Promise<boolean>} 是否已处理（未命中的路径返回 false，交回给宿主）
 */
export async function handleApi(req, res, url, facade, paths) {
  if (!isLoopback(req)) { sendJson(res, 403, { ok: false, error: '只接受本机请求' }); return true; }

  const p = url.pathname;
  const configPath = bridgeConfigPath(paths);

  if (req.method === 'GET' && p === '/api/dfy-memory/state') {
    try { sendJson(res, 200, collectState(facade)); }
    catch (e) { sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }); }
    return true;
  }

  if (req.method === 'GET' && p === '/api/dfy-memory/config') {
    const cfg = readBridgeConfig(configPath);
    sendJson(res, 200, {
      ok: true,
      configPath,
      memorySource: String(cfg?.security?.toolAllow?.memorySource ?? 'both'),
      injectionSource: String(cfg?.injection?.source ?? 'bridge'),
    });
    return true;
  }

  if (req.method === 'POST' && p === '/api/dfy-memory/switch') {
    const ctype = String(req.headers['content-type'] || '').toLowerCase();
    if (!ctype.includes('application/json')) {
      sendJson(res, 415, { ok: false, error: '请求必须是 application/json' });
      return true;
    }
    try {
      const body = await readBody(req);
      const raw = String(body?.memorySource ?? '').toLowerCase();
      if (!['both', 'new', 'old'].includes(raw)) {
        sendJson(res, 400, { ok: false, error: `memorySource 只能是 both / new / old（收到 ${raw || '空'}）` });
        return true;
      }
      patchBridgeConfig(configPath, (doc) => {
        doc.security = doc.security || {};
        doc.security.toolAllow = doc.security.toolAllow || {};
        doc.security.toolAllow.memorySource = raw;
        return doc;
      });
      sendJson(res, 200, { ok: true, memorySource: raw, note: '守卫 1.5 秒内生效，不用重启' });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
    }
    return true;
  }

  // 维护：把到期的记忆模糊化 / 归档（"删除"= 归档，只追加不删）。
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
