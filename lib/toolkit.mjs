/**
 * lib/toolkit.mjs —— 把「一个函数」变成 DSH 工具的最小封装
 * ============================================================================
 * 为什么不用 `import { defineTool } from '@deepseek-ai/dsh-tools'`：
 *   桌面版 profile 是 `autoInstallPeers: false` ⇒ 它是个 optional peer，**永远不装**；
 *   裸 import 会让整条插件不激活（`dsh-bili-scroll` 的注释里记了这个坑，本机实测
 *   `require.resolve('@deepseek-ai/dsh-tools')` 也是 MODULE_NOT_FOUND）。
 *
 * 桌面版上真正被用到的是**本地等价实现**：原样返回 spec，只补一条 schema 校验。
 * 这里照抄那个做法。
 *
 * spec 形状（与 dsh-bili-scroll 一致）：
 *   {
 *     name: 'dfy_xxx',
 *     description: '...',
 *     parameters: { 属性名: { type, description, ... } },   // 属性表，不是完整 JSON Schema
 *     async execute(args) { return 任意可 JSON 化的值 }
 *   }
 */

/** 结果统一渲染成「一段 text」。 */
export const textOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string'
      ? value
      : (typeof value?.message === 'string' ? value.message : JSON.stringify(value, null, 2)),
  }],
};

/** 让返回值一定能被 JSON 化（把循环引用之类挡在工具边界外）。 */
export const toJsonable = (v) => {
  if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  try { return JSON.parse(JSON.stringify(v)); } catch { return String(v); }
};

/** 本地等价 defineTool：只保留那条真会炸的校验。 */
export function localDefineTool(options) {
  const check = (schema, where) => {
    if (!schema || typeof schema !== 'object') return;
    if (schema.type === 'object' && schema.additionalProperties === undefined) {
      throw new Error(`defineTool(${options?.name}): ${where} 是 object 却没写 additionalProperties`);
    }
    for (const [k, v] of Object.entries(schema.properties || {})) check(v, `${where}.properties.${k}`);
  };
  check(options?.parameters, 'parameters');
  check(options?.output?.schema, 'output.schema');
  return options;
}

/**
 * 属性表 → **完整 JSON Schema**。
 *
 * ⚠️ 2026-10-28 踩坑：DeepSeek 的 API 直接校验工具 schema，报
 *    `Invalid schema for function 'dfy_affinity': schema must be a JSON Schema of
 *     'type: "object"', got 'type: null'` —— 整轮运行失败。
 *    `dsh-bili-scroll` 之所以只写属性表就行，是因为它在宿主树里拿到了**真 defineTool**
 *    （会做 spec→JSONSchema 转换）；本机拿不到（optional peer 不装），降级实现是"原样返回"，
 *    属性表就被原封不动发给了模型 ⇒ 必须自己补成完整 schema。
 *
 * 我们所有参数都是可选的（缺省时工具自己有默认行为），所以 required 恒为空。
 */
export const toJsonSchema = (params) => {
  if (!params || typeof params !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: false };
  }
  if (params.type === 'object') return params;   // 已经是完整 schema，别二次包装
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(params)) {
    if (!value || typeof value !== 'object') continue;
    const prop = { ...value };
    // 嵌套的 object 属性也必须有 additionalProperties，否则宿主校验会炸
    if (prop.type === 'object' && prop.additionalProperties === undefined) prop.additionalProperties = false;
    if (prop.type === 'array' && prop.items?.type === 'object' && prop.items.additionalProperties === undefined) {
      prop.items = { ...prop.items, additionalProperties: false };
    }
    properties[key] = prop;
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
};

/**
 * 绑定到某个 ctx 的注册器。返回一个 `tool(spec)` 函数。
 * 注册出来的每个工具都会被记进 `registered`（自检要用）。
 */
export function createToolRegistrar(ctx, defineTool = localDefineTool, registered = null) {
  return (spec) => {
    const clean = defineTool({
      ...spec,
      parameters: toJsonSchema(spec.parameters),
      output: spec.output || textOutput,
      async execute(args, exec) {
        const out = toJsonable(await spec.execute(args ?? {}, exec));
        // ⚠️ DSH 按 output.schema（object）校验返回值；直接返回字符串会报
        //    `invalid output: "value" must be an object`，整个工具调用失败。
        if (typeof out === 'string') return { message: out };
        if (out === undefined || out === null) return { message: '' };
        if (typeof out !== 'object') return { message: String(out) };
        return out;
      },
    });
    if (registered) registered.push(clean.name);
    ctx.tools.register(clean);
    return clean;
  };
}
