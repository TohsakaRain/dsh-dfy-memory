# dsh-dfy-memory

> 给 AI 伴侣一套**会淡忘**的人格数据层：长期记忆 / 心情·好感 / 承诺 / 日记。
> 一个 DeepSeek Harness（DSH）插件，29 个工具 + 一个设置页。

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

插件本身是纯 ESM，没有构建步骤。三种装法：

### ① 从本地目录 link（开发用，推荐先这样）

```powershell
# 1. 放到你喜欢的位置
git clone https://github.com/YOUR_GITHUB/dsh-dfy-memory.git D:\plugins\dsh-dfy-memory

# 2. 让 DSH 能解析到它
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\plugins\dsh-dfy-memory" -Target "D:\plugins\dsh-dfy-memory"
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-dfy-memory" -Target "D:\plugins\dsh-dfy-memory"

# 3. 在 profile 的 package.json 里登记（dependencies + bundles 各加一条）
```

```jsonc
// ~/.dsh/profiles/desktop/package.json
{
  "dependencies": { "dsh-dfy-memory": "link:C:/Users/<你>/.dsh/plugins/dsh-dfy-memory" },
  "dsh": { "profile": { "bundles": [ /* …既有… */, "dsh-dfy-memory" ] } }
}
```

### ② npm 本地安装

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
npm install file:D:\plugins\dsh-dfy-memory
# 然后把 "dsh-dfy-memory" 加进 dsh.profile.bundles
```

### ③ 发布到 npm 之后

```powershell
dsh plugin --profile desktop add dsh-dfy-memory
```

装完**重启 DSH**（插件在启动时加载）。

---

## 数据放哪

默认放在**用户目录**下，和 douyin-browser 等第三方 DSH 插件同一个规矩：

```
~/.dsh/dsh-dfy-memory/
├── memory/    长期记忆（memory.json + 人可读的 memory.md）
├── diary/     日记（一天一个 .md）
├── state/     心情·好感度（emotion.json + emotion.md）、承诺
├── works/     作品库（text/ image/，各自带 archive/ 和 drafts/）
├── mailbox/   邮箱（信件，和作品库分开）
└── context/   按天的对话窗口（全量 / 摘要）
```

Windows 上就是 `C:\Users\<你>\.dsh\dsh-dfy-memory\`。

**想换位置**（二选一）：

```bash
# 1) 环境变量：整个数据根目录搬家
DFY_DATA_DIR=D:\my\dsh-data

# 2) 插件 config：分别指定
#    memoryDir / diaryDir / stateDir / worksDir
```

`memory.md` 和 `emotion.md` 是给人看的只读视图——每次写入会顺手同步，
手改那边不生效（下次写入会被覆盖），要改走工具。

## 29 个工具

| 组 | 工具 | 说明 |
|---|---|---|
| **日记** | `dfy_diary_write` / `dfy_diary_read` / `dfy_diary_list` | 一天可写多段、写出去不能删 |
| **记忆** | `dfy_memory_save` / `dfy_memory_recall` / `dfy_memory_touch` / `dfy_memory_update` / `dfy_memory_forget` / `dfy_memory_stats` | 存 / 想起来 / 强化 / 改 / 淡忘 / 看统计 |
| **心情** | `dfy_mood` / `dfy_affinity` | 不传参数就是查，传了就是记 |
| **承诺** | `dfy_promise` / `dfy_promises` / `dfy_promise_drop` | 答应的事 + 到点提醒（提醒需要宿主配合） |
| **对话窗口** | `dfy_context_get` / `dfy_context_list` / `dfy_context_raw` / `dfy_context_summarize` / `dfy_context_digest` | 按天存的对话：读摘要、读**原始记录**、自己重写摘要、周/月压缩 |
| **归档** | `dfy_archive_search` / `dfy_archive_get` / `dfy_archive_stats` | 淡出记忆的索引，想不起旧事时翻 |
| **作品库** | `dfy_work_save` / `dfy_work_image` / `dfy_works` / `dfy_work_read` | 她写的东西、画的图（`works/`） |
| **邮箱** | `dfy_mail_send` / `dfy_mail_list` / `dfy_mail_read` | 她和执行者之间的信（`mailbox/`，和作品库分开） |

> **注意**：`dfy_promise` 只是**记录**承诺。真正"到点提醒"需要一个定时器去查 `due()` 并把结果喂给模型 ——
> 这属于宿主（比如 QQ 机器人框架）的职责，不在插件里。

---

## 注入（重要）

这个插件**只负责数据与工具**。把记忆/心情拼进提示词是**宿主侧**的事，两种做法：

```js
// A. 宿主直接 import 插件导出的门面
import { createMemoryFacade, resolvePaths } from 'dsh-dfy-memory'

const paths = resolvePaths(/* 你的配置 */)
const f = createMemoryFacade(paths)

