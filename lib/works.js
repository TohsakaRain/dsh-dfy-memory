/**
 * lib/works.js —— 她的作品库
 * ============================================================================
 * 干什么：把她**认为是自己产出的东西**（一段文字、一张画）存下来，长期留存。
 *
 * 目录形状（英文命名，按类别分文件夹，文件名 = 作品标题）：
 *   <dataRoot>/works/
 *   ├── text/            文字作品（当前稿）  <标题>.md
 *   ├── text/archive/    文字作品的历史版本
 *   ├── image/           图片作品（当前稿）  <标题>.<png|jpg|webp>
 *   ├── image/archive/   图片作品的历史版本
 *   └── index.jsonl      索引（只追加，便于快速列表，不用扫盘）
 *
 * 归档（2026-11-07 加）：
 *   一个作品会被反复打磨，**旧稿不扔，进 archive/**。
 *   · 同名再存一次 → 旧稿自动挪进 archive/<标题>@<旧稿时间>.md，新稿成为当前稿
 *   · 也可以手动 dfy_work_archive 把当前稿收起来（暂时不想换新稿时）
 *   · 归档文件带 @时间戳，同一个标题能攒很多版，按时间排就是它的修改史
 *
 * 设计约束：
 *   · **当前稿不覆盖**：同名不是覆盖，是"旧稿归档、新稿接位"。
 *   · **路径锁死**：标题经 sanitize 后只能是文件名，任何 ../ 都被吃掉，落点必须在本目录内。
 *   · **分类白名单**：只允许 text / image 两类，避免被写成任意目录。
 *   · 图片只**复制**，不动源文件（源通常是出图目录里的文件）。
 */
import fs from 'node:fs';
import path from 'node:path';

export const CATEGORIES = ['text', 'image'];
export const ARCHIVE_DIR = 'archive';
export const DRAFTS_DIR = 'drafts';

const TEXT_EXT = '.md';
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_TITLE_CHARS = 80;
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

function normalizeCategory(raw, fallback) {
  const c = String(raw ?? '').trim().toLowerCase();
  if (!c) return fallback;
  if (!CATEGORIES.includes(c)) {
    throw new Error(`分类只能是 ${CATEGORIES.join(' / ')}（收到 "${raw}"）`);
  }
  return c;
}

/** 把一件作品的文件挪进 archive/，返回相对路径（archive/xxx）。 */
export function moveToArchive(dir, category, file, now = Date.now()) {
  const ad = path.join(dir, category, ARCHIVE_DIR);
  fs.mkdirSync(ad, { recursive: true });
  const ext = path.extname(file);
  const stem = path.basename(file, ext);
  let name = `${stem}@${stamp(now)}${ext}`;
  let n = 2;
  while (fs.existsSync(path.join(ad, name))) {
    name = `${stem}@${stamp(now)}-${n}${ext}`;
    n += 1;
    if (n > 200) throw new Error('同名归档太多了');
  }
  fs.renameSync(path.join(dir, category, file), path.join(ad, name));
  return `${ARCHIVE_DIR}/${name}`;
}

/** 当前稿列表（不含归档）。 */
function currentRows(dir, category, stem) {
  return readIndex(dir).filter((e) => e.category === category
    && e.title === stem
    && !e.archived
    && fs.existsSync(path.join(dir, category, e.file)));
}

/**
 * 存一件作品：同名旧稿先归档，新稿接位。
 * write(targetPath) 负责真正写文件。
 */
function promote(dir, { category, stem, ext, now, write, base }) {
  ensureDir(dir);
  const catDir = path.join(dir, category);
  const rows = readIndex(dir);

  // 同名当前稿 → 挪进 archive，并在索引里标成 archived
  const olds = rows.filter((e) => e.category === category && e.title === stem && !e.archived
    && fs.existsSync(path.join(catDir, e.file)));
  for (const e of olds) {
    try {
      const rel = moveToArchive(dir, category, e.file, now);
      e.file = rel;
      e.archived = true;
      e.archivedAt = nowIso(now);
    } catch { /* 挪不动就让它留在原处，别把新稿也搞失败 */ }
  }

  const target = path.join(catDir, `${stem}${ext}`);
  write(target);

  const entry = {
    id: `w_${now}_${Math.random().toString(36).slice(2, 7)}`,
    title: stem,
    category,
    file: path.basename(target),
    created: nowIso(now),
    ...base,
  };
  rewriteIndex(dir, [...rows, entry]);
  return { ...entry, path: target, archivedOld: olds.length };
}

