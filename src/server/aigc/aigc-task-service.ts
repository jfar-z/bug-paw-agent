import { TaskExecutionQueue } from "../core/task-execution-queue";
import { DEFAULT_AIGC_AGENT_LIMITS, type AigcAgentLimits } from "./aigc-agent-limits";
import { KeyedMutex } from "../core/keyed-mutex";
import { taskFingerprint } from "../core/task-preparation";
import { agentFields, agentOutputs } from "./aigc-agent-parameters";
import { randomUUID } from "node:crypto";

import type {
  AigcRunRequest,
  AigcOutputKind,
  AigcOutputPage,
  AigcTaskDocument,
  AigcTaskError,
  AigcTaskExecutionState,
  AigcTaskRecord,
  AigcTaskSummary,
} from "../../shared/aigc-contracts";
import type { CredentialService } from "../configuration/credential-service";
import { toSafePublicMessage } from "../core/errors";
import { AigcAssetService } from "./aigc-asset-service";
import type { AigcConnectionService } from "./aigc-connection-service";
import type { AigcInterfaceService } from "./aigc-interface-service";
import type { AigcPublicFileService } from "./aigc-public-file-service";
import type { AigcProtocolAdapter } from "./aigc-protocol-adapter";
import type { AigcTaskRepository } from "./aigc-task-repository";
import type { AigcWorkflowService } from "./aigc-workflow-service";

interface AigcTaskServiceDependencies {
  repository: AigcTaskRepository;
  /** 后台持久化异常接入系统错误观测。 */
  backgroundError?: (error: Error) => void;
  interfaces: AigcInterfaceService;
  workflows: AigcWorkflowService;
  connections: AigcConnectionService;
  credentials: CredentialService;
  assets: AigcAssetService;
  publicFiles: AigcPublicFileService;
  adapters: Record<string, AigcProtocolAdapter>;
}

/** 协调 AIGC 手动试运行、状态流转和任务历史。 */
export class AigcTaskService {
  /** 批量启动与取消互斥，防止取消与提交交错后错误确认上游已停止。 */
  private readonly lifecycle = new KeyedMutex();
  private readonly controllers = new Map<string, AbortController>();
  private readonly executionStates = new Map<string, AigcTaskExecutionState>();
  private readonly executions = new Map<string, Promise<void>>();
  /** 停服开始后不再接受新任务或重试。 */
  private closing = false;

  /** 所有入口共用的实际执行队列。 */
  private readonly queue: TaskExecutionQueue;
  /** 历史恢复完成后才接受新提交。 */
  private readonly ready: Promise<void>;
  /** @param dependencies AIGC 任务执行依赖 */
  constructor(private readonly dependencies: AigcTaskServiceDependencies, limits: Readonly<AigcAgentLimits> = DEFAULT_AIGC_AGENT_LIMITS) {
    this.queue = new TaskExecutionQueue({ global: limits.maxActiveTasks, perOwner: limits.maxActiveTasksPerAgent, hourly: limits.maxHourlyTasksPerAgent }, (error) => {
      dependencies.backgroundError?.(error);
    });
    this.ready = this.restore();
  }
  /** 恢复未启动队列，历史运行中任务由仓库标记中断。 */
  async initialize(): Promise<void> { await this.ready; }
  /** 内部恢复只执行一次。 */
  private async restore(): Promise<void> {
    const tasks = await this.dependencies.repository.list();
    for (const task of tasks) this.queue.restore(taskOwner(task), task.startedAt);
    for (const task of tasks.filter((task) => task.status === "queued").sort((a, b) => a.queueOrder! - b.queueOrder!)) this.enqueue(task);
  }
  /** 提交入口共用本地队列，不在调用方重复检查执行配额。 */
  private enqueue(task: AigcTaskRecord): void {
    this.queue.add({ id: task.id, owner: taskOwner(task), execute: () => this.startExecution(task.id) });
  }