const memoryLine = f.memory.forPrompt()    // 【你记得的事】≤8 条 / ≤600 字
const moodLine   = f.emotion.format({ who: '10001' })
const diaryLine  = f.diary.status()        // 今天写了没
```

```yaml
# B. 直接用内置的 HTTP 端点（浏览器/其它进程都能拿）
GET  /api/dfy-memory/state    → 记忆/心情/承诺/日记概况
GET  /api/dfy-memory/config   → 当前目录与开关
POST /api/dfy-memory/switch   → { memorySource: 'both'|'new'|'old' }
```

---

## 设置页（可选，默认没开）

插件带一个设置面板（状态 + 工具开关），但**默认没启用**——因为它需要客户端 bundle，
而客户端 bundle 是 DSH 里最容易把整机搞挂的一块（见下面"坑"）。

想开就在 `package.json` 里加：

```json
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

**并且确认 `exports` 里有 `"./client": "./client.js"`**（少了这一行，DSH 会启动失败）。

---

## 工具开关：新旧并存

如果你在迁移旧工具，可以一次只放行一套：

```json
// 桥接/宿主的 config.json
{ "security": { "toolAllow": { "memorySource": "both" } } }
```

| 取值 | 效果 |
|---|---|
| `both` | 两套都可见 |
| `new` | 只放 `dfy_*`，旧工具被拒（拒绝信息里会告诉你等价的新名字） |
| `old` | 只放旧工具（一键回滚） |

这层过滤要**你自己在宿主里实现**（插件不认识别的命名空间）。

---

## 自检

```powershell
node selfcheck.mjs      # 42 项，全用临时目录，不碰真实数据
```

覆盖：加载、记忆（写入/判重/召回/分层/touch/渲染/注入文本）、心情（衰减/淡透/好感度）、
承诺（到点/标记/丢弃）、日记（多段/间隔/非法日期拦截）、工具注册（14 个名字/schema/返回值类型）。

---

## 三个真实踩过的坑（写在这里，省你一次重启）

### 1. 工具的 `parameters` 必须是**完整 JSON Schema**

```js
// ✗ 这样会在模型侧报错，而且**整轮运行失败**（不只是这个工具不可用）
parameters: { text: { type: 'string' } }

// ✓
parameters: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false }
```

报错长这样：

```
Invalid schema for function 'dfy_xxx': schema must be a JSON Schema of 'type: "object"', got 'type: null'
```

DSH 的 `defineTool` 在**拿得到**的时候会帮你做转换；桌面版 profile 里它是个 optional peer（不装），
降级实现是"原样返回"，所以一定要自己写完整。插件里用 `toJsonSchema()` 统一处理。

### 2. 工具**返回值必须是对象**

返回字符串会被判：

```
tool "dfy_xxx" returned invalid output: "value" must be an object
```

插件的 `lib/toolkit.mjs` 会把字符串自动包成 `{ message }`，渲染时再取出来。

### 3. 声明 `dsh.client` 就必须导出 `./client`

```
client-modules: <包名> declares dsh.client but exports no "./client" bundle
```

后果不是"设置页不显示"，而是 **DSH 整个打不开**。`package.json` 的 `exports` 里必须有
`"./client": "./client.js"`。

---

## 架构

```
宿主（DSH / QQ 机器人 / 任何东西）
   │  ① 调工具                      ② 每轮唤醒时拼提示词
   ▼                                  ▼
┌─────────────────────────────────────────────────┐
│ dsh-dfy-memory                                   │
│  index.js      29 个工具（薄封装，逻辑在 lib/）   │
│  lib/memory-store.js   分层 + 遗忘曲线 + 打分     │
│  lib/emotion.js        心情衰减 + 好感度          │
│  lib/commitments.js    承诺                      │
│  lib/diary.js          日记（路径锁死防穿越）     │
│  lib/webapi.mjs        只读端点 + 开关            │
│  client.js             设置页（可选）             │
└─────────────────────────────────────────────────┘
   │
   ▼ 纯文件，无数据库
~/.dsh/dfy-memory/{memory,diary,state}
```

**设计原则**：门面是**薄透传**——返回形状与 `lib/` 里原始函数完全一致，
这样宿主从旧实现切过来是 1:1 替换，不会多出一层"形状转换"。

---

## 常见问题

**Q：能跟别的程序共用同一批文件吗？**
能。把 `memoryDir` / `stateDir` 指到同一个目录即可。文件是普通 JSON + Markdown，没有锁文件。

**Q：数据会丢吗？**
写入走"临时文件 + rename"（原子），坏 JSON 当空结构处理且**不覆盖原文件**。
但**没有内置备份**——重要的话自己定期拷。

**Q：能做多角色吗？**
可以：每个角色一套目录（`memoryDir` 不同），或者把 `who` 字段用起来区分关系对象。

**Q：为什么心情是单条而不是曲线？**
单条更接近人的体感（"我现在有点烦"）。要历史曲线，用日记。

---


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
## License

MIT


