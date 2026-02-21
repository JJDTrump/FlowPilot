/**
 * @module application/workflow-service
 * @description 工作流应用服务 - 核心用例
 */

import type { ProgressData, TaskEntry, FlowConfig } from '../domain/types';
import { DEFAULT_CONFIG } from '../domain/types';
import type { WorkflowDefinition } from '../domain/workflow';
import type { WorkflowRepository, GitService, VerifyService } from '../domain/repository';
import { validateDefinition } from '../infrastructure/markdown-parser';
import { makeTaskId, findNextTask, findParallelTasks, completeTask, failTask, resumeProgress, isAllDone } from '../domain/task-store';

export class WorkflowService {
  constructor(
    private readonly repo: WorkflowRepository,
    private readonly git: GitService,
    private readonly verifier: VerifyService,
    private readonly parse: (md: string) => WorkflowDefinition,
  ) {}

  /** init: 解析任务markdown → 生成progress/tasks */
  async init(tasksMd: string, force = false): Promise<ProgressData> {
    const existing = await this.repo.loadProgress();
    if (existing && existing.status === 'running' && !force) {
      throw new Error(`已有进行中的工作流: ${existing.name}，使用 --force 覆盖`);
    }
    const def = this.parse(tasksMd);

    // 验证定义
    const warnings = validateDefinition(def);
    const errors = warnings.filter(w => w.type === 'error');
    if (errors.length) {
      throw new Error(`任务定义错误:\n${errors.map(e => `- ${e.message}`).join('\n')}`);
    }

    const tasks: TaskEntry[] = def.tasks.map((t, i) => ({
      id: makeTaskId(i + 1),
      title: t.title,
      description: t.description,
      type: t.type,
      status: 'pending',
      deps: t.deps,
      summary: '',
      retries: 0,
      failHistory: [],
      timestamps: { created: Date.now() },
    }));
    const data: ProgressData = {
      name: def.name,
      status: 'running',
      activeTaskIds: [],
      tasks,
      startedAt: Date.now(),
    };
    await this.repo.saveProgress(data);
    await this.repo.saveTasks(tasksMd);
    await this.repo.saveSummary(`# ${def.name}\n\n${def.description}\n`);
    await this.repo.ensureClaudeMd();
    await this.repo.ensureHooks();
    await this.repo.saveConfig(DEFAULT_CONFIG);
    await this.repo.appendHistory({ ts: new Date().toISOString(), event: 'init', detail: data.name });
    return data;
  }

  /** next: 获取下一个可执行任务（含依赖上下文） */
  async next(): Promise<{ task: TaskEntry; context: string } | null> {
    const config = await this.repo.loadConfig();
    await this.repo.lock(config.lockTimeout);
    try {
      const data = await this.requireProgress();
      if (isAllDone(data.tasks)) return null;

      if (data.activeTaskIds.length > 0) {
        throw new Error(`有 ${data.activeTaskIds.length} 个任务仍为 active 状态（${data.activeTaskIds.join(',')}），请先执行 node flow.js status 检查并补 checkpoint，或 node flow.js resume 重置`);
      }

      const task = findNextTask(data.tasks);
      if (!task) {
        await this.repo.saveProgress(data); // persist cascadeSkip changes
        return null;
      }

      task.status = 'active';
      task.timestamps.started = Date.now();
      data.activeTaskIds.push(task.id);
      await this.repo.saveProgress(data);

      // 更新心跳
      await this.repo.saveHeartbeat({ lastCommand: 'next', timestamp: new Date().toISOString(), activeTaskIds: data.activeTaskIds });
      // 更新水印
      await this.repo.updateWatermark(`active: ${data.activeTaskIds.join(',')}`);
      // 记录历史
      await this.repo.appendHistory({ ts: new Date().toISOString(), event: 'next', taskId: task.id, detail: task.title });

      // 拼装上下文：summary + 依赖任务产出
      const parts: string[] = [];
      const summary = await this.repo.loadSummary();
      if (summary) parts.push(summary);

      for (const depId of task.deps) {
        const ctx = await this.repo.loadTaskContext(depId);
        if (ctx) parts.push(ctx);
      }

      return { task, context: parts.join('\n\n---\n\n') };
    } finally {
      await this.repo.unlock();
    }
  }

