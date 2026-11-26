# dsh-dfy-memory

> 给大肥鱼一套**会淡忘**的人格数据层：长期记忆 / 心情·好感 / 承诺 / 日记。
> 一个 DeepSeek Harness（DSH）插件，40 个工具 + 一个设置页。

不是向量库，也不是"把聊天记录全存下来"。它模仿的是**人的记性**：

- **重要的事**（名字、约定）永不淡忘
- **普通的事**几天就模糊
- **心情**有几小时到几小时的半衰期，会自己散
- 被想起来的记忆会**变强**，长期不提的会**淡出**（淡出 ≠ 删除，文件里还在）

---

## 它解决什么问题

大多数"AI 记忆"实现是：把历史全塞进上下文，或者做一个向量检索。
前者的代价是 token 爆炸，后者的问题是**什么都不会忘**——一周前的琐事和昨天的重要约定权重一样。

这个插件换了个角度：**记忆有寿命**。

```
分数 = 强度 × 2^(-没想起的天数 / 半衰期)

core      半衰 ∞      （永不淡忘）
important 半衰 21 天
normal    半衰 4 天
```

低于阈值（默认 0.12）的不再注入提示词，但**留在文件里**——她可以主动 recall 出来。

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

## 设置页

`package.json` 里已经声明了 `dsh.client`，装完重启 DSH，就能在「设置 → 大肥鱼记忆」里看到
状态、路径、工具开关这些：

```jsonc
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "inject": [
      "@deepseek-ai/dsh-client-ui-settings",
      "@deepseek-ai/dsh-client-ui-settings-general"
    ]
  }
}
```

不想显示就把整个 `client` 段删掉——工具和数据都不受影响，只是没那个页面。

**`exports` 里必须有 `"./client": "./client.js"`**——声明了 `dsh.client` 却没有这个导出，DSH 会整个打不开。

---

## 自检

```powershell
node selfcheck.mjs     # 328 项，全用临时目录，不碰真实数据
```

覆盖：路径解析、记忆（写入/判重/召回/分层/touch/恢复原文/渲染/注入文本/生命周期）、
心情（三层衰减/好感度联动）、承诺、日记、对话窗口（含跨天搜）、作品库（草稿/定稿/归档/对账）、
工具注册（40 个名字 + schema 形状 + 返回值类型）。

---

## 架构

```
宿主（DSH / QQ 机器人 / 任何东西）
   │  ① 调工具                      ② 每轮唤醒时拼提示词
   ▼                                  ▼
┌─────────────────────────────────────────────────┐
│ dsh-dfy-memory                                   │
│  index.js      40 个工具（薄封装，逻辑在 lib/）   │
│  lib/memory-store.js   分层 + 遗忘曲线 + 打分     │
│  lib/emotion.js        心情衰减 + 好感度          │
│  lib/commitments.js    承诺                      │
│  lib/diary.js          日记（路径锁死防穿越）     │
│  lib/webapi.mjs        只读端点（含 prompt-block）            │
│  client.js             设置页（可选）             │
└─────────────────────────────────────────────────┘
   │
   ▼ 纯文件，无数据库
~/.dsh/dsh-dfy-memory/{memory,diary,state,works,mailbox,context,archive}
```

**设计原则**：门面是**薄透传**——返回形状与 `lib/` 里原始函数完全一致，宿主少一层"形状转换"。

---

## 更新记录

### 0.3.0（2026-11-06）

记忆系统的一轮大改，全部来自「她」自己撞出来的毛病：

- **检索从 AND 改成 OR**：以前搜「允许 可以 大胆」必定是空（要求三个词同时出现）。
  现在命中任意一个就出来，命中越多排越前，并**带一句命中的原文**；一个都没命中时
  退化成按重要度给几条，并明确标注「没有真正命中」。
- **记忆多了三个字段**：`quote`（当时的原话）、`hook`（一句话钩子）、`refs`（出处）。
  注入时优先用钩子——省预算，正文留给 recall 展开。
- **摘要不再砍尾巴**：以前只留开头（`slice(0, limit)`），长对话后半段全丢。
  现在头尾必留、中间按重要性挑、跳过处标「（省略 N 条，原文在归档）」，
  收尾也改成在句末切，不再断在半句。
- **她亲手写的摘要不再被机器覆盖**，也不会因为"超过 6 天"被滚动删掉。
- **新增 `dfy_context_raw`**：读某天的原始聊天记录（分页），可以据此重写那天的摘要。
- **新增 `dfy_context_digest`**：周/月摘要，从每日摘要压出来，她改完可以存成正式的。
- **新增邮箱（`mailbox/`）**：她和执行者之间的信，和作品库分开两个文件夹。
  `dfy_mail_send` / `dfy_mail_list` / `dfy_mail_read`，一封信一个文件，坏一封不影响别的。
