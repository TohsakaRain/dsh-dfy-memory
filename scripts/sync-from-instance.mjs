import fs from 'node:fs';
import path from 'node:path';

// sync-from-instance.mjs —— 把「运行实例里改好的代码」搬进这个仓库
//
// 规矩（2026-11-08）：先在实例上直接改、验证稳定，再整理进仓库。
// 这个脚本负责"整理"那一步的搬运，避免手抄漏文件。
//
// 用法：
//   node scripts/sync-from-instance.mjs <实例插件目录> [--dry]
//
//   例：node scripts/sync-from-instance.mjs D:/dfy/qq-bridge/plugins/dsh-dfy-memory
//
// 只搬这些（运行代码 + 自检）：
//   index.js  selfcheck.mjs  lib/*.js
// **不搬** cordis.patch.yml（实例里写的是真实盘符路径，仓库用的是默认 ~/.dsh）
// 也不搬 README / package.json（仓库的版本号和更新记录要在仓库里手改）

const args = process.argv.slice(2).filter((a) => a !== '--dry');
const dry = process.argv.includes('--dry');
const src = args[0];

if (!src) {
  console.error('用法: node scripts/sync-from-instance.mjs <实例插件目录> [--dry]');
  process.exit(1);
}
const from = path.resolve(src);
const to = path.resolve('.');

if (!fs.existsSync(path.join(from, 'index.js'))) {
  console.error('这不是插件目录（没有 index.js）：' + from);
  process.exit(1);
}
if (path.resolve(from) === to) {
  console.error('源和目标是同一个目录');
  process.exit(1);
}

// client.js **不搬**：设置页标题在实例里是「大肥鱼记忆」，开源版是「AI 记忆」，故意不同
const files = ['index.js', 'selfcheck.mjs'];
const libDir = path.join(from, 'lib');
if (fs.existsSync(libDir)) {
  for (const n of fs.readdirSync(libDir)) {
    if (n.endsWith('.js') || n.endsWith('.mjs')) files.push(path.join('lib', n));
  }
}

let copied = 0;
for (const rel of files) {
  const s = path.join(from, rel);
  const d = path.join(to, rel);
  if (!fs.existsSync(s)) { console.log('  跳过（源没有）: ' + rel); continue; }
  // 比较时忽略行尾差异（CRLF/LF、结尾空行），避免"内容一样却每次都说要覆盖"
  const norm = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '');
  const same = fs.existsSync(d) && norm(fs.readFileSync(s)) === norm(fs.readFileSync(d));
  if (same) { console.log('  相同  ' + rel); continue; }
  if (!dry) fs.copyFileSync(s, d);
  console.log('  ' + (dry ? '[dry] 会覆盖 ' : '已覆盖 ') + rel);
  copied += 1;
}

console.log(`\n${dry ? '（dry run，没有真的写）' : ''}共 ${copied} 个文件${dry ? '待' : '已'}更新。`);
console.log(`
下一步：
  1. node selfcheck.mjs                     # 全过（条数只增不减）
  2. 改 package.json 的 version
  3. README.md 加一节「更新记录 · vX.Y.Z」
  4. git checkout -b vX.Y.Z && git add -A && git commit -m "feat(vX.Y.Z): …"
  5. git checkout main && git merge --no-ff vX.Y.Z && node selfcheck.mjs
  6. git push && git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z
`);


