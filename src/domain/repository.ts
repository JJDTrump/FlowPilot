/**
 * @module domain/repository
 * @description 仓储接口 - 持久化契约
 */

import type { FlowConfig, HistoryEntry, ProgressData } from './types';

/** 验证结果 */
export interface VerifyResult {
  passed: boolean;
  scripts: string[];
  error?: string;
}

/** Git 操作接口 */
export interface GitService {
  /** Git自动提交，返回错误信息或null */
  commit(taskId: string, title: string, summary: string, files?: string[]): string | null;
  /** Git清理未提交变更（resume时调用），用stash保留而非丢弃 */
  cleanup(): void;
  /** 清理过期的 stash 条目（保留最近 maxKeep 个） */
  pruneStash(maxKeep?: number): void;
}

/** 项目验证接口 */
export interface VerifyService {
  /** 执行项目验证（build/test/lint） */
  verify(config?: FlowConfig): VerifyResult;
}

/** 仓储接口 */
export interface WorkflowRepository {
  /** 保存进度数据到 progress.md */
  saveProgress(data: ProgressData): Promise<void>;
  /** 加载进度数据 */
  loadProgress(): Promise<ProgressData | null>;
  /** 保存任务详细产出 */
  saveTaskContext(taskId: string, content: string): Promise<void>;
  /** 加载任务详细产出 */
  loadTaskContext(taskId: string): Promise<string | null>;
  /** 保存/加载滚动摘要 */
  saveSummary(content: string): Promise<void>;
  loadSummary(): Promise<string>;
  /** 保存任务树定义 */
  saveTasks(content: string): Promise<void>;
  loadTasks(): Promise<string | null>;
  /** 确保CLAUDE.md包含工作流协议 */
  ensureClaudeMd(): Promise<boolean>;
  /** 确保.claude/settings.json包含hooks */
  ensureHooks(): Promise<boolean>;
  /** 清理 context/ 目录（finish后释放上下文） */
  clearContext(): Promise<void>;
  /** 清理整个 .workflow/ 目录 */
  clearAll(): Promise<void>;
  /** 项目根目录 */
  projectRoot(): string;
  /** 文件锁 */
  lock(maxWait?: number): Promise<void>;
  unlock(): Promise<void>;

  /** 保存用户配置 */
  saveConfig(config: FlowConfig): Promise<void>;
  /** 加载用户配置 */
  loadConfig(): Promise<FlowConfig>;

  /** 追加执行历史 */
  appendHistory(entry: HistoryEntry): Promise<void>;
  /** 加载执行历史 */
  loadHistory(): Promise<HistoryEntry[]>;

  /** 移除 CLAUDE.md 中的工作流协议 */
  removeClaudeMd(): Promise<void>;
  /** 移除 hooks */
  removeHooks(): Promise<void>;

  /** 保存心跳（Compact 恢复用） */
  saveHeartbeat(data: { lastCommand: string; timestamp: string; activeTaskIds: string[] }): Promise<void>;
  /** 加载心跳（Compact 恢复用） */
  loadHeartbeat(): Promise<{ lastCommand: string; timestamp: string; activeTaskIds: string[] } | null>;

  /** 更新 CLAUDE.md 中的状态水印 */
  updateWatermark(info: string): Promise<void>;
}
