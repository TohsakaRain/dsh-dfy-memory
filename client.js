/**
 * dsh-dfy-memory —— 浏览器半端：「设置 → 大肥鱼记忆」那一页
 * ============================================================================
 * ⭐ client bundle **不是 ESM，是自注册脚本**：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                          // 必须等于 package.json 的 name
 *       factory: (require) => ({ apply(ctx) {...} }),
 *     })
 *
 * ⚠️ 2026-11-22：这个文件一直存在，但**从来没被加载过** —— 因为
 *    package.json 里没有 `dsh.client` 声明。宿主的扫描（dsh-client-modules
 *    的 resolveMeta）对「没有 dsh.client 的包」直接跳过，所以界面上那一页
 *    压根不存在。补上 `dsh.client = { platform: 'web', inject: [...] }` 才会
 *    进浏览器；改这一项要**重启 DSH**（包清单只在启动时读一次）。
 *
 * ⭐ 怎么进设置页左侧导航（别自己糊按钮 + overlay）：
 *
 *     slots.inject('settings.section', () => slots.register(
 *       { name: 'settings.section', id: 'dfy-memory', order: 45, label: '大肥鱼记忆' },
 *       () => h(Panel),
 *     ))
 *
 * 页面结构（2026-11-22 改版）：一个页面里分三个 tab
 *     大肥鱼状态 | 数据目录 | 介绍
 * 刷新放在最上边。工具开关已删除（新装就是最新版，没有历史包袱要切）。
 * 文案一律简短——详细说明在 README / plan 文档里，这里不重复。
 * ============================================================================
 */
