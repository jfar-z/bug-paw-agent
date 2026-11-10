import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import mime from "mime";
import type { AigcRunInputValue, AigcSingleRunInputValue, AigcTaskRecord } from "../../shared/aigc-contracts";
import type { WorkspaceFileService } from "../attachments";
import type { WorkspaceFileManager } from "../workspace-files";
import { taskFingerprint, taskFileFingerprint, validateTaskIds } from "../core/task-preparation";
import { KeyedMutex } from "../core/keyed-mutex";
import type { AigcAssetService } from "./aigc-asset-service";
import type { AigcConnectionService } from "./aigc-connection-service";
import type { AigcInterfaceService } from "./aigc-interface-service";
import type { AigcPublicFileService } from "./aigc-public-file-service";
import type { AigcTaskService } from "./aigc-task-service";
import type { AigcWorkflowService } from "./aigc-workflow-service";
import { DEFAULT_AIGC_AGENT_LIMITS, type AigcAgentLimits } from "./aigc-agent-limits";
import { agentFields, agentOutputs, validateAgentParameters, type AigcAgentParameter } from "./aigc-agent-parameters";

/** 工具调用身份只由 Runtime 提供，不能从模型参数读取。 */
export interface AigcAgentContext {
  agentId: string;
  sessionId: string;
}

/** AIGC 工具服务依赖既有领域边界，不自行读写配置或工作区。 */
export interface AigcAgentDependencies {
  interfaces: AigcInterfaceService;
  connections: AigcConnectionService;
  workflows: AigcWorkflowService;
  tasks: AigcTaskService;
  assets: AigcAssetService;
  publicFiles: AigcPublicFileService;
  publicOrigin?: string;
  workspace: WorkspaceFileManager;
  files: WorkspaceFileService;
  allowedTools(agentId: string): Promise<string[]>;
}

/** 只允许明确的业务错误进入模型上下文。 */
export class AigcAgentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** 统一处理 AIGC 发布权限、任务归属、配额、幂等和产物交付。 */
export class AigcAgentService {
  /** 查询限频只保留最近使用的有界条目。 */
  private readonly lastQueries = new Map<string, number>();

  /** 注入领域服务、实时授权读取函数和部署侧限流配置。 */
  constructor(
    private readonly dependencies: AigcAgentDependencies,
    private readonly limits: Readonly<AigcAgentLimits> = DEFAULT_AIGC_AGENT_LIMITS,
    private readonly locks: KeyedMutex = new KeyedMutex(),
  ) {}

  /** 每次调用读取最新 Agent 权限，旧 Runtime 不能绕过撤销授权。 */
  async authorize(context: AigcAgentContext, tool: string): Promise<void> {
    if (!(await this.dependencies.allowedTools(context.agentId)).includes(tool)) {
      throw new AigcAgentError("AIGC_TOOL_DENIED", "当前 Agent 未获工具授权，请在 Agent 工具权限中配置");
    }
  }

  /** 分页读取接口摘要；指定接口 ID 时才返回完整字段以控制上下文大小。 */
  async list(context: AigcAgentContext, input: { interfaceId?: string; offset?: number }) {
    await this.authorize(context, "aigc_list_interfaces");
    if (input.interfaceId) {
      const { item, fields, outputs } = await this.published(input.interfaceId);
      const description = agentDescription(item);
      return { interfaces: [{ id: item.id, name: item.name, description, instructions: description, capability: item.capability, fields, outputs }] };
    }
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("分页起点无效");
    const channels = (await this.dependencies.connections.read()).channels;
    const items = (await this.dependencies.interfaces.list()).interfaces.filter((item) => item.enabled && item.toolPublishEnabled
      && channels.some((channel) => channel.id === item.channelId && channel.enabled && channel.type === item.protocol));
    return {
      interfaces: items.slice(offset, offset + 20).map((item) => ({ id: item.id, name: item.name, description: agentDescription(item), capability: item.capability })),
      total: items.length, ...(offset + 20 < items.length ? { nextOffset: offset + 20 } : {}),
    };
  }