  /** nextBatch: 获取所有可并行执行的任务 */
  async nextBatch(): Promise<{ task: TaskEntry; context: string }[]> {
    const config = await this.repo.loadConfig();
    await this.repo.lock(config.lockTimeout);
    try {
      const data = await this.requireProgress();
      if (isAllDone(data.tasks)) return [];

      if (data.activeTaskIds.length > 0) {
        throw new Error(`有 ${data.activeTaskIds.length} 个任务仍为 active 状态（${data.activeTaskIds.join(',')}），请先执行 node flow.js status 检查并补 checkpoint，或 node flow.js resume 重置`);
      }

      let tasks = findParallelTasks(data.tasks);
      if (!tasks.length) {
        await this.repo.saveProgress(data); // persist cascadeSkip changes
        return [];
      }

      // 限制并行数
      if (config.maxParallel && tasks.length > config.maxParallel) {
        tasks = tasks.slice(0, config.maxParallel);
      }

      for (const t of tasks) {
        t.status = 'active';
        t.timestamps.started = Date.now();
        data.activeTaskIds.push(t.id);
      }
      await this.repo.saveProgress(data);

      // 更新心跳
      await this.repo.saveHeartbeat({ lastCommand: 'next', timestamp: new Date().toISOString(), activeTaskIds: data.activeTaskIds });
      // 更新水印
      await this.repo.updateWatermark(`active: ${data.activeTaskIds.join(',')}`);
      // 记录历史
      await this.repo.appendHistory({ ts: new Date().toISOString(), event: 'next', detail: `batch: ${tasks.map(t => t.id).join(',')}` });

      const summary = await this.repo.loadSummary();
      const results: { task: TaskEntry; context: string }[] = [];

      for (const task of tasks) {
        const parts: string[] = [];
        if (summary) parts.push(summary);
        for (const depId of task.deps) {
          const ctx = await this.repo.loadTaskContext(depId);
          if (ctx) parts.push(ctx);
        }
        results.push({ task, context: parts.join('\n\n---\n\n') });
      }
      return results;
    } finally {
      await this.repo.unlock();
    }
  }

  /** checkpoint: 记录任务完成 */
  async checkpoint(id: string, detail: string, files?: string[]): Promise<string> {
    await this.repo.lock();
    try {
      const data = await this.requireProgress();
      const task = data.tasks.find(t => t.id === id);
      if (!task) throw new Error(`任务 ${id} 不存在`);
      if (task.status !== 'active') {
        throw new Error(`任务 ${id} 状态为 ${task.status}，只有 active 状态可以 checkpoint`);
      }

      if (detail === 'FAILED') {
        const reason = detail;
        const result = failTask(data, id, reason);
        // 记录失败的 taskContext
        await this.repo.saveTaskContext(id, `# task-${id}: ${task.title}\n\n[FAILED] 第${task.retries}次失败\n`);
        await this.repo.saveProgress(data);

        // 更新心跳和水印
        await this.repo.saveHeartbeat({ lastCommand: 'checkpoint', timestamp: new Date().toISOString(), activeTaskIds: data.activeTaskIds });
        await this.repo.updateWatermark(`active: ${data.activeTaskIds.join(',') || '无'}`);
        // 记录历史
        await this.repo.appendHistory({ ts: new Date().toISOString(), event: 'fail', taskId: id, detail: `第${task.retries}次失败` });

        return result === 'retry'
          ? `任务 ${id} 失败(第${task.retries}次)，将重试`
          : `任务 ${id} 连续失败3次，已跳过`;
      }

      if (!detail.trim()) throw new Error(`任务 ${id} checkpoint内容不能为空`);

      const summaryLine = detail.split('\n')[0].slice(0, 80);
      completeTask(data, id, summaryLine);

      await this.repo.saveProgress(data);
      await this.repo.saveTaskContext(id, `# task-${id}: ${task.title}\n\n${detail}\n`);
      await this.updateSummary(data);

      const config = await this.repo.loadConfig();
      let commitMsg = '';
      if (config.autoCommit) {
        const commitErr = this.git.commit(id, task.title, summaryLine, files);
        if (commitErr) {
          commitMsg = `\n[git提交失败] ${commitErr}\n请根据错误修复后手动执行 git add -A && git commit`;
        } else {
          commitMsg = ' [已自动提交]';
        }
      }

      // 更新心跳和水印
      await this.repo.saveHeartbeat({ lastCommand: 'checkpoint', timestamp: new Date().toISOString(), activeTaskIds: data.activeTaskIds });
      await this.repo.updateWatermark(`active: ${data.activeTaskIds.join(',') || '无'}`);
      // 记录历史
      await this.repo.appendHistory({ ts: new Date().toISOString(), event: 'checkpoint', taskId: id, detail: summaryLine });

      const doneCount = data.tasks.filter(t => t.status === 'done').length;
      let msg = `任务 ${id} 完成 (${doneCount}/${data.tasks.length})${commitMsg}`;
      return isAllDone(data.tasks) ? msg + '\n全部任务已完成，请执行 node flow.js finish 进行收尾' : msg;
    } finally {
      await this.repo.unlock();
    }
  }

