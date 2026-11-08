/**
 * lib/chatlog.js —— 从 DSH 会话日志里抽取「人和她的对话」
 * ============================================================================
 * 数据源：~/.dsh/sessions/<工作区哈希>/session-<id>/session.v4.jsonl.zstd
 *   · 你说的    <- user/message 里【本次消息快照】的 JSON（时间 = 唤醒时间 - ago）
 *   · 她说的    <- tool/call 里 qq_send_* 的参数（那才是真发出去的）
 *   · 去重      <- 你用 messageId，她用 callId
 *
 * 这个模块同时服务两件事：
 *   (5) 聊天记录归档（tools/export-daily-logs.mjs 的逻辑搬进来）
 *   (7) 7 天滑动窗口（context/）
 *
 * 注意：本文件刻意不用模板字符串 —— 之前版本在某个中文模板里踩过
 *      "Unexpected identifier '$'"，改成拼接后一切正常。
 * ============================================================================
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import z from 'node:zlib';
import { decompressAll } from './zstd-multi.js';

const SEND_TOOLS = {
  qq_send_message: function (a) { return toList(a.messages === undefined ? a.message : a.messages); },
  qq_send_burst: function (a) { return toList(a.messages); },
  qq_reply: function (a) { return toList(a.message); },
  qq_send_group_message: function (a) { return toList(a.message); },
  qq_send_private_message: function (a) { return toList(a.message); },
  qq_send_sticker: function () { return ['[表情]']; },
  qq_send_voice: function (a) { return [a.text ? '[语音] ' + String(a.text) : '[语音]']; },
  qq_send_poke: function () { return ['[戳一戳]']; },
};

function toList(v) {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map(function (x) { return String(x).trim(); }).filter(Boolean);
  const s = String(v).trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map(function (x) { return String(x).trim(); }).filter(Boolean);
    } catch (e) { /* 不是 JSON 就当普通文本 */ }
  }
  return s ? [s] : [];
}

function agoToMs(ago) {
  const m = String(ago === undefined || ago === null ? '' : ago).trim().match(/^(\d+(?:\.\d+)?)\s*([smhd])$/i);
  if (!m) return 0;
  const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2].toLowerCase()];
  return Math.round(Number(m[1]) * unit);
}

