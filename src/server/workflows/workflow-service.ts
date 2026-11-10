import { TaskExecutionQueue } from "../core/task-execution-queue";
import { workflowNodesDeep, type WorkflowSemaphoreInput } from "../../shared/workflow-contracts";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  WorkflowDefinition,
  WorkflowSummary,
  WorkflowDraft,
  WorkflowRun,
  WorkflowNode,
  WorkflowBinding,
  WorkflowCondition,
  WorkflowNodeRun,
  WorkflowCatalog,
} from "../../shared/workflow-contracts";
import { DomainError, toSafePublicMessage } from "../core/errors";
import type { TaskPreparation } from "../../shared/task-preparation-contracts";
import { taskFingerprint, validateTaskIds } from "../core/task-preparation";
import { KeyedMutex } from "../core/keyed-mutex";
import { WorkflowRepository } from "./workflow-repository";
import {
  checkValueSize,
  invalid,
  record,
  validateValues,
  validateWorkflow,
} from "./workflow-validation";
import {
  snapshotWorkflowDependencies,
  workflowDependencies,
} from "./workflow-dependencies";
import { WorkflowExecutionBudget } from "./workflow-execution-budget";
import { runWorkflowScript } from "./workflow-script";

export interface WorkflowExecutionContext {
  run: WorkflowRun;
  node: WorkflowNode;
  signal: AbortSignal;
  referenceGroups?: Record<string, unknown>;
  progress(message: string): Promise<void>;
}
export interface WorkflowExecutor {
  /** 创建与运行复核外部能力配置，返回内容只参与指纹，不进入工具结果。 */
  preparationFingerprint?(definition: WorkflowDefinition): Promise<unknown>;
  execute(
    context: WorkflowExecutionContext,
    inputs: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  validate?(
    definition: WorkflowDefinition,
    origin?: WorkflowRun["origin"],
  ): Promise<void>;
}
/** DAG 调度器负责幂等、快照、分支、有限并发、取消与持久化观测。 */
export class WorkflowService {
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly executions = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private readonly lock = new KeyedMutex();
  private closing = false;
  private sequence = 0;
  private readonly queue = new TaskExecutionQueue({ global: 8, perOwner: 2, hourly: 60 }, (error) => this.backgroundError(error));
  /** 配置和运行共享同一个信号量管理器。 */
  get semaphores() { return this.repository.semaphores; }
  /** 配置变更与运行提交串行，避免引用校验后删除资源。 */
  saveSemaphore(input: WorkflowSemaphoreInput, revision?: number) {
    return this.lock.run("submit", () => this.semaphores.save(input, revision));
  }
  /** 已保存定义或未终止快照仍引用的信号量不可删除。 */
  removeSemaphore(code: string, revision: number): Promise<void> {
    return this.lock.run("submit", async () => {
      const definitions = [...this.repository.definitions().map((item) => this.repository.definition(item.id)!),
        ...[...this.runs.values()].filter((run) => ["prepared", "queued", "running"].includes(run.status)).flatMap((run) => [run.definition, ...Object.values(run.dependencies ?? {})])];
      if (definitions.some((definition) => workflowNodesDeep(definition).some((node) => node.config.semaphoreCode === code))) throw new DomainError("CONFLICT", "信号量仍被工作流定义或活动任务引用，请先移除引用");
      await this.semaphores.remove(code, revision);
    });
  }
  constructor(
    private readonly repository: WorkflowRepository,
    private readonly executor: WorkflowExecutor,
    private readonly backgroundError: (error: Error) => void = () => undefined,
    private readonly checkFiles?: (definition: WorkflowDraft, inputs?: unknown) => Promise<void>,
  ) {}
  /** 重启后不重复提交可能计费的节点；中断运行明确标记失败。 */
  async initialize(): Promise<void> {
    await this.semaphores.initialize();
    for (const run of await this.repository.runs()) {
      this.sequence = Math.max(this.sequence, run.queueOrder ?? 0);
      this.queue.restore(run.origin ? `agent:${run.origin.agentId}` : "manual", run.startedAt);
      if (run.status === "running" || (run.status === "queued" && run.queueOrder === undefined)) {
        run.status = "failed";
        run.finishedAt = new Date().toISOString();
        run.error = {
          code: "WORKFLOW_INTERRUPTED",
          message:
            "服务重启导致工作流中断；未自动重试，请检查上游任务后重新运行",
          requestId: run.id,
        };
        const interrupt = (scope: WorkflowRun) => {
          if (scope !== run && ["queued", "running"].includes(scope.status)) {
            scope.status = "failed";
            scope.error = run.error;
            scope.finishedAt = run.finishedAt;
          }
          for (const n of scope.nodes) {
            if (n.status === "queued") n.status = "skipped";
            else if (n.status === "running") {
              n.status = "failed";
              n.error = run.error;
            }
            if (!n.finishedAt) n.finishedAt = run.finishedAt;
            for (const child of n.children ?? []) interrupt(child);
          }
        };
        interrupt(run);
        await this.repository.saveRun(run);
      }
      this.runs.set(run.id, run);
    }
    for (const run of [...this.runs.values()].filter((run) => run.status === "queued").sort((a, b) => a.queueOrder! - b.queueOrder!)) this.enqueue(run);
  }
  async list(): Promise<WorkflowSummary[]> {
    return this.repository.definitions();
  }
  /** 目录单项损坏以明确禁用原因呈现，不阻止其他工作流继续选择。 */
  catalogWorkflows(): NonNullable<WorkflowCatalog["workflows"]> {
    return this.repository.definitions().map((summary) => {
      try {
        const definition = this.repository.definition(summary.id)!;
        const snapshots = snapshotWorkflowDependencies(definition, (id) =>
          this.repository.definition(id),
        );
        return {
          id: summary.id,
          name: summary.name,
          dependencies: Object.keys(snapshots),
          enumFields: definition.nodes
            .find((node) => node.kind === "input")!
            .outputs.filter((field) => field.enumValues?.length)
            .map((field) => ({
              name: field.name,
              values: field.enumValues!.map(String),
            })),
        };
      } catch (error) {
        return {
          id: summary.id,
          name: summary.name,
          dependencies: [],
          unavailable: toSafePublicMessage(
            error,
            `读取工作流 ${summary.name} 的调用依赖时未返回可读异常`,
          ),
        };
      }
    });
  }
  /** 校验未保存草稿时仍使用当前真实 ID，避免遗漏指向自身的间接环路。 */
  validate(draft: WorkflowDraft, id?: string): void {
    validateWorkflow(draft, true);
    const now = new Date().toISOString();
    snapshotWorkflowDependencies(
      {
        ...draft,
        id: id ?? randomUUID(),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
      (key) => this.repository.definition(key),
      true,
    );
  }
  async get(id: string): Promise<WorkflowDefinition> {
    const item = this.repository.definition(id);
    if (!item) throw new DomainError("NOT_FOUND", "工作流不存在");
    return item;
  }
  async save(
    draft: WorkflowDraft,
    id?: string,
    revision?: number,
  ): Promise<WorkflowDefinition> {
    return this.withFileMutation(async () => {
      validateWorkflow(draft, record(draft) && draft.published === true);
      for (const node of workflowNodesDeep(draft)) if (node.config.semaphoreCode) this.semaphores.get(node.config.semaphoreCode);
      await this.checkFiles?.(draft);
      const targetId = id ?? randomUUID();
      return this.repository.mutateDefinition(targetId, (current) => {
        if (id && !current) throw new DomainError("NOT_FOUND", "工作流不存在");
        if (current && current.revision !== revision)
          throw new DomainError(
            "VERSION_CONFLICT",
            "工作流已被其他页面修改，请重新加载后编辑",
          );
        const now = new Date().toISOString();
        const next: WorkflowDefinition = {
          ...structuredClone({
            editorSettings: draft.editorSettings,
            name: draft.name,
            description: draft.description,
            published: draft.published,
            nodes: draft.nodes,
            edges: draft.edges,
          }),
          id: targetId,
          revision: (current?.revision ?? 0) + 1,
          createdAt: current?.createdAt ?? now,
          updatedAt: now,
        };
        snapshotWorkflowDependencies(
          next,
          (key) => this.repository.definition(key),
          next.published,
        );
        return { value: next, result: next };
      });
    });
  }
  async remove(id: string, revision: number): Promise<void> {
    await this.lock.run("submit", async () =>
      this.repository.mutateDefinition(id, (current) => {
        if (!current) throw new DomainError("NOT_FOUND", "工作流不存在");
        if (current.revision !== revision)
          throw new DomainError(
            "VERSION_CONFLICT",
            "工作流版本已改变，请刷新列表",
          );
        if (
          [...this.runs.values()].some(
            (r) =>
              r.workflowId === id && ["prepared", "running", "queued"].includes(r.status),
          )
        )
          throw new DomainError(
            "CONFLICT",
            "工作流仍有运行中任务，请先取消或等待完成",
          );
        for (const other of this.repository.definitions()) {
          if (other.id === id) continue;
          const definition = this.repository.definition(other.id)!;
          if (workflowDependencies(definition).includes(id))
            throw new DomainError(
              "CONFLICT",
              `工作流仍被“${other.name}”引用，请先移除调用节点`,
            );
        }
        return { result: undefined };
      }),
    );
  }
  /** 文件删除与定义保存、任务启动共用临界区，防止引用检查后出现竞争。 */
  withFileMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.lock.run("submit", operation);
  }
  /** 文件索引只读快照；避免为每个文件列表深拷贝全部运行正文。 */
  fileUsageSnapshot(): { definitions: WorkflowDefinition[]; runs: readonly WorkflowRun[] } {
    return { definitions: this.repository.definitions().map((item) => this.repository.definition(item.id)!), runs: [...this.runs.values()] };
  }
  listRuns(origin?: WorkflowRun["origin"]): WorkflowRun[] {
    return [...this.runs.values()]
      .filter((r) => !origin || r.origin?.agentId === origin.agentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => ({ ...structuredClone(r), queueReason: this.queue.reason(r.id) }));
  }
  getRun(id: string, origin?: WorkflowRun["origin"]): WorkflowRun {
    const run = this.runs.get(id);
    if (!run || (origin && run.origin?.agentId !== origin.agentId))
      throw new DomainError(
        "NOT_FOUND",
        "当前调用方无权访问此工作流任务或任务不存在",
      );
    return { ...structuredClone(run), queueReason: this.queue.reason(run.id) };
  }
  /** 创建幂等先于文件读取；已存在任务不会因原输入文件被移除而重复导入。 */
  existingRequest(workflowId: string, inputs: Record<string, unknown>, requestKey: string, origin?: WorkflowRun["origin"]): WorkflowRun | undefined {
    if (typeof requestKey !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(requestKey))
      invalid("requestKey 必须为 1 到 80 位字母、数字、下划线或连字符");
    const run = [...this.runs.values()].find((item) => item.origin?.agentId === origin?.agentId && item.origin?.sessionId === origin?.sessionId && item.requestKey === requestKey);
    if (!run) return undefined;
    const hash = createHash("sha256").update(stableJson({ workflowId, inputs })!).digest("hex");
    if (hash !== run.requestHash) throw new DomainError("CONFLICT", "同一 requestKey 的工作流或参数已变化");
    return this.getRun(run.id, origin);
  }