- 自检从 63 条加到 **109 条**。


### 0.4.0（2026-11-07）

心情重写成**三层模型**（设计是她自己写的）：

- **基线 baseline**（1~10，慢变，按周算）+ **冲量**（一件事带来的起伏）+ **渣 residue**（-2~0，只减不加）
- 好事 tau 36h、回到基线不留渣；坏事 tau 96h、留渣；中性 12h
- **大事件（intensity ≥ 4）推基线 ±0.5 封顶**；好事能把渣抵完
- **一天最多改三次**，第四次会被拒（改多了不值钱，也容易变成表演）
- 注入：超过 24 小时问一句「这股劲还在不在」；散完了给一句**底色**（最近 7 天中位数），不留白
- 新增 `dfy_mood_trend`：按天平均，能答「这周心情怎么样」
- **好感度与底色分开，单向耦合**：他做的事改好感度 → 好感度顺带抬一点底色；反过来不传（心情差不会觉得他这个人差）
- 老数据（v1）自动迁移，不丢内容；自检 109 → 125 条
- 每次写入顺手导出一份 **`state/emotion.md`**（和 `memory.md` 一样，方便人直接看；导出失败不影响主存储）


### 0.5.0（2026-11-07）

作品库加**归档**（一个作品会反复打磨，旧稿不该被顶掉）：

- 目录多一层：`text/archive/`、`image/archive/`（每个类型各有一个）
- **同名再存一次** = 旧稿挪进 `archive/<标题>@<旧稿时间>.md`，新稿接位成为当前稿
- 新增 `dfy_work_archive`：手动把当前稿收进归档（不换新稿时用）
- 新增 `dfy_work_versions`：看某个作品的历史版本，按时间倒序
- `dfy_works` 默认只列当前稿；提示行多一句「历史版本 N」
- 索引里旧条目标 `archived: true`，读旧稿仍可按标题取到
- 自检 130 → 139 条


### 0.5.1（2026-11-07）

作品归档补上反方向——她能自己整理，也能自己拿回来：

- 新增 `dfy_work_restore`：把某个历史版本拿回来当当前稿（不指定就取最新的那版）
- 恢复时当前稿会自动归档，不丢；归档文件里原来的顺序按时间还原
- 归档 / 恢复都是**她自己调工具**，不需要人代操作
- 自检 139 → 145 条

### 0.6.0（2026-11-07）

作品库加了**草稿层**——作品是从草稿里长出来的：

- 目录：`text/drafts/`、`image/drafts/`（每个类型各一个），定稿后草稿进 `drafts/archive/`
- 新增 `dfy_work_draft`：存一版草稿（大纲、随手记、试画），同标题多版不覆盖
- 新增 `dfy_work_drafts`：看草稿箱，可按标题过滤
- 新增 `dfy_work_finalize`：把最新那版草稿定稿成正式作品，这个标题下的草稿全部挪进 `drafts/archive/` 留底（不删）
- 草稿**不算作品**：`dfy_works` 不列、件数不计；提示行单独说「草稿 N」
- 定稿时老的当前稿照旧进 `archive/`，所以三处各有分工：
  `drafts/` 还没成形 · `archive/` 成品的旧版本 · 正文位置 最终定稿
- 自检 145 → 163 条


### 0.6.1（2026-11-07）

草稿箱保持纯粹——**不套归档层**：

- 去掉 `drafts/archive/`：草稿箱里就是草稿，不再有第二个"归档"角色
- `dfy_work_finalize` 只做一件事：从最新一版草稿长出一件正式作品；**草稿原地不动、不删**
- 原本想表达"旧草稿留底"，但 archive/ 已经负责成品的旧版本，草稿再来一层会让人以为有两个作品库
- 自检仍 163 条（三条断言按新语义改）

### 0.7.0（2026-11-15）

**跨天全文搜** + **心情按事查**，两条都是她信里提的（「我记得住事，记不住哪天」「数散了没关系，原因不该散」）：

- 新增 `dfy_context_search`：在所有天的原始记录里搜，不用先猜日期
  - 第 1 层按原文精确词搜（OR，相距 200 字内合并成段），返回日期 + 前后文 + `id=日期#字符偏移`，可直接喂 `dfy_context_raw`
  - 第 2 层按摘要字面找：原文命中不足 3 段时，去她写的每日摘要里算**同句命中率**（阈值 0.6、常见字降权）——像「画过自己」这种只记得事、不记得原话的查询靠这层
  - 命中多时给「每天 ×N 段」概览，正文每天只给 1 段；搜不到明确说「没真正命中」