  /** resume: 中断恢复 */
  async resume(): Promise<string> {
    await this.repo.lock();
    try {
      const data = await this.repo.loadProgress();
      if (!data || (data.status !== 'running' && data.status !== 'idle')) {
        // 检查 finishing 状态
        if (data?.status === 'finishing') {
          return '正在收尾阶段，请执行 node flow.js finish';
        }
        return '没有需要恢复的工作流，使用 flow init 开始新流程';
      }

      // idle 状态 resume → 设置回 running
      if (data.status === 'idle') {
        data.status = 'running';
        await this.repo.saveProgress(data);
      }

      const resetIds = resumeProgress(data);
      await this.repo.saveProgress(data);
      if (resetIds.length) {
        this.git.cleanup();
        this.git.pruneStash();
      }

      // 加载 summary 和 status 用于丰富输出
      const summary = await this.repo.loadSummary();
      const doneCount = data.tasks.filter(t => t.status === 'done').length;
      const total = data.tasks.length;

      const lines: string[] = [
        `恢复工作流: ${data.name}`,
        `进度: ${doneCount}/${total}`,
      ];

      if (resetIds.length) {
        lines.push(`中断任务 ${resetIds.join(', ')} 已重置，将重新执行`);
      } else {
        lines.push('继续执行');
      }

      // 附加全局状态
      lines.push('');
      lines.push('--- 任务状态 ---');
      for (const t of data.tasks) {
        const icon = { pending: '[ ]', active: '[>]', done: '[x]', skipped: '[-]', failed: '[!]' }[t.status] || '[ ]';
        lines.push(`${icon} ${t.id} [${t.type}] ${t.title}${t.summary ? ' - ' + t.summary : ''}`);
      }

      // 附加摘要
      if (summary) {
        lines.push('');
        lines.push('--- 项目摘要 ---');
        lines.push(summary);
      }

      lines.push('');
      lines.push('请执行 node flow.js next --batch 继续');

      // 记录历史
      await this.repo.appendHistory({ ts: new Date().toISOString(), event: 'resume', detail: `重置: ${resetIds.join(',') || '无'}` });

      // 更新心跳
      await this.repo.saveHeartbeat({ lastCommand: 'resume', timestamp: new Date().toISOString(), activeTaskIds: [] });

      return lines.join('\n');
    } finally {
      this.repo.unlock();
    }
  }

  /** add: 追加任务 */
  async add(title: string, type: TaskEntry['type'], description = '', deps: string[] = []): Promise<string> {
    await this.repo.lock();
    try {
      const data = await this.requireProgress();
      const maxNum = data.tasks.reduce((m, t) => Math.max(m, parseInt(t.id, 10)), 0);
      const id = makeTaskId(maxNum + 1);

      // 验证 deps 存在
      for (const d of deps) {
        if (!data.tasks.find(t => t.id === d)) {
          throw new Error(`依赖任务 ${d} 不存在`);
        }
      }

      data.tasks.push({
        id, title, description, type,
        status: 'pending', deps, summary: '',
        retries: 0, failHistory: [],
        timestamps: { created: Date.now() },
      });
      await this.repo.saveProgress(data);
      await this.repo.appendHistory({ ts: new Date().toISOString(), event: 'add', taskId: id, detail: title });
      return `已添加任务 ${id}: ${title}`;
    } finally {
      await this.repo.unlock();
    }
  }

  /** skip: 手动跳过任务 */
  async skip(id: string): Promise<string> {
    await this.repo.lock();
    try {
      const data = await this.requireProgress();
      const task = data.tasks.find(t => t.id === id);
      if (!task) throw new Error(`任务 ${id} 不存在`);
      if (task.status === 'done') return `任务 ${id} 已完成，无需跳过`;
      const warn = task.status === 'active' ? '（警告: 该任务为 active 状态，子Agent可能仍在运行）' : '';
      task.status = 'skipped';
      task.summary = '手动跳过';
      data.activeTaskIds = data.activeTaskIds.filter(x => x !== id);
      await this.repo.saveProgress(data);
      await this.repo.appendHistory({ ts: new Date().toISOString(), event: 'skip', taskId: id, detail: task.title });
      return `已跳过任务 ${id}: ${task.title}${warn}`;
    } finally {
      await this.repo.unlock();
    }
  }