  /** 手动入口仍支持立即运行，Agent 必须先使用 createPrepared 创建。 */
  async start(workflowId: string, inputs: Record<string, unknown>, requestKey: string,
    origin?: WorkflowRun["origin"], idempotencyInputs: Record<string, unknown> = inputs): Promise<WorkflowRun> {
    return this.create(workflowId, inputs, requestKey, origin, idempotencyInputs);
  }

  /** 保存已校验任务，不占运行额度，也不执行任何节点。 */
  async createPrepared(workflowId: string, inputs: Record<string, unknown>, requestKey: string,
    origin: NonNullable<WorkflowRun["origin"]>, raw: Record<string, unknown>, files: Record<string, string>, expectedDefinition?: string): Promise<WorkflowRun> {
    return this.create(workflowId, inputs, requestKey, origin, raw, { values: raw, files, definitionHash: "" }, expectedDefinition);
  }

  /** 同一会话的 requestKey 保持稳定，参数变更时拒绝重用。 */
  private async create(
    workflowId: string,
    inputs: Record<string, unknown>,
    requestKey: string,
    origin?: WorkflowRun["origin"],
    idempotencyInputs: Record<string, unknown> = inputs,
    preparation?: TaskPreparation,
    expectedDefinition?: string,
  ): Promise<WorkflowRun> {
    return this.lock.run("submit", async () => {
      if (this.closing) throw new DomainError("CONFLICT", "工作流服务正在关闭");
      if (
        typeof requestKey !== "string" ||
        !/^[A-Za-z0-9_-]{1,80}$/.test(requestKey)
      )
        invalid("requestKey 必须为 1 到 80 位字母、数字、下划线或连字符");
      checkValueSize(inputs);
      const hash = createHash("sha256")
        .update(stableJson({ workflowId, inputs: idempotencyInputs })!)
        .digest("hex");
      const existing = this.existingRequest(workflowId, idempotencyInputs, requestKey, origin);
      if (existing) return existing;
      const definition = await this.get(workflowId);
      if (expectedDefinition && taskFingerprint(definition) !== expectedDefinition)
        throw new DomainError("CONFLICT", "创建期间工作流定义变化，请重新查询参数并创建任务");
      if (origin && !definition.published)
        throw new DomainError("FORBIDDEN", "工作流未发布为 Agent 工具");
      validateWorkflow(definition, true);
      const dependencies = snapshotWorkflowDependencies(
        definition,
        (key) => this.repository.definition(key),
        true,
      );
      for (const snapshot of [definition, ...Object.values(dependencies)]) {
        const validateScope = async (
          scope: WorkflowDefinition,
        ): Promise<void> => {
          await this.executor.validate?.(scope, origin);
          for (const node of scope.nodes)
            if (node.kind === "loop" && node.config.loop)
              await validateScope({ ...scope, ...node.config.loop.body });
        };
        await validateScope(snapshot);
      }
      for (const snapshot of [definition, ...Object.values(dependencies)])
        await this.checkFiles?.(snapshot);
      if (!preparation) await this.checkFiles?.(definition, inputs);
      const values = validateValues(
        definition.nodes.find((n) => n.kind === "input")!.outputs,
        inputs,
      );
      if (preparation) {
        preparation = { ...preparation, values: { ...values, ...preparation.values }, definitionHash: await this.preparationFingerprint(definition, dependencies) };
      }
      const run: WorkflowRun = {
        id: randomUUID(),
        workflowId,
        definition,
        dependencies,
        status: preparation ? "prepared" : "queued",
        inputs: preparation?.values ?? values,
        ...(preparation ? { preparation } : { submittedAt: new Date().toISOString(), queueOrder: ++this.sequence }),
        outputs: {},
        nodes: definition.nodes.map((n) => ({
          nodeId: n.id,
          status: "queued",
          events: [],
        })),
        createdAt: new Date().toISOString(),
        origin,
        requestKey,
        requestHash: hash,
      };
      new WorkflowExecutionBudget(run);
      await this.repository.saveRun(run);
      this.runs.set(run.id, run);
      if (!preparation) this.enqueue(run);
      return structuredClone(run);
    });
  }
  /** 整批重新验证定义和输入，提交凭据落盘后才按顺序入队。 */
  async startBatch(ids: string[], origin: NonNullable<WorkflowRun["origin"]>,
    prepareInputs: (run: WorkflowRun) => Promise<Record<string, unknown>>,
    authorize: () => Promise<void>): Promise<WorkflowRun[]> {
    return this.lock.run("submit", async () => {
      await authorize();
      validateTaskIds(ids);
      if (this.closing) throw new DomainError("CONFLICT", "工作流服务正在关闭");
      const runs = ids.map((id) => this.getRun(id, origin));
      const pending = runs.filter((run) => run.status === "prepared");
      for (const run of runs) {
        const definition = await this.get(run.workflowId);
        if (!definition.published) throw new DomainError("FORBIDDEN", "工作流未发布或已撤销发布");
        if (run.status !== "prepared") continue;
        const dependencies = snapshotWorkflowDependencies(definition, (id) => this.repository.definition(id), true);
        if (!run.preparation || run.preparation.definitionHash !== await this.preparationFingerprint(definition, dependencies))
          throw new DomainError("CONFLICT", `任务 ${run.id} 的工作流定义已变化，请重新创建任务`);
        for (const snapshot of [definition, ...Object.values(dependencies)]) {
          const validate = async (scope: WorkflowDefinition): Promise<void> => {
            await this.executor.validate?.(scope, origin);
            for (const node of scope.nodes) if (node.kind === "loop" && node.config.loop) await validate({ ...scope, ...node.config.loop.body });
          };
          await validate(snapshot);
          await this.checkFiles?.(snapshot);
        }
      }
      const now = new Date().toISOString();
      for (const run of pending) {
        run.inputs = validateValues(run.definition.nodes.find((node) => node.kind === "input")!.outputs, await prepareInputs(run));
        await this.checkFiles?.(run.definition, run.inputs);
        run.status = "queued";
        run.submittedAt = now;
        run.queueOrder = ++this.sequence;
      }
      await authorize();
      if (this.closing) throw new DomainError("CONFLICT", "工作流服务正在关闭");
      // 文件准备期间仍可能被外部编辑，持久化前再次检查完整定义树。
      for (const run of pending) {
        const definition = await this.get(run.workflowId);
        const dependencies = snapshotWorkflowDependencies(definition, (id) => this.repository.definition(id), true);
        if (!definition.published || await this.preparationFingerprint(definition, dependencies) !== run.preparation!.definitionHash)
          throw new DomainError("CONFLICT", `任务 ${run.id} 的工作流定义在准备期间变化，请重新创建任务`);
      }
      if (pending.length) await this.repository.saveBatch(pending);
      for (const run of pending) this.runs.set(run.id, run);
      for (const run of pending) this.enqueue(run);
      return structuredClone(runs);
    });
  }

