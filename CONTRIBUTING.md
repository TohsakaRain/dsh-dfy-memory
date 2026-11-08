# 开发流程（作者自己的规矩）

> 2026-11-08 定：
> 1. **先在运行实例里直接改**（`D:\dfy\qq-bridge\plugins\dsh-dfy-memory`），她身上验证稳定；
> 2. 稳定之后**整理进这个仓库**，大改要开**版本号命名的分支**，回归通过再合 main。

## 零、先在实例上改（日常开发都在这里）

真正跑着的插件是 `D:\dfy\qq-bridge\plugins\dsh-dfy-memory`，她用的就是它。

```bash
# 直接改实例里的代码 → 重启 DSH → 看她用起来对不对
# 改完先跑实例自己的自检：
cd D:\dfy\qq-bridge\plugins\dsh-dfy-memory
node selfcheck.mjs
```

**稳定的意思**：她实际用了一两天没出问题，或者至少你亲手验证过关键路径。

## 一、整理进仓库

```bash
cd D:\Workspace\dsh-dfy-memory

# 把实例的代码搬过来（自动跳过没变化的文件）
node scripts/sync-from-instance.mjs D:/dfy/qq-bridge/plugins/dsh-dfy-memory --dry   # 先看会改哪些
node scripts/sync-from-instance.mjs D:/dfy/qq-bridge/plugins/dsh-dfy-memory         # 真搬
```

**不会搬的东西**（各有各的理由）：

| 文件 | 为什么不同步 |
|---|---|
| `cordis.patch.yml` | 实例里写的是真实盘符路径；仓库靠 `~/.dsh` 默认值 |
| `client.js` | 设置页标题：实例「大肥鱼记忆」/ 仓库「AI 记忆」 |
| `package.json` | 版本号和仓库地址要在仓库里手改 |
| `README.md` | 更新记录在仓库里写 |

## 二、日常小修（不值得开分支）

```bash
git add -A
git commit -m "fix: 一句话说清改了什么"
git push
```

## 三、一次大改（新功能、行为变更、数据结构调整）

### 1. 开分支，用版本号命名

```bash
cd D:\Workspace\dsh-dfy-memory
git checkout main
git pull                                   # 先跟上远端

git checkout -b v0.7.0                     # 分支名 = 目标版本号
```

### 2. 在分支上迭代

```bash
# 改代码……
node selfcheck.mjs                          # 必须全过，条数只增不减（除非改的是断言本身的语义）
git add -A
git commit -m "feat(v0.7.0): 做了什么"
git push -u origin v0.7.0                   # 推分支（可选，但建议推，远端有备份）
```

### 3. 顺手把版本号和三处说明改齐

| 改哪 | 内容 |
|---|---|
| `package.json` | `version` 改成 `0.7.0` |
| `README.md` | 「更新记录」加一节 `### 0.7.0（日期）` |
| `selfcheck.mjs` | 新功能的用例 + 工具数量断言 |

### 4. 验证通过后合回 main

```bash
git checkout main
git merge --no-ff v0.7.0 -m "merge: v0.7.0"
node selfcheck.mjs                          # 合完再跑一遍
git push
```

`--no-ff` 是为了保留分支痕迹 —— 以后 `git log --graph` 能看出"这一版是怎么长出来的"。

### 5. 打 tag

```bash
git tag -a v0.7.0 -m "v0.7.0：一句话说明"
git push origin v0.7.0
```

### 6. 删掉已合并的分支

```bash
git branch -d v0.7.0
git push origin --delete v0.7.0             # 远端那份也删
```

## 四、出问题要回滚

```bash
git checkout main
git revert -m 1 <merge-commit-sha>          # 撤销一次合并（保留历史）
git push
```

别用 `reset --hard` 推上去 —— 别人 clone 过的仓库会被搞坏。

## 五、版本号怎么定

| 变化 | 版本 |
|---|---|
| 加了新工具 / 新数据字段 / 行为变了 | `0.X.0`（次版本 +1） |
| 只修 bug、不动对外行为 | `0.X.Y`（修订 +1） |
| 破坏性改名、数据格式不兼容 | `1.0.0` 或 `0.X.0` 并在 README 写明迁移 |

## 六、提交信息格式（简单够用）

```
feat: 新增邮箱（dfy_mail_send / list / read）
fix: D-1 滚动时不再删她写的摘要
docs: README 补 0.6.3 更新记录
refactor: 把窗口裁剪拆成 smartTrim
test: 补草稿→定稿的用例
```

## 七、提交前自查

```bash
git status --short                          # 确认没有 data/ 之类的私人文件混进来
node selfcheck.mjs                          # 全过
```

`.gitignore` 已经挡住 `memory/ diary/ state/ works/ mailbox/ context/ archive/`、`_backup-*`、`.idea`。
**永远不要** `git add -f` 去强加这些目录 —— 里面是她真实的记忆和作品。
