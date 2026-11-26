/**
 * lib/works.js —— 她的作品库
 * ============================================================================
 * 干什么：把她**认为是自己产出的东西**（一段文字、一张画）存下来，长期留存。
 *
 * 目录形状（2026-11-21 起按项目组织）：
 *   <dataRoot>/works/
 *   ├── text/
 *   │   ├── projects.json          项目注册表（每个类型一份）
 *   │   ├── <项目>/
 *   │   │   ├── drafts/            ← 唯一，项目级草稿箱
 *   │   │   ├── archive/           ← 唯一，项目级历史版本
 *   │   │   ├── <子分类>/          ← 她定，随便分几层
 *   │   │   └── <标题>.md          ← 当前稿也可以直接放项目根
 *   │   ├── archive/              类型级归档（旧数据 + 未归项目的散件用）
 *   │   └── drafts/               类型级草稿（同上）
 *   └── image/  … 同构
 *
 * 两条硬规则：
 *   · **项目先注册再用**：`<类型>/<项目>/` 必须由 dfy_work_project(create) 建出来
 *   · **drafts/ 和 archive/ 只出现在「类型/项目」这一层**，子分类里不许有
 *
 * 索引 `index.jsonl` 里每条记录的关键字段：
 *   { category, title, file, project?, created, archived?, draft?, ... }
 *   `file` 是**相对 `<类型>/` 目录的路径**，比如：
 *     `白饭派/前传/第一回.md`   （项目里的当前稿）
 *     `白饭派/drafts/第一回@20261121-2230.md`
 *     `白饭派/archive/第一回@20261120-1010.md`
 *     `散件.md`                （还没归项目的，旧数据都长这样）
 *   这样所有地方只要 `path.join(dir, category, e.file)` 就能定位，不用再拼 project。
 *
 * 归档（2026-11-07 加）：
 *   · 同名再存一次 → 旧稿自动挪进（项目级）archive/<标题>@<旧稿时间>.md
 *   · 也可以手动 dfy_work_archive 把当前稿收起来
 *
 * 设计约束：
 *   · **当前稿不覆盖**：同名不是覆盖，是"旧稿归档、新稿接位"。
 *   · **路径锁死**：标题/项目名/子路径都经 sanitize，../ 一律吃掉，落点必须在本目录内。
 *   · **分类白名单**：只允许 text / image 两类。
 *   · 图片只**复制**，不动源文件。
 *
 * 2026-11-22（她提了四件事，都做了）：
 *   · 草稿清理 cleanDrafts：每个标题只留最新 N 版，其余挪进项目 archive/（标 archivedDraft，**不删**）
 *   · save 不再掉到项目根：不传 sub 就跟着**同名那份原来的位置**走；传了 sub 就换层，
 *     别处的同名旧稿一样先归档 → 一个标题在项目里永远只剩一份当前稿
 *   · move 有 onConflict：skip（默认）/ overwrite（挡路的那份先归档，不丢）/ rename（标题 (2)）
 *   · overview / check：一次看清各项目、子分类的件数，最近动过几件，索引有没有对不上的账
 *   · **位置以路径为准**：drafts/ 下就是草稿，archive/ 下就是历史——标记写歪了不影响列表
 */
import fs from 'node:fs';
import path from 'node:path';

export const CATEGORIES = ['text', 'image'];
export const ARCHIVE_DIR = 'archive';
export const DRAFTS_DIR = 'drafts';
const PROJECTS_FILE = 'projects.json';

const TEXT_EXT = '.md';
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_TITLE_CHARS = 80;
const MAX_PROJECT_CHARS = 40;
const MAX_TEXT_CHARS = 200000;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

// Windows 文件名保留字：不能当文件名，前面垫一个下划线
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 作品库根目录：跟 memoryDir 同级（memory 的父目录 / works）。 */
export function worksDirOf(memoryDir) {
  return path.join(path.dirname(path.resolve(memoryDir)), 'works');
}

export function ensureDir(dir) {
  for (const c of CATEGORIES) {
    fs.mkdirSync(path.join(dir, c), { recursive: true });
    // 类型级 archive/drafts 保留：旧数据和"还没归项目"的散件要用
    fs.mkdirSync(path.join(dir, c, ARCHIVE_DIR), { recursive: true });
    fs.mkdirSync(path.join(dir, c, DRAFTS_DIR), { recursive: true });
  }
  return dir;
}

/**
 * 标题 → 安全文件名（不含扩展名）。
 * 非法字符换下划线、压空格、去首尾点和空格（Windows 不允许结尾的点）、限长。
 */
