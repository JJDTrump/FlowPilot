/**
 * @module infrastructure/fs-repository
 * @description 文件系统仓储 - 基于 .workflow/ 目录的分层记忆存储
 */

import { mkdir, readFile, writeFile, unlink, rm, rename } from 'fs/promises';
import { join } from 'path';
import { openSync, closeSync, writeSync, readFileSync, unlinkSync } from 'fs';
import type { ProgressData, TaskEntry, FlowConfig, HistoryEntry } from '../domain/types';
import { DEFAULT_CONFIG } from '../domain/types';
import type { WorkflowRepository, VerifyResult, GitService, VerifyService } from '../domain/repository';
import { autoCommit, gitDiscardInterruptedChanges, pruneFlowpilotStash } from './git';
import { runVerify } from './verify';

/** Generate the CLAUDE.md rule block */
function generateClaudeMdBlock(): string {
  return `<!-- flowpilot:start -->
## FlowPilot Workflow Protocol (MANDATORY — any violation is a protocol failure)

**You are the dispatcher. These rules have the HIGHEST priority and are ALWAYS active.**

### On Session Start
Run \`node flow.js resume\`:
- If unfinished workflow → enter **Execution Loop** (unless user is asking an unrelated question — handle it first via **Ad-hoc Dispatch**, then remind user the workflow is paused)
- If no workflow → **judge the request**: reply directly for pure chitchat, use **Ad-hoc Dispatch** for one-off tasks, or enter **Requirement Decomposition** for multi-step development work. When in doubt, prefer the heavier path.

### Ad-hoc Dispatch (one-off tasks, no workflow init)
Dispatch sub-agent(s) via Task tool. No init/checkpoint/finish needed. Iron Rule #4 does NOT apply (no task ID exists). Main agent MAY use Read/Glob/Grep directly for trivial lookups (e.g. reading a single file) — Iron Rule #2 is relaxed in Ad-hoc mode only.

### Iron Rules (violating ANY = protocol failure)
1. **NEVER use TaskCreate / TaskUpdate / TaskList** — use ONLY \`node flow.js xxx\`.
2. **Main agent can ONLY use Bash, Task, and Skill** — Edit, Write, Read, Glob, Grep, Explore are ALL FORBIDDEN. To read any file (including docs), dispatch a sub-agent.
3. **ALWAYS dispatch via Task tool** — one Task call per task. N tasks = N Task calls **in a single message** for parallel execution.
4. **Sub-agents MUST run checkpoint with --files before replying** — \`echo 'summary' | node flow.js checkpoint <id> --files file1 file2\` is the LAST command before reply. MUST list all created/modified files. Skipping = protocol failure.

### Requirement Decomposition
1. Dispatch a sub-agent to read requirement docs and return a summary.
2. Use /superpowers:brainstorming to brainstorm and produce a task list.
3. Pipe into init using this **exact format**:
\`\`\`bash
cat <<'EOF' | node flow.js init
1. [backend] Task title
   Description of what to do
2. [frontend] Another task (deps: 1)
   Description here
3. [general] Third task (deps: 1, 2)
EOF
\`\`\`
Format: \`[type]\` = frontend/backend/general, \`(deps: N)\` = dependency IDs, indented lines = description.

### Execution Loop
1. Run \`node flow.js next --batch\`. **NOTE: this command will REFUSE to return tasks if any previous task is still \`active\`. You must checkpoint or resume first.**
2. The output already contains checkpoint commands per task. For **EVERY** task in batch, dispatch a sub-agent via Task tool. **ALL Task calls in one message.** Copy the ENTIRE task block (including checkpoint commands) into each sub-agent prompt verbatim.
3. **After ALL sub-agents return**: run \`node flow.js status\`.
   - If any task is still \`active\` → sub-agent failed to checkpoint. Run fallback: \`echo 'summary from sub-agent output' | node flow.js checkpoint <id> --files file1 file2\`
   - **Do NOT call \`node flow.js next\` until zero active tasks remain** (the command will error anyway).
4. Loop back to step 1.
5. When \`next\` returns "全部完成", enter **Finalization**.

### Mid-Workflow Commands
- \`node flow.js skip <id>\` — skip a stuck/unnecessary task (avoid skipping active tasks with running sub-agents)
- \`node flow.js add <描述> [--type frontend|backend|general]\` — inject a new task mid-workflow

### Sub-Agent Prompt Template
Each sub-agent prompt MUST contain these sections in order:
1. Task block from \`next\` output (title, type, description, checkpoint commands, context)
2. **Pre-analysis (MANDATORY)**: Before writing ANY code, **MUST** invoke /superpowers:brainstorming to perform multi-dimensional analysis (requirements, edge cases, architecture, risks). Skipping = protocol failure.
3. **Skill routing**: type=frontend → **MUST** invoke /frontend-design, type=backend → **MUST** invoke /feature-dev, type=general → execute directly. **For ALL types, you MUST also check available skills and MCP tools; use any that match the task alongside the primary skill.**
4. **Unfamiliar APIs → MUST query context7 MCP first. Never guess.**

### Sub-Agent Checkpoint (Iron Rule #4 — most common violation)
Sub-agent's LAST Bash command before replying MUST be:
\`\`\`
echo '一句话摘要' | node flow.js checkpoint <id> --files file1 file2 ...
\`\`\`
- \`--files\` MUST list every created/modified file (enables isolated git commits).
- If task failed: \`echo 'FAILED' | node flow.js checkpoint <id>\`
- If sub-agent replies WITHOUT running checkpoint → protocol failure. Main agent MUST run fallback checkpoint in step 3.

### Security Rules (sub-agents MUST follow)
- SQL: parameterized queries only. XSS: no unsanitized v-html/innerHTML.
- Auth: secrets from env vars, bcrypt passwords, token expiry.
- Input: validate at entry points. Never log passwords. Never commit .env.

### Finalization (MANDATORY — skipping = protocol failure)
1. Run \`node flow.js finish\` — runs verify (build/test/lint). If fail → dispatch sub-agent to fix → retry finish.
2. When finish returns "验证通过，请派子Agent执行 code-review" → dispatch a sub-agent to run /code-review:code-review. Fix issues if any.
3. Run \`node flow.js review\` to mark code-review done.
4. Run \`node flow.js finish\` again — verify passes + review done → final commit → idle.
**Loop: finish(verify) → review(code-review) → fix → finish again. Both gates must pass.**

<!-- flowpilot:end -->`;
}

