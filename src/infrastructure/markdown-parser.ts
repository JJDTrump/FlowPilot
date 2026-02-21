/**
 * @module infrastructure/markdown-parser
 * @description Markdown 任务解析器
 *
 * tasks.md 格式：
 * - `# 名称`
 * - 描述段落
 * - `1. [frontend] 标题 (deps: 002,003)`
 * - `   描述文本`
 */

import type { TaskType } from '../domain/types';
import type { TaskDefinition, WorkflowDefinition } from '../domain/workflow';
import { makeTaskId } from '../domain/task-store';

// 先尝试匹配带 deps 的格式，再尝试不带 deps 的
const TASK_WITH_DEPS_RE = /^(\d+)\.\s+\[\s*([\w-]+)\s*\]\s+(.+)\s+\((?:deps?|依赖)\s*:\s*([^)]*)\)\s*$/i;
const TASK_NO_DEPS_RE = /^(\d+)\.\s+\[\s*([\w-]+)\s*\]\s+(.+?)\s*$/i;
const DESC_RE = /^(?:\t|\s{2,})(.+)$/;

export interface ParseWarning {
  type: 'error' | 'warning';
  message: string;
}

/** 解析 tasks.md 为 WorkflowDefinition */
export function parseTasksMarkdown(markdown: string): WorkflowDefinition {
  const lines = markdown.split('\n');
  let name = '';
  let description = '';
  const tasks: TaskDefinition[] = [];
  const numToId = new Map<string, string>(); // 用户编号 → 系统ID

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!name && line.startsWith('# ')) {
      name = line.slice(2).trim();
      continue;
    }
    if (name && !description && !line.startsWith('#') && line.trim() && !TASK_WITH_DEPS_RE.test(line) && !TASK_NO_DEPS_RE.test(line)) {
      description = line.trim();
      continue;
    }

    // 先尝试带 deps 的正则（贪婪标题），再尝试不带 deps 的
    const m = line.match(TASK_WITH_DEPS_RE) || line.match(TASK_NO_DEPS_RE);
    if (m) {
      const userNum = m[1];
      const sysId = makeTaskId(tasks.length + 1);
      numToId.set(userNum.padStart(3, '0'), sysId);
      numToId.set(userNum, sysId);

      const validTypes = new Set(['frontend', 'backend', 'general']);
      const rawType = m[2].toLowerCase();
      const type = (validTypes.has(rawType) ? rawType : 'general') as TaskType;
      const title = m[3].trim();
      const rawDeps = m[4] ? m[4].split(',').map(d => d.trim()).filter(Boolean) : [];
      // 收集缩进描述行
      let desc = '';
      while (i + 1 < lines.length && DESC_RE.test(lines[i + 1])) {
        i++;
        desc += (desc ? '\n' : '') + lines[i].trim();
      }
      tasks.push({ title, type, deps: rawDeps, description: desc });
    }
  }

  // 第二遍：将用户编号映射为系统ID
  for (const t of tasks) {
    t.deps = t.deps.map(d => numToId.get(d.padStart(3, '0')) || numToId.get(d) || makeTaskId(parseInt(d, 10))).filter(Boolean);
  }

  return { name, description, tasks };
}

/** 验证解析后的工作流定义，返回错误和警告列表 */
export function validateDefinition(def: WorkflowDefinition): ParseWarning[] {
  const warnings: ParseWarning[] = [];

  if (!def.name) {
    warnings.push({ type: 'error', message: '缺少工作流名称（需要 # 标题）' });
  }

  if (!def.tasks.length) {
    warnings.push({ type: 'error', message: '未解析到任何任务，请检查格式: N. [type] 标题' });
  }

  // 构建有效 ID 集合
  const validIds = new Set(def.tasks.map((_, i) => makeTaskId(i + 1)));

  for (let i = 0; i < def.tasks.length; i++) {
    const t = def.tasks[i];
    const taskId = makeTaskId(i + 1);

    // 检查依赖引用不存在的 ID
    for (const d of t.deps) {
      if (!validIds.has(d)) {
        warnings.push({ type: 'error', message: `任务 ${taskId} "${t.title}" 依赖不存在的任务 ID: ${d}` });
      }
    }

    // 检查自依赖
    if (t.deps.includes(taskId)) {
      warnings.push({ type: 'error', message: `任务 ${taskId} "${t.title}" 不能依赖自己` });
    }

    // 检查重复依赖
    const uniqueDeps = new Set(t.deps);
    if (uniqueDeps.size < t.deps.length) {
      warnings.push({ type: 'warning', message: `任务 ${taskId} "${t.title}" 有重复的依赖声明` });
    }
  }

  return warnings;
}