// ⭐ 兜底：没有 __ModuleLoader__ 就安静跳过 —— 客户端加载失败绝不该拖垮整个 Web 端
if (typeof window === 'undefined' || !window.__ModuleLoader__?.load) {
  try { console.warn('[dsh-dfy-memory] 缺少 window.__ModuleLoader__，客户端插件已跳过'); } catch { /* 忽略 */ }
} else window.__ModuleLoader__.load({
  id: 'dsh-dfy-memory',
  factory: (require) => {
    let React = null;
    try { React = require('react'); } catch (e) {
      try { console.warn('[dsh-dfy-memory] 拿不到 react，设置页跳过'); } catch { /* 忽略 */ }
      return { apply() {} };
    }
    const h = React.createElement;

    const API = '/api/dfy-memory';

    const asJson = async (res) => {
      if (res.ok) return res.json();
      let detail = '';
      try {
        const body = await res.json();
        detail = body?.error ? `：${body.error}` : '';
      } catch { /* 没有 JSON 就算了 */ }
      const why = res.status === 403 ? '（被宿主拦了）' : res.status === 404 ? '（端点没挂上）' : '';
      throw new Error(`HTTP ${res.status}${why}${detail}`);
    };
    const jget = (p) => fetch(API + p, { headers: { accept: 'application/json' } }).then(asJson);
    const jpost = (p, body) => fetch(API + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(asJson);

    const MONO = 'ui-monospace, Consolas, monospace';

    const S = {
      card: {
        border: '1px solid var(--dsw-border, rgba(127,127,127,.25))',
        borderRadius: 10,
        padding: '12px 14px',
        marginBottom: 10,
      },
      label: { fontSize: 12, opacity: 0.65, marginBottom: 4 },
      big: { fontSize: 17, fontWeight: 600 },
      row: { display: 'flex', gap: 18, flexWrap: 'wrap' },
      meta: { fontSize: 12, opacity: 0.7, lineHeight: 1.7 },
      btn: {
        padding: '6px 12px', borderRadius: 7, cursor: 'pointer',
        border: '1px solid var(--dsw-border, rgba(127,127,127,.35))',
        background: 'transparent', color: 'inherit', font: 'inherit',
      },
      btnPrimary: {
        padding: '6px 12px', borderRadius: 7, cursor: 'pointer',
        border: '1px solid #3b82f6', background: 'rgba(59,130,246,.14)',
        color: 'inherit', font: 'inherit', fontWeight: 600,
      },
      btnTiny: {
        padding: '2px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 11,
        border: '1px solid var(--dsw-border, rgba(127,127,127,.35))',
        background: 'transparent', color: 'inherit', font: 'inherit',
      },
      tab: {
        padding: '5px 12px', borderRadius: 7, cursor: 'pointer', fontSize: 13,
        border: '1px solid transparent', background: 'transparent',
        color: 'inherit', opacity: 0.62, font: 'inherit',
      },
      tabOn: {
        padding: '5px 12px', borderRadius: 7, cursor: 'pointer', fontSize: 13, fontWeight: 600,
        border: '1px solid var(--dsw-border, rgba(127,127,127,.35))',
        background: 'rgba(127,127,127,.12)', color: 'inherit', font: 'inherit',
      },
      input: {
        flex: '1 1 320px', minWidth: 220, padding: '6px 9px', borderRadius: 7,
        border: '1px solid var(--dsw-border, rgba(127,127,127,.35))',
        background: 'transparent', color: 'inherit',
        font: 'inherit', fontFamily: MONO, fontSize: 12,
      },
      err: { color: '#dc2626', fontSize: 12, lineHeight: 1.6 },
      ok: { color: '#16a34a', fontSize: 12, lineHeight: 1.6 },
      warn: { color: '#d97706', fontSize: 12, lineHeight: 1.6 },
      code: { fontFamily: MONO, fontSize: 11, opacity: 0.85, wordBreak: 'break-all' },
      box: {
        marginTop: 10, padding: '10px 12px', borderRadius: 8,
        border: '1px dashed var(--dsw-border, rgba(127,127,127,.35))',
      },
      dirItem: {
        display: 'inline-block', padding: '3px 10px', margin: '0 6px 6px 0',
        borderRadius: 6, cursor: 'pointer', fontSize: 12,
        border: '1px solid var(--dsw-border, rgba(127,127,127,.3))',
      },
      kv: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', fontSize: 12, lineHeight: 1.9, alignItems: 'center' },
      kt: { opacity: 0.6 },
      h3: { fontSize: 13, fontWeight: 600, margin: '0 0 6px', opacity: 0.85 },
      p: { fontSize: 12.5, lineHeight: 1.8, margin: '0 0 10px', opacity: 0.85 },
    };

    const TABS = [
      ['status', '大肥鱼状态'],
      ['dir', '数据目录'],
      ['tuning', '记忆参数'],
      ['about', '介绍'],
    ];

    const SOURCE_LABEL = {
      env: '环境变量 DFY_DATA_DIR（压过所有设置）',
      config: '插件配置',
      default: '默认值（没配）',
    };

    /** 拼子目录：盘符根（D:\）后面不要再加斜杠。 */
    const joinPath = (base, name) => {
      const b = String(base || '');
      if (!b) return name;
      return b.endsWith('\\') || b.endsWith('/') ? `${b}${name}` : `${b}\\${name}`;
    };

    function probeText(probe) {
      if (!probe || !probe.path) return '';
      if (!probe.exists) return '不存在（保存时新建）';
      if (!probe.isDir) return '是个文件，不能当目录';
      const bits = [];
      if (!probe.writable) bits.push('⚠️ 不可写');
      const subs = Object.keys(probe.subdirs || {}).filter((k) => probe.subdirs[k]);
      if (subs.length) bits.push(`已有 ${subs.join(' / ')}`);
      if (typeof probe.memoryTotal === 'number') bits.push(`记忆 ${probe.memoryTotal} 条`);
      if (probe.diaryDays) bits.push(`日记 ${probe.diaryDays} 天`);
      if (!bits.length) bits.push('空目录');
      return bits.join(' · ');
    }

    const Stat = (props) => h('div', { style: S.card },
      h('div', { style: S.label }, props.label),
      h('div', { style: S.big }, props.value === undefined || props.value === null || props.value === '' ? '—' : String(props.value)),
      props.hint ? h('div', { style: S.meta }, props.hint) : null);

    function Panel() {
      const [tab, setTab] = React.useState('status');
      const [state, setState] = React.useState(null);
      const [info, setInfo] = React.useState(null);
      const [draft, setDraft] = React.useState('');
      const [probe, setProbe] = React.useState(null);
      const [err, setErr] = React.useState('');
      const [msg, setMsg] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [browse, setBrowse] = React.useState(null); // null = 关着
      // 放在最后：前面那些 hook 的位置要稳定（别打乱既有 state 顺序）
      const [tune, setTune] = React.useState(null);
      const [tuneDraft, setTuneDraft] = React.useState({});
      const [tuneBusy, setTuneBusy] = React.useState(false);

      const load = React.useCallback(async () => {
        setErr('');
        try {
          const [s, pi] = await Promise.all([jget('/state'), jget('/paths')]);
          setState(s);
          setInfo(pi);
          setDraft((prev) => (prev ? prev : (pi?.dataRoot || '')));
        } catch (e) {
          setErr(String(e?.message ?? e));
        }
      }, []);

      React.useEffect(() => { load(); }, [load]);

      const flash = (text) => { setMsg(text); setTimeout(() => setMsg(''), 6000); };

      /* ── 数据目录行为 ─────────────────────────────────────────── */

      const checkDraft = async () => {
        setBusy(true); setErr(''); setProbe(null);
        try {
          const r = await jget(`/paths?probe=${encodeURIComponent(draft.trim())}`);
          setProbe(r?.probe?.candidate || null);
          setInfo(r);
        } catch (e) {
          setErr(String(e?.message ?? e));
        } finally { setBusy(false); }
      };

      /**
       * 改完目录插件会自己重启；这里轮询到「真读到新根目录」再收工，
       * 不让使用者自己去点刷新。
       */
      const waitForRoot = async (want) => {
        const target = String(want || '').toLowerCase();
        for (let i = 0; i < 20; i += 1) {
          await new Promise((r) => { setTimeout(r, 800); });
          try {
            const pi = await jget('/paths');
            if (String(pi?.dataRoot || '').toLowerCase() === target) {
              setInfo(pi);
              setDraft(pi.dataRoot);
              setProbe(null);
              try { setState(await jget('/state')); } catch { /* 状态稍后再说 */ }
              return true;
            }
          } catch { /* 插件正在重启，接口短暂不可用，继续等 */ }
        }
        try { await load(); } catch { /* 忽略 */ }
        return false;
      };

      const saveDraft = async (value) => {
        const next = String(value ?? draft).trim();
        if (!next) { setErr('先填一个目录，或者点「用默认位置」'); return; }
        setBusy(true); setMsg(''); setErr('');
        try {
          const r = await jpost('/paths', { dataRoot: next });
          const lines = [`已改成 ${r?.dataRoot || next}`, ...(r?.notes || [])];
          if (r?.bridge && r.bridge.ok === false) lines.push(`桥接那份没改：${r.bridge.reason}`);
          setMsg(lines.join('\n'));
          setProbe(null);
          const okNow = await waitForRoot(r?.dataRoot || next);
          flash(okNow
            ? `已切到 ${r?.dataRoot || next}${r?.move?.moved ? `，搬了 ${r.move.files} 个文件` : ''}`
            : lines.join('\n') + '\n\n（插件还在重启，过几秒这个页面会自动再读一次）');
        } catch (e) {
          setErr(String(e?.message ?? e));
        } finally { setBusy(false); }
      };

      const openDir = async (target) => {
        setErr('');
        try {
          await jpost('/open', { path: target });
          flash(`已打开 ${target}`);
        } catch (e) {
          setErr(String(e?.message ?? e));
        }
      };

      const openBrowse = async (at) => {
        const start = at || draft.trim() || info?.dataRoot || '';
        setBusy(true); setErr('');
        try {
          const r = await jget(`/fs?path=${encodeURIComponent(start)}`);
          setBrowse({ path: r?.path || '', parent: r?.parent || null, dirs: r?.dirs || [], drives: r?.drives || [], probe: r?.probe || null });
        } catch (e) {
          // 起点不可读就从盘符开始
          try {
            const r2 = await jget('/fs');
            setBrowse({ path: '', parent: null, dirs: [], drives: r2?.drives || [], probe: null });
          } catch (e2) {
            setErr(String(e2?.message ?? e2));
          }
        } finally { setBusy(false); }
      };

      const navTo = async (target) => {
        setBusy(true); setErr('');
        try {
          const r = await jget(`/fs?path=${encodeURIComponent(target)}`);
          setBrowse({ path: r?.path || '', parent: r?.parent || null, dirs: r?.dirs || [], drives: r?.drives || [], probe: r?.probe || null });
        } catch (e) {
          setErr(String(e?.message ?? e));
        } finally { setBusy(false); }
      };

      /* ── 记忆参数行为 ─────────────────────────────────────────── */

      const loadTuning = React.useCallback(async () => {
        setErr('');
        try {
          const t = await jget('/tuning');
          setTune(t);
          setTuneDraft(t?.values || {});
        } catch (e) {
          setErr(String(e?.message ?? e));
        }
      }, []);

      // 第一次切到「记忆参数」时才去读，别让打开页面就多打一次请求
      React.useEffect(() => { if (tab === 'tuning' && !tune) loadTuning(); }, [tab, tune, loadTuning]);

      const tuningPatch = () => {
        const cur = tune?.values || {};
        const out = {};
        for (const [k, v] of Object.entries(tuneDraft)) {
          if (v === '' || v === null || v === undefined) continue;
          if (String(cur[k]) !== String(v)) out[k] = v;
        }
        return out;
      };

      const tuningDirty = () => Object.keys(tuningPatch()).length > 0;

      const saveTuning = async () => {
        const patch = tuningPatch();
        if (!Object.keys(patch).length) { flash('没有改动'); return; }
        setTuneBusy(true); setErr(''); setMsg('');
        try {
          const r = await jpost('/tuning', { patch });
          setTune((t) => ({ ...(t || {}), ...r, values: r.values, fromFile: r.fromFile }));
          setTuneDraft(r.values || {});
          // memory.md 的头里印着"当前节奏"，后端保存后会顺手重写它；这里如实报出来
          const tail = r.syncExport?.ok
            ? `｜memory.md 已同步（${r.syncExport.entries} 条）`
            : (r.syncExport?.error ? `｜memory.md 没同步上：${r.syncExport.error}` : '');
          flash(`已保存 ${r.changed?.length || 0} 项${tail}`);
        } catch (e) {
          setErr(String(e?.message ?? e));
        } finally { setTuneBusy(false); }
      };

      /* ── 三个 tab 的内容 ──────────────────────────────────────── */

      const renderStatus = () => {
        const mem = state?.memory || {};
        const mood = state?.mood;
        const diary = state?.diary || {};
        const prom = state?.promises || {};
        const works = state?.works;
        const mail = state?.mail;
        return h('div', null,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: 8 } },
            h('button', { style: S.btn, disabled: busy, onClick: load }, busy ? '刷新中…' : '刷新')),
          h('div', { style: S.row },
            h(Stat, {
              label: '长期记忆',
              value: mem.total,
              hint: `core ${mem.core ?? 0} · important ${mem.important ?? 0} · normal ${mem.normal ?? 0}${mem.fading ? ` · 快淡忘 ${mem.fading}` : ''}`,
            }),
            h(Stat, {
              label: '现在的心情',
              value: mood ? (mood.faded ? '已经散了' : mood.tone) : '没什么特别',
              hint: mood ? `${mood.hours} 小时前${mood.cause ? ' · ' + mood.cause : ''}${mood.faded ? '' : ` · 强度 ${mood.effective}`}` : '',
            }),
            h(Stat, { label: '承诺', value: prom.total, hint: prom.due ? `到点未提醒 ${prom.due}` : '没有到点的' }),
            h(Stat, {
              label: '今天日记',
              value: diary.todaySections ? `${diary.todaySections} 段` : '还没写',
              hint: diary.lastDate ? `最近一次 ${diary.lastDate}` : '',
            }),
            h(Stat, {
              label: '作品库',
              value: works?.total,
              hint: works ? `草稿 ${works.drafts} · 旧稿 ${works.versions} · 项目 ${works.projects}` : '',
            }),
            h(Stat, {
              label: '信箱',
              value: mail?.total,
              hint: mail ? `未读 ${mail.unread}` : '',
            })));
      };

      const renderDir = () => {
        const derived = info?.derived || {};
        const curProbe = info?.probe?.current || null;
        const candProbe = probe || (info?.probe?.candidate ?? null);
        const dirty = Boolean(info) && draft.trim() && draft.trim() !== info.dataRoot;
        const dirRows = [
          ['记忆', derived.memory],
          ['日记', derived.diary],
          ['心情·承诺', derived.state],
          ['作品库', derived.works],
          ['信箱', derived.mailbox],
          ['对话窗口', derived.context],
          ['归档', derived.archive],
        ].filter(([, v]) => v);

        return h('div', null,
          h('div', { style: S.card },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
              h('div', { style: { flex: '1 1 auto' } },
                h('div', { style: S.label }, '数据根目录'),
                h('div', { style: { ...S.code, fontSize: 13 } }, info?.dataRoot || '…')),
              h('button', {
                style: S.btn, disabled: busy || !info?.dataRoot,
                onClick: () => openDir(info.dataRoot),
              }, '打开目录')),

            h('div', { style: { ...S.meta, marginTop: 6 } },
              '来自：', SOURCE_LABEL[info?.source] || '…',
              curProbe ? h('span', null, ' · ', probeText(curProbe)) : null,
              info?.envDataRoot ? h('div', { style: S.warn }, '环境变量指向 ', info.envDataRoot, '，改配置不会生效') : null),

            dirRows.length ? h('div', { style: S.box },
              h('div', { style: { ...S.label, marginBottom: 4 } }, '子目录（由根目录派生，不用单独配）'),
              h('div', { style: S.kv }, dirRows.map(([k, v]) => h(React.Fragment, { key: k },
                h('div', { style: S.kt }, k),
                h('div', { style: S.code }, v))))) : null,

            h('div', { style: { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' } },
              h('input', {
                style: S.input,
                value: draft,
                spellCheck: false,
                placeholder: info?.defaultDataRoot || 'D:\\…',
                onChange: (ev) => { setDraft(ev.target.value); setProbe(null); },
              }),
              h('button', { style: S.btn, disabled: busy, onClick: () => openBrowse() }, '浏览…'),
              h('button', { style: S.btn, disabled: busy || !draft.trim(), onClick: checkDraft }, '检查'),
              h('button', {
                style: dirty ? S.btnPrimary : S.btn,
                disabled: busy || !draft.trim(),
                onClick: () => saveDraft(),
              }, '保存'),
              h('button', {
                style: S.btn, disabled: busy || !info?.defaultDataRoot,
                title: '填进输入框，再点保存',
                onClick: () => { setDraft(info.defaultDataRoot); setProbe(null); },
              }, '用默认位置')),

            h('div', { style: { ...S.meta, marginTop: 6 } },
              '默认位置 ', h('span', { style: S.code }, info?.defaultDataRoot || '…'),
              h('br'), '保存后自动搬数据过去、自动刷新生效；桥接要重启。'),

            candProbe ? h('div', { style: S.box },
              h('div', { style: S.label }, '这次要改成'),
              h('div', { style: S.code }, candProbe.path),
              h('div', { style: S.meta }, probeText(candProbe)),
              candProbe.relation === 'same' ? h('div', { style: S.meta }, '和当前一样，保存不会改动') : null,
              candProbe.relation === 'inside' ? h('div', { style: S.warn }, '⚠️ 在当前目录里面，保存会被拒') : null,
              candProbe.relation === 'contains' ? h('div', { style: S.warn }, '⚠️ 当前目录在它里面，两个根会重叠') : null,
              candProbe.exists && candProbe.memoryTotal ? h('div', { style: S.warn }, '⚠️ 这个目录里已经有记忆数据') : null) : null,

            browse ? h('div', { style: S.box },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } },
                h('div', { style: { ...S.label, margin: 0 } }, '浏览目录'),
                h('button', { style: S.btnTiny, onClick: () => setBrowse(null) }, '关闭')),
              h('div', { style: { ...S.code, marginBottom: 8 } }, browse.path || '选一个盘'),
              browse.probe ? h('div', { style: { ...S.meta, marginBottom: 6 } }, probeText(browse.probe)) : null,
              h('div', { style: { marginBottom: 8 } },
                browse.parent ? h('button', { style: S.btnTiny, disabled: busy, onClick: () => navTo(browse.parent) }, '↑ 上一级') : null,
                h('button', {
                  style: { ...S.btnTiny, marginLeft: 8 },
                  disabled: busy || !browse.path,
                  onClick: () => { setDraft(browse.path); setProbe(browse.probe); setBrowse(null); },
                }, '选这个目录'),
                h('button', {
                  style: { ...S.btnTiny, marginLeft: 8 },
                  disabled: busy || !browse.path,
                  onClick: () => { const p = browse.path; setBrowse(null); setDraft(p); saveDraft(p); },
                }, '选并保存')),
              h('div', null, (browse.drives || []).map((d) => h('button', {
                key: d, style: S.dirItem, disabled: busy, onClick: () => navTo(d),
              }, d))),
              (browse.dirs || []).length
                ? h('div', { style: { marginTop: 4 } }, browse.dirs.map((d) => h('button', {
                  key: d, style: S.dirItem, disabled: busy, onClick: () => navTo(joinPath(browse.path, d)),
                }, `${d}\\`)))
                : h('div', { style: S.meta }, '（没有子目录）')) : null));
      };

      const renderTuning = () => {
        const spec = tune?.spec || [];
        const dflt = tune?.defaults || {};
        if (!tune) return h('div', { style: S.meta }, '读取中…');
        return h('div', null,
          h('div', { style: S.card },
            h('div', { style: S.h3 }, '这些参数存在哪'),
            h('div', { style: S.p },
              '存在桥接的 config.json 里 —— 真正拼注入的是桥接，参数放它那儿两边才一致。'
              + '注入和淡忘都是现读现用，改完不用重启。'),
            tune.found === false
              ? h('div', { style: S.warn }, '⚠️ 找不到桥接的 config.json，只能看不能改。')
              : h('div', { style: S.code }, tune.file || '—')),

          spec.map((g) => h('div', { key: g.group, style: S.card },
            h('div', { style: { ...S.h3, marginBottom: 10 } }, g.group),
            (g.fields || []).map((f) => h('div', { key: f.key, style: { marginBottom: 10 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
                h('div', { style: { flex: '1 1 auto', fontSize: 13 } },
                  f.label,
                  f.unit ? h('span', { style: { ...S.meta, marginLeft: 4 } }, `（${f.unit}）`) : null,
                  h('span', { style: { ...S.meta, marginLeft: 8 } }, `默认 ${dflt[f.key]}`)),
                f.type === 'bool'
                  ? h('button', {
                    style: tuneDraft[f.key] ? S.btnPrimary : S.btn,
                    disabled: tuneBusy || tune.found === false,
                    onClick: () => setTuneDraft((d) => ({ ...d, [f.key]: !d[f.key] })),
                  }, tuneDraft[f.key] ? '开' : '关')
                  : h('input', {
                    type: 'number',
                    style: { ...S.input, flex: '0 0 130px', minWidth: 110 },
                    min: f.min, max: f.max, step: f.step,
                    value: tuneDraft[f.key] === undefined || tuneDraft[f.key] === null ? '' : tuneDraft[f.key],
                    disabled: tuneBusy || tune.found === false,
                    onChange: (ev) => {
                      const v = ev.target.value === '' ? '' : Number(ev.target.value);
                      setTuneDraft((d) => ({ ...d, [f.key]: v }));
                    },
                  })),
              f.hint ? h('div', { style: S.meta }, f.hint) : null)))),

          tuningDirty() ? h('div', { style: { ...S.warn, marginBottom: 8 } }, '有未保存的改动') : null,
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('button', {
              style: tuningDirty() ? S.btnPrimary : S.btn,
              disabled: tuneBusy || tune.found === false || !tuningDirty(),
              onClick: saveTuning,
            }, tuneBusy ? '保存中…' : '保存'),
            h('button', {
              style: S.btn, disabled: tuneBusy || tune.found === false,
              title: '只填进输入框，还要点保存',
              onClick: () => setTuneDraft({ ...(tune.defaults || {}) }),
            }, '填默认值'),
            h('button', { style: S.btn, disabled: tuneBusy, onClick: loadTuning }, '重新读取')));
      };

      const renderAbout = () => h('div', null,
        h('div', { style: S.card },
          h('h3', { style: S.h3 }, '这是什么'),
          h('div', { style: S.p },
            '大肥鱼的人格数据层：她不随会话消失的那部分状态。全部落成普通文件'
            + '（json / md），人和程序都能直接读。目前 40 个 dfy_ 工具、v0.2。')),

        h('div', { style: S.card },
          h('h3', { style: S.h3 }, '记忆怎么淡'),
          h('div', { style: S.p },
            'core 永不淡忘 · important 半衰期 21 天 · normal 7 天。'
            + '淡出不是删除，是模糊化后进归档 —— 「记不清了」和「没发生过」是两件事。')),

        h('div', { style: S.card },
          h('h3', { style: S.h3 }, '心情怎么算'),
          h('div', { style: S.p },
            '底色（慢变）+ 冲量（某件事带来的起伏）+ 渣（坏事散完也回不到原位的那一截）。')),

        h('div', { style: S.card },
          h('h3', { style: S.h3 }, '和 QQ 桥接的关系'),
          h('div', { style: S.p },
            '两边读写同一批文件，不复制、不分叉。桥接负责注入和发消息，这里负责数据和工具。'
            + '改数据目录时两边要一起改 —— 页面会替你做，但桥接得重启才读新值。')),

        h('div', { style: S.card },
          h('h3', { style: S.h3 }, '备份 / 迁移'),
          h('div', { style: S.p },
            '把整个数据根目录拷走就是完整备份，拷回来就是恢复。不要只拷 memory/ —— '
            + '日记、心情、作品库、信箱是分开的。'),
          h('button', {
            style: S.btn, disabled: !info?.dataRoot,
            onClick: () => openDir(info.dataRoot),
          }, '打开数据目录')));

      /* ── 外壳 ─────────────────────────────────────────────────── */

      return h('div', { style: { padding: '4px 2px 24px' } },
        h('h2', { style: { margin: 0, fontSize: 18 } }, '大肥鱼记忆'),
        // 标题和简介之间空一行（≈14px），简介和 tab 之间空两行（≈32px）
        h('div', { style: { ...S.meta, marginTop: 14, marginBottom: 32 } },
          '给大肥鱼加上长期记忆、情绪、承诺、日记、作品库和信箱，并在这里做相应配置。'),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 4 } },
          TABS.map(([k, label]) => h('button', {
            key: k, style: tab === k ? S.tabOn : S.tab, onClick: () => setTab(k),
          }, label))),

        err ? h('div', { style: { ...S.err, marginTop: 8, whiteSpace: 'pre-wrap' } }, err) : null,
        msg ? h('div', { style: { ...S.ok, marginTop: 8, whiteSpace: 'pre-wrap' } }, msg) : null,

        h('div', { style: { marginTop: 10 } },
          tab === 'dir' ? renderDir()
            : tab === 'tuning' ? renderTuning()
              : tab === 'about' ? renderAbout()
                : renderStatus())
      );
    }

    return {
      apply(ctx) {
        // ⭐ 注册失败绝不上抛：少一个设置页，不能少一个能用的应用
        try {
          const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots;
          if (!slots?.inject) {
            try { console.warn('[dsh-dfy-memory] 没有 slots 服务，设置页跳过'); } catch { /* 忽略 */ }
            return;
          }
          slots.inject('settings.section', () => slots.register(
            { name: 'settings.section', id: 'dfy-memory', order: 45, label: '大肥鱼记忆' },
            () => h(Panel),
          ));
        } catch (e) {
          try { console.warn('[dsh-dfy-memory] 设置页注册失败：', e?.message ?? e); } catch { /* 忽略 */ }
        }
      },
    };
  },
});