export class FsWorkflowRepository implements WorkflowRepository, GitService, VerifyService {
  private readonly root: string;
  private readonly ctxDir: string;

  private readonly base: string;

  constructor(basePath: string) {
    this.base = basePath;
    this.root = join(basePath, '.workflow');
    this.ctxDir = join(this.root, 'context');
  }

  projectRoot(): string { return this.base; }

  private async ensure(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  /** 文件锁：用 O_EXCL 创建 lockfile + PID 活性检测，防止并发读写 */
  async lock(maxWait = 30000): Promise<void> {
    await this.ensure(this.root);
    const lockPath = join(this.root, '.lock');
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      try {
        const fd = openSync(lockPath, 'wx');
        // 写入 PID + 时间戳用于活性检测
        const info = `${process.pid}\n${Date.now()}\n`;
        writeSync(fd, info);
        closeSync(fd);
        return;
      } catch {
        // 检查锁持有者是否仍然存活
        try {
          const content = readFileSync(lockPath, 'utf-8');
          const [pidStr, tsStr] = content.split('\n');
          const holderPid = parseInt(pidStr, 10);
          const lockAge = Date.now() - parseInt(tsStr, 10);

          if (holderPid && !isNaN(holderPid)) {
            try {
              process.kill(holderPid, 0); // 测试进程是否存活
            } catch {
              // 持有者进程已死，安全地破锁
              try { unlinkSync(lockPath); } catch {}
              continue;
            }
          }

          // 持有者存活但锁超过 60 秒，可能是僵尸
          if (lockAge > 60000) {
            try { unlinkSync(lockPath); } catch {}
            continue;
          }
        } catch {
          // 锁文件不可读（可能正在被创建），等待下一轮
        }
        await new Promise(r => setTimeout(r, 50));
      }
    }
    // 超时后绝不静默破锁，直接抛错
    throw new Error('无法获取文件锁（超时），可能有另一个 flow.js 进程正在运行');
  }