  /** 完整依赖树与各层外部能力共同参与创建时的配置指纹。 */
  private async preparationFingerprint(definition: WorkflowDefinition, dependencies: Record<string, WorkflowDefinition>): Promise<string> {
    const inspect = async (scope: WorkflowDefinition): Promise<unknown[]> => {
      const values = [await this.executor.preparationFingerprint?.(scope)];
      for (const node of scope.nodes) if (node.kind === "loop" && node.config.loop) values.push(await inspect({ ...scope, ...node.config.loop.body }));
      return values;
    };
    return taskFingerprint([definition, dependencies, await Promise.all([definition, ...Object.values(dependencies)].map(inspect))]);
  }

  /** 提交成功后按 FIFO 调度，排队任务不占实际运行额度。 */
  private enqueue(run: WorkflowRun): void {
    this.queue.add({ id: run.id, owner: run.origin ? `agent:${run.origin.agentId}` : "manual", execute: () => this.launch(run) });
  }
  /** 只有获得执行额度后才创建控制器和执行超时。 */
  private launch(run: WorkflowRun): Promise<void> {
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => { run.startedAt = new Date().toISOString(); return this.execute(run, controller); })
      .catch((error) =>
        this.backgroundError(
          error instanceof Error ? error : new Error("工作流终态持久化失败"),
        ),
      )
      .finally(() => this.executions.delete(run.id));
    this.executions.set(run.id, { controller, promise });
    return promise;
  }

