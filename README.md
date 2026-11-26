# dsh-dfy-memory

> DSH 插件：给一个人格一套**会淡忘**的数据层 —— 长期记忆 / 心情·好感度 / 承诺 / 日记 / 对话窗口 / 作品库 / 邮箱。
> **40 个 `dfy_*` 工具 + 一个设置页**，纯文件存储，没有数据库。当前版本 **0.8.0**。

---

## 它怎么工作

- **记忆有寿命**。分数 = 强度 × 2^(−没想起的天数 / 半衰期)：

  ```
  core       半衰 ∞      永不淡忘（名字、约定、承诺）
  important  半衰 21 天
  normal     半衰 4 天
  ```

- 分数低于阈值（默认 0.12）就不再进注入，但**文件里还在**，随时能 `dfy_memory_recall` 翻出来。
- 被想起来会**变强**（`lastRecalledAt` / `strength` 涨，模糊的正文会恢复原文）；长期不碰的会**模糊**（只剩一句钩子），再久就进归档。
- **心情**分三层：`baseline`（按周慢变）+ `impulse`（这件事带来的起伏，按 tau 衰减）+ `residue`（坏事散完回不去的那一截）。数由她自己打，插件只负责记录、衰减、下次摆到她眼前。
- **承诺只是记录**。到点提醒要宿主自己有定时器（见「注入」）。

---

## 安装

没有任何构建步骤，纯 ESM。三种方式选一种：

```powershell
# ① 本地目录 link（改代码时用这个）
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\plugins\dsh-dfy-memory" -Target "D:\plugins\dsh-dfy-memory"
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-dfy-memory" -Target "D:\plugins\dsh-dfy-memory"

# ② 从本地目录装
cd $env:USERPROFILE\.dsh\profiles\desktop; npm install file:D:\plugins\dsh-dfy-memory

# ③ 发布到 npm 之后
dsh plugin --profile desktop add dsh-dfy-memory
```

然后在 profile 的 `package.json` 里登记两处：

```jsonc
// ~/.dsh/profiles/desktop/package.json
{
  "dependencies": { "dsh-dfy-memory": "link:C:/Users/<你>/.dsh/plugins/dsh-dfy-memory" },
  "dsh": { "profile": { "bundles": [ /* …既有… */, "dsh-dfy-memory" ] } }
}
```

**装完重启 DSH** —— 插件在启动时加载一次。

---

## 数据放哪

默认在用户目录下（跟其它 DSH 插件一致），Windows 上是 `C:\Users\<你>\.dsh\dsh-dfy-memory\`：

```
~/.dsh/dsh-dfy-memory/
├── memory/    长期记忆（memory.json + 人可读的 memory.md）
├── diary/     日记（一天一个 .md，可写多段）
├── state/     心情·好感度（emotion.json + emotion.md）、承诺（commitments.json）
├── works/     作品库（按项目分：正传/前传/设定…，各带 drafts/ 和 archive/）
├── mailbox/   邮箱（她 ↔ 执行者的信，和作品库分开）
├── context/   按天的对话窗口（全量 / 摘要）
└── archive/   归档（淡出记忆的索引，只追加）
```

想换位置，两种办法（二选一）：

```bash
# 1) 整个数据根目录搬家
DFY_DATA_DIR=D:\my\dsh-data
# 也可以只换某一类：DFY_MEMORY_DIR / DFY_DIARY_DIR / DFY_STATE_DIR / DFY_WORKS_DIR / DFY_MAIL_DIR
```

```jsonc
// 2) 插件 config（cordis.patch.yml 里）
{ "dataRoot": "D:/my/dsh-data", "memoryDir": "D:/my/dsh-data/memory" }
```

`memory.md` 和 `emotion.md` 是**只读视图**：每次写入顺手同步，手改不生效（下次写入会被覆盖），要改走工具。

---

## 40 个工具

| 组 | 工具 | 说明 |
|---|---|---|
| **日记** | `dfy_diary_write` / `dfy_diary_read` / `dfy_diary_list` | 一天可写多段；写出去不能删 |
| **记忆** | `dfy_memory_save` / `dfy_memory_recall` / `dfy_memory_touch` / `dfy_memory_update` / `dfy_memory_forget` / `dfy_memory_stats` | 存 / 想起来 / 强化 / 改 / 淡忘 / 统计 |
| **心情** | `dfy_mood` / `dfy_mood_trend` / `dfy_mood_search` / `dfy_affinity` | 记或查当前心情、按天走势、按关键词查历史、心里的秤 |
| **承诺** | `dfy_promise` / `dfy_promises` / `dfy_promise_drop` | 答应过的事（到点提醒归宿主） |
| **对话窗口** | `dfy_context_get` / `dfy_context_list` / `dfy_context_raw` / `dfy_context_search` / `dfy_context_summarize` / `dfy_context_digest` | 读摘要 / 读原始记录 / 跨天全文搜 / 自己重写摘要 / 周月压缩 |
| **归档** | `dfy_archive_search` / `dfy_archive_get` / `dfy_archive_stats` | 淡出记忆的索引 |
| **作品库** | `dfy_work_save` / `dfy_work_draft` / `dfy_work_drafts` / `dfy_work_finalize` / `dfy_work_read` / `dfy_work_versions` / `dfy_work_restore` / `dfy_work_archive` / `dfy_work_move` / `dfy_work_project` / `dfy_work_image` / `dfy_works` | 草稿→定稿、归档/还原、按项目归类、总览与对账 |
| **邮箱** | `dfy_mail_send` / `dfy_mail_list` / `dfy_mail_read` | 和作品库分开的两份东西 |

工具签名和语义以 `index.js` 里的描述为准（模型看到的就是那些）。

---

## 注入：宿主怎么接

插件**只管数据和工具**。把「你记得的事」「你现在的心情」摆到模型眼前，是**宿主**的事。两种接法：

### A. 直接 import 门面（同进程）

```js
import { createMemoryFacade, resolvePaths } from 'dsh-dfy-memory'