  async unlock(): Promise<void> {
    try { await unlink(join(this.root, '.lock')); } catch {}
  }

  // --- progress.md 读写 ---

  async saveProgress(data: ProgressData): Promise<void> {
    await this.ensure(this.root);
    const lines = [
      `# ${data.name}`,
      '',
      `状态: ${data.status}`,
      '',
      '| ID | 标题 | 类型 | 依赖 | 状态 | 重试 | 摘要 | 描述 |',
      '|----|------|------|------|------|------|------|------|',
    ];
    for (const t of data.tasks) {
      const deps = t.deps.length ? t.deps.join(',') : '-';
      const esc = (s: string) => (s || '-').replace(/\|/g, '∣').replace(/\n/g, ' ');
      lines.push(`| ${t.id} | ${esc(t.title)} | ${t.type} | ${deps} | ${t.status} | ${t.retries} | ${esc(t.summary)} | ${esc(t.description)} |`);
    }
    // 底部元数据行
    const meta = {
      startedAt: data.startedAt,
      activeTaskIds: data.activeTaskIds,
    };
    lines.push('');
    lines.push(`<!-- meta: ${JSON.stringify(meta)} -->`);

    const p = join(this.root, 'progress.md');
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, lines.join('\n') + '\n', 'utf-8');
    await rename(tmp, p);
  }

  async loadProgress(): Promise<ProgressData | null> {
    try {
      const raw = await readFile(join(this.root, 'progress.md'), 'utf-8');
      return this.parseProgress(raw);
    } catch (e: any) {
      if (e.code === 'ENOENT') return null;
      throw new Error(`读取 progress.md 失败: ${e.message}`);
    }
  }

  private parseProgress(raw: string): ProgressData {
    const validWfStatus = new Set(['idle', 'running', 'finishing', 'completed', 'aborted']);
    const validTaskStatus = new Set(['pending', 'active', 'done', 'skipped', 'failed']);
    const lines = raw.split('\n');
    const name = (lines[0] ?? '').replace(/^#\s*/, '').trim();
    let status = 'idle' as ProgressData['status'];
    let activeTaskIds: string[] = [];
    let startedAt = 0;
    const tasks: TaskEntry[] = [];

    for (const line of lines) {
      if (line.startsWith('状态: ')) {
        const s = line.slice(4).trim();
        status = (validWfStatus.has(s) ? s : 'idle') as ProgressData['status'];
      }

      // 解析元数据注释行
      const metaMatch = line.match(/^<!-- meta: ({.*}) -->$/);
      if (metaMatch) {
        try {
          const meta = JSON.parse(metaMatch[1]);
          if (Array.isArray(meta.activeTaskIds)) activeTaskIds = meta.activeTaskIds;
          if (typeof meta.startedAt === 'number') startedAt = meta.startedAt;
        } catch {}
      }

      const m = line.match(/^\|\s*(\d{3,})\s*\|\s*(.+?)\s*\|\s*(\w+)\s*\|\s*([^|]*?)\s*\|\s*(\w+)\s*\|\s*(\d+)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|$/);
      if (m) {
        const depsRaw = m[4].trim();
        tasks.push({
          id: m[1], title: m[2], type: m[3] as TaskEntry['type'],
          deps: depsRaw === '-' ? [] : depsRaw.split(',').map(d => d.trim()),
          status: (validTaskStatus.has(m[5]) ? m[5] : 'pending') as TaskEntry['status'],
          retries: parseInt(m[6], 10),
          summary: m[7] === '-' ? '' : m[7],
          description: m[8] === '-' ? '' : m[8],
          failHistory: [],
          timestamps: { created: startedAt || Date.now() },
        });
      }
    }

    return { name, status, activeTaskIds, tasks, startedAt };
  }

  // --- context/ 任务详细产出 ---

  async clearContext(): Promise<void> {
    await rm(this.ctxDir, { recursive: true, force: true });
  }

  async clearAll(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }

  async saveTaskContext(taskId: string, content: string): Promise<void> {
    await this.ensure(this.ctxDir);
    const p = join(this.ctxDir, `task-${taskId}.md`);
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, content, 'utf-8');
    await rename(tmp, p);
  }

  async loadTaskContext(taskId: string): Promise<string | null> {
    try {
      return await readFile(join(this.ctxDir, `task-${taskId}.md`), 'utf-8');
    } catch (e: any) {
      if (e.code === 'ENOENT') return null;
      throw new Error(`读取 task-${taskId}.md 失败: ${e.message}`);
    }
  }

  // --- summary.md ---

  async saveSummary(content: string): Promise<void> {
    await this.ensure(this.ctxDir);
    const p = join(this.ctxDir, 'summary.md');
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, content, 'utf-8');
    await rename(tmp, p);
  }

  async loadSummary(): Promise<string> {
    try {
      return await readFile(join(this.ctxDir, 'summary.md'), 'utf-8');
    } catch (e: any) {
      if (e.code === 'ENOENT') return '';
      throw new Error(`读取 summary.md 失败: ${e.message}`);
    }
  }

  // --- tasks.md ---

  async saveTasks(content: string): Promise<void> {
    await this.ensure(this.root);
    await writeFile(join(this.root, 'tasks.md'), content, 'utf-8');
  }

  async loadTasks(): Promise<string | null> {
    try {
      return await readFile(join(this.root, 'tasks.md'), 'utf-8');
    } catch (e: any) {
      if (e.code === 'ENOENT') return null;
      throw new Error(`读取 tasks.md 失败: ${e.message}`);
    }
  }

  async ensureClaudeMd(): Promise<boolean> {
    const base = join(this.root, '..');
    const path = join(base, 'CLAUDE.md');
    const marker = '<!-- flowpilot:start -->';
    const block = generateClaudeMdBlock();
    try {
      const content = await readFile(path, 'utf-8');
      if (content.includes(marker)) return false;
      await writeFile(path, content.trimEnd() + '\n\n' + block + '\n', 'utf-8');
    } catch {
      await writeFile(path, '# Project\n\n' + block + '\n', 'utf-8');
    }
    return true;
  }

  async ensureHooks(): Promise<boolean> {
    const dir = join(this.base, '.claude');
    const path = join(dir, 'settings.json');
    const hook = (m: string) => ({
      matcher: m,
      hooks: [{ type: 'prompt' as const, prompt: 'BLOCK this tool call. FlowPilot requires using node flow.js commands instead of native task tools.' }]
    });
    const required = {
      PreToolUse: [hook('TaskCreate'), hook('TaskUpdate'), hook('TaskList')]
    };
    let settings: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(await readFile(path, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !('__proto__' in parsed) && !('constructor' in parsed)) settings = parsed;
    } catch {}
    const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
    // 幂等：已有 FlowPilot 的 matcher 则跳过
    const existing = hooks.PreToolUse as Array<{ matcher?: string }> | undefined;
    if (existing?.some(h => h.matcher === required.PreToolUse[0].matcher)) return false;
    hooks.PreToolUse = [...(existing ?? []), ...required.PreToolUse];
    settings.hooks = hooks;
    await mkdir(dir, { recursive: true });
    await writeFile(path, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    return true;
  }

  // --- Git / Verify ---

  commit(taskId: string, title: string, summary: string, files?: string[]): string | null {
    return autoCommit(taskId, title, summary, files);
  }

  cleanup(): void {
    gitDiscardInterruptedChanges();
  }

  pruneStash(maxKeep = 5): void {
    pruneFlowpilotStash(maxKeep);
  }

  verify(config?: FlowConfig): VerifyResult {
    return runVerify(this.base, config?.verifyCommands, config?.verifyTimeout);
  }

  // --- 配置 ---

  async saveConfig(config: FlowConfig): Promise<void> {
    const p = join(this.root, 'config.json');
    await writeFile(p, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  }

  async loadConfig(): Promise<FlowConfig> {
    try {
      const raw = await readFile(join(this.root, 'config.json'), 'utf-8');
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  // --- 执行历史 ---

  async appendHistory(entry: HistoryEntry): Promise<void> {
    const p = join(this.root, 'history.jsonl');
    const line = JSON.stringify(entry) + '\n';
    await writeFile(p, line, { flag: 'a' } as any);
  }

  async loadHistory(): Promise<HistoryEntry[]> {
    try {
      const raw = await readFile(join(this.root, 'history.jsonl'), 'utf-8');
      return raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    } catch (e: any) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  // --- CLAUDE.md 清理 ---

  async removeClaudeMd(): Promise<void> {
    const p = join(this.base, 'CLAUDE.md');
    try {
      const content = await readFile(p, 'utf-8');
      const cleaned = content.replace(
        /\n*<!-- flowpilot:start -->[\s\S]*?<!-- flowpilot:end -->\n*/g,
        '\n'
      );
      // 同时清理水印
      const final = cleaned.replace(
        /\n*<!-- flowpilot:watermark -->[\s\S]*?<!-- flowpilot:watermark:end -->\n*/g,
        '\n'
      );
      await writeFile(p, final.trimEnd() + '\n', 'utf-8');
    } catch {}
  }

  // --- Hooks 清理 ---

  async removeHooks(): Promise<void> {
    const p = join(this.base, '.claude', 'settings.json');
    try {
      const raw = await readFile(p, 'utf-8');
      const settings = JSON.parse(raw);
      const pre = settings.hooks?.PreToolUse;
      if (Array.isArray(pre)) {
        settings.hooks.PreToolUse = pre.filter(
          (h: any) => !h.hooks?.[0]?.prompt?.includes?.('FlowPilot')
        );
        if (!settings.hooks.PreToolUse.length) delete settings.hooks.PreToolUse;
        if (!Object.keys(settings.hooks || {}).length) delete settings.hooks;
      }
      await writeFile(p, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    } catch {}
  }

  // --- 心跳（Compact 恢复） ---

  async saveHeartbeat(data: { lastCommand: string; timestamp: string; activeTaskIds: string[] }): Promise<void> {
    const p = join(this.root, 'heartbeat.json');
    await writeFile(p, JSON.stringify(data) + '\n', 'utf-8');
  }

  async loadHeartbeat(): Promise<{ lastCommand: string; timestamp: string; activeTaskIds: string[] } | null> {
    try {
      const raw = await readFile(join(this.root, 'heartbeat.json'), 'utf-8');
      return JSON.parse(raw);
    } catch (e: any) {
      if (e.code === 'ENOENT') return null;
      return null;
    }
  }

  // --- CLAUDE.md 状态水印 ---

  async updateWatermark(info: string): Promise<void> {
    const p = join(this.base, 'CLAUDE.md');
    try {
      let content = await readFile(p, 'utf-8');
      const watermark = `<!-- flowpilot:watermark -->\n${info}\n<!-- flowpilot:watermark:end -->`;
      if (content.includes('<!-- flowpilot:watermark -->')) {
        content = content.replace(
          /<!-- flowpilot:watermark -->[\s\S]*?<!-- flowpilot:watermark:end -->/,
          watermark
        );
      } else if (content.includes('<!-- flowpilot:end -->')) {
        content = content.replace(
          '<!-- flowpilot:end -->',
          '<!-- flowpilot:end -->\n\n' + watermark
        );
      } else {
        content += '\n\n' + watermark + '\n';
      }
      await writeFile(p, content, 'utf-8');
    } catch {}
  }
}