export function sanitizeTitle(raw) {
  let t = String(raw ?? '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!t) t = 'untitled';
  if (WIN_RESERVED.test(t)) t = `_${t}`;
  if (t.length > MAX_TITLE_CHARS) t = t.slice(0, MAX_TITLE_CHARS).trim();
  return t || 'untitled';
}

/**
 * 项目名 / 子路径 → 安全路径片段。
 * 比标题更严：不允许点（"../" 就是靠点穿越的），不允许空串。
 */
export function sanitizeProject(raw) {
  const t = String(raw ?? '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[.]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) throw new Error('项目名不能为空（也不能只由点和空格组成）');
  if (WIN_RESERVED.test(t)) return `_${t}`;
  if (t.length > MAX_PROJECT_CHARS) return t.slice(0, MAX_PROJECT_CHARS).trim();
  return t;
}

/** 项目内的子路径：允许 a/b/c，每段各自 sanitize。 */
export function sanitizeSubpath(raw) {
  const parts = String(raw ?? '').split(/[\\/]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return '';
  if (parts.length > 6) throw new Error('子路径太深了（最多 6 层）');
  return parts.map((p) => sanitizeProject(p)).join('/');
}

function indexPath(dir) {
  return path.join(dir, 'index.jsonl');
}

function appendIndex(dir, entry) {
  try {
    fs.appendFileSync(indexPath(dir), JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* 索引写失败不影响作品本身 */ }
}

function readIndex(dir) {
  try {
    return fs.readFileSync(indexPath(dir), 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function rewriteIndex(dir, rows) {
  try {
    const tmp = indexPath(dir) + '.tmp';
    fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, indexPath(dir));
  } catch { /* 索引写失败不影响作品本身 */ }
}

function nowIso(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 归档文件名里的时间戳：20261107-2159 */
function stamp(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// ── 位置判定（2026-11-22）────────────────────────────────────────────────
//
// 为什么不信 draft / archived 标记：这些标记被「搬来搬去」的动作写歪过。
// 实测她的库里有 3 条 archived=true 的文件躺在 <项目>/前传/ 里（同一个文件还被
// 两条索引指着），另有 57 条 draft 被标了 archived。后果是：她明明看得见的稿子
// 在列表里不出现，dfy_work_save 也认不出它 → 又存一份到项目根 =「根和前传各有一份」。
//
// 所以：**位置以 file 路径为准**，标记只是附注；fixFlags 负责把标记改回一致。

const isDraftPath = (rel) => /(^|\/)drafts\//.test(String(rel ?? ''));
const isArchivePath = (rel) => /(^|\/)archive\//.test(String(rel ?? ''));

/** 一条索引记录现在算什么：draft / archive / work（看路径，不看标记）。 */
export function rowKind(e) {
  if (isDraftPath(e?.file)) return 'draft';
  if (isArchivePath(e?.file)) return 'archive';
  return 'work';
}

/** 位图：标记和路径对不对得上。 */
function flagDiffers(e) {
  const k = rowKind(e);
  if (k === 'draft') return e.draft !== true || Boolean(e.archived);
  if (k === 'archive') return e.archived !== true || Boolean(e.draft);
  return Boolean(e.archived) || Boolean(e.draft);
}

/** 把 e 的标记改成和路径一致（原地改）。返回是否动过。 */
function fixFlags(e, now = Date.now()) {
  const k = rowKind(e);
  let changed = false;
  const drop = (...keys) => { for (const key of keys) if (key in e) { delete e[key]; changed = true; } };
  if (k === 'draft') {
    if (e.draft !== true) { e.draft = true; changed = true; }
    drop('archived', 'archivedAt', 'archivedDraft');
  } else if (k === 'archive') {
    // 归档里的「旧草稿」靠 archivedDraft 认，draft 标记本身不再保留（路径已经说明一切）
    if (e.draft !== undefined) { delete e.draft; changed = true; }
    if (e.archived !== true) { e.archived = true; changed = true; }
    if (!e.archivedAt) { e.archivedAt = e.movedAt || e.created || nowIso(now); changed = true; }
  } else {
    drop('draft', 'archived', 'archivedAt', 'archivedDraft');
  }
  return changed;
}

/** 文件在磁盘上还在不在。 */
function hasFile(dir, e) {
  try { return fs.existsSync(path.join(dir, e.category, e.file)); } catch { return false; }
}

/** 从 file 反推子路径（去掉项目名和文件名）。 */
function subFromFile(rel, project) {
  const parts = String(rel ?? '').split('/');
  parts.pop();
  if (project && parts[0] === project) parts.shift();
  return parts.join('/');
}

/** 同一个文件被多条索引指着时，只留最新的那条；返回 { rows, dropped }。 */
function dedupeByFile(rows) {
  const best = new Map();
  const dropped = [];
  for (const e of rows) {
    const key = `${e.category}/${e.file}`;
    const prev = best.get(key);
    if (!prev) { best.set(key, e); continue; }
    const newer = String(e.created ?? '').localeCompare(String(prev.created ?? '')) > 0 ? e : prev;
    dropped.push(newer === e ? prev : e);
    best.set(key, newer);
  }
  return { rows: [...best.values()], dropped };
}

/** 目标位置已有同名时给一个「标题 (2).md」（返回相对路径）。 */
function uniqueNameIn(dir, category, rel) {
  const ext = path.extname(rel);
  const dirPart = path.posix.dirname(rel);
  const stem = path.basename(rel, ext);
  const prefix = dirPart === '.' ? '' : `${dirPart}/`;
  for (let n = 2; n <= 200; n += 1) {
    const cand = `${prefix}${stem} (${n})${ext}`;
    if (!fs.existsSync(path.join(dir, category, cand))) return cand;
  }
  throw new Error('同名太多了，改不了名');
}

/** 扫磁盘：某个类型下所有算作品的文件的相对路径。 */
function listFilesIn(dir, category) {
  const base = path.join(dir, category);
  const out = [];
  const walk = (abs, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      if (ent.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { walk(path.join(abs, ent.name), childRel); continue; }
      const ext = path.extname(ent.name).toLowerCase();
      if (category === 'text' ? ext !== TEXT_EXT : !IMAGE_EXTS.has(ext)) continue;
      out.push(childRel);
    }
  };
  walk(base, '');
  return out;
}

/** 磁盘上有、索引里没有的文件（她手工搬过/改过名的稿子会落进这里）。 */
function scanOrphans(dir, rows) {
  const known = new Set(rows.map((e) => `${e.category}/${e.file}`));
  const out = [];
  for (const cat of CATEGORIES) {
    for (const rel of listFilesIn(dir, cat)) {
      if (known.has(`${cat}/${rel}`)) continue;
      out.push({ category: cat, file: rel });
    }
  }
  return out;
}

/** 手工放进来的文件 → 索引记录（标题去掉 @时间戳 ~ 尾巴）。 */
function rowFromFile(dir, category, rel, now = Date.now()) {
  const parts = String(rel).split('/');
  const name = parts.pop();
  const ext = path.extname(name);
  const stem = path.basename(name, ext).replace(/@\d{8}-\d{4}(-\d+)?$/, '');
  const draft = parts[0] === DRAFTS_DIR || parts[1] === DRAFTS_DIR;
  const arch = parts[0] === ARCHIVE_DIR || parts[1] === ARCHIVE_DIR;
  const project = parts.length && parts[0] !== DRAFTS_DIR && parts[0] !== ARCHIVE_DIR ? parts[0] : '';
  const subParts = parts.filter((p) => p !== project && p !== DRAFTS_DIR && p !== ARCHIVE_DIR);
  let at = nowIso(now);
  try { at = nowIso(fs.statSync(path.join(dir, category, rel)).mtimeMs); } catch { /* 用当前时间 */ }
  return {
    id: `w_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    title: sanitizeTitle(stem),
    category,
    file: rel,
    created: at,
    ...(project ? { project } : {}),
    ...(subParts.length ? { sub: subParts.join('/') } : {}),
    ...(draft ? { draft: true } : {}),
    ...(arch ? { archived: true, archivedAt: at } : {}),
  };
}

function normalizeCategory(raw, fallback) {
  const c = String(raw ?? '').trim().toLowerCase();
  if (!c) return fallback;
  if (!CATEGORIES.includes(c)) {
    throw new Error(`分类只能是 ${CATEGORIES.join(' / ')}（收到 "${raw}"）`);
  }
  return c;
}

// ── 项目（2026-11-21）────────────────────────────────────────────────────
//
// 为什么要注册：她说"一百八十多件全堆在一个抽屉里"。允许随手建文件夹的结果
// 就是抽屉越开越多、每个里面又各有一份 drafts/archive，规则等于没定。
// 所以项目必须显式 create；但**子分类不注册**——那是她自己的事，move 时自动建。

function projectsPath(dir, category) {
  return path.join(dir, category, PROJECTS_FILE);
}

function readProjectsRaw(dir, category) {
  try {
    const j = JSON.parse(fs.readFileSync(projectsPath(dir, category), 'utf8'));
    if (j && Array.isArray(j.projects)) return j;
  } catch { /* 没有/坏了都当空表 */ }
  return { version: 1, projects: [] };
}

function writeProjectsRaw(dir, category, data) {
  fs.mkdirSync(path.join(dir, category), { recursive: true });
  const tmp = projectsPath(dir, category) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, projectsPath(dir, category));
}

/** 项目目录（works/<cat>/<project>）。 */
function projectDir(dir, category, project) {
  return path.join(dir, category, project);
}

/** 列出某类型下所有"像项目"的目录（含注册表里没有的，标 unregistered）。 */
export function listProjects(dir, { category } = {}) {
  ensureDir(dir);
  const cats = category ? [normalizeCategory(category, null)] : CATEGORIES;
  const out = [];
  for (const cat of cats) {
    const reg = readProjectsRaw(dir, cat);
    const regNames = new Set(reg.projects.map((p) => p.name));
    const rows = readIndex(dir);
    const seen = new Set();
    // 计数一律按路径分类（标记写歪了也不影响）
    const count = (projName) => {
      const mine = rows.filter((e) => e.category === cat && (e.project || '') === projName && hasFile(dir, e));
      return {
        works: mine.filter((e) => rowKind(e) === 'work').length,
        drafts: mine.filter((e) => rowKind(e) === 'draft').length,
        archives: mine.filter((e) => rowKind(e) === 'archive').length,
      };
    };
    for (const p of reg.projects) {
      const d = projectDir(dir, cat, p.name);
      const exists = fs.existsSync(d);
      seen.add(p.name);
      out.push({
        name: p.name,
        category: cat,
        description: p.description || '',
        createdAt: p.createdAt || '',
        exists,
        unregistered: false,
        ...count(p.name),
        subdirs: exists ? subdirsOf(d) : [],
      });
    }
    // 磁盘上有、注册表里没有的目录也列出来（她手动建的，或旧数据）
    let entries = [];
    try { entries = fs.readdirSync(path.join(dir, cat), { withFileTypes: true }); } catch { /* 空目录 */ }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name === ARCHIVE_DIR || ent.name === DRAFTS_DIR) continue;
      if (seen.has(ent.name)) continue;
      const d = projectDir(dir, cat, ent.name);
      out.push({
        name: ent.name, category: cat, description: '', createdAt: '', exists: true,
        unregistered: true,
        ...count(ent.name),
        subdirs: subdirsOf(d),
      });
    }
  }
  return out;
}

/** 项目下的子目录名（不含 drafts/archive）。 */
function subdirsOf(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== ARCHIVE_DIR && e.name !== DRAFTS_DIR)
      .map((e) => e.name);
  } catch { return []; }
}

/** 注册一个项目（幂等：已存在直接返回，不报错）。 */
export function createProject(dir, { name, category = 'text', description = '', now = Date.now() } = {}) {
  ensureDir(dir);
  const cat = normalizeCategory(category, 'text');
  const safe = sanitizeProject(name);
  const reg = readProjectsRaw(dir, cat);
  const d = projectDir(dir, cat, safe);
  fs.mkdirSync(path.join(d, DRAFTS_DIR), { recursive: true });
  fs.mkdirSync(path.join(d, ARCHIVE_DIR), { recursive: true });
  let project = reg.projects.find((p) => p.name === safe);
  if (!project) {
    project = { name: safe, description: String(description ?? '').slice(0, 200), createdAt: nowIso(now) };
    reg.projects.push(project);
    writeProjectsRaw(dir, cat, reg);
  } else if (description) {
    project.description = String(description).slice(0, 200);
    writeProjectsRaw(dir, cat, reg);
  }
  return { ...project, category: cat, dir: d, created: !project.createdAt || project.createdAt === nowIso(now) };
}

/** 改项目名：移动目录 + 改索引里的 project 字段。 */
export function renameProject(dir, { from, to, category = 'text', now = Date.now() } = {}) {
  ensureDir(dir);
  const cat = normalizeCategory(category, 'text');
  const oldName = sanitizeProject(from);
  const newName = sanitizeProject(to);
  if (oldName === newName) return { renamed: false, reason: '新旧名字一样' };
  const reg = readProjectsRaw(dir, cat);
  const project = reg.projects.find((p) => p.name === oldName);
  if (!project) throw new Error(`没有这个项目：${oldName}`);
  if (reg.projects.some((p) => p.name === newName)) throw new Error(`已经有叫「${newName}」的项目了`);
  const src = projectDir(dir, cat, oldName);
  const dst = projectDir(dir, cat, newName);
  if (fs.existsSync(dst) && fs.readdirSync(dst).length) throw new Error('目标目录已存在且不是空的');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.existsSync(src)) fs.renameSync(src, dst);
  project.name = newName;
  writeProjectsRaw(dir, cat, reg);
  const rows = readIndex(dir);
  let touched = 0;
  for (const e of rows) {
    if (e.category !== cat || !e.project || e.project !== oldName) continue;
    e.project = newName;
    if (typeof e.file === 'string' && e.file.startsWith(oldName + '/')) e.file = newName + e.file.slice(oldName.length);
    e.updatedAt = nowIso(now);
    touched += 1;
  }
  if (touched) rewriteIndex(dir, rows);
  return { renamed: true, from: oldName, to: newName, category: cat, indexUpdated: touched };
}

// ── 路径解析 ─────────────────────────────────────────────────────────────

/**
 * 作品当前稿的相对路径（相对 <类型>/ 目录）。
 *   project 为空 → `<sub>/<title><ext>`（其实是散件）
 *   有 project  → `<project>/<sub>/<title><ext>`
 */
function workRelPath({ project, sub, stem, ext }) {
  const segs = [];
  if (project) segs.push(project);
  if (sub) segs.push(sub);
  segs.push(`${stem}${ext}`);
  return segs.join('/');
}

/** 归档目录的相对路径：项目级优先，没有项目就用类型级。 */
function archiveRelDir(project) {
  return project ? `${project}/${ARCHIVE_DIR}` : ARCHIVE_DIR;
}

function draftsRelDir(project) {
  return project ? `${project}/${DRAFTS_DIR}` : DRAFTS_DIR;
}

// ── 归档 ─────────────────────────────────────────────────────────────────

/** 把一件作品的文件挪进归档，返回相对路径（archive/xxx 或 <项目>/archive/xxx）。 */
export function moveToArchive(dir, category, file, now = Date.now(), project = '', { keepName = false } = {}) {
  const relDir = archiveRelDir(project);
  const ad = path.join(dir, category, relDir);
  fs.mkdirSync(ad, { recursive: true });
  const ext = path.extname(file);
  const stem = path.basename(file, ext);
  // keepName：文件名自带时间戳的（草稿就是）原样搬，不再叠一层 @时间
  const base = keepName ? stem : `${stem}@${stamp(now)}`;
  let name = `${base}${ext}`;
  let n = 2;
  while (fs.existsSync(path.join(ad, name))) {
    name = `${base}-${n}${ext}`;
    n += 1;
    if (n > 200) throw new Error('同名归档太多了');
  }
  fs.renameSync(path.join(dir, category, file), path.join(ad, name));
  return `${relDir}/${name}`;
}

/** 某个标题在某个项目里的**当前稿**（看路径，不看标记）。 */
function currentRows(dir, category, stem, project = '') {
  return readIndex(dir).filter((e) => e.category === category
    && e.title === stem
    && (e.project || '') === (project || '')
    && rowKind(e) === 'work'
    && hasFile(dir, e));
}

/**
 * 存一件作品：同名旧稿先归档，新稿接位。
 *
 * sub 的三种意思（2026-11-22 起）：
 *   undefined  → **没指定**：跟着同名那份原来的位置走（一份都没有才落项目根）
 *   ''         → 明确要放项目根
 *   '前传'      → 明确要换到前传
 *
 * 为什么改：她说「不传子目录就会存到项目根，结果根和前传各有一份」。原来只看
 * project 找旧稿，一旦旧稿带着 sub 走了、或者索引标记写歪了，就认不出来，于是
 * 同一篇稿子在两个地方各躺一份。现在**不管旧稿在哪个子目录**都先归档，新稿放到
 * destSub —— 一个标题在项目里永远只有一份当前稿。
 */
function promote(dir, { category, stem, ext, now, write, base, project = '', sub, subPath }) {
  ensureDir(dir);
  const rows = readIndex(dir);

  // 同名当前稿（同项目内，任意子目录）→ 挪进归档，并在索引里标成 archived
  // ⚠️ 必须排除 draft：草稿不算"旧稿"。2026-11-21 测试发现，少了这一步时
  //    finalizeDraft → saveTextWork → promote 会把刚定稿的草稿一起塞进 archive，
  //    草稿箱瞬间被清空（和"草稿不搬家"的设计正好相反）。
  const olds = rows
    .filter((e) => e.category === category && e.title === stem && (e.project || '') === (project || ''))
    .filter((e) => rowKind(e) === 'work' && hasFile(dir, e))
    .sort((a, b) => String(b.created ?? '').localeCompare(String(a.created ?? '')));

  // 目标子目录：显式给了就用它，没给就跟着最新那份旧稿的位置
  const explicit = sub !== undefined || subPath !== undefined;
  const fromOld = olds[0] ? (olds[0].sub || subFromFile(olds[0].file, project)) : '';
  const destSub = explicit ? sanitizeSubpath(sub ?? subPath ?? '') : fromOld;
  const fromFiles = olds.map((e) => e.file);

  for (const e of olds) {
    try {
      const rel = moveToArchive(dir, category, e.file, now, project);
      e.file = rel;
      fixFlags(e, now);
      e.archivedAt = nowIso(now);
    } catch { /* 挪不动就让它留在原处，别把新稿也搞失败 */ }
  }

  const rel = workRelPath({ project, sub: destSub, stem, ext });
  const target = path.join(dir, category, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  write(target);

  // 同一个文件可能被两条索引指着（历史遗留）——顺手只留最新的那条
  const { rows: kept } = dedupeByFile(rows);
  const entry = {
    id: `w_${now}_${Math.random().toString(36).slice(2, 7)}`,
    title: stem,
    category,
    file: rel,
    created: nowIso(now),
    ...(project ? { project } : {}),
    ...(destSub ? { sub: destSub } : {}),
    ...base,
  };
  rewriteIndex(dir, [...kept, entry]);
  return {
    ...entry,
    path: target,
    archivedOld: olds.length,
    archivedFrom: fromFiles,
    sub: destSub,
    inheritedSub: !explicit && Boolean(destSub),
  };
}

/** 存一段文字作品。 */
export function saveTextWork(dir, { title, text, tags = [], project = '', sub, path: subPath, now = Date.now() } = {}) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('作品正文是空的，没东西可存');
  if (body.length > MAX_TEXT_CHARS) throw new Error(`太长了（${body.length} 字），上限 ${MAX_TEXT_CHARS}`);

  const proj = project ? sanitizeProject(project) : '';
  // undefined = 没指定（跟着同名旧稿原来的位置走）；'' = 明确放项目根
  const hasSub = sub !== undefined || subPath !== undefined;
  const subRel = hasSub ? sanitizeSubpath(sub ?? subPath) : undefined;
  const stem = sanitizeTitle(title);
  const created = nowIso(now);
  const tagLine = Array.isArray(tags) && tags.length ? `tags: ${tags.join(', ')}\n` : '';
  const projLine = proj ? `project: ${proj}\n` : '';
  const doc = `---\ntitle: ${stem}\ncategory: text\n${projLine}created: ${created}\n${tagLine}---\n\n${body}\n`;

  return promote(dir, {
    category: 'text', stem, ext: TEXT_EXT, now, project: proj, sub: subRel,
    write: (target) => fs.writeFileSync(target, doc, 'utf8'),
    base: { bytes: Buffer.byteLength(doc, 'utf8'), chars: body.length },
  });
}

/** 存一张图片作品（复制源文件，不动源）。 */
export function saveImageWork(dir, { title, source, project = '', sub, path: subPath, now = Date.now() } = {}) {
  const src = path.resolve(String(source ?? ''));
  let st;
  try { st = fs.statSync(src); } catch { throw new Error(`找不到这个文件：${src}`); }
  if (!st.isFile()) throw new Error('不是文件：' + src);
  if (st.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片太大（${(st.size / 1048576).toFixed(1)} MB），上限 ${MAX_IMAGE_BYTES / 1048576} MB`);
  }
  const ext = path.extname(src).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) throw new Error(`只支持 ${[...IMAGE_EXTS].join(' / ')}，收到 "${ext || '(无扩展名)'}"`);

  const proj = project ? sanitizeProject(project) : '';
  const hasSub = sub !== undefined || subPath !== undefined;
  const subRel = hasSub ? sanitizeSubpath(sub ?? subPath) : undefined;
  const stem = sanitizeTitle(title);
  return promote(dir, {
    category: 'image', stem, ext, now, project: proj, sub: subRel,
    write: (target) => fs.copyFileSync(src, target),
    base: { bytes: st.size, source: src },
  });
}

/** 手动把当前稿收进归档（不想换新稿、只是想留一份的时候用）。 */
export function archiveWork(dir, { title, category, project, now = Date.now() } = {}) {
  ensureDir(dir);
  const stem = sanitizeTitle(title);
  const cat = category ? normalizeCategory(category, null) : '';
  const proj = project === undefined || project === null || project === '' ? null : sanitizeProject(project);
  const rows = readIndex(dir);
  const targets = rows.filter((e) => e.title === stem
    && (cat ? e.category === cat : true)
    && (proj === null ? true : (e.project || '') === proj)
    && rowKind(e) === 'work'
    && hasFile(dir, e));
  if (!targets.length) return { archived: 0, items: [] };

  const out = [];
  for (const e of targets) {
    try {
      const rel = moveToArchive(dir, e.category, e.file, now, e.project || '');
      e.file = rel;
      fixFlags(e, now);
      e.archivedAt = nowIso(now);
      out.push({ title: e.title, category: e.category, file: rel, project: e.project || '' });
    } catch { /* 单个失败不影响其它 */ }
  }
  rewriteIndex(dir, rows);
  return { archived: out.length, items: out };
}

/**
 * 草稿：大纲、随手记、试画都放这儿。
 *   <cat>/<项目>/drafts/<标题>@<时间>.<ext>   每一版草稿一个文件，不覆盖
 *   没有指定项目时退回 <cat>/drafts/（旧行为，给还没归项目的散件用）
 *
 * 为什么要单独一层：草稿是"还没成形的东西"，不该混在定稿里数件数，
 * 也不该占 archive（archive 是"成品的旧版本"）。作品从草稿里长出来。
 */
export function saveDraft(dir, { title, text, source, category = 'text', project = '', now = Date.now() } = {}) {
  ensureDir(dir);
  const cat = normalizeCategory(category, 'text');
  const proj = project ? sanitizeProject(project) : '';
  const stem = sanitizeTitle(title);
  const relDir = draftsRelDir(proj);
  const dDir = path.join(dir, cat, relDir);
  fs.mkdirSync(dDir, { recursive: true });

  let ext;
  if (cat === 'text') {
    const body = String(text ?? '').trim();
    if (!body) throw new Error('草稿是空的，写点什么再存');
    if (body.length > MAX_TEXT_CHARS) throw new Error(`太长了（${body.length} 字），上限 ${MAX_TEXT_CHARS}`);
    ext = TEXT_EXT;
  } else {
    const src = path.resolve(String(source ?? ''));
    let st;
    try { st = fs.statSync(src); } catch { throw new Error('找不到这个文件：' + src); }
    if (!st.isFile()) throw new Error('不是文件：' + src);
    ext = path.extname(src).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) throw new Error('只支持 ' + [...IMAGE_EXTS].join(' / '));
  }

  let name = `${stem}@${stamp(now)}${ext}`;
  let n = 2;
  while (fs.existsSync(path.join(dDir, name))) { name = `${stem}@${stamp(now)}-${n}${ext}`; n += 1; }

  const target = path.join(dDir, name);
  if (cat === 'text') {
    const created = nowIso(now);
    const projLine = proj ? `project: ${proj}\n` : '';
    fs.writeFileSync(target, `---\ntitle: ${stem}\ncategory: text\ndraft: true\n${projLine}created: ${created}\n---\n\n${String(text).trim()}\n`, 'utf8');
  } else {
    fs.copyFileSync(path.resolve(String(source)), target);
  }

  const entry = {
    id: `w_${now}_${Math.random().toString(36).slice(2, 7)}`,
    title: stem, category: cat, file: `${relDir}/${name}`,
    created: nowIso(now), draft: true,
    ...(proj ? { project: proj } : {}),
    seq: readIndex(dir).length,   // 自增序号：同一秒存多版时靠它定先后
  };
  appendIndex(dir, entry);
  return { ...entry, path: target };
}

/** 列草稿（默认全部，可按标题/项目/前缀过滤）。 */
export function listDrafts(dir, { title, category, project, prefix, limit = 30 } = {}) {
  ensureDir(dir);
  const cat = category ? normalizeCategory(category, null) : '';
  const stem = title ? sanitizeTitle(title) : '';
  const proj = project === undefined || project === null || project === '' ? null : sanitizeProject(project);
  const pre = String(prefix ?? '').trim();
  const rows = readIndex(dir)
    .filter((e) => rowKind(e) === 'draft')
    .filter((e) => (cat ? e.category === cat : true))
    .filter((e) => (stem ? e.title === stem : true))
    .filter((e) => (proj === null ? true : (e.project || '') === proj))
    .filter((e) => (pre ? String(e.title).startsWith(pre) : true))
    .filter((e) => hasFile(dir, e))
    // 先按自增序号（同一秒多版也分得清先后），再按时间
    .sort((a, b) => (Number(b.seq) || 0) - (Number(a.seq) || 0)
      || String(b.created).localeCompare(String(a.created))
      || String(b.file).localeCompare(String(a.file)));
  const max = Math.max(1, Math.min(200, Number(limit) || 30));
  return { total: rows.length, items: rows.slice(0, max) };
}

/** 读最新一版草稿。 */
export function readDraft(dir, { title, category = 'text', project = '' } = {}) {
  const proj = project ? sanitizeProject(project) : '';
  const r = listDrafts(dir, { title, category, project: proj, limit: 1 });
  if (!r.items.length) return { found: false };
  const e = r.items[0];
  const full = path.join(dir, e.category, e.file);
  if (e.category === 'image') return { found: true, ...e, path: full };
  const raw = fs.readFileSync(full, 'utf8');
  return { found: true, ...e, path: full, text: raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim() };
}

/**
 * 定稿：把最新一版草稿变成正式作品。
 * · 新定稿成为当前稿（原来的当前稿按老规矩进 archive）
 * · 草稿本身不搬家、不删（2026-11-07 定的）
 */
export function finalizeDraft(dir, { title, category = 'text', project = '', sub, path: subPath, now = Date.now() } = {}) {
  ensureDir(dir);
  const cat = normalizeCategory(category, 'text');
  const proj = project ? sanitizeProject(project) : '';
  // undefined = 没指定：定稿也跟着同名旧稿的位置走（别掉到项目根）
  const hasSub = sub !== undefined || subPath !== undefined;
  const subRel = hasSub ? sanitizeSubpath(sub ?? subPath) : undefined;
  const stem = sanitizeTitle(title);
  const drafts = listDrafts(dir, { title: stem, category: cat, project: proj, limit: 200 });
  if (!drafts.items.length) return { finalized: false, reason: '这个标题下没有草稿' };

  const picked = drafts.items[0];
  const pickedPath = path.join(dir, cat, picked.file);
  let work;
  if (cat === 'text') {
    const raw = fs.readFileSync(pickedPath, 'utf8');
    const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    work = saveTextWork(dir, { title: stem, text: body, project: proj, sub: subRel, now });
  } else {
    work = saveImageWork(dir, { title: stem, source: pickedPath, project: proj, sub: subRel, now });
  }
  return { finalized: true, work, draftsKept: drafts.total };
}

/**
 * 把某个历史版本**拿回来当当前稿**（和 archiveWork 对称）。
 * 当前稿若存在，先自动归档，再把指定版本搬回来。
 */
export function restoreWork(dir, { title, category, file, project, now = Date.now() } = {}) {
  ensureDir(dir);
  const stem = sanitizeTitle(title);
  const cat = category ? normalizeCategory(category, null) : '';
  const proj = project === undefined || project === null || project === '' ? null : sanitizeProject(project);
  const rows = readIndex(dir);

  const archived = rows
    .filter((e) => rowKind(e) === 'archive' && !e.archivedDraft && e.title === stem
      && (cat ? e.category === cat : true))
    .filter((e) => (proj === null ? true : (e.project || '') === proj))
    .filter((e) => hasFile(dir, e))
    .sort((a, b) => String(b.archivedAt ?? b.created).localeCompare(String(a.archivedAt ?? a.created)));

  if (!archived.length) return { restored: 0, reason: '没有可恢复的历史版本' };

  let pick = archived[0];
  if (file) {
    const want = path.basename(String(file));
    const hit = archived.find((e) => path.basename(e.file) === want || e.file === file);
    if (!hit) return { restored: 0, reason: '归档里没有这个文件：' + file };
    pick = hit;
  }

  // 当前稿先挪进归档（如果有）
  const olds = rows.filter((e) => rowKind(e) === 'work' && e.category === pick.category && e.title === stem
    && (e.project || '') === (pick.project || '')
    && hasFile(dir, e));
  for (const e of olds) {
    try {
      const rel = moveToArchive(dir, pick.category, e.file, now, pick.project || '');
      e.file = rel;
      fixFlags(e, now);
      e.archivedAt = nowIso(now);
    } catch { /* 挪不动就留着 */ }
  }

  // 把选中的历史版本搬回当前（子目录沿用归档时记下的 sub；归档路径本身推不出子分类）
  const ext = path.extname(pick.file);
  const sub = pick.sub || '';
  const targetRel = workRelPath({ project: pick.project || '', sub, stem, ext });
  const target = path.join(dir, pick.category, targetRel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.renameSync(path.join(dir, pick.category, pick.file), target);
  } catch (e) {
    return { restored: 0, reason: '搬不回来：' + (e?.message ?? e) };
  }
  pick.file = targetRel;
  if (sub) pick.sub = sub; else delete pick.sub;
  fixFlags(pick, now);          // 从 archive/ 搬出来 → 标记要跟着变成当前稿
  delete pick.archivedDraft;
  pick.created = nowIso(now);
  rewriteIndex(dir, rows);

  return { restored: 1, title: stem, category: pick.category, project: pick.project || '', file: pick.file, path: target, archivedOld: olds.length };
}

/** 看某个作品的历史版本（归档里的），新的在前。 */
export function listVersions(dir, { title, category, project } = {}) {
  ensureDir(dir);
  const stem = sanitizeTitle(title);
  const cat = category ? normalizeCategory(category, null) : '';
  const proj = project === undefined || project === null || project === '' ? null : sanitizeProject(project);
  const rows = readIndex(dir)
    .filter((e) => rowKind(e) === 'archive' && !e.archivedDraft && e.title === stem && (cat ? e.category === cat : true))
    .filter((e) => (proj === null ? true : (e.project || '') === proj))
    .sort((a, b) => String(b.archivedAt ?? b.created).localeCompare(String(a.archivedAt ?? a.created)));
  return rows.filter((e) => hasFile(dir, e));
}

/**
 * 列表。
 *   kind: works（默认，当前稿）/ drafts / archive / root（类型目录下没归项目的）
 *   project / prefix / category / limit
 */
export function listWorks(dir, { category, project, prefix, kind = 'works', limit = 30, includeArchived = false } = {}) {
  ensureDir(dir);
  const cat = category ? normalizeCategory(category, null) : '';
  const proj = project === undefined || project === null || project === '' ? null : sanitizeProject(project);
  const pre = String(prefix ?? '').trim();
  const k = String(kind || 'works').toLowerCase();
  const wantsDraft = k === 'drafts';
  const wantsArchive = k === 'archive';
  const wantsRoot = k === 'root';

  const rows = dedupeByFile(readIndex(dir)
    .filter((e) => (cat ? e.category === cat : true))
    .filter((e) => {
      const kindOf = rowKind(e);
      if (wantsDraft) return kindOf === 'draft';
      if (wantsArchive) return kindOf === 'archive';
      return kindOf === 'work';
    })
    .filter((e) => {
      if (wantsRoot) return !e.project;
      if (proj === null) return true;
      return (e.project || '') === proj;
    })
    .filter((e) => (pre ? String(e.title).startsWith(pre) : true))
    // 索引可能比磁盘旧（手动删过文件）：以磁盘为准
    .filter((e) => hasFile(dir, e))
    .sort((a, b) => String(b.created).localeCompare(String(a.created)))).rows;

  const max = Math.max(1, Math.min(200, Number(limit) || 30));
  const byCat = {};
  for (const e of rows) byCat[e.category] = (byCat[e.category] || 0) + 1;
  return { total: rows.length, byCat, kind: k, items: rows.slice(0, max), dir };
}

/** 读一件作品：文字返回内容，图片返回路径（不返回二进制）。 */
export function readWork(dir, { title, category, file, project } = {}) {
  ensureDir(dir);
  const rows = readIndex(dir);
  const proj = project === undefined || project === null || project === '' ? null : sanitizeProject(project);
  let hit = null;
  if (file) {
    const base = path.basename(String(file));
    hit = rows.find((e) => e.file === String(file) || path.basename(e.file) === base);
  } else if (title) {
    const t = sanitizeTitle(title);
    const cat = category ? normalizeCategory(category, null) : '';
    hit = rows
      .filter((e) => e.title === t && (cat ? e.category === cat : true))
      .filter((e) => (proj === null ? true : (e.project || '') === proj))
      .sort((a, b) => String(b.created).localeCompare(String(a.created)))[0];
  }
  if (!hit) return { found: false };
  const full = path.join(dir, hit.category, hit.file);
  if (!fs.existsSync(full)) return { found: false, missing: full };
  if (hit.category === 'image') {
    return { found: true, ...hit, path: full };
  }
  const raw = fs.readFileSync(full, 'utf8');
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  return { found: true, ...hit, path: full, text: body };
}

// ── 搬家（2026-11-21，2026-11-22 加 onConflict）──────────────────────────
//
// 她的迁移主力。187 个文件自己搬，一次最多 50 个，搬错能搬回来。
//
//   from:  root（类型目录下的散件）/ drafts / archive / project（项目内）
//   to:    project（默认）/ root
//
// 规则：
//   · 目标已有同名文件 → onConflict 决定：
//       skip（默认）→ 跳过并报告
//       overwrite   → 挡路的那份先收进它自己的 archive（不丢），再搬进去
//       rename      → 新文件改叫「标题 (2)」
//   · 搬完把 draft/archived 标记改成和路径一致（以前不改，标记写歪以后
//     列表就认不出她看得见的稿子，dfy_work_save 又会往项目根再存一份）
//   · 找不到源 → 报告，不算失败
//   · 不猜归属、不合并同名、不动内容
export function moveWork(dir, {
  items, project, sub = '', path: subPath, category, from = 'root', to = 'project',
  onConflict = 'skip', now = Date.now(),
} = {}) {
  ensureDir(dir);
  const list = Array.isArray(items) ? items.map((s) => String(s)).filter(Boolean) : [];
  if (!list.length) throw new Error('items 不能为空');
  if (list.length > 50) throw new Error(`一次最多搬 50 个（收到 ${list.length} 个），分批来吧`);
  const cat = category ? normalizeCategory(category, null) : '';
  const fromKind = String(from || 'root').toLowerCase();
  const toKind = String(to || 'project').toLowerCase();
  if (!['root', 'drafts', 'archive', 'project'].includes(fromKind)) throw new Error(`from 只能是 root / drafts / archive / project`);
  if (!['root', 'project'].includes(toKind)) throw new Error(`to 只能是 root / project`);
  const rawConflict = String(onConflict ?? 'skip').toLowerCase().trim();
  const mode = /^(skip|不|留)/.test(rawConflict) || !rawConflict ? 'skip'
    : /^(over|replace|cover|force|clobber|盖|替)/.test(rawConflict) ? 'overwrite'
      : /^(rename|auto|uniq|new|改)/.test(rawConflict) ? 'rename'
        : '';
  if (!mode) throw new Error(`onConflict 只能是 skip / overwrite / rename（收到 "${onConflict}"）`);
  const proj = toKind === 'project' || fromKind === 'project'
    ? sanitizeProject(project || '')
    : '';
  const subRel = sanitizeSubpath(sub || subPath);
  const rows = readIndex(dir);
  const moved = [];
  const skipped = [];
  const missing = [];
  const overwritten = [];

  for (const raw of list) {
    const stem = sanitizeTitle(raw);
    // 找源条目（一律看路径，不看标记）
    const cands = rows.filter((e) => {
      if (cat && e.category !== cat) return false;
      if (e.title !== stem) return false;
      const kindOf = rowKind(e);
      if (fromKind === 'drafts') return kindOf === 'draft';
      if (fromKind === 'archive') return kindOf === 'archive';
      if (fromKind === 'project') return kindOf === 'work' && (e.project || '') === proj;
      // root：类型目录下的当前稿，且没有项目
      return kindOf === 'work' && !e.project;
    }).filter((e) => hasFile(dir, e));

    if (!cands.length) { missing.push({ title: stem, reason: '没找到（或不在这个来源里）' }); continue; }

    for (const e of cands) {
      const oldAbs = path.join(dir, e.category, e.file);
      const ext = path.extname(e.file);
      let newRel;
      if (toKind === 'root') {
        // 搬回类型根：文件名沿用原来的（归档/草稿的 @时间戳保留）
        newRel = path.basename(e.file);
      } else if (fromKind === 'drafts') {
        newRel = `${proj}/${DRAFTS_DIR}/${path.basename(e.file)}`;
      } else if (fromKind === 'archive') {
        newRel = `${proj}/${ARCHIVE_DIR}/${path.basename(e.file)}`;
      } else {
        newRel = workRelPath({ project: proj, sub: subRel, stem, ext });
      }
      const newAbs = path.join(dir, e.category, newRel);
      if (newAbs === oldAbs) { skipped.push({ title: stem, file: e.file, reason: '已经在目标位置' }); continue; }

      let finalRel = newRel;
      if (fs.existsSync(newAbs)) {
        if (mode === 'skip') {
          skipped.push({ title: stem, file: e.file, reason: `目标已有同名：${newRel}（想换掉它就用 onConflict="overwrite"）` });
          continue;
        }
        if (mode === 'rename') {
          finalRel = uniqueNameIn(dir, e.category, newRel);
        } else {
          // overwrite：挡路的那份先收进归档（它是别人的稿子，不能直接删）
          const seat = rows.find((x) => x !== e && x.category === e.category && x.file === newRel && hasFile(dir, x));
          const archProj = proj || seat?.project || '';
          try {
            const rel = moveToArchive(dir, e.category, newRel, now, archProj, { keepName: true });
            if (seat) { seat.file = rel; fixFlags(seat, now); seat.archivedAt = nowIso(now); }
            overwritten.push({ title: stem, category: e.category, file: rel, was: newRel, seat: Boolean(seat) });
          } catch (err) {
            skipped.push({ title: stem, file: e.file, reason: `要覆盖的那份挪不进归档：${err?.message ?? err}` });
            continue;
          }
        }
      }

      try {
        const destAbs = path.join(dir, e.category, finalRel);
        fs.mkdirSync(path.dirname(destAbs), { recursive: true });
        fs.renameSync(oldAbs, destAbs);
        const before = e.file;
        e.file = finalRel;
        if (toKind === 'root') { delete e.project; delete e.sub; } else { e.project = proj; if (subRel) e.sub = subRel; else delete e.sub; }
        fixFlags(e, now);
        e.movedAt = nowIso(now);
        moved.push({
          title: stem, category: e.category, from: before, to: finalRel,
          ...(finalRel !== newRel ? { renamed: true } : {}),
        });
      } catch (err) {
        skipped.push({ title: stem, file: e.file, reason: `搬不动：${err?.message ?? err}` });
      }
    }
  }

  if (moved.length) rewriteIndex(dir, rows);
  return {
    moved: moved.length,
    skipped: skipped.length,
    missing: missing.length,
    overwritten: overwritten.length,
    onConflict: mode,
    items: moved,
    skippedItems: skipped,
    missingItems: missing,
    overwrittenItems: overwritten,
  };
}

/** 统计（给设置页 / 提示行用）。一律按路径分类。 */
export function statsWorks(dir) {
  const r = listWorks(dir, { limit: 200 });
  const rows = readIndex(dir).filter((e) => hasFile(dir, e));
  const { rows: uniq } = dedupeByFile(rows);
  const versions = uniq.filter((e) => rowKind(e) === 'archive' && !e.archivedDraft).length;
  const drafts = uniq.filter((e) => rowKind(e) === 'draft').length;
  const projects = new Set(uniq.filter((e) => e.project).map((e) => `${e.category}/${e.project}`));
  return {
    dir,
    total: r.total,
    text: r.byCat.text || 0,
    image: r.byCat.image || 0,
    versions,
    drafts,
    projects: projects.size,
    loose: uniq.filter((e) => rowKind(e) === 'work' && !e.project).length,
    latest: r.items[0] ? { title: r.items[0].title, category: r.items[0].category, created: r.items[0].created } : null,
  };
}

/**
 * 草稿清理（2026-11-22 她的第一件事）。
 * 「把项目 drafts 里的旧草稿一键挪去归档，或者按『每回只留最新几版』清掉」
 *
 * 每个标题**只留最新 keep 版**在 drafts/ 里，其余挪进该项目的 archive/
 * （文件名沿用草稿自带的 @时间戳，不再叠一层），索引里打 archivedDraft —— **不删**。
 *   keep = 0   → 这个标题的草稿全收走
 *   project    → 必填（草稿箱是项目级的）
 *   title      → 可选，只清一个标题
 *   preview    → true 时只报数，不动文件
 */
export function cleanDrafts(dir, { project, title, category, keep = 2, preview = false, now = Date.now() } = {}) {
  ensureDir(dir);
  const proj = project === undefined || project === null ? '' : String(project).trim();
  const cat = category ? normalizeCategory(category, null) : '';
  const stem = title ? sanitizeTitle(title) : '';
  const keepN = Math.max(0, Math.min(100, Math.floor(Number(keep) || 0)));
  const rows = readIndex(dir);
  const pool = rows
    .filter((e) => rowKind(e) === 'draft')
    .filter((e) => (cat ? e.category === cat : true))
    .filter((e) => (stem ? e.title === stem : true))
    .filter((e) => (e.project || '') === (proj ? sanitizeProject(proj) : ''))
    .filter((e) => hasFile(dir, e));

  const byTitle = new Map();
  for (const e of pool) {
    const key = `${e.category}/${e.title}`;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(e);
  }
  const plan = [];
  for (const group of byTitle.values()) {
    // 和 listDrafts 同一个顺序：seq 优先（同一秒多版也分得清），再时间
    group.sort((a, b) => (Number(b.seq) || 0) - (Number(a.seq) || 0)
      || String(b.created ?? '').localeCompare(String(a.created ?? ''))
      || String(b.file).localeCompare(String(a.file)));
    plan.push(...group.slice(keepN));
  }

  const items = plan.map((e) => ({
    title: e.title, category: e.category, file: e.file, created: e.created, project: e.project || '',
  }));
  if (preview) {
    return { preview: true, keep: keepN, titles: byTitle.size, kept: pool.length - plan.length, archived: 0, wouldArchive: plan.length, items };
  }

  let done = 0;
  const failed = [];
  for (const e of plan) {
    try {
      const rel = moveToArchive(dir, e.category, e.file, now, e.project || '', { keepName: true });
      e.file = rel;
      fixFlags(e, now);           // 路径进了 archive/ → 标记跟着变成历史
      e.archivedDraft = true;     // 但要认得出「这是旧草稿」，不算作品的版本
      e.archivedAt = nowIso(now);
      done += 1;
    } catch (err) {
      failed.push({ file: e.file, reason: String(err?.message ?? err) });
    }
  }
  if (done) rewriteIndex(dir, rows);
  return {
    preview: false, keep: keepN, titles: byTitle.size,
    kept: pool.length - done, archived: done, items: items.slice(0, done), failed,
  };
}

/**
 * 总览（2026-11-22 她的第四件事）：一条命令看完——
 * 项目、子分类、草稿、归档各多少件，最近动过哪几件，索引有没有对不上的账。
 */
export function overviewWorks(dir, { recent = 6 } = {}) {
  ensureDir(dir);
  const all = readIndex(dir);
  const live = all.filter((e) => hasFile(dir, e));
  const { rows: uniq, dropped } = dedupeByFile(live);

  const totals = { records: all.length, live: uniq.length, work: 0, draft: 0, archive: 0, oldDraft: 0, text: 0, image: 0 };
  for (const e of uniq) {
    totals[rowKind(e)] += 1;
    if (e.archivedDraft) totals.oldDraft += 1;
    totals[e.category] = (totals[e.category] || 0) + 1;
  }

  const buckets = new Map();
  const bucketOf = (category, name) => {
    const key = `${category}/${name}`;
    if (!buckets.has(key)) {
      buckets.set(key, { name, category, registered: false, work: 0, draft: 0, archive: 0, oldDraft: 0, subs: new Map() });
    }
    return buckets.get(key);
  };
  // 空项目 / 空子分类也要列出来（扫一遍磁盘，不然"还有哪些格子"看不全）
  for (const p of listProjects(dir)) {
    const b = bucketOf(p.category, p.name);
    b.registered = !p.unregistered;
    for (const sd of p.subdirs || []) if (!b.subs.has(sd)) b.subs.set(sd, 0);
  }
  for (const e of uniq) {
    const b = bucketOf(e.category, e.project || '');
    const kindOf = rowKind(e);
    b[kindOf] += 1;
    if (e.archivedDraft) b.oldDraft += 1;
    if (kindOf === 'work') {
      const s = e.sub || subFromFile(e.file, e.project || '') || '';
      b.subs.set(s, (b.subs.get(s) || 0) + 1);
    }
  }

  // 最近动过：索引里的时间戳 + 文件 mtime（她手改文件也算动过）
  const touchedAt = (e) => {
    let t = String(e.movedAt || e.archivedAt || e.created || '');
    try {
      const s = nowIso(fs.statSync(path.join(dir, e.category, e.file)).mtimeMs);
      if (s > t) t = s;
    } catch { /* 文件刚没了就算了 */ }
    return t;
  };
  const maxRecent = Math.max(1, Math.min(20, Number(recent) || 6));
  const recentList = uniq
    .map((e) => ({ e, at: touchedAt(e) }))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, maxRecent)
    .map(({ e, at }) => ({
      title: e.title,
      category: e.category,
      project: e.project || '',
      sub: e.sub || (rowKind(e) === 'work' ? subFromFile(e.file, e.project || '') : ''),
      kind: rowKind(e),
      oldDraft: Boolean(e.archivedDraft),
      at,
      file: e.file,
    }));

  return {
    dir,
    totals,
    projects: [...buckets.values()]
      .map((b) => ({
        name: b.name,
        category: b.category,
        registered: b.registered,
        work: b.work,
        draft: b.draft,
        archive: b.archive,
        oldDraft: b.oldDraft,
        subdirs: [...b.subs].map(([name, work]) => ({ name, work }))
          .sort((x, y) => y.work - x.work || String(x.name).localeCompare(String(y.name))),
      }))
      .sort((a, b) => String(a.category).localeCompare(String(b.category)) || b.work - a.work),
    loose: uniq.filter((e) => rowKind(e) === 'work' && !e.project).length,
    recent: recentList,
    issues: {
      missing: all.length - live.length,
      duplicated: dropped.length,
      mismarked: uniq.filter(flagDiffers).length,
      orphans: scanOrphans(dir, all).length,
    },
  };
}

/** 对账：索引进和磁盘对不上的地方（只读）。 */
export function checkWorks(dir) {
  ensureDir(dir);
  const all = readIndex(dir);
  const live = all.filter((e) => hasFile(dir, e));
  const missing = all.filter((e) => !hasFile(dir, e))
    .map((e) => ({ title: e.title, category: e.category, file: e.file, created: e.created }));
  const { dropped } = dedupeByFile(live);
  const duplicated = dropped.map((e) => ({ title: e.title, category: e.category, file: e.file, created: e.created }));
  const mismarked = live.filter(flagDiffers).map((e) => ({
    title: e.title, category: e.category, file: e.file, kind: rowKind(e),
    flags: { draft: Boolean(e.draft), archived: Boolean(e.archived), archivedDraft: Boolean(e.archivedDraft) },
  }));
  const orphans = scanOrphans(dir, all);
  return {
    ok: !missing.length && !duplicated.length && !mismarked.length && !orphans.length,
    total: all.length,
    missing: missing.length,
    duplicated: duplicated.length,
    mismarked: mismarked.length,
    orphans: orphans.length,
    items: { missing, duplicated, mismarked, orphans },
  };
}

/**
 * 修账（要显式要才跑）：删掉「文件已经不在了」和「同一文件重复」的记录，
 * 把 draft/archived 标记改回和路径一致，并把**磁盘上有、索引里没有**的文件补成记录。
 * **不动任何文件**。
 */
export function repairWorks(dir, { now = Date.now() } = {}) {
  ensureDir(dir);
  const all = readIndex(dir);
  const seen = new Set();
  const kept = [];
  const removed = [];
  let fixed = 0;
  // 新的在前，重复时留最新的那条；最后 reverse 回「老的在前」的原始顺序
  const sorted = [...all].sort((a, b) => String(b.created ?? '').localeCompare(String(a.created ?? '')));
  for (const e of sorted) {
    if (!hasFile(dir, e)) { removed.push({ title: e.title, category: e.category, file: e.file, reason: '文件不在了' }); continue; }
    const key = `${e.category}/${e.file}`;
    if (seen.has(key)) { removed.push({ title: e.title, category: e.category, file: e.file, reason: '同一文件有更新的记录' }); continue; }
    seen.add(key);
    if (fixFlags(e, now)) fixed += 1;
    kept.push(e);
  }
  kept.reverse();
  const adopted = [];
  for (const o of scanOrphans(dir, kept)) {
    const row = rowFromFile(dir, o.category, o.file, now);
    kept.push(row);
    adopted.push({ title: row.title, category: row.category, file: row.file });
  }
  if (removed.length || fixed || adopted.length) rewriteIndex(dir, kept);
  return { removed: removed.length, fixed, adopted: adopted.length, kept: kept.length, removedItems: removed, adoptedItems: adopted, dir };
}

/** 注入用的一行提示（很短，别占地方）。 */
export function worksHint(dir) {
  try {
    const s = statsWorks(dir);
    if (!s.total) return '';
    const tail = s.latest ? `，最近「${s.latest.title}」` : '';
    const ver = s.versions ? `，历史版本 ${s.versions}` : '';
    const draftPart = s.drafts ? `，草稿 ${s.drafts}` : '';
    const projPart = s.projects ? `，${s.projects} 个项目` : '';
    const loosePart = s.loose ? `，${s.loose} 件没归项目` : '';
    return `【我的作品】${s.total} 件（文字 ${s.text} · 图片 ${s.image}${projPart}${tail}${ver}${draftPart}${loosePart}）`;
  } catch {
    return '';
  }
}
