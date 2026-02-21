/**
 * @module domain/types
 * @description 领域值对象与枚举
 */

/** 任务类型常量数组 - 可扩展 */
export const TASK_TYPES = ['frontend', 'backend', 'general'] as const;
/** 任务类型 - 决定子Agent调用哪个插件 */
export type TaskType = typeof TASK_TYPES[number];
/** 合法任务类型集合（运行时校验用） */
export const VALID_TASK_TYPES = new Set<string>(TASK_TYPES);

/** 任务状态 */
export type TaskStatus = 'pending' | 'active' | 'done' | 'skipped' | 'failed';

/** 工作流状态 */
export type WorkflowStatus = 'idle' | 'running' | 'finishing' | 'completed' | 'aborted';

/** 单个任务条目 */
export interface TaskEntry {
  /** 三位数编号如 "001" */
  id: string;
  title: string;
  description: string;
  type: TaskType;
  status: TaskStatus;
  /** 依赖的前置任务ID列表 */
  deps: string[];
  /** 完成摘要 */
  summary: string;
  /** 失败重试次数 */
  retries: number;
  /** 失败历史记录（每次失败的原因） */
  failHistory: string[];
  /** 时间戳 */
  timestamps: {
    created: number;
    started?: number;
    completed?: number;
    lastFailed?: number;
  };
}

/** 工作流全局状态 */
export interface ProgressData {
  name: string;
  status: WorkflowStatus;
  /** 当前活跃的任务ID列表（支持并行） */
  activeTaskIds: string[];
  tasks: TaskEntry[];
  /** 工作流开始时间 */
  startedAt: number;
}

/** 用户配置 */
export interface FlowConfig {
  /** 是否自动 git commit（默认 true） */
  autoCommit: boolean;
  /** 自定义验证命令（覆盖自动检测） */
  verifyCommands?: string[];
  /** 验证超时（毫秒，默认 300000） */
  verifyTimeout: number;
  /** summary 压缩阈值（默认 50，即超过 50 个才压缩） */
  summaryCompressThreshold: number;
  /** 最大并行任务数（默认无限制） */
  maxParallel?: number;
  /** 失败最大重试次数（默认 3） */
  maxRetries: number;
  /** 锁超时（毫秒，默认 30000） */
  lockTimeout: number;
}

/** 默认配置 */
export const DEFAULT_CONFIG: FlowConfig = {
  autoCommit: true,
  verifyTimeout: 300_000,
  summaryCompressThreshold: 50,
  maxRetries: 3,
  lockTimeout: 30_000,
};

/** 执行历史条目 */
export interface HistoryEntry {
  ts: string;
  event: 'init' | 'next' | 'checkpoint' | 'skip' | 'fail' | 'resume' | 'finish' | 'add' | 'edit' | 'rollback' | 'pause';
  taskId?: string;
  detail: string;
}