  /** 列出任务摘要。 */
  async list(): Promise<AigcTaskDocument> {
    return {
      tasks: (await this.dependencies.repository.list()).map((task) => toSummary({ ...task, queueReason: this.queue.reason(task.id) }, this.executionStates.get(task.id))),
    };
  }

  /** 读取任务详情。 */
  async get(id: string): Promise<AigcTaskRecord | undefined> {
    const task = await this.dependencies.repository.get(id);
    return task ? withExecutionState({ ...task, queueReason: this.queue.reason(id) }, this.executionStates.get(id)) : undefined;
  }

  /** 创建任务并异步开始执行。 */
  async createRun(request: AigcRunRequest, agentOrigin?: AigcTaskRecord["agentOrigin"], mcpOrigin?: AigcTaskRecord["mcpOrigin"]): Promise<AigcTaskRecord> {
    await this.ready;
    if (this.closing) throw new Error("AIGC 服务正在停止");
    const item = await this.dependencies.interfaces.get(request.interfaceId);
    if (!item) throw new Error("AIGC 接口不存在");
    if (!item.enabled) throw new Error("AIGC 接口未启用");
    if (agentOrigin && !item.toolPublishEnabled) throw new Error("AIGC 接口未发布");
    if (mcpOrigin && !item.mcpPublishEnabled) throw new Error("AIGC 接口未开放给外部 MCP");
    if (item.protocol !== "comfyui" && hasComfyUiInput(request.inputs)) {
      throw new TypeError("仅 ComfyUI 接口支持 ComfyUI input");
    }
    const now = new Date().toISOString();
    if (this.closing) throw new Error("AIGC 服务正在停止");
    const task = await this.dependencies.repository.create({
      id: randomUUID(),
      ...(agentOrigin ? { agentOrigin } : {}),
      ...(mcpOrigin ? { mcpOrigin } : {}),
      interfaceId: item.id,
      interfaceName: item.name,
      channelId: item.channelId,
      status: "queued",
      inputs: { ...request.inputs },
      assets: [],
      createdAt: now,
      updatedAt: now,
    });
    this.enqueue(task);
    return task;
  }

  /** 只保存已校验的 Agent 任务，绝不启动适配器。 */
  async createPrepared(task: AigcTaskRecord): Promise<AigcTaskRecord> {
    await this.ready;
    if (this.closing) throw new Error("AIGC 服务正在停止");
    return this.dependencies.repository.create(task);
  }

  /** 全批持久化成功后才启动任何上游调用。 */
  async submitPrepared(entries: { id: string; inputs: Record<string, unknown> }[]): Promise<AigcTaskRecord[]> {
    return this.lifecycle.run("tasks", async () => {
      await this.ready;
      if (this.closing) throw new Error("AIGC 服务正在停止");
      const tasks = await this.dependencies.repository.submitPrepared(entries);
      for (const task of tasks) this.enqueue(task);
      return tasks;
    });
  }

  /** 取消排队中或执行中的任务。 */
  async cancel(id: string): Promise<AigcTaskRecord | undefined> {
    return this.lifecycle.run("tasks", async () => {
    const task = await this.dependencies.repository.get(id);
    if (!task) throw new Error("AIGC 任务不存在");
    if (!["prepared", "queued", "running"].includes(task.status)) throw new Error("仅待运行、排队中或执行中的任务可以取消");
    const notSubmitted = task.status === "prepared" || this.queue.suspend(id);
    this.controllers.get(id)?.abort();
    // 等待保存链收敛，避免取消后被迟到的成功响应覆盖。
    await this.executions.get(id)?.catch(() => undefined);
    this.executionStates.delete(id);
    const latest = await this.get(id);
    try {
      const cancelled = await this.updateTask(id, {
        status: "cancelled",
        upstreamCancellation: notSubmitted ? "confirmed" : latest?.upstreamCancellation ?? "unknown",
        updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      });
      this.queue.remove(id);
      return cancelled;
    } catch (error) {
      this.queue.resume(id);
      throw error;
    }
    });
  }