const paths = resolvePaths(/* 你的 config，或留空用默认 */)
const f = createMemoryFacade(paths, { cfgProvider: () => 你的配置 })

const memoryBlock = f.memory.forPrompt()        // 【你记得的事】≤ injectLimit 条 / ≤ injectMaxChars 字
const moodBlock   = f.emotion.format({ who })   // 心情 + 好感度那几行
const todayDiary  = f.diary.status()            // 今天写了没
```

### B. HTTP 端点（跨进程，宿主不在 DSH 进程里时用这个）

```
GET  /api/dfy-memory/state          记忆/心情/承诺/日记/作品/信箱的概况
GET  /api/dfy-memory/prompt-block   只读：长期记忆注入块 ← 宿主每轮来拿这个
GET  /api/dfy-memory/config         数据根目录 / 注入来源（诊断用）
GET  /api/dfy-memory/paths          当前路径、默认值、来自哪一层
GET  /api/dfy-memory/fs?path=<dir>  目录浏览
POST /api/dfy-memory/open           { path } 用系统文件管理器打开（只限数据目录内）
POST /api/dfy-memory/maintain       把到期的记忆模糊化 / 归档
GET  /api/dfy-memory/archive?q=     搜归档
POST /api/dfy-memory/window/roll    7 天窗口滚动
```

只接受本机回环地址；POST 必须是 `application/json`。

> **最关键的一条**：记忆的取舍/淡忘/注入格式只有**这一份实现**。
> 宿主如果需要这段文本，走 `prompt-block` 或 `memory.forPrompt()`，**不要再自己抄一份
> `memory-store`**——两份实现追着改，一定会出现"这边修了那边没修"。

---

## 配置

`cordis.patch.yml` 里能改的：

| 键 | 含义 |
|---|---|
| `enabled` | 关掉插件（不注册工具） |
| `dataRoot` | 数据根目录（优先级：`DFY_DATA_DIR` > 这里 > 默认） |
| `memoryDir` / `diaryDir` / `stateDir` / `worksDir` / `mailDir` | 单独指某一类目录 |

注入的条数和字数上限（`memory.injectLimit` / `memory.injectMaxChars`）读的是**宿主的 config.json**，不是这里——插件每轮现读，不用重启。

---

## 设置页（默认没开）

`client.js` 在包里，但 `package.json` **没有声明** `dsh.client`，所以默认不显示。
想开就加：

```jsonc
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "inject": [
      "@deepseek-ai/dsh-client-runtime",
      "@deepseek-ai/dsh-client-ui-settings",
      "@deepseek-ai/dsh-client-ui-settings-plugins"
    ]
  }
}
```

**`exports` 里必须有 `"./client": "./client.js"`**，否则 DSH 起不来（见下面的坑）。

---

## 自检

```powershell
node selfcheck.mjs     # 328 项，全用临时目录，不碰真实数据
```

覆盖：路径解析、记忆（写入/判重/召回/分层/touch/恢复原文/渲染/注入文本/生命周期）、
心情（三层衰减/好感度联动）、承诺、日记、对话窗口（含跨天搜）、作品库（草稿/定稿/归档/对账）、
工具注册（40 个名字 + schema 形状 + 返回值类型）。

---

## 坑（真踩过的，按踩的顺序）

### 1. 工具的 `parameters` 必须是完整 JSON Schema

```js
// ✗ 模型侧报错，而且整轮运行失败（不只是这个工具不可用）
parameters: { text: { type: 'string' } }

// ✓
parameters: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false }
```

报错：`Invalid schema for function 'dfy_xxx': schema must be a JSON Schema of 'type: "object"'`。
DSH 的 `defineTool` 在拿得到的时候会帮你转，但桌面版 profile 里它是 optional peer，
降级实现是"原样返回"——**一定要自己写完整**。插件里统一走 `toJsonSchema()`。

### 2. 工具返回值必须是对象

返回字符串会被判 `tool "dfy_xxx" returned invalid output: "value" must be an object`。
`lib/toolkit.mjs` 会把字符串包成 `{ message }`，渲染时再取出来。

### 3. 声明了 `dsh.client` 就必须导出 `./client`

```
client-modules: <包名> declares dsh.client but exports no "./client" bundle
```

后果不是"设置页不显示"，而是 **DSH 整个打不开**。反过来，有 `./client` 但没声明
`dsh.client` 只是不显示——两种都别记混。

### 4. 别在宿主里再抄一份记忆实现

历史上出过两份 `memory-store`（插件一份、宿主一份），结果是一个 bug 只修了一边：
注入的条数上限、模糊后恢复原文、core 不压缩……全都在两边各改一遍才对得上。
现在宿主只准通过 `prompt-block` / `forPrompt()` 拿文本。

### 5. 配置是"白名单式装配"

新加一个配置键，必须在 `index.js` 里显式登记，否则 `cordis.patch.yml` 里写了也不生效
（这个坑踩过三次：`balance`、`emotion`、`awakening` 各一次）。

---

## 版本

**0.8.0**。仓库每个版本一条分支（`0.7.0`、`0.8.0`…）加一个同名 tag（`v0.8.0`），
`git diff v0.7.0 v0.8.0` 就是两版之间的全部差异。发布流程见 `CONTRIBUTING.md`。

## License

MIT