  /** setup: 项目接管模式 - 写入CLAUDE.md */
  async setup(): Promise<string> {
    const existing = await this.repo.loadProgress();
    const wrote = await this.repo.ensureClaudeMd();
    await this.repo.ensureHooks();
    const lines: string[] = [];

    if (existing && (existing.status === 'running' || existing.status === 'finishing')) {
      const done = existing.tasks.filter(t => t.status === 'done').length;
      lines.push(`检测到进行中的工作流: ${existing.name}`);
      lines.push(`进度: ${done}/${existing.tasks.length}`);
      if (existing.status === 'finishing') {
        lines.push('状态: 收尾阶段，执行 node flow.js finish 继续');
      } else {
        lines.push('执行 node flow.js resume 继续');
      }
    } else {
      lines.push('项目已接管，工作流工具就绪');
      lines.push('等待需求输入（文档或对话描述）');
    }

    lines.push('');
    if (wrote) lines.push('CLAUDE.md 已更新: 添加了工作流协议');
    lines.push('描述你的开发任务即可启动全自动开发');
    return lines.join('\n');
  }

  /** review: 标记已通过code-review，解锁finish */
  async review(): Promise<string> {
    await this.repo.lock();
    try {
      const data = await this.requireProgress();
      if (data.status !== 'finishing') return '当前不在 finishing 阶段';
      (data as any).reviewDone = true;
      await this.repo.saveProgress(data);
      return 'Code review 已标记完成，请执行 node flow.js finish 完成收尾';
    } finally {
      this.repo.unlock();
    }
  }

  /** finish: 智能收尾 - 先verify，review后置 */
  async finish(): Promise<string> {
    // 第一段：获取数据
    await this.repo.lock();
    let data: ProgressData;
    let config: FlowConfig;
    try {
      data = await this.requireProgress();
      config = await this.repo.loadConfig();
      if (data.status === 'idle' || data.status === 'completed') return '没有活跃的工作流';
      if (!isAllDone(data.tasks)) return '还有未完成的任务，请先完成所有任务';
      if (data.status !== 'finishing') {
        data.status = 'finishing';
        await this.repo.saveProgress(data);
      }
    } finally {
      this.repo.unlock();
    }

    // 无锁执行验证（可能耗时很长）
    const result = this.verifier.verify(config);
    if (!result.passed) {
      return `验证失败:\n${result.error}\n\n执行的脚本: ${result.scripts.join(', ')}\n请修复后重试 finish`;
    }

    // 第二段：重新获取锁完成收尾
    await this.repo.lock();
    try {
      // 重新读取最新数据（可能被其他命令修改）
      data = await this.requireProgress();

      // 检查 code-review
      if (!(data as any).reviewDone) {
        data.status = 'finishing';
        await this.repo.saveProgress(data);
        return '验证通过，请派子Agent执行 code-review\n完成后执行 node flow.js review 标记';
      }

      // 生成统计
      const done = data.tasks.filter(t => t.status === 'done').length;
      const skipped = data.tasks.filter(t => t.status === 'skipped').length;
      const failed = data.tasks.filter(t => t.status === 'failed').length;

      if (config.autoCommit) {
        const commitErr = this.git.commit('finish', data.name, `完成: ${done}/${data.tasks.length}`);
        if (commitErr) {
          return `验证通过但git提交失败: ${commitErr}`;
        }
      }

      // 清理
      await this.repo.removeClaudeMd();
      await this.repo.removeHooks();
      await this.repo.clearAll();

      await this.repo.appendHistory({ ts: new Date().toISOString(), event: 'finish', detail: `done=${done} skipped=${skipped} failed=${failed}` });

      return `工作流完成！\n完成: ${done} | 跳过: ${skipped} | 失败: ${failed}\n验证: ${result.scripts.join(', ') || '无'}`;
    } finally {
      this.repo.unlock();
    }
  }

  /** status: 全局进度 */
  async status(): Promise<ProgressData | null> {
    return this.repo.loadProgress();
  }