  /** 创建阶段只读取并校验，不上传媒体、不触发上游计算。 */
  async create(context: AigcAgentContext, input: { interfaceId: string; requestKey: string; parameters: AigcAgentParameter[] }, signal?: AbortSignal) {
    return this.locks.run("submissions", async () => {
      await this.authorize(context, "aigc_create_task");
      signal?.throwIfAborted();
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(input.requestKey)) throw new TypeError("requestKey 必须为 1 到 80 位字母、数字、下划线或连字符");
      const definition = await this.published(input.interfaceId);
      const values = validateAgentParameters(definition.fields, input.parameters);
      if (definition.item.protocol === "grok" && values.size !== undefined && !/^\d{2,5}x\d{2,5}$/.test(String(values.size))) throw new TypeError("size 必须使用 WIDTHxHEIGHT 格式");
      const requestHash = taskFingerprint([input.interfaceId, Object.fromEntries(input.parameters.map((parameter) => [parameter.name, parameter.value]))]);
      const records = await this.dependencies.tasks.listRecords();
      const previous = records.find((task) => task.agentOrigin?.agentId === context.agentId
        && task.agentOrigin.sessionId === context.sessionId && task.agentOrigin.requestKey === input.requestKey);
      if (previous) {
        if (previous.agentOrigin?.requestHash !== requestHash) throw new AigcAgentError("AIGC_IDEMPOTENCY_CONFLICT", "相同 requestKey 的参数已改变，不能重复创建");
        return { ...this.summary(previous), parameters: previous.preparation?.values ?? previous.inputs };
      }
      const media = await this.readMedia(context, definition.fields, values);
      const files = Object.fromEntries([...media.values()].flat().map(({ path, file }) => [path, taskFileFingerprint(file)]));
      if (definition.item.protocol === "grok" && media.size && !normalizePublicOrigin(this.dependencies.publicOrigin))
        throw new AigcAgentError("AIGC_PUBLIC_ORIGIN_UNAVAILABLE", "Grok 本地媒体需要配置 BUG_PAW_PUBLIC_ORIGIN，或使用明确的 BUG_PAW_BIND_ADDRESS");
      await this.authorize(context, "aigc_create_task");
      if (taskFingerprint(await this.published(input.interfaceId)) !== taskFingerprint(definition))
        throw new AigcAgentError("AIGC_INTERFACE_CHANGED", "校验期间接口定义发生变化，请重新创建任务");
      signal?.throwIfAborted();
      const now = new Date().toISOString();
      const task = await this.dependencies.tasks.createPrepared({
        id: randomUUID(), interfaceId: definition.item.id, interfaceName: definition.item.name, channelId: definition.item.channelId,
        status: "prepared", inputs: values, assets: [], createdAt: now, updatedAt: now,
        agentOrigin: { ...context, requestKey: input.requestKey, requestHash },
        preparation: { values, files, definitionHash: taskFingerprint(definition) },
      });
      return { ...this.summary(task), parameters: values };
    });
  }

  /** 异步批量运行，仅接受创建工具返回的真实 ID。 */
  async run(context: AigcAgentContext, input: { taskIds: string[] }, signal?: AbortSignal) {
    return this.submit(context, input.taskIds, "aigc_run", signal);
  }

  /** 先提交整批再等待；聊天中止只结束等待，后台执行继续。 */
  async runAndWait(context: AigcAgentContext, input: { taskIds: string[] }, signal?: AbortSignal,
    onProgress?: (state: { tasks: Awaited<ReturnType<AigcAgentService["get"]>>[] }) => void) {
    const deadline = Date.now() + 30 * 60_000;
    const submitted = await this.submit(context, input.taskIds, "aigc_run_and_wait", signal);
    let state = { tasks: submitted.tasks.map((task) => ({ ...task, files: [] as Awaited<ReturnType<AigcAgentService["get"]>>["files"] })) };
    onProgress?.(state);
    try {
      while (true) {
        signal?.throwIfAborted();
        state = { tasks: await Promise.all(input.taskIds.map((id) => this.readTask(context, id, "aigc_run_and_wait", false, signal))) };
        onProgress?.(state);
        if (state.tasks.every((task) => !["queued", "running"].includes(task.status))) return { ...state, waitStatus: "completed" as const };
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { ...state, waitStatus: "timed_out" as const };
        await delay(Math.min(5_000, remaining), undefined, { signal });
      }
    } catch (error) {
      if (signal?.aborted) return { ...state, waitStatus: "interrupted" as const };
      throw error;
    }
  }

  /** 整批校验完成后原子提交状态，执行额度由统一 FIFO 队列控制。 */
  private async submit(context: AigcAgentContext, ids: string[], tool: string, signal?: AbortSignal) {
    return this.locks.run("submissions", async () => {
      await this.authorize(context, tool);
      validateTaskIds(ids);
      signal?.throwIfAborted();
      const tasks = await Promise.all(ids.map((id) => this.owned(context, id)));
      const candidates = [];
      for (const task of tasks) {
        const definition = await this.published(task.interfaceId);
        if (task.status !== "prepared") continue;
        if (!task.preparation || task.preparation.definitionHash !== taskFingerprint(definition))
          throw new AigcAgentError("AIGC_INTERFACE_CHANGED", `任务 ${task.id} 的接口或工作流定义已变化，请重新创建任务`);
        const values = validateAgentParameters(definition.fields, Object.entries(task.preparation.values).map(([name, value]) => ({ name, value })) as AigcAgentParameter[]);
        const media = await this.readMedia(context, definition.fields, values);
        const files = Object.fromEntries([...media.values()].flat().map(({ path, file }) => [path, taskFileFingerprint(file)]));
        if (taskFingerprint(files) !== taskFingerprint(task.preparation.files))
          throw new AigcAgentError("AIGC_INPUT_CHANGED", `任务 ${task.id} 的输入文件已变化，请重新创建任务`);
        candidates.push({ task, definition, values, media });
      }
      const uploads: string[] = [], publicUploads: string[] = [];
      let committed = false;
      try {
        const entries = [];
        for (const candidate of candidates) {
          const inputs: Record<string, AigcRunInputValue> = { ...candidate.values } as Record<string, AigcRunInputValue>;
          for (const [name, media] of candidate.media) {
            const references: AigcSingleRunInputValue[] = [];
            for (const { file } of media) {
              signal?.throwIfAborted();
              if (candidate.definition.item.protocol === "grok") {
                const publicOrigin = normalizePublicOrigin(this.dependencies.publicOrigin);
                if (!publicOrigin) throw new AigcAgentError("AIGC_PUBLIC_ORIGIN_UNAVAILABLE", "Grok 媒体公开地址不可用，请检查 BUG_PAW_PUBLIC_ORIGIN");
                const saved = await this.dependencies.publicFiles.save(Readable.from(file.content), `agent-${randomUUID()}-${file.name}`, file.mediaType);
                publicUploads.push(saved.id);
                references.push(`${publicOrigin}/aigc-public/files/${encodeURIComponent(saved.id)}`);
              } else {
                const saved = await this.dependencies.assets.saveInput(Readable.from(file.content), file.name, file.mediaType);
                uploads.push(saved.id);
                references.push({ assetId: saved.id, name: saved.name, mediaType: saved.mediaType });
              }
            }
            inputs[name] = Array.isArray(candidate.values[name]) ? references : references[0];
          }
          entries.push({ id: candidate.task.id, inputs });
        }
        await this.authorize(context, tool);
        for (const candidate of candidates)
          if (taskFingerprint(await this.published(candidate.task.interfaceId)) !== candidate.task.preparation!.definitionHash)
            throw new AigcAgentError("AIGC_INTERFACE_CHANGED", `任务 ${candidate.task.id} 的配置在准备期间变化，请重新创建任务`);
        signal?.throwIfAborted();
        const started = entries.length ? await this.dependencies.tasks.submitPrepared(entries) : [];
        committed = true;
        const byId = new Map(started.map((task) => [task.id, task]));
        return { tasks: tasks.map((task) => this.summary(byId.get(task.id) ?? task)) };
      } finally {
        if (!committed) await Promise.all([
          ...uploads.map((id) => this.dependencies.assets.removeInput(id)),
          ...publicUploads.map((id) => this.dependencies.publicFiles.remove(id)),
        ]);
      }
    });
  }

  /** 文件只读校验供创建和运行复用；保留读入内容以避免上传前再次读取产生竞争。 */
  private async readMedia(context: AigcAgentContext, fields: ReturnType<typeof agentFields>, values: Record<string, unknown>) {
    const media = new Map<string, { path: string; file: Awaited<ReturnType<WorkspaceFileManager["readFile"]>> }[]>();
    let totalBytes = 0;
    for (const field of fields) {
      if (field.source !== "workspace" || values[field.name] === undefined) continue;
      const references = (Array.isArray(values[field.name]) ? values[field.name] : [values[field.name]]) as string[];
      const entries = [];
      for (const path of references) {
        const file = await this.dependencies.workspace.readFile(context.agentId, path, 100 * 1024 * 1024);
        if (!file.mediaType.startsWith(`${field.type}/`)) throw new TypeError(`参数 ${field.name} 媒体类型不匹配`);
        totalBytes += file.content.length;
        if (totalBytes > 200 * 1024 * 1024) throw new TypeError("单任务媒体入参总量不能超过 200 MiB");
        entries.push({ path, file });
      }
      media.set(field.name, entries);
    }
    return media;
  }

  /** 按归属查询任务，完成时把产物交付到所属 Agent 的附件目录。 */
  async get(context: AigcAgentContext, taskId: string) {
    return this.readTask(context, taskId, "aigc_get_task", true);
  }

  /** 阻塞等待自行限频，不占用外部查询限频窗口；交付仍按任务串行化。 */
  private async readTask(
    context: AigcAgentContext,
    taskId: string,
    tool: "aigc_get_task" | "aigc_run_and_wait",
    rateLimit: boolean,
    signal?: AbortSignal,
  ) {
    await this.authorize(context, tool);
    return this.locks.run(taskId, async () => {
      signal?.throwIfAborted();
      await this.authorize(context, tool);
      const task = await this.owned(context, taskId);
      await this.published(task.interfaceId);
      const queryKey = `${context.agentId}:${taskId}`;
      const now = Date.now();
      if (rateLimit) {
        if (now - (this.lastQueries.get(queryKey) ?? 0) < this.limits.queryIntervalMs) {
          throw new AigcAgentError("AIGC_QUERY_TOO_FREQUENT", `任务查询间隔至少 ${this.limits.queryIntervalMs / 1_000} 秒`);
        }
        this.lastQueries.delete(queryKey);
        this.lastQueries.set(queryKey, now);
        if (this.lastQueries.size > 1_000) this.lastQueries.delete(this.lastQueries.keys().next().value!);
      }
      const files: { path: string; name: string; mediaType: string; size: number; outputId: string; outputName: string }[] = [];
      if (task.status === "succeeded") {
        const delivered = { ...task.deliveredFiles };
        let totalBytes = 0;
        for (const asset of task.assets) {
          totalBytes += asset.size;
          if (totalBytes > 200 * 1024 * 1024 || task.assets.length > 20) {
            throw new AigcAgentError("AIGC_DELIVERY_LIMIT", "产物超过 20 个或总量超过 200 MiB，请在 AIGC 工作台查看");
          }
        }
        for (const asset of task.assets) {
          signal?.throwIfAborted();
          let file = delivered[asset.id] ? await this.dependencies.files.resolve(context.agentId, delivered[asset.id]) : undefined;
          if (!file) {
            const content = await this.dependencies.assets.readOutput(task.id, asset.id, 200 * 1024 * 1024);
            signal?.throwIfAborted();
            const extension = mime.getExtension(asset.mediaType) ?? "bin";
            file = await this.dependencies.files.saveUpload(context.agentId, `aigc-${task.id}-${asset.id}.${extension}`, asset.mediaType, Readable.from(content));
            delivered[asset.id] = file.path;
            await this.dependencies.tasks.recordDelivery(task.id, delivered);
          }
          files.push({
            path: file.path,
            name: asset.name,
            mediaType: asset.mediaType,
            size: file.size,
            outputId: asset.outputId ?? "result",
            outputName: asset.outputName ?? "result",
          });
        }
      }
      return { ...this.summary(task), files };
    });
  }

  /** 撤销发布后仍允许所有者停止已有任务，但不再允许启动或读取。 */
  async cancel(context: AigcAgentContext, taskId: string) {
    await this.authorize(context, "aigc_cancel_task");
    const task = await this.owned(context, taskId);
    if (task.status === "cancelled") return this.summary(task);
    if (!["prepared", "queued", "running"].includes(task.status)) throw new AigcAgentError("AIGC_NOT_CANCELLABLE", "任务已结束，不能取消");
    const cancelled = await this.dependencies.tasks.cancel(task.id);
    return this.summary(cancelled!);
  }

  /** 只读已发布且渠道匹配的接口，禁止暴露凭证和内部地址。 */
  private async published(id: string) {
    const item = await this.dependencies.interfaces.get(id);
    const channel = item && (await this.dependencies.connections.read()).channels.find((candidate) => candidate.id === item.channelId);
    if (!item?.enabled || !item.toolPublishEnabled || !channel?.enabled || channel.type !== item.protocol) {
      throw new AigcAgentError("AIGC_INTERFACE_UNAVAILABLE", "接口不存在、未发布或渠道已停用，请在 AIGC 工作台检查");
    }
    const workflow = item.protocol === "comfyui" ? await this.dependencies.workflows.getPrivate((item.config as { workflowId: string }).workflowId) : undefined;
    return { item, channel, workflow, fields: agentFields(item, workflow), outputs: agentOutputs(item, workflow) };
  }

  /** 无归属的手动任务和其他 Agent 任务统一表现为不可访问。 */
  private async owned(context: AigcAgentContext, id: string): Promise<AigcTaskRecord> {
    const task = await this.dependencies.tasks.get(id);
    if (!task || task.agentOrigin?.agentId !== context.agentId) throw new AigcAgentError("AIGC_TASK_NOT_FOUND", "当前 Agent 无权访问此任务或任务不存在");
    return task;
  }

  /** 返回白名单字段；上游原始错误和节点名不进入工具上下文。 */
  private summary(task: AigcTaskRecord) {
    return {
      taskId: task.id, interfaceId: task.interfaceId, status: task.status, queueReason: task.queueReason,
      ...(task.execution ? { progress: {
        phase: task.execution.phase, queueAhead: task.execution.queueAhead,
        value: task.execution.progressValue, max: task.execution.progressMax,
      } } : {}),
      ...(task.error ? { error: { code: task.error.code, message: task.error.message } } : {}),
      ...(task.status === "cancelled" ? {
        upstreamCancellation: task.upstreamCancellation ?? (task.submittedAt || !task.preparation ? "unknown" : "confirmed"),
        message: task.preparation && !task.submittedAt ? "待运行任务已取消，未提交上游" : task.upstreamCancellation === "confirmed" ? "已确认移除上游排队任务" : "本地任务已取消，上游可能仍在计算或计费",
      } : {}),
      pollAfterMs: 5_000,
    };
  }
}

/** 优先返回 Agent 专用说明，兼容尚未保存新字段的历史接口。 */
function agentDescription(item: { description: string; toolDescription?: string }): string {
  return item.toolDescription?.trim() || item.description;
}

/** 归一化部署侧公开地址，避免把路径、凭据或查询参数带入媒体 URL。 */
function normalizePublicOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new TypeError("BUG_PAW_PUBLIC_ORIGIN 必须是不含路径、凭据、查询参数或片段的 HTTP(S) Origin");
  }
  return url.origin;
}