function snapshotOf(text) {
  const m = text.match(/【本次消息快照】\s*(\{[\s\S]*?\})\s*\n\s*以上消息/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}

function pad2(n) { return String(n).padStart(2, '0'); }

export function dayOf(ts) {
  const d = new Date(ts);
  return String(d.getFullYear()) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

export function clockOf(ts) {
  const d = new Date(ts);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

/** zstd 解压是否可用（Electron/Node 版本差异会导致没有） */
export function zstdAvailable() {
  return typeof z.zstdDecompressSync === 'function';
}

export function sessionsRoot() {
  // Electron 里 os.homedir() 偶尔不等于用户目录，USERPROFILE 优先
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, '.dsh', 'sessions');
}

/** 这个工作区目录名是不是她的（qq-bridge 起的那批会话） */
function looksLikeHer(wsName) {
  return /qq-bridge/i.test(wsName);
}

/** 扫出所有会话文件（按 mtime 降序） */
export function findSessions(opts) {
  const root = (opts && opts.root) || sessionsRoot();
  const out = [];
  const all = [];
  let workspaces = [];
  try { workspaces = fs.readdirSync(root); } catch (e) { return out; }
  for (const ws of workspaces) {
    const wsDir = path.join(root, ws);
    let sessions = [];
    try { sessions = fs.readdirSync(wsDir); } catch (e) { continue; }
    for (const sid of sessions) {
      const file = path.join(wsDir, sid, 'session.v4.jsonl.zstd');
      try {
        const st = fs.statSync(file);
        const rec = { sessionId: sid, file: file, mtime: st.mtimeMs, ws: ws };
        all.push(rec);
      } catch (e) { /* 不是会话目录 */ }
    }
  }
  const hers = all.filter(function (r) { return looksLikeHer(r.ws); });
  const pool = hers.length ? hers : all;
  return pool.sort(function (a, b) { return b.mtime - a.mtime; });
}

/** 从若干会话文件里抽事件（已去重、已排序） */
export function extractEvents(opts) {
  const o = opts || {};
  const root = o.root || sessionsRoot();
  const limit = Number(o.limitSessions) > 0 ? Number(o.limitSessions) : 4;
  const sessions = findSessions({ root: root }).slice(0, limit);
  const events = [];
  const perSession = [];
  const debugArr = o.debugArr || null;

  for (const sess of sessions) {
    let lines;
    const rec = { sid: String(sess.sessionId).slice(0, 20), bytes: 0, error: null, lines: 0, frames: 0 };
    try {
      const buf = fs.readFileSync(sess.file);
      rec.bytes = buf.length;
      // ⚠️ DSH 宿主的 zstd 只解第一帧，必须逐帧解
      const dec = decompressAll(buf);
      rec.frames = dec.frames;
      if (dec.failed) rec.error = 'bad-frames:' + dec.failed;
      lines = dec.text.split('\n').filter(Boolean);
      rec.lines = lines.length;
    } catch (e) {
      rec.error = String((e && e.message) || e).slice(0, 120);
      perSession.push(rec);
      continue;
    }
    perSession.push(rec);

    const parsed = [];
    for (const line of lines) {
      try { parsed.push(JSON.parse(line)); } catch (e) { /* 跳过坏行 */ }
    }

    const failed = new Set();
    for (const j of parsed) {
      if (j.type === 'tool/result' && j.data && (j.data.ok === false || j.data.error)) {
        if (j.data.callId) failed.add(j.data.callId);
      }
    }

    for (const j of parsed) {
      if (j.type === 'user/message') {
        const content = j.data && j.data.content;
        const text = (content && content.find(function (c) { return c.type === 'text'; }) || {}).text || '';
        const snap = snapshotOf(text);
        if (!snap) continue;
        const wakeAt = Number(j.time) || 0;
        const all = [].concat(snap.messages || [], snap.recent || []);
        for (const x of all) {
          const body = String(x.text === undefined || x.text === null ? '' : x.text).trim();
          if (!body || x.isOwner === false) continue;
          events.push({
            key: 'm:' + x.messageId,
            who: 'me',
            text: body,
            ts: (wakeAt - agoToMs(x.ago)) || wakeAt,
            session: sess.sessionId,
          });
        }
      }
      if (j.type === 'tool/call') {
        const fullName = String((j.data && j.data.name) || '');
        const short = fullName.split('__').pop();
        const pick = SEND_TOOLS[short];
        if (!pick) continue;
        const callId = String((j.data && j.data.callId) || '');
        if (callId && failed.has(callId)) continue;
        let args = {};
        try { args = JSON.parse(String((j.data && j.data.arguments) || '{}')); } catch (e) { continue; }
        const parts = pick(args);
        if (!parts.length) continue;
        const ts = Number(j.time) || 0;
        for (let i = 0; i < parts.length; i++) {
          events.push({ key: 'c:' + callId + ':' + i, who: 'her', text: parts[i], ts: ts + i * 1000, session: sess.sessionId });
        }
      }
    }
  }

  const seen = new Set();
  const dedup = [];
  for (const e of events) {
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    dedup.push(e);
  }
  if (debugArr) debugArr.push({ zstd: zstdAvailable(), perSession: perSession });
  return dedup.sort(function (a, b) { return a.ts - b.ts; });
}

/** 按天分组 */
export function groupByDay(events) {
  const map = new Map();
  for (const e of events) {
    const d = dayOf(e.ts);
    if (!map.has(d)) map.set(d, []);
    map.get(d).push(e);
  }
  return map;
}

/** 把一天的事件渲染成人读文本（窗口/归档都用它） */
export function renderDay(day, events) {
  const me = events.filter(function (e) { return e.who === 'me'; }).length;
  const her = events.filter(function (e) { return e.who === 'her'; }).length;
  const lines = ['# ' + day, '', '- 共 ' + events.length + ' 条（你 ' + me + ' / 她 ' + her + '）', ''];
  for (const e of events) {
    lines.push('**' + clockOf(e.ts) + '** ' + (e.who === 'me' ? '你' : '她'), '');
    for (const l of e.text.split('\n')) lines.push('  ' + l);
    lines.push('');
  }
  return lines.join('\n');
}