  async cancel(
    id: string,
    origin?: WorkflowRun["origin"],
  ): Promise<WorkflowRun> {
    await this.lock.run("submit", async () => {
      const run = this.getRun(id, origin);
      if (run.status === "prepared" || this.queue.suspend(id)) {
        run.status = "cancelled";
        run.finishedAt = new Date().toISOString();
        for (const node of run.nodes) node.status = "skipped";
        try {
          await this.repository.saveRun(run);
          this.runs.set(id, run);
          this.queue.remove(id);
        } catch (error) {
          this.queue.resume(id);
          throw error;
        }
      }
    });
    const job = this.executions.get(id);
    if (job) {
      job.controller.abort(new Error("用户取消工作流"));
      await job.promise;
    }
    return this.getRun(id, origin);
  }
  async wait(
    id: string,
    signal?: AbortSignal,
    progress?: (run: WorkflowRun) => void,
  ): Promise<WorkflowRun> {
    const deadline = Date.now() + 30 * 60_000;
    while (true) {
      const run = this.getRun(id);
      progress?.(run);
      if (
        !["running", "queued"].includes(run.status) ||
        signal?.aborted ||
        Date.now() >= deadline
      )
        return run;
      try {
        await delay(1000, undefined, { signal });
      } catch (error) {
        if (!signal?.aborted) throw error;
        return this.getRun(id);
      }
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    this.queue.close();
    for (const job of this.executions.values())
      job.controller.abort(new Error("服务正在关闭"));
    await Promise.all([...this.executions.values()].map((j) => j.promise));
  }
  private async persist(run: WorkflowRun): Promise<void> {
    await this.repository.saveRun(run);
  }
  /** 所有前驱终态后才调度；输出和选择节点允许任一入边激活以汇合互斥分支。 */
  private async execute(
    run: WorkflowRun,
    controller: AbortController,
    budget = new WorkflowExecutionBudget(run),
    depth = 0,
  ): Promise<void> {
    if (depth > 16) invalid("工作流执行嵌套超过 16 层");
    const persist = () => this.persist(budget.root);
    const timer =
      depth === 0
        ? setTimeout(
            () => controller.abort(new Error("工作流超过 30 分钟执行上限")),
            30 * 60_000,
          )
        : undefined;
    const signal = controller.signal;
    let primaryFailure: WorkflowNodeRun | undefined;
    const states = new Map(run.nodes.map((n) => [n.nodeId, n]));
    const activeEdges = new Set<string>();
    const inflight = new Set<Promise<void>>();
    const executingNodes = new Set<string>();
    let executionFailure: unknown;
    try {
      run.status = "running";
      await persist();
      while (run.nodes.some((n) => n.status === "queued") || inflight.size) {
        signal.throwIfAborted();
        const ready = run.definition.nodes.filter(
          (n) =>
            states.get(n.id)!.status === "queued" &&
            run.definition.edges
              .filter((e) => e.target === n.id)
              .every((e) =>
                ["succeeded", "skipped"].includes(states.get(e.source)!.status) && !executingNodes.has(e.source),
              ),
        );
        if (!ready.length && !inflight.size)
          throw new DomainError(
            "VALIDATION_FAILED",
            "工作流无可执行节点，分支依赖无法满足",
          );
        // 叶节点额度由整棵运行树的 budget.leaf 统一控制；容器及资源协调节点不能阻塞释放路径。
        for (const node of ready) {
          executingNodes.add(node.id);
          const execution = (async () => {
            const state = states.get(node.id)!;
            const incoming = run.definition.edges.filter(
              (e) => e.target === node.id,
            );
            const enabled =
              node.kind === "input" ||
              (node.kind === "select" || node.kind === "output"
                ? incoming.some((e) => activeEdges.has(e.id))
                : incoming.length > 0 &&
                  incoming.every((e) => activeEdges.has(e.id)));
            if (!enabled) {
              state.status = "skipped";
              state.events.push({
                at: new Date().toISOString(),
                message: "前驱分支未激活，跳过节点",
              });
              await persist();
              return;
            }
            state.status = "running";
            state.startedAt = new Date().toISOString();
            const progress = async (message: string) => {
              signal.throwIfAborted();
              budget.account(message.slice(0, 1000));
              state.progress = message.slice(0, 1000);
              if (state.events.length < 200)
                state.events.push({
                  at: new Date().toISOString(),
                  message: state.progress,
                });
              await persist();
            };
            try {
              budget.step();
              const bindings = Object.entries(node.inputs);
              const inputs = Object.fromEntries(
                bindings.flatMap(([k, b]) => {
                  const value = resolveBinding(b, states);
                  return value === undefined ? [] : [[k, value]];
                }),
              );
              checkValueSize(inputs);
              // 可选参考组未提供时记录为空数组，使运行详情与实际执行输入一致。
              const referenceGroups = Object.fromEntries(
                Object.entries(node.config.referenceGroups ?? {}).map(
                  ([id, group]) => [
                    id,
                    group.binding
                      ? (resolveBinding(group.binding, states) ?? [])
                      : [],
                  ],
                ),
              );
              checkValueSize(referenceGroups);
              budget.account({ inputs, referenceGroups });
              state.referenceGroups = referenceGroups;
              state.inputs = inputs;
              await progress("开始执行节点");
              let output: Record<string, unknown>;
              if (node.kind === "input") output = run.inputs;
              else if (node.kind === "output") output = inputs;
              else if (node.kind === "semaphore_acquire" || node.kind === "semaphore_release") {
                const code = node.config.semaphoreCode!;
                const count = inputs.count as number;
                if (node.kind === "semaphore_acquire") {
                  await progress(`等待获取信号量 ${code}：${count} 个`);
                  await this.semaphores.acquire(code, count, budget.root.id, signal);
                  await progress(`已获取信号量 ${code}：${count} 个`);
                } else {
                  await this.semaphores.release(code, count, budget.root.id);
                  await progress(`已释放信号量 ${code}：${count} 个`);
                }
                output = {};
              }
              else if (node.kind === "condition") {
                const values = node.config.conditions!.map((c) =>
                  evaluateCondition(c, states),
                );
                output = {
                  result:
                    node.config.conditionMode === "any"
                      ? values.some(Boolean)
                      : values.every(Boolean),
                };
              } else if (node.kind === "select") {
                const candidates = node.config.candidates!;
                let selected: unknown;
                if (node.config.selectMode === "condition")
                  selected = resolveBinding(
                    candidates[
                      evaluateCondition(node.config.selectCondition!, states)
                        ? 0
                        : 1
                    ],
                    states,
                  );
                else
                  for (const b of candidates) {
                    const v = resolveBinding(b, states);
                    if (v !== undefined) {
                      selected = v;
                      break;
                    }
                  }
                if (selected === undefined)
                  invalid(`选择节点 ${node.name} 没有已执行的候选输入`);
                output = { [node.outputs[0]?.name ?? "result"]: selected };
              } else if (node.kind === "javascript") {
                const result = await budget.leaf(signal, () =>
                  runWorkflowScript(
                    node.config.script!,
                    inputs,
                    node.config.timeoutMs!,
                    signal,
                  ),
                );
                output = result.output;
                for (const message of result.logs)
                  await progress(`脚本：${message}`);
              } else if (node.kind === "loop") {
                output = await this.executeLoop(
                  run,
                  node,
                  inputs,
                  states,
                  signal,
                  budget,
                  depth,
                  progress,
                );
              } else if (node.kind === "workflow") {
                const target =
                  budget.root.dependencies?.[node.config.workflowId!];
                if (!target) invalid(`节点 ${node.name} 缺少目标工作流快照`);
                output = await this.executeChild(
                  run,
                  node,
                  target,
                  inputs,
                  signal,
                  budget,
                  depth,
                  `调用 ${target.name}`,
                );
              } else
                output = await budget.leaf(signal, () =>
                  this.executor.execute(
                    { run, node, signal, progress, referenceGroups },
                    inputs,
                  ),
                );
              signal.throwIfAborted();
              checkValueSize(output);
              // 循环的默认值只用于零轮结果，实际执行时不得掩盖最后一轮缺失的产出。
              const fields =
                node.kind === "loop"
                  ? node.outputs.map((field) => ({
                      ...field,
                      defaultValue: undefined,
                    }))
                  : node.outputs;
              const checked = validateValues(fields, output);
              budget.account(checked);
              state.outputs = checked;
              state.status = "succeeded";
              state.finishedAt = new Date().toISOString();
              if (node.kind === "output") run.outputs = state.outputs;
              for (const edge of run.definition.edges.filter(
                (e) => e.source === node.id,
              )) {
                if (
                  node.kind !== "condition" ||
                  edge.branch === String(output.result)
                )
                  activeEdges.add(edge.id);
              }
              await progress("节点执行完成");
            } catch (error) {
              state.status = signal.aborted ? "cancelled" : "failed";
              state.finishedAt = new Date().toISOString();
              state.error = {
                code:
                  error instanceof DomainError
                    ? error.code
                    : "WORKFLOW_NODE_FAILED",
                message: toSafePublicMessage(
                  error,
                  `节点 ${node.name} 执行器未返回可读异常`,
                ),
                requestId: budget.root.id,
                nodeId: node.id,
              };
              if (!signal.aborted) {
                primaryFailure = state;
                controller.abort(error);
              }
              await persist();
              throw error;
            }
          })();
          const tracked = execution.catch((error: unknown) => { executionFailure ??= error; }).finally(() => { inflight.delete(tracked); executingNodes.delete(node.id); });
          inflight.add(tracked);
        }
        if (inflight.size) await Promise.race(inflight);
        if (executionFailure) throw executionFailure;
      }
      if (
        !run.definition.nodes
          .filter((n) => n.kind === "output")
          .every((n) => states.get(n.id)!.status === "succeeded")
      )
        invalid("输出节点未被执行：没有已激活的入边，请检查分支到输出节点的连线");
      run.status = "succeeded";
    } catch (error) {
      const failed = primaryFailure ?? run.nodes.find((n) => n.error);
      run.status = primaryFailure
        ? "failed"
        : signal.aborted
          ? "cancelled"
          : "failed";
      run.error = failed?.error ?? {
        code: signal.aborted
          ? "OPERATION_ABORTED"
          : "WORKFLOW_EXECUTION_FAILED",
        message: toSafePublicMessage(error, "工作流调度器未返回可读异常"),
        requestId: budget.root.id,
      };
      for (const n of run.nodes)
        if (["queued", "running"].includes(n.status)) {
          n.status = signal.aborted ? "cancelled" : "skipped";
          n.events.push({
            at: new Date().toISOString(),
            message: "工作流已终止，未继续执行",
          });
        }
    } finally {
      clearTimeout(timer);
      await Promise.allSettled([...inflight]);
      if (depth === 0) await this.semaphores.releaseAll(run.id);
      run.finishedAt = new Date().toISOString();
      await persist();
    }
  }
  /** 子调用留在根任务的轨迹树中，不创建独立限流任务或丢失文件归属。 */
  private async executeChild(
    parent: WorkflowRun,
    node: WorkflowNode,
    definition: WorkflowDefinition,
    inputs: Record<string, unknown>,
    signal: AbortSignal,
    budget: WorkflowExecutionBudget,
    depth: number,
    label: string,
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    if (depth >= 16) invalid("工作流执行嵌套超过 16 层");
    const child: WorkflowRun = {
      id: randomUUID(),
      workflowId: definition.id,
      definition,
      status: "queued",
      inputs: validateValues(
        definition.nodes.find((n) => n.kind === "input")!.outputs,
        inputs,
      ),
      outputs: {},
      nodes: definition.nodes.map((n) => ({
        nodeId: n.id,
        status: "queued",
        events: [],
      })),
      createdAt: new Date().toISOString(),
      origin: parent.origin,
      requestKey: parent.requestKey,
      requestHash: parent.requestHash,
    };
    budget.account(child);
    const state = parent.nodes.find((item) => item.nodeId === node.id)!;
    (state.children ??= []).push(child);
    state.progress = label;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      await this.execute(child, controller, budget, depth + 1);
      if (child.status !== "succeeded")
        throw new DomainError(
          (child.error?.code ?? "REQUEST_FAILED") as ConstructorParameters<
            typeof DomainError
          >[0],
          `${label}：${child.error?.message ?? "子流程未成功完成"}`,
        );
      return child.outputs;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  /** 每轮上下文隔离，成功后才更新状态、提交聚合值，并在下一轮前判断 while。 */
  private async executeLoop(
    run: WorkflowRun,
    node: WorkflowNode,
    inputs: Record<string, unknown>,
    states: Map<string, WorkflowNodeRun>,
    signal: AbortSignal,
    budget: WorkflowExecutionBudget,
    depth: number,
    progress: (message: string) => Promise<void>,
  ): Promise<Record<string, unknown>> {
    const loop = node.config.loop!;
    const bodyInput = loop.body.nodes.find((n) => n.kind === "input")!;
    const variables = Object.fromEntries(
      Object.entries(loop.state).map(([name, value]) => [
        name,
        resolveBinding(value.initial, states),
      ]),
    );
    const items =
      loop.mode === "array" ? resolveBinding(loop.items, states) : [];
    const count =
      loop.mode === "count" ? resolveBinding(loop.count, states) : undefined;
    if (
      loop.mode === "count" &&
      (!Number.isInteger(count) ||
        Number(count) < 0 ||
        Number(count) > loop.maxIterations)
    )
      invalid(`循环 ${node.name} 次数必须为 0 到 ${loop.maxIterations} 的整数`);
    if (
      loop.mode === "array" &&
      (!Array.isArray(items) || items.length > loop.maxIterations)
    )
      invalid(
        `循环 ${node.name} 的迭代输入必须为最多 ${loop.maxIterations} 项的数组`,
      );
    const output: Record<string, unknown> = {};
    for (const [name, mapping] of Object.entries(loop.outputs))
      if (mapping.mode !== "last") output[name] = [];
    let index = 0;
    while (true) {
      signal.throwIfAborted();
      const rawContext = {
        ...inputs,
        ...variables,
        index,
        ...(loop.mode === "array" ? { item: (items as unknown[])[index] } : {}),
      };
      if (loop.mode === "count" && index >= Number(count)) break;
      if (loop.mode === "array" && index >= (items as unknown[]).length) break;
      const context = validateValues(bodyInput.outputs, rawContext);
      if (
        loop.mode === "while" &&
        !evaluateCondition(
          loop.condition,
          new Map([
            [
              bodyInput.id,
              {
                nodeId: bodyInput.id,
                status: "succeeded",
                outputs: context,
                events: [],
              },
            ],
          ]),
        )
      )
        break;
      if (index >= loop.maxIterations)
        invalid(
          `循环 ${node.name} 达到 ${loop.maxIterations} 次上限，while 条件仍为真`,
        );
      await progress(
        `第 ${index + 1} 轮 · ${loop.mode === "while" ? `最多 ${loop.maxIterations} 轮` : `共 ${loop.mode === "array" ? (items as unknown[]).length : count} 轮`}`,
      );
      const definition: WorkflowDefinition = {
        ...loop.body,
        id: `${run.workflowId}/${node.id}`,
        revision: run.definition.revision,
        createdAt: run.createdAt,
        updatedAt: run.createdAt,
      };
      const values = await this.executeChild(
        run,
        node,
        definition,
        context,
        signal,
        budget,
        depth,
        `循环 ${node.name} 第 ${index + 1} 轮`,
      );
      for (const [name, variable] of Object.entries(loop.state)) {
        const value = values[variable.output];
        const field = bodyInput.outputs.find((f) => f.name === name)!;
        validateValues([{ ...field, required: true }], { [name]: value });
        variables[name] = value;
      }
      for (const [name, mapping] of Object.entries(loop.outputs)) {
        const value = values[mapping.field];
        if (mapping.mode === "last") {
          if (value === undefined) delete output[name];
          else output[name] = value;
        } else {
          if (value === undefined || value === null)
            invalid(
              `循环 ${node.name} 第 ${index + 1} 轮未提供聚合输出 ${mapping.field}`,
            );
          const list = output[name] as unknown[];
          if (mapping.mode === "flatten") {
            if (!Array.isArray(value))
              invalid(
                `循环 ${node.name} 的合并输出 ${mapping.field} 必须为数组`,
              );
            list.push(...value);
          } else list.push(value);
          if (list.length > 100)
            invalid(`循环 ${node.name} 聚合输出 ${name} 超过 100 项`);
        }
      }
      checkValueSize(output);
      index++;
    }
    if (index === 0) {
      for (const [name, mapping] of Object.entries(loop.outputs)) {
        if (mapping.mode !== "last") continue;
        const variable = Object.entries(loop.state).find(
          ([, state]) => state.output === mapping.field,
        );
        if (variable) output[name] = variables[variable[0]];
        else {
          const fallback = node.outputs.find(
            (field) => field.name === name,
          )?.defaultValue;
          if (fallback !== undefined) output[name] = fallback;
        }
      }
    }
    await progress(`循环完成 · 已执行 ${index} 轮`);
    return output;
  }
}
/** 安全读取上游命名输出；分支未执行时返回 undefined，保留 null/false/0。 */
export function resolveBinding(
  binding: WorkflowBinding,
  states: Map<string, WorkflowNodeRun>,
): unknown {
  if (binding.kind === "literal") return binding.value;
  const state = states.get(binding.nodeId);
  return state?.status === "succeeded"
    ? state.outputs?.[binding.field]
    : undefined;
}
export function evaluateCondition(
  condition: WorkflowCondition,
  states: Map<string, WorkflowNodeRun>,
): boolean {
  const a = resolveBinding(condition.left, states),
    b = resolveBinding(condition.right, states);
  const empty =
    a === undefined ||
    a === null ||
    a === "" ||
    (Array.isArray(a) && a.length === 0);
  switch (condition.operator) {
    case "empty":
      return empty;
    case "not_empty":
      return !empty;
    case "eq":
      return stableJson(a) === stableJson(b);
    case "ne":
      return stableJson(a) !== stableJson(b);
    case "contains":
      return typeof a === "string" && typeof b === "string"
        ? a.includes(b)
        : Array.isArray(a) && a.some((v) => stableJson(v) === stableJson(b));
    default:
      if (typeof a !== "number" || typeof b !== "number")
        invalid("数值比较条件两侧必须都是数值");
      return condition.operator === "gt"
        ? a > b
        : condition.operator === "gte"
          ? a >= b
          : condition.operator === "lt"
            ? a < b
            : a <= b;
  }
}
/** 对象键排序用于幂等与结构化相等判断，不改变数组顺序。 */
function stableJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, v) =>
    record(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
}