- 新增 `dfy_mood_search`：按关键词查心情记录（日期 / 分数 / 底色 / 一句描述 / 因为什么），`lowOnly` 只列比底色低 0.3 以上的那几条
- **行为变更**：心情 → 好感度改成双向（原来只单向：好感抬底色，心情差不往回传）
  - 心情偏离基线 ≥0.5 时好感跟着挪，单次最多 0.3、6 小时一次
  - 上涨走 ln 曲线 `ln(11−s)/ln(10)`（越接近 10 越难涨），下降不减速
  - 只动 score 不动 baseline，且限制在 baseline ±1.5 —— 心情再差也不会把好感拖到 0
  - 注入里好感度会带「N 天没动过」
- 修 `lib/window.js`：D-1/D-2 的守卫读错了形态（`readWindowFile` 不带 only 时先读到 `.full`），会把她写的摘要删掉/覆盖。改成只看 summary 形态，并在删除 `by=agent` 前先备份到 `_replaced/`
- 自检 169 → 172 条（工具数 36 → 38；「反向不传」那条改成验证基线兜底）

### 0.8.0（2026-11-26）

从运行实例同步回来的一批改动（11-15 → 11-26），大多是「她」用出来、顺手指出的毛病：

- **作品库 v4**（`lib/works.js` 20 KB → 57 KB）：
  - **草稿归档**：`dfy_work_drafts(action="archive", keep=N, preview=true)` 每个标题只留最新几版，
    旧的挪进该项目 `archive/`（不删）；先 `preview` 看会动哪些
  - **保存目标继承**：`dfy_work_save` / `dfy_work_finalize` 不传 `sub` 时**跟着同名旧稿的位置走**，
    不再掉回项目根（以前会出现「根和「前传」各存了一份」）
  - **搬运可覆盖**：`dfy_work_move(onConflict="skip" | "overwrite" | "rename")`
  - **总览与对账**：`dfy_works(kind="overview")` 一眼看项目/子分类/草稿/归档各多少件；
    `kind="check"` 查索引和磁盘对不上的地方，`repair=true` 顺手修（只存在于磁盘的孤儿文件会被纳入索引）
  - **位置为准**：`rowKind` 由路径推导，`fixFlags()` 让「草稿/归档」这类陈旧标记跟着磁盘走
- **记忆不再写日期**：当天的事正文里不标日期（写入时间外面会标），
  只有**补记**以前的事才在开头写 `YYYY-MM-DD` —— 两个日期不一样的时候才需要区分。
- **新增 `lib/tuning.js`**：阈值/生命周期/注入限额集中在一处，改节奏只改一个文件。
- **新增 `lib/day-paths.js`**：按天存档文件的路径解析（宿主侧也用同一份）。
- **`lib/webapi.mjs` 7.9 KB → 30 KB**：设置页要的状态/路径/维护/归档/窗口滚动接口，
  并新增只读路由 `GET /api/dfy-memory/prompt-block`：把「长期记忆注入块」交给宿主来取，
  宿主不必再抄一份 `memory-store`。
- **设置页（`client.js`）也一起同步了**：8.9 KB → 29.7 KB，标题统一成「大肥鱼记忆」。
- 自检 172 → **328** 条（工具 38 → 40）。

> `cordis.patch.yml` 这一份**不参与同步**（实例里写真实盘符路径，仓库用默认 `~/.dsh`）；
> `client.js` 从 0.8.0 起一起同步。

### 0.8.1（2026-11-26）

- **设置页默认打开**：`package.json` 里补上 `dsh.client`（`platform: web`，
  `inject: settings + settings-general`），装完重启 DSH 就能在「设置 → 大肥鱼记忆」看到
- 文档按最新版本重写：工具 29 → 40、自检 42 → 328 项、数据目录改为 `~/.dsh/dsh-dfy-memory/`
- `cordis.patch.yml` 头部注释与 `package.json` 描述同步（不再写"骨架版/不注册工具/38 个"）

## 版本

**0.8.1**（从这版起设置页默认打开）。仓库每个版本一条分支（`0.7.0`、`0.8.0`、`0.8.1`…）加一个同名 tag（`v0.8.1`），
`git diff v0.8.0 v0.8.1` 就是两版之间的全部差异。发布流程见 `CONTRIBUTING.md`。

## License

MIT