  /** 保存工具交付记录，防止每次查询都重复复制产物。 */
  async recordDelivery(id: string, deliveredFiles: Record<string, string>): Promise<void> {
    await this.updateTask(id, { deliveredFiles });
  }

  /** 读取内部完整记录，仅供有归属校验的应用服务使用。 */
  async listRecords(): Promise<AigcTaskRecord[]> {
    return this.dependencies.repository.list();
  }

  /** 停服时先终止请求并等待所有写入，避免遗留后台任务持有数据文件。 */
  async close(): Promise<void> {
    this.closing = true;
    this.queue.close();
    await this.ready;
    const ids = [...this.controllers.keys()];
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.executions.values()]);
    for (const id of ids) {
      const task = await this.get(id);
      if (task && ["queued", "running"].includes(task.status)) {
        await this.failTask(id, { code: "AIGC_INTERRUPTED", message: "服务停止，无法确认上游结果" });
      }
    }
  }

  /** 重新执行失败或已取消的任务。 */
  async retry(id: string): Promise<AigcTaskRecord | undefined> {
    await this.ready;
    if (this.closing) throw new Error("AIGC 服务正在停止");
    const task = await this.dependencies.repository.get(id);
    if (!task) throw new Error("AIGC 任务不存在");
    if (task.status !== "failed" && task.status !== "cancelled") throw new Error("仅失败或已取消的任务可以重试");
    if (task.preparation) throw new Error("Agent 任务不能隐式重试，请通过创建工具使用新 requestKey 创建任务");
    this.executionStates.delete(id);
    const next = await this.updateTask(id, {
      status: "queued",
      assets: [],
      deliveredFiles: undefined,
      upstreamCancellation: undefined,
      error: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      updatedAt: new Date().toISOString(),
    });
    if (next) this.enqueue(next);
    return next;
  }

  /** 删除任务；活动任务先中止并等待执行收敛，再级联清理全部产物。 */
  async remove(id: string): Promise<AigcTaskRecord> {
    const task = await this.dependencies.repository.get(id);
    if (!task) throw new Error("AIGC 任务不存在");
    await this.removeMany([id]);
    return task;
  }

  /** 整批暂停队位后再删除，失败保留原顺序，避免删除期间启动下一目标。 */
  async removeMany(ids: string[]): Promise<{ removedIds: string[] }> {
    return this.lifecycle.run("tasks", async () => {
      await this.ready;
      for (const id of ids) this.queue.suspend(id);
      try {
        for (const id of ids) {
          if (!await this.dependencies.repository.get(id)) throw new Error(`AIGC 任务不存在：${id}`);
        }
        for (const id of ids) this.controllers.get(id)?.abort();
        await Promise.all(ids.map((id) => this.executions.get(id)?.catch(() => undefined)));
        for (const id of ids) await this.dependencies.assets.removeTaskOutputs(id);
        const removed = await this.dependencies.repository.removeMany(ids);
        if (!removed) throw new Error("部分 AIGC 任务在批量删除期间已不存在");
        for (const id of ids) { this.queue.remove(id); this.executionStates.delete(id); }
        return { removedIds: removed.map((task) => task.id) };
      } finally {
        for (const id of ids) this.queue.resume(id);
      }
    });
  }

  /** 按媒体分组、任务与产物创建时间返回铺平后的产物页。 */
  async listOutputs(input: { kind: AigcOutputKind; sort: "asc" | "desc"; page: number; pageSize: number }): Promise<AigcOutputPage> {
    const tasks = await this.dependencies.repository.list();
    const counts = { image: 0, video: 0, audio: 0, other: 0 } satisfies Record<AigcOutputKind, number>;
    const items = tasks.flatMap((task) => task.assets.map((asset) => {
      const kind = outputKind(asset.mediaType);
      counts[kind] += 1;
      return { ...asset, taskId: task.id, interfaceName: task.interfaceName, taskCreatedAt: task.createdAt, kind };
    })).filter((asset) => asset.kind === input.kind).sort((left, right) => {
      const taskOrder = left.taskCreatedAt.localeCompare(right.taskCreatedAt);
      const assetOrder = left.createdAt.localeCompare(right.createdAt);
      const order = taskOrder || assetOrder || left.taskId.localeCompare(right.taskId) || left.id.localeCompare(right.id);
      return input.sort === "asc" ? order : -order;
    });
    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / input.pageSize));
    const page = Math.min(input.page, totalPages);
    const offset = (page - 1) * input.pageSize;
    return { items: items.slice(offset, offset + input.pageSize), counts, page, pageSize: input.pageSize, total, totalPages };
  }

  /** 注册单个任务执行 Promise，删除任务时可等待最终写入停止。 */
  private startExecution(id: string): Promise<void> {
    if (this.closing) {
      // 已提交但尚未启动的任务留在磁盘，下次启动恢复排队。
      return Promise.resolve();
    }
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const execution = this.executeTask(id, controller);
    this.executions.set(id, execution);
    return execution.finally(() => {
      if (this.executions.get(id) === execution) this.executions.delete(id);
      if (this.controllers.get(id) === controller) this.controllers.delete(id);
    });
  }

  /** 执行任务并写入最终状态。 */
  private async executeTask(id: string, controller: AbortController): Promise<void> {
    const task = await this.dependencies.repository.get(id);
    if (!task || task.status !== "queued") return;
    if (controller.signal.aborted) return;
    const item = await this.dependencies.interfaces.get(task.interfaceId);
    if (!item) return this.failTask(id, { code: "AIGC_INTERFACE_MISSING", message: "AIGC 接口不存在" });
    if (!item.enabled || (task.agentOrigin && !item.toolPublishEnabled) || (task.mcpOrigin && !item.mcpPublishEnabled)) {
      return this.failTask(id, { code: "AIGC_INTERFACE_DISABLED", message: "AIGC 接口未启用或已撤销发布" });
    }
    const channel = (await this.dependencies.connections.read()).channels.find((candidate) => candidate.id === item.channelId);
    if (!channel) return this.failTask(id, { code: "AIGC_CHANNEL_MISSING", message: "AIGC 渠道不存在" });
    if (!channel.enabled) return this.failTask(id, { code: "AIGC_CHANNEL_DISABLED", message: "AIGC 渠道未启用" });
    let workflow;
    try {
      workflow = task.preparation && item.protocol === "comfyui"
        ? await this.dependencies.workflows?.getPrivate((item.config as { workflowId: string }).workflowId) : undefined;
      if (task.preparation && task.preparation.definitionHash !== taskFingerprint({ item, channel, workflow, fields: agentFields(item, workflow), outputs: agentOutputs(item, workflow) }))
        return this.failTask(id, { code: "AIGC_INTERFACE_CHANGED", message: "任务执行前接口、渠道或工作流发生变化，请重新创建任务" });
    } catch (error) {
      return this.failTask(id, sanitizeError(error));
    }
    const adapter = this.dependencies.adapters[item.protocol];
    if (!adapter) return this.failTask(id, { code: "AIGC_PROTOCOL_UNSUPPORTED", message: "AIGC 协议暂不支持" });
    const signal = task.agentOrigin || task.mcpOrigin
      ? AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60_000)])
      : controller.signal;
    let upstreamCancellation: "confirmed" | "unknown" = "unknown";
    await this.updateTask(id, { status: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    try {
      const apiKey = await this.dependencies.credentials.getApiKey(channel.id);
      signal.throwIfAborted();
      const result = await adapter.execute({
        item,
        channel,
        apiKey,
        inputs: task.inputs,
        assets: this.dependencies.assets,
        publicFiles: this.dependencies.publicFiles,
        workflows: this.dependencies.workflows,
        ...(workflow ? { workflowSnapshot: workflow } : {}),
        signal,
        onCancellation: (status) => { upstreamCancellation = status; },
        onProgress: (state) => {
          // 进度事件可能非常密集，只保留内存快照供轮询接口读取。
          if (!controller.signal.aborted && this.controllers.get(id) === controller) {
            this.executionStates.set(id, { ...state });
          }
        },
      });
      const assets = [];
      for (const output of result.assets) {
        signal.throwIfAborted();
        const saved = await this.dependencies.assets.saveOutput(id, output.content, output.name, output.mediaType);
        assets.push({
          ...saved,
          outputId: output.outputId ?? "result",
          outputName: output.outputName ?? "result",
        });
      }
      signal.throwIfAborted();
      await this.updateTask(id, {
        status: "succeeded",
        assets,
        error: undefined,
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (signal.aborted) {
        await this.updateTask(id, {
          status: controller.signal.aborted ? "cancelled" : "failed",
          upstreamCancellation,
          ...(!controller.signal.aborted ? { error: { code: "AIGC_TIMEOUT", message: "任务超过 30 分钟，上游停止状态请人工核对" } } : {}),
          finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
      } else {
        await this.failTask(id, sanitizeError(error));
      }
    } finally {
      this.executionStates.delete(id);
      if (this.controllers.get(id) === controller) this.controllers.delete(id);
    }
  }

  /** 写入失败状态。 */
  private async failTask(id: string, error: AigcTaskError): Promise<void> {
    await this.updateTask(id, {
      status: "failed",
      error,
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  /** 更新任务并返回最新记录。 */
  private async updateTask(id: string, patch: Partial<AigcTaskRecord>): Promise<AigcTaskRecord | undefined> {
    const updated = await this.dependencies.repository.update(id, patch);
    return updated;
  }
}

/** 判断任务是否包含只能由 ComfyUI 直接引用的 input 目录文件。 */
function hasComfyUiInput(inputs: Record<string, unknown>): boolean {
  return Object.values(inputs).some((value) => (Array.isArray(value) ? value : [value]).some((entry) =>
    typeof entry === "object" && entry !== null && "source" in entry && entry.source === "comfyui_input"));
}

/** 将任务记录映射为列表摘要。 */
function toSummary(task: AigcTaskRecord, execution?: AigcTaskExecutionState): AigcTaskSummary {
  return {
    id: task.id,
    interfaceId: task.interfaceId,
    interfaceName: task.interfaceName,
    channelId: task.channelId,
    status: task.status,
    ...(task.preparation ? { requiresNewTask: true } : {}),
    assetCount: task.assets.length,
    queueReason: task.queueReason,
    ...(execution ? { execution: { ...execution } } : {}),
    ...(task.error ? { error: task.error } : {}),
    ...(task.upstreamCancellation ? { upstreamCancellation: task.upstreamCancellation } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.startedAt ? { startedAt: task.startedAt } : {}),
    ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
  };
}

/** 给任务详情附加不落盘的实时执行状态。 */
function withExecutionState(task: AigcTaskRecord, execution?: AigcTaskExecutionState): AigcTaskRecord {
  return execution ? { ...task, execution: { ...execution } } : task;
}

/** 将异常转换为不包含认证信息的任务错误。 */
function sanitizeError(error: unknown): AigcTaskError {
  return {
    code: error instanceof TypeError ? "AIGC_INPUT_INVALID" : "AIGC_UPSTREAM_FAILED",
    message: toSafePublicMessage(error, "AIGC 任务执行器捕获到非 Error 异常"),
  };
}

/** 将 MIME 类型归入产物页的四个稳定分组。 */
function outputKind(mediaType: string): AigcOutputKind {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  return "other";
}

/** 手动、Agent 和 MCP 调用方各自统计额度，但共用全局 FIFO。 */
function taskOwner(task: AigcTaskRecord): string {
  return task.agentOrigin ? `agent:${task.agentOrigin.agentId}` : task.mcpOrigin ? `mcp:${task.mcpOrigin.clientId}` : "manual";
}