  /** edit: 编辑 pending 状态的任务 */
  async edit(id: string, updates: { title?: string; description?: string; type?: TaskEntry['type']; deps?: string[] }): Promise<string> {
    await this.repo.lock();
    try {
      const data = await this.requireProgress();
      const task = data.tasks.find(t => t.id === id);
      if (!task) throw new Error(`任务 ${id} 不存在`);
      if (task.status !== 'pending') throw new Error(`只能编辑 pending 状态的任务（当前: ${task.status}）`);

      if (updates.title) task.title = updates.title;
      if (updates.description !== undefined) task.description = updates.description;
      if (updates.type) task.type = updates.type;
      if (updates.deps) {
        for (const d of updates.deps) {
          if (!data.tasks.find(t => t.id === d)) throw new Error(`依赖任务 ${d} 不存在`);
          if (d === id) throw new Error('不能依赖自己');
        }
        task.deps = updates.deps;
      }

      await this.repo.saveProgress(data);
      await this.repo.appendHistory({ ts: new Date().toISOString(), event: 'edit', taskId: id, detail: JSON.stringify(updates) });
      return `已更新任务 ${id}`;
    } finally {
      this.repo.unlock();
    }
  }

  /** log: 查看执行历史 */
  async log(): Promise<string> {
    const history = await this.repo.loadHistory();
    if (!history.length) return '暂无执行历史';

    const lines = ['=== 执行历史 ===', ''];
    for (const h of history.slice(-30)) { // 最近 30 条
      const taskPart = h.taskId ? ` [${h.taskId}]` : '';
      lines.push(`${h.ts} ${h.event}${taskPart} ${h.detail}`);
    }
    return lines.join('\n');
  }

  /** show: 查看任务详情 */
  async show(id: string): Promise<string> {
    const data = await this.requireProgress();
    const task = data.tasks.find(t => t.id === id);
    if (!task) throw new Error(`任务 ${id} 不存在`);

    const context = await this.repo.loadTaskContext(id);

    const lines = [
      `=== 任务 ${id} 详情 ===`,
      `标题: ${task.title}`,
      `类型: ${task.type}`,
      `状态: ${task.status}`,
      `依赖: ${task.deps.length ? task.deps.join(', ') : '无'}`,
      `重试: ${task.retries}/${3}`,
    ];

    if (task.description) lines.push(`描述: ${task.description}`);
    if (task.summary) lines.push(`摘要: ${task.summary}`);
    if (task.timestamps.started) lines.push(`开始: ${new Date(task.timestamps.started).toISOString()}`);
    if (task.timestamps.completed) lines.push(`完成: ${new Date(task.timestamps.completed).toISOString()}`);
    if (task.failHistory.length) {
      lines.push('', '--- 失败记录 ---');
      task.failHistory.forEach(f => lines.push(`  ${f}`));
    }
    if (context) {
      lines.push('', '--- 产出上下文 ---', context);
    }

    return lines.join('\n');
  }

  /** pause: 手动暂停工作流 */
  async pause(): Promise<string> {
    await this.repo.lock();
    try {
      const data = await this.requireProgress();
      if (data.status !== 'running') return '没有运行中的工作流';

      // 将所有 active 任务重置为 pending
      for (const t of data.tasks) {
        if (t.status === 'active') {
          t.status = 'pending';
          t.timestamps.started = undefined;
        }
      }
      data.activeTaskIds = [];
      data.status = 'idle';
      await this.repo.saveProgress(data);
      await this.repo.appendHistory({ ts: new Date().toISOString(), event: 'pause', detail: '手动暂停' });

      return '工作流已暂停，使用 resume 继续';
    } finally {
      this.repo.unlock();
    }
  }

  /** 滚动摘要：每次checkpoint追加，压缩策略使用 config 阈值 */
  private async updateSummary(data: ProgressData): Promise<void> {
    const config = await this.repo.loadConfig();
    const done = data.tasks.filter(t => t.status === 'done');
    const lines = [`# ${data.name}\n`];

    if (done.length > config.summaryCompressThreshold) {
      // 分组摘要 — 但保留所有任务的 title + summary
      const groups = new Map<string, typeof done>();
      for (const t of done) {
        const arr = groups.get(t.type) || [];
        arr.push(t);
        groups.set(t.type, arr);
      }
      for (const [type, tasks] of groups) {
        lines.push(`## ${type} (${tasks.length}项完成)`);
        for (const t of tasks) {
          lines.push(`- ${t.id}: ${t.title} → ${t.summary}`);
        }
        lines.push('');
      }
    } else {
      for (const t of done) {
        lines.push(`- [${t.type}] ${t.id}: ${t.title}: ${t.summary}`);
      }
    }

    await this.repo.saveSummary(lines.join('\n') + '\n');
  }

  private async requireProgress(): Promise<ProgressData> {
    const data = await this.repo.loadProgress();
    if (!data) throw new Error('无活跃工作流，请先 node flow.js init');
    return data;
  }
}
