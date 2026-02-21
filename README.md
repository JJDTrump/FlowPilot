# FlowPilot (改进版)

基于 Claude Code Agent Teams 的全自动工作流调度引擎 -- 在 [6BNBN/FlowPilot](https://github.com/6BNBN/FlowPilot) 基础上深度改造，重点强化中断恢复和并发安全能力。

单文件 64KB，零运行时依赖，复制到任意项目即可使用。

---

## 目录

- [改进版 vs 原版](#改进版-vs-原版)
- [快速开始](#快速开始)
- [核心机制详解](#核心机制详解)
  - [中断恢复体系](#41-中断恢复体系)
  - [并发安全机制](#42-并发安全机制)
  - [三层记忆 + 心跳](#43-三层记忆--心跳)
  - [任务生命周期](#44-任务生命周期)
- [命令参考](#命令参考)
- [配置系统](#配置系统)
- [支持的项目类型](#支持的项目类型)
- [架构概览](#架构概览)
- [完整改动对照表](#与原版的完整改动对照表)
- [开发](#开发)
- [致谢](#致谢)

---

## 改进版 vs 原版

本 fork 对原版进行了 28 项改进，按四大类别分组如下。

### 中断恢复（8 项）

| # | 改进项 | 原版行为 | 改进版行为 |
|---|--------|----------|------------|
| 1 | resume 增强输出 | 仅返回简短恢复消息 | 输出完整任务状态表 + 项目摘要 + 被重置的任务列表，新会话的 Claude 能立即理解全局 |
| 2 | 心跳文件 | 无 | `heartbeat.json` 记录最后执行的命令、时间戳和活跃任务 ID，即使未 checkpoint 也能追踪进度 |
| 3 | CLAUDE.md 状态水印 | 无 | 每次 `next`/`checkpoint` 后在 CLAUDE.md 嵌入 `<!-- flowpilot:watermark -->` 块，Context Window Compact 后 Claude 重读即可重建认知 |
| 4 | 执行历史日志 | 无 | `history.jsonl` 记录完整操作流水（init/next/checkpoint/skip/fail/resume/finish/add/edit/pause），可通过 `log` 命令查看 |
| 5 | resume 全量重置报告 | 只处理第一个 active 任务 | 重置所有 active 任务并报告全部被重置的 ID 列表，并行中断场景不遗漏 |
| 6 | git stash 保留变更 | 中断恢复时丢弃未提交变更 | 使用 `git stash push` 保留半成品代码，可随时 `git stash pop` 找回 |
| 7 | 自动清理过期 stash | 无 | 保留最近 5 个 flowpilot stash 条目，自动 drop 更老的，防止 stash 列表膨胀 |
| 8 | 失败原因记录 | 仅计数重试次数 | `failHistory[]` 保存每次失败的详细原因，重试时子 Agent 能看到上次为什么失败 |

### 并发安全（5 项）

| # | 改进项 | 原版行为 | 改进版行为 |
|---|--------|----------|------------|
| 9 | 文件锁重写 | 简单文件锁，无法检测死进程 | PID + 时间戳写入锁文件，活性检测判断持有者是否存活，死进程安全破锁，超过 60 秒的僵尸锁自动清理 |
| 10 | 原子写入 | 直接写入目标文件 | write-to-temp-then-rename 模式，临时文件路径包含 PID + 时间戳确保唯一，写入中途崩溃不会损坏数据 |
| 11 | 全方法加锁 | resume/review 等方法缺少锁保护 | 所有写操作方法（next/nextBatch/checkpoint/skip/add/edit/pause/resume/review/finish）全部加锁 |
| 12 | finish 分段加锁 | 持锁执行验证（长操作阻塞其他命令） | 第一段加锁读取数据，释放锁执行验证（可能耗时数分钟），第二段重新加锁完成提交和清理 |
| 13 | 锁超时抛错 | 超时后静默破锁 | 超时后直接抛出错误，绝不静默破锁导致并发问题 |

### 架构改进（7 项）

| # | 改进项 | 原版行为 | 改进版行为 |
|---|--------|----------|------------|
| 14 | Repository 接口拆分 | 单一仓储接口 | 拆分为 `WorkflowRepository`（数据持久化）、`GitService`（版本控制）、`VerifyService`（项目验证）三个独立接口 |
| 15 | 用户配置体系 | 硬编码参数 | `FlowConfig` 支持自定义验证命令、超时、并行数、重试次数、锁超时等，通过 `.workflow/config.json` 持久化 |
| 16 | 任务时间戳 | 无时间信息 | `timestamps` 字段记录 `created`/`started`/`completed`/`lastFailed` 四个时间点 |
| 17 | failed 状态 + 级联跳过 | 失败直接跳过 | 新增 `failed` 状态，依赖了 failed/skipped 任务的 pending 任务自动标记 `skipped`（级联跳过） |
| 18 | 循环依赖检测 | 无 | `next`/`nextBatch` 执行前检测任务图中的循环引用，发现后立即报错并给出环路径 |
| 19 | 超时任务检测 | 无 | `detectTimeoutTasks` 可检测超过指定时间仍为 active 的任务（默认 30 分钟） |
| 20 | 项目类型扩展 | 支持 8 种项目类型 | 支持 14 种项目类型自动验证（新增 .NET/Ruby/PHP/Elixir/Dart(Flutter)/Swift） |

### 用户体验（8 项）

| # | 改进项 | 原版行为 | 改进版行为 |
|---|--------|----------|------------|
| 21 | edit 命令 | 无 | 修改 pending 任务的标题、描述、类型、依赖关系 |
| 22 | show 命令 | 无 | 查看任务详情，包括失败记录、时间戳和产出上下文 |
| 23 | log 命令 | 无 | 查看执行历史（最近 30 条），含时间戳、事件类型和详情 |
| 24 | pause 命令 | 无 | 手动暂停工作流，所有 active 任务重置为 pending，状态设为 idle |
| 25 | add 命令增强 | 仅��持标题和类型 | 新增 `--deps` 指定依赖、`--desc` 指定描述 |
| 26 | finish 自动清理 | 工作流文件残留 | 完成后自动清除 CLAUDE.md 中的协议块、.claude/settings.json 中的 Hooks、整个 .workflow 目录 |
| 27 | 进度条可视化 | 纯文本进度 | `status` 命令输出包含图形化进度条 `[████████░░░░] 67%` |
| 28 | Git 子模块支持 | 无 | 自动检测子模块边界，按子模块分组提交，父仓库自动更新子模块指针 |

---

## 快速开始

### 三步启动

```bash
# 第一步：构建单文件
cd FlowPilot && npm install && npm run build

# 第二步：复制到目标项目
cp dist/flow.js /your/project/

# 第三步：初始化
cd /your/project && node flow.js init
```

### 全自动模式

```bash
# 跳过所有权限确认，实现真正无人值守
claude --dangerously-skip-permissions
```

打开 Claude Code 后直接描述需求即可：

```
你：帮我做一个博客系统，用户注册、文章管理、评论功能、标签分类
（然后就不用管了）
```

Claude Code 会自动完成：拆解任务 -> 识别依赖 -> 并行派发子 Agent -> 写代码 -> checkpoint -> git commit -> build/test/lint -> 全部完成。

### 中断恢复

```bash
# 接续最近一次对话
claude --dangerously-skip-permissions --continue

# 从历史对话列表选择
claude --dangerously-skip-permissions --resume
```

新会话中只需说"继续任务"，FlowPilot 会自动执行 `resume` 恢复到中断前的状态。

---

## 核心机制详解

### 4.1 中断恢复体系

这是改进版最核心的能力。Claude Code 的工作环境天然不稳定 -- 网络可能中断、窗口可能关闭、上下文可能被压缩。改进版针对每种中断场景都设计了专门的应对策略。

#### 场景 1：Claude Code 窗口关闭 / 断网

**症状**：对话中断，所有子 Agent 立即停止，工作流停在半途。

**恢复方式**：打开新窗口 -> 说"继续任务" -> FlowPilot 自动执行 `flow resume`。

**原理**：
- 所有 active 状态的任务被重置为 pending，等待重新派发
- 未提交的代码变更通过 `git stash push` 保留，不会丢失
- 已经 checkpoint 的任务状态安全持久化在磁盘，不受影响

**改进点**：
- resume 现在输出完整的任务状态表和项目摘要，新会话的 Claude 无需翻阅历史就能理解全局进展
- 报告所有被重置的任务 ID（原版只报告第一个），并行中断场景不遗漏
- 自动清理过期的 stash 条目（保留最近 5 个），避免 stash 列表无限增长

#### 场景 2：API 中断 / 网络超时

**症状**：Claude 调用 Anthropic API 失败，当前 turn 中断。

**恢复方式**：Claude 自动重试，或用户重新发消息触发恢复。

**原理**：
- 如果子 Agent 已经执行了 checkpoint，状态已经安全持久化到 `.workflow/progress.md`，中断无影响
- 如果子 Agent 尚未 checkpoint，resume 会将其重置为 pending 重新执行

**改进点**：
- 心跳文件 `heartbeat.json` 记录最后执行的操作和时间戳，即使没有 checkpoint 也能知道工作流进行到了哪一步
- 心跳数据包含 `lastCommand`（最后执行的命令）、`timestamp`（时间戳）和 `activeTaskIds`（活跃任务列表），为调试和恢复决策提供依据

#### 场景 3：Context Window Compact（最棘手的场景）

**症状**：Claude Code 自动压缩上下文，主 Agent 丢失对话记忆，但进程本身没有中断。

**关键问题**：这不是一次"新会话"，所以 `resume` 不会被自动触发。Compact 后主 Agent 可能不知道工作流进行到了哪里。

**原版缺陷**：完全没有应对机制。Compact 后主 Agent 可能重复派发任务或跳过任务。

**改进方案（四层防御）**：

1. **CLAUDE.md 状态水印**：每次 `next` 或 `checkpoint` 操作后，在 CLAUDE.md 中更新 `<!-- flowpilot:watermark -->` 块，写入当前活跃任务列表。Compact 后 Claude 重新读取 CLAUDE.md 时会看到这个水印，据此理解当前状态。

2. **心跳文件**：`.workflow/heartbeat.json` 实时记录最后操作的命令和时间戳。Compact 后可通过 `flow status` 读取心跳信息重建认知。

3. **执行历史**：`.workflow/history.jsonl` 记录完整的操作流水。即使水印和心跳都丢失，历史日志仍可还原完整时间线。

4. **协议层防御指令**：工作流协议（嵌入 CLAUDE.md）中包含防御性规则 -- 当主 Agent 不确定当前状态时，必须先执行 `flow status` 重建认知后再继续。

#### 场景 4：并行子 Agent 部分中断

**症状**：同时派发了 3 个子 Agent，其中 1 个成功 checkpoint，另外 2 个因中断未完成。

**恢复方式**：执行 `flow resume`，所有 active 任务被重置为 pending。

**原理**：
- 已经 checkpoint 的任务状态为 done，不受 resume 影响
- 未 checkpoint 的 active 任务全部重置为 pending，等待下一轮 `next --batch` 重新派发
- resume 返回所有被重置的任务 ID 列表，方便确认哪些任务需要重做

**改进点**：
- 原版只报告第一个被重置的 ID，改进版报告全部
- `git stash` 保存半成品代码，不会因 resume 而丢失已写的代码
- 自动清理过期 stash（保留最近 5 个），防止 stash 堆积

#### 场景 5：子 Agent 执行失败

**症状**：子 Agent 写的代码报错、测试不通过、或实现方向不正确。

**恢复方式**：子 Agent 通过 `echo 'FAILED' | node flow.js checkpoint <id>` 报告失败，系统自动重试。

**原理**：
- 失败后任务状态不是直接标记为 failed，而是先重置为 pending 等待重试
- 最多重试 3 次（可通过 `maxRetries` 配置），3 次仍失败才标记为 failed
- 被标记为 failed 的任务会触发级联跳过：所有依赖该任务的下游任务自动标记为 skipped

**改进点**：
- `failHistory[]` 数组记录每次失败的详细原因（如"第 1 次：编译错误 xxx"），重试时子 Agent 能看到上次失败的原因，避免重蹈覆辙
- `show` 命令可查看任务的完整失败记录，方便排查问题
- 失败时间戳 `lastFailed` 精确记录最后一次失败的时间

---

### 4.2 并发安全机制

当多个 `node flow.js` 进程同时操作同一个 `.workflow/` 目录时，必须保证数据一致性。改进版从四个层面解决并发问题。

#### 文件锁重写

原版的文件锁是简单的 `O_EXCL` 创建，无法检测持有锁的进程是否已经死亡。改进版的锁机制：

```
获取锁:
1. 尝试以 O_EXCL 模式创建 .workflow/.lock
2. 成功 -> 写入 PID + 时间戳，返回
3. 失败 -> 读取锁文件内容
4. 解析出持有者 PID，用 process.kill(pid, 0) 检测是否存活
5. 持有者已死 -> 安全删除锁文件，重试
6. 持有者存活但锁龄超过 60 秒 -> 视为僵尸锁，安全删除并重试
7. 持有者存活且锁龄正常 -> 等待 50ms 后重试
8. 超过 maxWait（默认 30 秒） -> 抛出错误，绝不静默破锁
```

这套机制确保了：
- 正常的锁竞争有序等待
- 进程崩溃后不会留下永久性死锁
- 僵尸锁有兜底清理
- 超时后明确报错，不会导致数据竞争

#### 原子写入

所有文件写入操作使用 write-to-temp-then-rename 模式：

```typescript
const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
await writeFile(tmp, content, 'utf-8');
await rename(tmp, path);
```

临时文件路径包含 PID 和时间戳，确保即使多个进程同时写同一个文件，临时文件也不会冲突。`rename` 操作在 POSIX 文件系统上是原子的，要么完全成功要么完全失败，不会出现写到一半的损坏文件。

#### 全方法加锁

改进版确保所有修改状态的方法都在锁保护内执行：

| 方法 | 原版有锁 | 改进版有锁 |
|------|----------|------------|
| next / nextBatch | 是 | 是 |
| checkpoint | 是 | 是 |
| skip | 是 | 是 |
| add | 是 | 是 |
| edit | - | 是 |
| pause | - | 是 |
| resume | 否 | 是 |
| review | 否 | 是 |
| finish | 部分 | 分段加锁 |

#### finish 分段加锁

`finish` 命令需要执行项目验证（build/test/lint），这可能耗时数分钟。如果全程持锁，会阻塞其他所有命令。改进版采用分段加锁策略：

```
第一段（加锁）:
  读取 progress 数据
  检查是否所有任务完成
  设置状态为 finishing
  释放锁

验证阶段（无锁）:
  执行 build / test / lint
  （可能耗时数分钟，期间不阻塞其他命令）

第二段（重新加锁）:
  重新读取最新数据（可能被其他命令修改）
  检查 code-review 是否完成
  执行 git commit
  清理 CLAUDE.md / Hooks / .workflow/
  释放锁
```

---

### 4.3 三层记忆 + 心跳

改进版在原版三层记忆的基础上新增了心跳层、水印层和历史层，形成完整的状态追踪体系。

| 层级 | 文件 | 读者 | 内容 | 改进 |
|------|------|------|------|------|
| 第一层（状态） | `progress.md` | 主 Agent | 极简状态表（ID/标题/状态/摘要） | 新增元数据注释行，存储 activeTaskIds 和 startedAt |
| 第二层（上下文） | `context/task-xxx.md` | 子 Agent | 每个任务的详细产出和决策记录 | 原子写入保护 |
| 第三层（摘要） | `context/summary.md` | 子 Agent | 滚动摘要，超过阈值自动按类型分组压缩 | 压缩阈值可配置（默认 50） |
| 心跳层 | `heartbeat.json` | 恢复逻辑 | 最后操作命令、时间戳、活跃任务 | **新增** |
| 水印层 | CLAUDE.md 中的注释块 | 主 Agent（Compact 后） | 当前活跃任务列表 | **新增** |
| 历史层 | `history.jsonl` | `log` 命令 | 完整操作流水日志 | **新增** |

`flow next` 自动拼装依赖上下文：summary + 所有依赖任务的 task-xxx.md -> 注入子 Agent prompt。主 Agent 永远只读 progress.md，上下文占用极小。

---

### 4.4 任务生命周期

```
pending ---------> active ---------> done
  ^                  |
  |                  | (checkpoint 'FAILED')
  |                  v
  +--- (重试) --- failed
                     |
                     | (重试次数 >= maxRetries，默认 3)
                     v
                   failed (最终) ---> 级联 skipped（下游依赖任务）
```

每个状态转换都带有精确的时间戳：

| 字段 | 记录时机 |
|------|----------|
| `timestamps.created` | 任务创建时（init 或 add） |
| `timestamps.started` | 任务被 next/nextBatch 取出时 |
| `timestamps.completed` | checkpoint 成功时 |
| `timestamps.lastFailed` | checkpoint FAILED 时 |

此外，`retries` 字段记录已重试次数，`failHistory[]` 数组记录每次失败的详细原因。

---

## 命令参考

### init -- 初始化工作流

```bash
# 从 stdin 读取任务定义
cat <<'EOF' | node flow.js init
# 电商系统
1. [backend] 数据库设计
   设计用户表、商品表、订单表
2. [backend] 用户API (deps: 1)
   注册、登录、个人信息
3. [frontend] 用户页面 (deps: 2)
   注册页、登录页、个人中心
EOF

# 强制覆盖已有工作流
cat tasks.md | node flow.js init --force

# 无 stdin 时进入项目接管模式（仅写入协议和 Hooks）
node flow.js init
```

**参数**：
- `--force`：覆盖已有的进行中工作流

**任务定义格式**：
- `N. [type] 标题` -- 序号 + 类型（frontend/backend/general）+ 标题
- `(deps: N,M)` -- 依赖关系，逗号分隔序号
- 缩进行 -- 任务描述

**注意事项**：
- init 会自动在 CLAUDE.md 中嵌入工作流协议
- 会在 `.claude/settings.json` 中注入 Hooks 拦截原生 Task 工具
- 会创建 `.workflow/config.json` 保存默认配置

---

### next -- 获取待执行任务

```bash
# 获取单个任务
node flow.js next

# 获取所有可并行执行的任务（推荐）
node flow.js next --batch
```

**参数**：
- `--batch`：返回所有依赖已满足的 pending 任务，而非仅返回第一个

**注意事项**：
- 如果有任何任务仍为 active 状态，此命令会拒绝执行并报错，要求先 checkpoint 或 resume
- 输出包含完整的 checkpoint 指令模板，可直接复制到子 Agent prompt 中
- 并行任务数受 `maxParallel` 配置限制

---

### checkpoint -- 记录任务完成

```bash
# 通过 stdin 传入摘要（推荐）
echo '实现了用户注册和登录API' | node flow.js checkpoint 001 --files src/auth.ts src/routes.ts

# 报告任务失败
echo 'FAILED' | node flow.js checkpoint 001

# 通过 --file 从文件读取摘要
node flow.js checkpoint 001 --file summary.txt --files src/auth.ts

# 内联摘要
node flow.js checkpoint 001 实现了用户注册和登录API
```

**参数**：
- `<id>`：三位数任务 ID（如 001）
- `--files <f1> <f2> ...`：本次任务创建或修改的文件列表，用于精确 git commit
- `--file <path>`：从文件读取摘要内容

**注意事项**：
- 只有 active 状态的任务可以 checkpoint
- `--files` 列表是 git 自动提交的关键，遗漏会导致文件未被 commit
- 传入 `FAILED` 会触发失败重试机制（最多 3 次）
- checkpoint 成功后自动更新心跳和水印

---

### skip -- 手动跳过任务

```bash
node flow.js skip 003
```

**参数**：
- `<id>`：要跳过的任务 ID

**注意事项**：
- 跳过 active 状态的任务会输出警告（子 Agent 可能仍在运行）
- 已完成（done）的任务不能跳过
- 跳过的任务会触发级联跳过：依赖该任务的下游 pending 任务也会被自动跳过

---

### edit -- 修改待执行任务

```bash
# 修改标题
node flow.js edit 003 --title "新的标题"

# 修改描述
node flow.js edit 003 --desc "更详细的任务描述"

# 修改类型
node flow.js edit 003 --type frontend

# 修改依赖
node flow.js edit 003 --deps 001,002

# 组合修改
node flow.js edit 003 --title "新标题" --type backend --deps 001
```

**参数**：
- `<id>`：任务 ID
- `--title <text>`：新标题
- `--desc <text>`：新描述
- `--type <frontend|backend|general>`：新类型
- `--deps <id1,id2>`：新依赖列表（逗号分隔）

**注意事项**：
- 只能编辑 pending 状态的任务
- 至少需要指定一个修改项
- 依赖 ID 必须存在且不能依赖自己

---

### show -- 查看任务详情

```bash
node flow.js show 001
```

**输出内容**：
- 标题、类型、状态、依赖关系
- 重试次数（如 `0/3`）
- 描述和完成摘要
- 开始和完成时间戳
- 失败记录（如有）
- 产出上下文（task-xxx.md 的内容）

---

### log -- 查看执行历史

```bash
node flow.js log
```

**输出格式**：

```
=== 执行历史 ===

2026-02-21T10:30:00.000Z init 电商系统
2026-02-21T10:30:05.000Z next [001] 数据库设计
2026-02-21T10:35:00.000Z checkpoint [001] 完成数据库表设计
2026-02-21T10:35:01.000Z next batch: 002,003
```

**注意事项**：
- 显示最近 30 条记录
- 事件类型包括：init/next/checkpoint/skip/fail/resume/finish/add/edit/pause

---

### pause -- 暂停工作流

```bash
node flow.js pause
```

**行为**：
- 将所有 active 任务重置为 pending
- 清空 activeTaskIds
- 工作流状态设为 idle

**恢复**：使用 `node flow.js resume` 恢复。

**注意事项**：
- 只有 running 状态的工作流可以暂停
- 暂停不会丢失任何已完成的工作

---

### resume -- 中断恢复

```bash
node flow.js resume
```

**行为**：
- 将所有 active 任务重置为 pending
- 使用 `git stash` 保存未提交变更
- 清理过期的 stash 条目
- 输出完整的任务状态表和项目摘要

**输出示例**：

```
恢复工作流: 电商系统
进度: 3/8
中断任务 004, 005 已重置，将重新执行

--- 任务状态 ---
[x] 001 [backend] 数据库设计 - 完成数据库表设计
[x] 002 [backend] 用户API - 实现注册登录接口
[x] 003 [backend] 商品API - 实现商品CRUD
[ ] 004 [frontend] 用户页面
[ ] 005 [frontend] 商品���面
[ ] 006 [frontend] 购物车
[ ] 007 [backend] 订单系统
[ ] 008 [general] 集成测试

--- 项目摘要 ---
# 电商系统
- [backend] 001: 数据库设计: 完成数据库表设计
- [backend] 002: 用户API: 实现注册登录接口
- [backend] 003: 商品API: 实现商品CRUD

请执行 node flow.js next --batch 继续
```

---

### review -- 标记 code-review 完成

```bash
node flow.js review
```

**注意事项**：
- 只在 finishing 阶段可用
- 必须在 `finish` 之前（或之间）执行
- 用于标记 code-review 子 Agent 的工作已完成

---

### finish -- 智能收尾

```bash
node flow.js finish
```

**行为流程**：

```
第一次 finish:
  检查所有任务是否完成 -> 执行项目验证（build/test/lint）
  验证通过 -> 提示"请派子Agent执行 code-review"
  验证失败 -> 报错并给出失败脚本和错误信息

执行 code-review 后:
  node flow.js review  （标记 review 完成）

第二次 finish:
  再次验证 -> 通过 -> git commit -> 清理 CLAUDE.md / Hooks / .workflow/ -> 完成
```

**注意事项**：
- finish 需要执行两次：第一次触发验证和 review，第二次完成最终提交
- 验证超时默认 5 分钟（可通过 `verifyTimeout` 配置）
- 最终 finish 会清除所有 FlowPilot 痕迹（CLAUDE.md 协议块、Hooks、.workflow 目录）

---

### status -- 查看全局进度

```bash
node flow.js status
```

**输出示例**：

```
=== 电商系统 ===
状态: running | 进度: [████████░░░░░░░░░░░░] 40% (4/10)
活跃: 005, 006

[x] 001 [backend] 数据库设计 - 完成数据库表设计
[x] 002 [backend] 用户API - 实现注册登录接口
[x] 003 [backend] 商品API - 实现商品CRUD
[x] 004 [backend] 订单API - 实现订单CRUD
[>] 005 [frontend] 用户页面
[>] 006 [frontend] 商品页面
[ ] 007 [frontend] 购物车
[ ] 008 [frontend] 订单页面
[ ] 009 [general] 集成测试
[-] 010 [general] 性能优化 - 手动跳过
```

---

### add -- 追加任务

```bash
# 基本用法
node flow.js add 添加支付模块

# 指定类型和描述
node flow.js add 支付接口对接 --type backend --desc "接入支付宝和微信支付SDK"

# 指定依赖
node flow.js add 支付页面 --type frontend --deps 004,005
```

**参数**：
- `<标题>`：任务标题（必填）
- `--type <frontend|backend|general>`：任务类型，默认 general
- `--desc <text>`：任务描述
- `--deps <id1,id2>`：依赖的任务 ID 列表（逗号分隔）

**注意事项**：
- 新任务 ID 自动递增（基于当前最大 ID）
- 依赖 ID 必须指向已存在的任务

---

## 配置系统

初始化时自动创建 `.workflow/config.json`，包含以下配置项：

```json
{
  "autoCommit": true,
  "verifyCommands": ["npm run build", "npm test"],
  "verifyTimeout": 300000,
  "summaryCompressThreshold": 50,
  "maxParallel": 5,
  "maxRetries": 3,
  "lockTimeout": 30000
}
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `autoCommit` | boolean | `true` | 每次 checkpoint 成功后是否自动 git commit |
| `verifyCommands` | string[] | 自动检测 | 自定义验证命令，设置后覆盖自动检测结果 |
| `verifyTimeout` | number | `300000` | 验证命令超时时间（毫秒），即 5 分钟 |
| `summaryCompressThreshold` | number | `50` | 完成任务数超过此值时，summary.md 按类型分组压缩 |
| `maxParallel` | number | 无限制 | `next --batch` 返回的最大并行任务数 |
| `maxRetries` | number | `3` | 任务失败后最多重试次数，超过后标记为 failed |
| `lockTimeout` | number | `30000` | 文件锁等待超时时间（毫秒），超时后抛错 |

**修改方式**：直接编辑 `.workflow/config.json` 文件，或在 `init` 之前手动创建。不提供的字段会使用默认值。

---

## 支持的项目类型

FlowPilot 在 `finish` 阶段会自动检测项目类型并执行对应的验证命令。支持以下 14 种项目类型：

| 项目类型 | 检测标记 | 自动执行的验证命令 |
|----------|----------|-------------------|
| Node.js | `package.json` | `npm run build`、`npm run test`、`npm run lint`（仅存在对应 script 时） |
| Python | `pyproject.toml` / `setup.py` / `requirements.txt` | `ruff check .`（如有）、`mypy .`（如有）、`python -m pytest --tb=short -q` |
| Rust | `Cargo.toml` | `cargo build`、`cargo test` |
| Go | `go.mod` | `go build ./...`、`go test ./...` |
| Java (Maven) | `pom.xml` | `mvn compile -q`、`mvn test -q` |
| Java (Gradle) | `build.gradle` / `build.gradle.kts` | `gradle build` |
| C++ (CMake) | `CMakeLists.txt` | `cmake --build build`、`ctest --test-dir build` |
| Makefile | `Makefile` | `make build`、`make test`、`make lint`（仅存在对应 target 时） |
| .NET (C#/F#) | `.sln` / `.csproj` | `dotnet build`、`dotnet test` |
| Ruby | `Gemfile` | `rubocop`（如有 `.rubocop.yml`）、`bundle exec rake test` |
| PHP (Composer) | `composer.json` | `composer test`、`composer lint`（或 `vendor/bin/phpunit`） |
| Elixir | `mix.exs` | `mix compile`、`mix test` |
| Dart/Flutter | `pubspec.yaml` | `dart analyze`/`flutter analyze`、`dart test`/`flutter test` |
| Swift (SPM) | `Package.swift` | `swift build`、`swift test` |

**优先级**：按上表顺序检测，匹配到第一个即停止。可通过 `verifyCommands` 配置项覆盖自动检测结果。

---

## 架构概览

```
主Agent（调度器，< 100行上下文）
  |
  +-- node flow.js next -----> 返回任务 + 依赖上下文
  |
  +-- 子Agent（Task工具派发）
  |    +-- frontend --> /frontend-design 插件 + 其他匹配 Skill/MCP
  |    +-- backend  --> /feature-dev 插件 + 其他匹配 Skill/MCP
  |    +-- general  --> 直接执行 + 其他匹配 Skill/MCP
  |
  +-- node flow.js checkpoint --> 记录产出 + git commit
  |
  +-- .workflow/（持久化层）
       +-- progress.md          # 任务状态表（主Agent读）
       +-- tasks.md             # 完整任务定义（原始 markdown）
       +-- config.json          # 用户配置 [新增]
       +-- heartbeat.json       # 心跳文件 [新增]
       +-- history.jsonl        # 执行历史 [新增]
       +-- .lock                # 文件锁（PID + 时间戳）[重写]
       +-- context/
            +-- summary.md      # 滚动摘要
            +-- task-001.md     # 各任务详细产出
            +-- task-002.md
            +-- ...
```

### 与原版的架构差异

**接口拆分**：原版使用单一的仓储接口，改进版拆分为三个职责清晰的接口：

| 接口 | 职责 | 方法数 |
|------|------|--------|
| `WorkflowRepository` | 数据持久化：progress/tasks/summary/config/heartbeat/watermark/history | 20+ |
| `GitService` | 版本控制：commit/cleanup/pruneStash | 3 |
| `VerifyService` | 项目验证：verify | 1 |

`FsWorkflowRepository` 类同时实现这三个接口，通过依赖注入传入 `WorkflowService`。

**新增类型定义**：

| 类型 | 用途 |
|------|------|
| `FlowConfig` | 用户配置（autoCommit/verifyTimeout/maxParallel/maxRetries/lockTimeout 等） |
| `HistoryEntry` | 执行历史条目（时间戳 + 事件类型 + 任务 ID + 详情） |
| `TaskEntry.timestamps` | 时间戳对象（created/started/completed/lastFailed） |
| `TaskEntry.failHistory` | 失败原因历史数组 |

### 依赖方向

```
interfaces --> application --> domain <-- infrastructure
```

运行时零外部依赖，只使用 Node.js 内置模块（fs、path、child_process）。

---

## 与原版的完整改动对照表

按优先级排列的 28 项改进完整表格：

| 优先级 | # | 类别 | 改进项 | 文件 |
|--------|---|------|--------|------|
| P0 | 9 | 并发安全 | 文件锁重写（PID + 活性检测 + 死进程安全破锁） | fs-repository.ts |
| P0 | 10 | 并发安全 | 原子写入（write-to-temp-then-rename） | fs-repository.ts |
| P0 | 13 | 并发安全 | 锁超时抛错（不再静默破锁） | fs-repository.ts |
| P0 | 11 | 并发安全 | 全方法加锁（resume/review/finish 补锁） | workflow-service.ts |
| P0 | 12 | 并发安全 | finish 分段加锁（验证期间不持锁） | workflow-service.ts |
| P0 | 1 | 中断恢复 | resume 增强输出（状态表 + 摘要） | workflow-service.ts |
| P0 | 3 | 中断恢复 | CLAUDE.md 状态水印（Compact 恢复） | fs-repository.ts |
| P0 | 2 | 中断恢复 | 心跳文件（heartbeat.json） | fs-repository.ts |
| P1 | 5 | 中断恢复 | resume 全量重置报告 | task-store.ts |
| P1 | 6 | 中断恢复 | git stash 保留变更（不再丢弃） | git.ts |
| P1 | 7 | 中断恢复 | 自动清理过期 stash | git.ts |
| P1 | 8 | 中断恢复 | 失败原因记录（failHistory） | types.ts, task-store.ts |
| P1 | 4 | 中断恢复 | 执行历史日志（history.jsonl） | fs-repository.ts |
| P1 | 17 | 架构改进 | failed 状态 + 级联跳过 | task-store.ts |
| P1 | 18 | 架构改进 | 循环依赖检测 | task-store.ts |
| P1 | 14 | 架构改进 | Repository 接口拆分 | repository.ts |
| P1 | 15 | 架构改进 | FlowConfig 用户配置体系 | types.ts |
| P1 | 16 | 架构改进 | 任务时间戳 | types.ts |
| P2 | 21 | 用户体验 | edit 命令 | cli.ts, workflow-service.ts |
| P2 | 22 | 用户体验 | show 命令 | cli.ts, workflow-service.ts |
| P2 | 23 | 用户体验 | log 命令 | cli.ts, workflow-service.ts |
| P2 | 24 | 用户体验 | pause 命令 | cli.ts, workflow-service.ts |
| P2 | 25 | 用户体验 | add 命令增强（--deps/--desc） | cli.ts |
| P2 | 26 | 用户体验 | finish 自动清理 | workflow-service.ts, fs-repository.ts |
| P2 | 27 | 用户体验 | 进度条可视化 | formatter.ts |
| P2 | 28 | 用户体验 | Git 子模块支持 | git.ts |
| P2 | 19 | 架构改进 | 超时任务检测 | task-store.ts |
| P2 | 20 | 架构改进 | 项目类型扩展（8 -> 14 种） | verify.ts |

---

## 开发

### 构建

```bash
cd FlowPilot
npm install
npm run build        # 构建 -> dist/flow.js（单文件，约 64KB）
```

### 开发模式

```bash
npm run dev          # 使用 tsx 直接运行 TypeScript
```

### 测试

```bash
npm test             # 使用 vitest 运行测试
```

### 源码结构

```
src/
+-- main.ts                          # 入口，依赖注入组装
+-- domain/
|   +-- types.ts                     # 值对象：TaskEntry, ProgressData, FlowConfig, HistoryEntry
|   +-- task-store.ts                # 任务状态管理（纯函数：查找/完成/失败/恢复/级联跳过/循环检测）
|   +-- workflow.ts                  # WorkflowDefinition 定义
|   +-- repository.ts               # 接口：WorkflowRepository + GitService + VerifyService
+-- application/
|   +-- workflow-service.ts          # 核心用例（13 个：init/next/nextBatch/checkpoint/skip/edit/show/log/pause/resume/review/finish/add）
+-- infrastructure/
|   +-- fs-repository.ts             # 文件系统实现 + CLAUDE.md 协议嵌入 + Hooks 注入 + 文件锁 + 原子写入
|   +-- markdown-parser.ts           # 任务 Markdown 解析 + 定义验证
|   +-- git.ts                       # Git 自动提交 + stash 管理 + 子模块支持
|   +-- verify.ts                    # 14 种项目类型自动验证
+-- interfaces/
    +-- cli.ts                       # 命令路由（13 个命令）
    +-- formatter.ts                 # 输出格式化（状态表/任务详情/批次/进度条）
    +-- stdin.ts                     # stdin 读取
```

### 依赖方向

```
interfaces --> application --> domain <-- infrastructure
```

运行时零外部依赖，只使用 Node.js 内置模块（`fs`、`path`、`child_process`）。

开发依赖：`tsup`（构建）、`tsx`（开发运行）、`vitest`（测试）、`typescript`（类型检查）。

---

## 致谢

本项目基于 [6BNBN/FlowPilot](https://github.com/6BNBN/FlowPilot) 深度改造。原版提供了优秀的架构设计和核心理念，改进版在此基础上重点强化了中断恢复能力和并发安全性，并扩展了用户体验和项目类型支持。
