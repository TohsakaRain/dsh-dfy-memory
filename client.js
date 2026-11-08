/**
 * dsh-dfy-memory —— 浏览器半端：「设置 → AI 记忆」那一页
 * ============================================================================
 * ⭐ client bundle **不是 ESM，是自注册脚本**（从 dsh-bili-scroll 抄来的约定）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                          // 必须等于 package.json 的 name
 *       factory: (require) => ({ apply(ctx) {...} }),
 *     })
 *
 * ⭐ 怎么进设置页左侧导航（别自己糊按钮 + overlay）：
 *
 *     const slots = ctx.get('slots') || ctx.slots
 *     slots.inject('settings.section', () => slots.register(
 *       { name: 'settings.section', id: 'dfy-memory', order: 45, label: 'AI 记忆' },
 *       () => h(Panel),
 *     ))
 *
 * 这一页只做两件事：**看状态** + **切开关**。
 * 数据全部来自 `/api/dfy-memory/*`（见 lib/webapi.mjs）。
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
      const why = res.status === 403 ? '（被宿主拦了）' : res.status === 404 ? '（端点没挂上）' : '';
      throw new Error(`HTTP ${res.status}${why}`);
    };
    const jget = (p) => fetch(API + p, { headers: { accept: 'application/json' } }).then(asJson);
    const jpost = (p, body) => fetch(API + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(asJson);

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
      meta: { fontSize: 12, opacity: 0.7, lineHeight: 1.6 },
      btn: {
        padding: '6px 12px', borderRadius: 7, cursor: 'pointer',
        border: '1px solid var(--dsw-border, rgba(127,127,127,.35))',
        background: 'transparent', color: 'inherit', font: 'inherit',
      },
      btnOn: {
        padding: '6px 12px', borderRadius: 7, cursor: 'pointer',
        border: '1px solid #3b82f6', background: 'rgba(59,130,246,.14)',
        color: 'inherit', font: 'inherit', fontWeight: 600,
      },
      err: { color: '#dc2626', fontSize: 12 },
      ok: { color: '#16a34a', fontSize: 12 },
      code: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11, opacity: 0.8 },
    };

    const Stat = (props) => h('div', { style: S.card },
      h('div', { style: S.label }, props.label),
      h('div', { style: S.big }, String(props.value)),
      props.hint ? h('div', { style: S.meta }, props.hint) : null);

    function Panel() {
      const [state, setState] = React.useState(null);
      const [cfg, setCfg] = React.useState(null);
      const [err, setErr] = React.useState('');
      const [msg, setMsg] = React.useState('');
      const [busy, setBusy] = React.useState(false);

      const load = React.useCallback(async () => {
        setErr('');
        try {
          const [s, c] = await Promise.all([jget('/state'), jget('/config')]);
          setState(s);
          setCfg(c);
        } catch (e) {
          setErr(String(e?.message ?? e));
        }
      }, []);

      React.useEffect(() => { load(); }, [load]);

      const switchTo = async (src) => {
        setBusy(true);
        setMsg('');
        setErr('');
        try {
          const r = await jpost('/switch', { memorySource: src });
          setMsg(r?.note || '已切换');
          await load();
          setTimeout(() => setMsg(''), 4000);
        } catch (e) {
          setErr(String(e?.message ?? e));
        } finally {
          setBusy(false);
        }
      };

      const mem = state?.memory || {};
      const mood = state?.mood;
      const diary = state?.diary || {};
      const prom = state?.promises || {};
      const cur = cfg?.memorySource || 'both';

      const optLabel = { both: '并存（迁移期）', new: '只用新工具 dfy_*', old: '只用旧工具（回滚）' };

      return h('div', { style: { padding: '4px 2px 24px' } },
        h('h2', { style: { margin: '4px 0 6px', fontSize: 18 } }, 'AI 记忆'),
        h('div', { style: S.meta },
          '长期记忆 / 心情·好感 / 承诺 / 日记。数据与桥接共用同一批文件，这里只做展示与开关。',
          h('br'),
          '整体状态：', h('span', { style: S.code }, cfg?.configPath || '…')),

        err ? h('div', { style: { ...S.err, marginTop: 8 } }, err) : null,
        msg ? h('div', { style: { ...S.ok, marginTop: 8 } }, msg) : null,

        h('div', { style: { ...S.row, marginTop: 14 } },
          h(Stat, { label: '长期记忆', value: mem.total ?? '—', hint: `core ${mem.core ?? 0} · important ${mem.important ?? 0} · normal ${mem.normal ?? 0}${mem.fading ? ` · 快淡忘 ${mem.fading}` : ''}` }),
          h(Stat, {
            label: '现在的心情',
            value: mood ? (mood.faded ? '已经散了' : mood.state) : '没什么特别',
            hint: mood ? `${mood.hours} 小时前${mood.cause ? ' · ' + mood.cause : ''}${mood.faded ? '' : ` · 强度 ${mood.effective}`}` : '',
          }),
          h(Stat, { label: '承诺', value: prom.total ?? '—', hint: prom.due ? `到点未提醒 ${prom.due}` : '没有到点的' }),
          h(Stat, {
            label: '今天日记',
            value: diary.todaySections ? `${diary.todaySections} 段` : '还没写',
            hint: diary.lastDate ? `最近一次 ${diary.lastDate}` : '',
          })),

        h('div', { style: S.card },
          h('div', { style: { ...S.label, marginBottom: 8 } }, '工具开关（切完 1.5 秒生效，不用重启）'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            ['both', 'new', 'old'].map((src) => h('button', {
              key: src,
              disabled: busy,
              onClick: () => switchTo(src),
              style: cur === src ? S.btnOn : S.btn,
              title: optLabel[src],
            }, `${src} · ${optLabel[src]}`))),
          h('div', { style: { ...S.meta, marginTop: 8 } },
            '当前：', h('span', { style: S.code }, cur),
            '　注入来源：', h('span', { style: S.code }, cfg?.injectionSource || 'bridge'),
            cfg?.injectionSource === 'bridge'
              ? '（桥接自己拼；要交给插件需改 injection.source + 重启桥接）'
              : '（由插件注入）')),

        h('div', { style: S.card },
          h('div', { style: { ...S.label, marginBottom: 8 } }, '数据位置'),
          h('div', { style: S.meta },
            h('div', null, '日记：', h('span', { style: S.code }, state?.paths?.diary || '—')),
            h('div', null, '记忆：', h('span', { style: S.code }, state?.paths?.memory || '—')),
            h('div', null, '状态：', h('span', { style: S.code }, state?.paths?.state || '—')))),

        h('div', null,
          h('button', { style: S.btn, disabled: busy, onClick: load }, busy ? '刷新中…' : '刷新'))
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
            { name: 'settings.section', id: 'dfy-memory', order: 45, label: 'AI 记忆' },
            () => h(Panel),
          ));
        } catch (e) {
          try { console.warn('[dsh-dfy-memory] 设置页注册失败：', e?.message ?? e); } catch { /* 忽略 */ }
        }
      },
    };
  },
  });