/** 存一段文字作品。 */
export function saveTextWork(dir, { title, text, tags = [], now = Date.now() } = {}) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('作品正文是空的，没东西可存');
  if (body.length > MAX_TEXT_CHARS) throw new Error(`太长了（${body.length} 字），上限 ${MAX_TEXT_CHARS}`);

  const stem = sanitizeTitle(title);
  const created = nowIso(now);
  const tagLine = Array.isArray(tags) && tags.length ? `tags: ${tags.join(', ')}\n` : '';
  const doc = `---\ntitle: ${stem}\ncategory: text\ncreated: ${created}\n${tagLine}---\n\n${body}\n`;

  const r = promote(dir, {
    category: 'text', stem, ext: TEXT_EXT, now,
    write: (target) => fs.writeFileSync(target, doc, 'utf8'),
    base: { bytes: Buffer.byteLength(doc, 'utf8'), chars: body.length },
  });
  return r;
}

/** 存一张图片作品（复制源文件，不动源）。 */
export function saveImageWork(dir, { title, source, now = Date.now() } = {}) {
  const src = path.resolve(String(source ?? ''));
  let st;
  try { st = fs.statSync(src); } catch { throw new Error(`找不到这个文件：${src}`); }
  if (!st.isFile()) throw new Error('不是文件：' + src);
  if (st.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片太大（${(st.size / 1048576).toFixed(1)} MB），上限 ${MAX_IMAGE_BYTES / 1048576} MB`);
  }
  const ext = path.extname(src).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) throw new Error(`只支持 ${[...IMAGE_EXTS].join(' / ')}，收到 "${ext || '(无扩展名)'}"`);

  const stem = sanitizeTitle(title);
  const r = promote(dir, {
    category: 'image', stem, ext, now,
    write: (target) => fs.copyFileSync(src, target),
    base: { bytes: st.size, source: src },
  });
  return r;
}

/** 手动把当前稿收进归档（不想换新稿、只是想留一份的时候用）。 */
export function archiveWork(dir, { title, category, now = Date.now() } = {}) {
  ensureDir(dir);
  const stem = sanitizeTitle(title);
  const cat = category ? normalizeCategory(category, null) : '';
  const rows = readIndex(dir);
  const targets = rows.filter((e) => e.title === stem
    && (cat ? e.category === cat : true)
    && !e.archived
    && fs.existsSync(path.join(dir, e.category, e.file)));
  if (!targets.length) return { archived: 0, items: [] };

  const out = [];
  for (const e of targets) {
    try {
      const rel = moveToArchive(dir, e.category, e.file, now);
      e.file = rel;
      e.archived = true;
      e.archivedAt = nowIso(now);
      out.push({ title: e.title, category: e.category, file: rel });
    } catch { /* 单个失败不影响其它 */ }
  }
  rewriteIndex(dir, rows);
  return { archived: out.length, items: out };
}

/**
 * 草稿（2026-11-07 加）：大纲、随手记、试画都放这儿。
 *   <cat>/drafts/<标题>@<时间>.<ext>        每一版草稿一个文件，不覆盖
 *   <cat>/drafts/archive/                    定稿之后，草稿挪到这里留底
 *
 * 为什么要单独一层：草稿是"还没成形的东西"，不该混在定稿里数件数，
 * 也不该占 archive（archive 是"成品的旧版本"）。作品从草稿里长出来。
 */
export function saveDraft(dir, { title, text, source, category = 'text', now = Date.now() } = {}) {
  ensureDir(dir);
  const cat = normalizeCategory(category, 'text');
  const stem = sanitizeTitle(title);
  const dDir = path.join(dir, cat, DRAFTS_DIR);
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
    fs.writeFileSync(target, `---\ntitle: ${stem}\ncategory: text\ndraft: true\ncreated: ${created}\n---\n\n${String(text).trim()}\n`, 'utf8');
  } else {
    fs.copyFileSync(path.resolve(String(source)), target);
  }

  const entry = {
    id: `w_${now}_${Math.random().toString(36).slice(2, 7)}`,
    title: stem, category: cat, file: `${DRAFTS_DIR}/${name}`,
    created: nowIso(now), draft: true,
    seq: readIndex(dir).length,   // 自增序号：同一秒存多版时靠它定先后
  };
  appendIndex(dir, entry);
  return { ...entry, path: target };
}

/** 列草稿（默认全部，可按标题过滤）。 */
export function listDrafts(dir, { title, category, limit = 30 } = {}) {
  ensureDir(dir);
  const cat = category ? normalizeCategory(category, null) : '';
  const stem = title ? sanitizeTitle(title) : '';
  const rows = readIndex(dir)
    .filter((e) => e.draft)
    .filter((e) => (cat ? e.category === cat : true))
    .filter((e) => (stem ? e.title === stem : true))
    .filter((e) => fs.existsSync(path.join(dir, e.category, e.file)))
    // 先按自增序号（同一秒多版也分得清先后），再按时间
    .sort((a, b) => (Number(b.seq) || 0) - (Number(a.seq) || 0)
      || String(b.created).localeCompare(String(a.created))
      || String(b.file).localeCompare(String(a.file)));
  const max = Math.max(1, Math.min(200, Number(limit) || 30));
  return { total: rows.length, items: rows.slice(0, max) };
}

/** 读最新一版草稿。 */
export function readDraft(dir, { title, category = 'text' } = {}) {
  const r = listDrafts(dir, { title, category, limit: 1 });
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
 * · 这个标题下的草稿全部挪进 <cat>/drafts/archive/ 留底
 */
export function finalizeDraft(dir, { title, category = 'text', now = Date.now() } = {}) {
  ensureDir(dir);
  const cat = normalizeCategory(category, 'text');
  const stem = sanitizeTitle(title);
  const drafts = listDrafts(dir, { title: stem, category: cat, limit: 200 });
  if (!drafts.items.length) return { finalized: false, reason: '这个标题下没有草稿' };

  const picked = drafts.items[0];
  const pickedPath = path.join(dir, cat, picked.file);
  let work;
  if (cat === 'text') {
    const raw = fs.readFileSync(pickedPath, 'utf8');
    const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    work = saveTextWork(dir, { title: stem, text: body, now });
  } else {
    work = saveImageWork(dir, { title: stem, source: pickedPath, now });
  }

  // 草稿箱就是草稿：定稿只是"从它长出一件作品"，草稿本身**不搬家、不删**。
  // （2026-11-07 改：原先会把草稿挪进 drafts/archive，那样草稿箱里套了个归档层，
  //   读起来像还有第二个作品库。现在草稿永远留在 drafts/ 里，想看就列出来。）
  return { finalized: true, work, draftsKept: drafts.total };
}


/**
 * 把某个历史版本**拿回来当当前稿**（2026-11-07 加，和 archiveWork 对称）。
 * 当前稿若存在，先自动归档，再把指定版本搬回来，文件名回到 <标题>.<ext>。
 * 不指定 file 就取最新的那个历史版本。
 */
export function restoreWork(dir, { title, category, file, now = Date.now() } = {}) {
  ensureDir(dir);
  const stem = sanitizeTitle(title);
  const cat = category ? normalizeCategory(category, null) : '';
  const rows = readIndex(dir);

  const archived = rows
    .filter((e) => e.archived && e.title === stem && (cat ? e.category === cat : true))
    .filter((e) => fs.existsSync(path.join(dir, e.category, e.file)))
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
  const olds = rows.filter((e) => e.category === pick.category && e.title === stem && !e.archived
    && fs.existsSync(path.join(dir, e.category, e.file)));
  for (const e of olds) {
    try {
      const rel = moveToArchive(dir, pick.category, e.file, now);
      e.file = rel;
      e.archived = true;
      e.archivedAt = nowIso(now);
    } catch { /* 挪不动就留着 */ }
  }

  // 把选中的历史版本搬回当前
  const ext = path.extname(pick.file);
  const target = path.join(dir, pick.category, stem + ext);
  try {
    fs.renameSync(path.join(dir, pick.category, pick.file), target);
  } catch (e) {
    return { restored: 0, reason: '搬不回来：' + (e?.message ?? e) };
  }
  pick.file = path.basename(target);
  pick.archived = false;
  delete pick.archivedAt;
  pick.created = nowIso(now);
  rewriteIndex(dir, rows);

  return { restored: 1, title: stem, category: pick.category, file: pick.file, path: target, archivedOld: olds.length };
}

/** 看某个作品的历史版本（归档里的），新的在前。 */
export function listVersions(dir, { title, category } = {}) {
  ensureDir(dir);
  const stem = sanitizeTitle(title);
  const cat = category ? normalizeCategory(category, null) : '';
  const rows = readIndex(dir)
    .filter((e) => e.archived && e.title === stem && (cat ? e.category === cat : true))
    .sort((a, b) => String(b.archivedAt ?? b.created).localeCompare(String(a.archivedAt ?? a.created)));
  return rows.filter((e) => fs.existsSync(path.join(dir, e.category, e.file)));
}

/** 列表：按分类/条数过滤，最新在前（默认不含归档）。 */
export function listWorks(dir, { category, limit = 30, includeArchived = false } = {}) {
  ensureDir(dir);
  const cat = category ? normalizeCategory(category, null) : '';
  const rows = readIndex(dir)
    .filter((e) => (cat ? e.category === cat : true))
    .filter((e) => !e.draft)                    // 草稿不算作品
    .filter((e) => includeArchived || !e.archived)
    .filter((e) => {
      // 索引可能比磁盘旧（手动删过文件）：以磁盘为准
      try { return fs.existsSync(path.join(dir, e.category, e.file)); } catch { return false; }
    })
    .sort((a, b) => String(b.created).localeCompare(String(a.created)));
  const max = Math.max(1, Math.min(200, Number(limit) || 30));
  const byCat = {};
  for (const e of rows) byCat[e.category] = (byCat[e.category] || 0) + 1;
  return { total: rows.length, byCat, items: rows.slice(0, max), dir };
}

/** 读一件作品：文字返回内容，图片返回路径（不返回二进制）。 */
export function readWork(dir, { title, category, file } = {}) {
  ensureDir(dir);
  const rows = readIndex(dir);
  let hit = null;
  if (file) {
    const base = path.basename(String(file));
    hit = rows.find((e) => e.file === base || path.basename(e.file) === base);
  } else if (title) {
    const t = sanitizeTitle(title);
    const cat = category ? normalizeCategory(category, null) : '';
    hit = rows
      .filter((e) => e.title === t && (cat ? e.category === cat : true))
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

/** 统计（给设置页 / 提示行用）。 */
export function statsWorks(dir) {
  const r = listWorks(dir, { limit: 200 });
  const versions = readIndex(dir).filter((e) => e.archived && !e.draft).length;
  const drafts = readIndex(dir).filter((e) => e.draft && !e.archivedDraft
    && fs.existsSync(path.join(dir, e.category, e.file))).length;
  return {
    dir,
    total: r.total,
    text: r.byCat.text || 0,
    image: r.byCat.image || 0,
    versions,
    drafts,
    latest: r.items[0] ? { title: r.items[0].title, category: r.items[0].category, created: r.items[0].created } : null,
  };
}

/** 注入用的一行提示（很短，别占地方）。 */
export function worksHint(dir) {
  try {
    const s = statsWorks(dir);
    if (!s.total) return '';
    const tail = s.latest ? `，最近「${s.latest.title}」` : '';
    const ver = s.versions ? `，历史版本 ${s.versions}` : '';
    const draftPart = s.drafts ? `，草稿 ${s.drafts}` : '';
    return `【我的作品】${s.total} 件（文字 ${s.text} · 图片 ${s.image}${tail}${ver}${draftPart}）`;
  } catch {
    return '';
  }
}

