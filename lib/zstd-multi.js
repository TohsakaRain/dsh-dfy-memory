/**
 * lib/zstd-multi.js —— 多帧 zstd 解压
 * ============================================================================
 * 背景（2026-10-29 实测）：
 *   DSH 插件宿主里的 `zlib.zstdDecompressSync` **只解第一帧**。
 *   DSH 的会话日志是**多帧**文件（实测 4493870 字节 / 5517 帧 / 8628 行），
 *   整段调用只会拿到第一帧的内容（1 行），于是"抽到 0 条事件"且不报错。
 *
 * 解法：按 zstd 帧魔数（小端 28 B5 2F FD）切分，逐帧解压再拼接。
 *   实测逐帧结果与整段解压**完全一致**（都是 8628 行）。
 *
 * 注意：魔数理论上可能出现在帧数据里，但会话日志是一行一条 JSON，
 * 解压失败时这里会回退到"整段解压"，不会把好数据弄丢。
 * ============================================================================
 */
import z from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 找出所有帧起点 */
export function frameStarts(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length - 4) {
    const at = buf.indexOf(MAGIC, i);
    if (at < 0) break;
    out.push(at);
    i = at + 1;
  }
  return out;
}

/**
 * 解压整个多帧缓冲。
 * @returns {{text: string, frames: number, failed: number, fallback: boolean}}
 */
export function decompressAll(buf) {
  if (!buf || !buf.length) return { text: '', frames: 0, failed: 0, fallback: false };

  const starts = frameStarts(buf);
  // 只有一帧（或找不到帧）→ 直接整段解
  if (starts.length <= 1) {
    try {
      return { text: z.zstdDecompressSync(buf).toString('utf8'), frames: 1, failed: 0, fallback: false };
    } catch (e) {
      return { text: '', frames: 0, failed: 1, fallback: false };
    }
  }

  const parts = [];
  let failed = 0;
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      parts.push(z.zstdDecompressSync(buf.subarray(start, end)).toString('utf8'));
    } catch (e) {
      failed += 1; // 魔数误命中，跳过
    }
  }

  const text = parts.join('');
  // 一帧都没解出来 → 回退整段（万一是单帧但魔数重复出现）
  if (!text) {
    try {
      return { text: z.zstdDecompressSync(buf).toString('utf8'), frames: starts.length, failed, fallback: true };
    } catch (e) {
      return { text: '', frames: starts.length, failed, fallback: true };
    }
  }
  return { text, frames: starts.length, failed, fallback: false };
}
