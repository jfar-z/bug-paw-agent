import { randomUUID } from "node:crypto";
import { workflowThinkingLevels } from "./workflow-thinking";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type {
  WorkflowCatalog,
  WorkflowDefinition,
  WorkflowField,
  WorkflowFile,
  WorkflowRun,
  WorkflowScriptAssistRequest,
  WorkflowScriptAssistProgress,
  WorkflowReferenceGroup,
  WorkflowNode,
} from "../../shared/workflow-contracts";
import type {
  AigcRunInputValue,
  AigcTaskRecord,
  AigcWorkflowDetail,
} from "../../shared/aigc-contracts";
import type { AgentStore } from "../agents/agent-store";
import type { RuntimeSupervisor } from "../runtime/runtime-supervisor";
import type { AigcInterfaceService } from "../aigc/aigc-interface-service";
import type { AigcWorkflowService } from "../aigc/aigc-workflow-service";
import type { AigcTaskService } from "../aigc/aigc-task-service";
import type { AigcAssetService } from "../aigc/aigc-asset-service";
import type { AigcPublicFileService } from "../aigc/aigc-public-file-service";
import {
  agentFields,
  agentOutputs,
  validateAgentParameters,
  type AigcAgentParameter,
} from "../aigc/aigc-agent-parameters";
import { compileAgentReferences } from "../agent-references";
import { DomainError, toSafePublicMessage } from "../core/errors";
import { checkField, invalid, record } from "./workflow-validation";
import type {
  WorkflowExecutionContext,
  WorkflowExecutor,
} from "./workflow-service";
import type { WorkflowFiles } from "./workflow-files";
import { generateWorkflowScript } from "./workflow-script-assist";

interface Dependencies {
  modelRuntime(): ModelRuntime;
  agents: AgentStore;
  runtimes: RuntimeSupervisor;
  files: WorkflowFiles;
  interfaces: AigcInterfaceService;
  aigcWorkflows: AigcWorkflowService;
  aigcTasks: AigcTaskService;
  aigcAssets: AigcAssetService;
  publicFiles: AigcPublicFileService;
  publicOrigin?: string;
  assignSession(sessionId: string, agentId: string): Promise<void>;
  sessionAgent(sessionId: string): Promise<string>;
  assertSessionRunnable(agentId: string, sessionId: string): void;
}
/** 复用现有模型、会话和 AIGC 服务；不重建 Provider 或业务凭据。 */
export class WorkflowNodeExecutor implements WorkflowExecutor {
  readonly workflowSessions = new Set<string>();
  private readonly sessions = new Set<string>();
  /** 限制管理端同时生成的数量，避免重复点击耗尽模型连接。 */
  private scriptGenerations = 0;
  constructor(private readonly dependencies: Dependencies) {}
  /** 生成候选脚本，不创建工作流运行，也不自动应用到持久化定义。 */
  async assistScript(input: WorkflowScriptAssistRequest, signal: AbortSignal, onProgress?: (event: WorkflowScriptAssistProgress) => void | Promise<void>) {
    if (this.scriptGenerations >= 2)
      invalid("已有两个脚本辅助请求正在生成，请完成或取消后再试");
    this.scriptGenerations++;
    try {
      return await generateWorkflowScript(
        this.dependencies.modelRuntime(),
        input,
        signal,
        onProgress,
      );
    } finally {
      this.scriptGenerations--;
    }
  }
  async catalog(): Promise<WorkflowCatalog> {
    const models = (await this.dependencies.modelRuntime().getAvailable()).map(
      (m) => ({
        provider: m.provider,
        id: m.id,
        name: m.name,
        reasoning: m.reasoning,
        thinkingLevels: workflowThinkingLevels(m),
        images: m.input.includes("image"),
      }),
    );
    const agents = (await this.dependencies.agents.list()).map((a) => ({
      id: a.profile.id,
      name: a.profile.name,
    }));
    const interfaces: WorkflowCatalog["interfaces"] = [];
    for (const item of (
      await this.dependencies.interfaces.list()
    ).interfaces.filter((i) => i.enabled)) {
      const workflow =
        item.protocol === "comfyui"
          ? (
              await this.dependencies.aigcWorkflows.get(
                (item.config as { workflowId: string }).workflowId,
              )
            ).workflow
          : undefined;
      const fields = agentFields(item, workflow).map((f) => ({
        ...f,
        type: (f.type === "number"
          ? "float"
          : f.type === "enum"
            ? typeof f.enumValues?.[0] === "number"
              ? "float"
              : typeof f.enumValues?.[0] === "boolean"
                ? "boolean"
                : "string"
            : f.type) as WorkflowField["type"],
      }));
      const outputs: WorkflowField[] = [
        { name: "files", type: "file", multiple: true },
        ...agentOutputs(item, workflow).map((o, i) => ({
          name: `output_${i + 1}`,
          type: (["image", "video", "audio"].includes(o.mediaType)
            ? o.mediaType
            : "file") as WorkflowField["type"],
          multiple: true,
          description: o.name,
        })),
      ];
      interfaces.push({
        id: item.id,
        name: item.name,
        fields,
        outputs,
        referenceGroups: workflowReferenceGroups(workflow),
      });
    }
    return { models, agents, interfaces };
  }
  /** 外部接口和 ComfyUI 原始定义变化时，拒绝运行此前创建的任务。 */
  async preparationFingerprint(definition: WorkflowDefinition): Promise<unknown> {
    const values: unknown[] = [];
    for (const node of definition.nodes) {
      if (node.kind === "aigc") {
        const item = await this.dependencies.interfaces.get(node.config.interfaceId!);
        const workflow = item?.protocol === "comfyui" ? await this.dependencies.aigcWorkflows.getPrivate((item.config as { workflowId: string }).workflowId) : undefined;
        values.push([node.id, item, workflow]);
      }
      if (node.kind === "llm") {
        const model = this.dependencies.modelRuntime().getModel(node.config.provider!, node.config.modelId!);
        values.push([node.id, model?.id, model?.provider, model?.api, model?.baseUrl, model?.input, model?.reasoning]);
      }
    }
    return values;
  }
  async validate(
    definition: WorkflowDefinition,
    origin?: WorkflowRun["origin"],
  ): Promise<void> {
    if (origin && this.workflowSessions.has(origin.sessionId))
      throw new DomainError(
        "FORBIDDEN",
        "工作流 Agent 节点不能再次调用工作流，避免递归执行与会话等待死锁",
      );
    const enumFields = new Map<string, ReturnType<typeof agentFields>>();
    for (const node of definition.nodes) {
      const c = node.config;
      if (
        node.kind === "llm" &&
        !this.dependencies.modelRuntime().getModel(c.provider!, c.modelId!)
      )
        invalid(`节点 ${node.name} 的模型已不存在`);
      if (node.kind === "agent") {
        if (!(await this.dependencies.agents.get(c.agentId!)))
          invalid(`节点 ${node.name} 的 Agent 已不存在`);
        if (c.sessionMode === "fixed") {
          if (origin?.sessionId === c.sessionId)
            invalid("工作流不能向正在调用它的同一个会话发消息");
          if (
            (await this.dependencies.sessionAgent(c.sessionId!)) !== c.agentId
          )
            invalid("固定会话不属于所选 Agent");
        }
      }
      if (node.kind === "aigc") {
        const item = await this.dependencies.interfaces.get(c.interfaceId!);
        if (!item || !item.enabled)
          invalid(`节点 ${node.name} 的 AIGC 接口已不存在或停用`);
        const workflow =
          item.protocol === "comfyui"
            ? (
                await this.dependencies.aigcWorkflows.get(
                  (item.config as { workflowId: string }).workflowId,
                )
              ).workflow
            : undefined;
        enumFields.set(node.id, agentFields(item, workflow));
        const groups = workflowReferenceGroups(workflow);
        for (const [id, setting] of Object.entries(c.referenceGroups ?? {})) {
          const group = groups.find((g) => g.id === id);
          if (!group) invalid(`节点 ${node.name} 的参考组已变更，请重新配置`);
          if (setting.binding?.kind === "reference") {
            const binding = setting.binding;
            const field = definition.nodes
              .find((n) => n.id === binding.nodeId)
              ?.outputs.find((f) => f.name === binding.field);
            if (!field?.multiple || field.type !== group.type)
              invalid(`参考组 ${group.label} 必须引用 ${group.type} 类型数组`);
          }
          if (setting.binding?.kind === "literal")
            checkReferenceArray(group, setting.binding.value);
        }
      }
    }
    for (const node of definition.nodes)
      for (const field of node.outputs) {
        if (!field.enumSource) continue;
        // 子工作流枚举已由依赖快照校验；外部能力执行器这里只检查 AIGC 实际接口选项。
        if (field.enumSource.workflowId !== undefined || field.enumSource.loop) continue;
        const options = enumFields
          .get(field.enumSource.nodeId)
          ?.find((f) => f.name === field.enumSource!.field)?.enumValues;
        const strings = options?.map(String);
        if (
          !strings?.length ||
          new Set(strings).size !== strings.length ||
          strings.length !== field.enumValues?.length ||
          strings.some((v) => !field.enumValues!.includes(v))
        )
          invalid(
            `参数 ${field.name} 引用的枚举定义已变更或存在字符串歧义，请重新选择枚举来源`,
          );
      }
  }
  async execute(
    context: WorkflowExecutionContext,
    inputs: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (context.node.kind === "llm") return this.llm(context, inputs);
    if (context.node.kind === "agent") return this.agent(context, inputs);
    if (context.node.kind === "aigc") return this.aigc(context, inputs);
    throw new DomainError("VALIDATION_FAILED", "当前节点不属于外部能力执行器");
  }
  private async llm(
    ctx: WorkflowExecutionContext,
    inputs: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const c = ctx.node.config,
      runtime = this.dependencies.modelRuntime(),
      model = runtime.getModel(c.provider!, c.modelId!);
    if (!model) invalid("工作流大模型节点所选模型不存在");
    const prompt = inputs.prompt;
    if (typeof prompt !== "string" || !prompt.trim())
      invalid("大模型节点需要非空字符串 prompt");
    const images = asFiles(inputs.images);
    if (images.length && !model.input.includes("image"))
      invalid("所选模型不支持图片输入");
    const content: (
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    )[] = [{ type: "text", text: prompt }];
    for (const image of images) {
      const { file, content: buffer } = await this.dependencies.files.buffer(
        image,
        ctx.run.origin?.agentId,
        20 * 1024 * 1024,
      );
      if (!file.mediaType.startsWith("image/"))
        invalid("大模型图片输入必须为图片文件");
      content.push({
        type: "image",
        data: buffer.toString("base64"),
        mimeType: file.mediaType,
      });
    }
    if (
      c.thinking === "off" &&
      model.reasoning &&
      model.thinkingLevelMap?.off === null
    )
      invalid("所选模型不支持关闭思考，请选择模型默认或其他思考等级");
    if (
      c.thinking &&
      !["inherit", "off"].includes(c.thinking) &&
      !model.reasoning
    )
      invalid("所选模型不支持思考等级");
    const reasoning =
      c.thinking && c.thinking !== "inherit" && c.thinking !== "off"
        ? c.thinking
        : undefined;
    await ctx.progress(`调用模型 ${model.name}`);
    const response = await runtime.completeSimple(
      model,
      {
        systemPrompt: c.systemPrompt ?? "",
        messages: [{ role: "user", content, timestamp: Date.now() }],
      },
      {
        temperature: c.temperature,
        maxTokens: c.maxTokens ?? 4096,
        reasoning,
        signal: ctx.signal,
        onPayload: (payload: unknown) =>
          workflowModelPayload(payload, String(model.api), c),
      },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted")
      throw new DomainError(
        "REQUEST_FAILED",
        `大模型 ${model.name} 在生成阶段${response.stopReason === "aborted" ? "被中止" : "返回错误"}：${toSafePublicMessage(response.errorMessage, "上游没有提供可公开的错误说明")}`,
      );
    await ctx.progress(
      `生成完成 · 输入 ${response.usage.input} / 输出 ${response.usage.output} tokens`,
    );
    return {
      text: response.content
        .filter((x) => x.type === "text")
        .map((x) => x.text)
        .join("\n"),
    };
  }
  private async agent(
    ctx: WorkflowExecutionContext,
    inputs: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const c = ctx.node.config,
      agentId = c.agentId!;
    if (typeof inputs.prompt !== "string" || !inputs.prompt.trim())
      invalid("Agent 节点需要非空字符串 prompt");
    const sessionKey =
      c.sessionMode === "fixed" ? c.sessionId! : ctx.run.id + ctx.node.id;
    if (this.sessions.has(sessionKey))
      throw new DomainError(
        "SESSION_BUSY",
        "目标会话已被其他工作流节点占用，请等待完成后再运行",
      );
    this.sessions.add(sessionKey);
    try {
      return await (async () => {
        ctx.signal.throwIfAborted();
        const lease = await this.dependencies.runtimes.acquire(agentId);
        let sessionId = "",
          started = false,
          completed = false;
        let unsubscribe = () => undefined as void;
        let abort = () => undefined as void;
        try {
          if (c.sessionMode === "fixed") {
            sessionId = c.sessionId!;
            if ((await this.dependencies.sessionAgent(sessionId)) !== agentId)
              invalid("固定会话不属于所选 Agent");
          } else {
            sessionId = (await lease.runtime.createSession()).id;
            try {
              await this.dependencies.assignSession(sessionId, agentId);
            } catch (error) {
              await lease.runtime.discardUnassignedSession(sessionId);
              throw error;
            }
          }
          const snapshot = await lease.runtime.openSession(sessionId);
          if (
            snapshot.run &&
            ["running", "starting"].includes(snapshot.run.status)
          )
            throw new DomainError(
              "SESSION_BUSY",
              "工作流目标会话正在执行其他任务",
            );
          this.dependencies.assertSessionRunnable(agentId, sessionId);
          await lease.runtime.unarchiveSession(sessionId);
          const paths = [];
          for (const file of asFiles(inputs.files))
            paths.push(
              await this.dependencies.files.toWorkspace(
                file,
                agentId,
                ctx.run.origin?.agentId,
              ),
            );
          const reference = compileAgentReferences(
            paths.map((f) => ({
              type: "file" as const,
              kind: "file" as const,
              path: f.path,
              name: f.name,
            })),
          );
          const prompt = `${inputs.prompt}${reference ? `\n\n${reference}` : ""}`;
          let text = "";
          const completion = new Promise<void>((resolve, reject) => {
            unsubscribe = lease.runtime.subscribe(
              sessionId,
              snapshot.lastEventId,
              (event) => {
                if (event.type === "text_delta") text += event.delta;
                if (Buffer.byteLength(text) > 800_000)
                  reject(
                    new DomainError(
                      "REQUEST_FAILED",
                      "Agent 节点输出超过 800 KiB",
                    ),
                  );
                if (event.type === "completed") {
                  completed = true;
                  resolve();
                }
                if (event.type === "error")
                  reject(new DomainError("REQUEST_FAILED", event.message));
                if (event.type === "aborted")
                  reject(
                    new DomainError(
                      "OPERATION_ABORTED",
                      "Agent 会话执行被中止",
                    ),
                  );
                if (event.type === "question_pending")
                  reject(
                    new DomainError(
                      "CONFLICT",
                      "Agent 请求人工回答，工作流已停止；请前往会话处理问题",
                    ),
                  );
              },
            );
            abort = () =>
              reject(
                new DomainError("OPERATION_ABORTED", "工作流 Agent 节点已取消"),
              );
            ctx.signal.addEventListener("abort", abort, { once: true });
          });
          // 先注册观察者，确保快速终态不会早于订阅；拒绝分支在下方统一传播。
          void completion.catch(() => undefined);
          this.workflowSessions.add(sessionId);
          await ctx.progress(`会话 ${sessionId} · 开始执行`);
          ctx.signal.throwIfAborted();
          await lease.runtime.startPrompt(
            sessionId,
            prompt,
            inputs.prompt as string,
          );
          started = true;
          ctx.signal.throwIfAborted();
          await completion;
          unsubscribe();
          ctx.signal.throwIfAborted();
          const files: WorkflowFile[] = [];
          const matches = [
            ...text.matchAll(/\]\((?:<)?((?:attachments\/)[^\s)>]+)(?:>)?\)/g),
          ].slice(0, 20);
          for (const path of new Set(
            matches.map((m) => decodeURIComponent(m[1])),
          )) {
            const saved = await this.dependencies.files.importPath(
              agentId,
              path,
            );
            const { content, file } = await this.dependencies.files.buffer(
              saved,
              agentId,
            );
            files.push(
              await this.dependencies.files.upload(
                Readable.from(content),
                file.name,
                file.mediaType,
                ctx.run.origin?.agentId,
                "runtime", ctx.run.id,
              ),
            );
          }
          if (c.archiveAfterCompletion) {
            await lease.runtime.archiveSession(sessionId);
            await ctx.progress(`会话 ${sessionId} · 已归档`);
          }
          return { text, files, sessionId };
        } catch (error) {
          if (started && !completed) await lease.runtime.abort(sessionId);
          throw error;
        } finally {
          unsubscribe();
          ctx.signal.removeEventListener("abort", abort);
          this.workflowSessions.delete(sessionId);
          lease.release();
        }
      })();
    } finally {
      this.sessions.delete(sessionKey);
    }
  }
  private async aigc(
    ctx: WorkflowExecutionContext,
    inputs: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const item = await this.dependencies.interfaces.get(
      ctx.node.config.interfaceId!,
    );
    if (!item || !item.enabled) invalid("工作流 AIGC 接口不存在或已停用");
    const workflow =
      item.protocol === "comfyui"
        ? (
            await this.dependencies.aigcWorkflows.get(
              (item.config as { workflowId: string }).workflowId,
            )
          ).workflow
        : undefined;
    inputs = expandReferenceGroups(
      ctx.node,
      inputs,
      ctx.referenceGroups ?? {},
      workflowReferenceGroups(workflow),
    );
    const fields = agentFields(item, workflow),
      parameters: AigcAgentParameter[] = Object.entries(inputs).map(
        ([name, original]) => {
          const field = fields.find((f) => f.name === name);
          let value = original;
          // 仅引用值按字符串匹配枚举；固定值必须保持下拉选项的真实类型。
          if (
            field?.enumValues?.length &&
            ctx.node.inputs[name]?.kind === "reference"
          ) {
            const options = field.enumValues;
            const matches = ["string", "number", "boolean"].includes(
              typeof value,
            )
              ? options.filter((option) => String(option) === String(value))
              : [];
            if (matches.length !== 1)
              invalid(
                `节点 ${ctx.node.name} 参数 ${name} 无法唯一转换为枚举；允许值：${JSON.stringify(options)}`,
              );
            value = matches[0];
          }
          return {
            name,
            value: (field?.source
              ? Array.isArray(value)
                ? value.map((_, i) => `file-${i}`)
                : value === null
                  ? null
                  : "file"
              : value) as AigcAgentParameter["value"],
          };
        },
      );
    const checked = validateAgentParameters(fields, parameters);
    const values: Record<string, AigcRunInputValue> = {};
    const preparedInputs: string[] = [],
      preparedPublic: string[] = [];
    let task: AigcTaskRecord;
    try {
      for (const [name, value] of Object.entries(checked)) {
        const field = fields.find((f) => f.name === name)!;
        if (!field.source) {
          values[name] = value;
          continue;
        }
        const references = [];
        for (const input of asFiles(inputs[name])) {
          const { file, content } = await this.dependencies.files.buffer(
            input,
            ctx.run.origin?.agentId, undefined, item.protocol === "grok",
          );
          if (!file.mediaType.startsWith(field.type + "/"))
            invalid(`AIGC 参数 ${name} 文件类型不匹配`);
          if (item.protocol === "grok") {
            if (!this.dependencies.publicOrigin)
              invalid("Grok 媒体输入需要配置可访问的公开 Origin");
            const saved = await this.dependencies.publicFiles.save(
              Readable.from(content),
              `workflow-${randomUUID()}-${file.name}`,
              file.mediaType,
            );
            preparedPublic.push(saved.id);
            references.push({
              url: `${this.dependencies.publicOrigin}/aigc-public/files/${saved.id}`,
              name: saved.name,
              mediaType: saved.mediaType,
            });
          } else {
            const saved = await this.dependencies.aigcAssets.saveInput(
              Readable.from(content),
              file.name,
              file.mediaType,
            );
            preparedInputs.push(saved.id);
            references.push({
              assetId: saved.id,
              name: saved.name,
              mediaType: saved.mediaType,
            });
          }
        }
        values[name] = field.multiple ? references : references[0];
      }
      ctx.signal.throwIfAborted();
      task = await this.dependencies.aigcTasks.createRun({
        interfaceId: item.id,
        inputs: values,
      });
    } catch (error) {
      // 任务接管前失败时回收本次准备的文件，避免取消或验证失败遗留上传。
      await Promise.all([
        ...preparedInputs.map((id) =>
          this.dependencies.aigcAssets.removeInput(id),
        ),
        ...preparedPublic.map((id) => this.dependencies.publicFiles.remove(id)),
      ]);
      throw error;
    }
    let terminal: AigcTaskRecord | undefined;
    let lastProgressMessage: string | undefined;
    try {
      while (true) {
        ctx.signal.throwIfAborted();
        terminal = await this.dependencies.aigcTasks.get(task.id);
        if (!terminal) invalid("工作流关联的 AIGC 任务已被删除");
        if (!["queued", "running"].includes(terminal.status)) break;
        const message = `AIGC ${task.id} · ${terminal.execution?.phase ?? terminal.status}${terminal.execution?.progressValue !== undefined ? ` · ${terminal.execution.progressValue}/${terminal.execution.progressMax ?? "?"}` : ""}`;
        // 仅记录本次节点执行中变化的日志正文，避免轮询时间变化导致重复事件刷屏。
        if (message !== lastProgressMessage) {
          await ctx.progress(message);
          lastProgressMessage = message;
        }
        await delay(1500, undefined, { signal: ctx.signal });
      }
    } catch (error) {
      const cancelled = await this.dependencies.aigcTasks.cancel(task.id);
      if (ctx.signal.aborted) {
        const state = ctx.run.nodes.find((n) => n.nodeId === ctx.node.id)!;
        state.events.push({
          at: new Date().toISOString(),
          message: `AIGC ${task.id} 上游取消：${cancelled?.upstreamCancellation ?? "unknown"}`,
        });
      }
      throw error;
    }
    if (terminal.status !== "succeeded")
      throw new DomainError(
        "REQUEST_FAILED",
        `AIGC 任务 ${task.id} ${terminal.status}：${toSafePublicMessage(terminal.error?.message, "上游任务未返回可用产物")}`,
      );
    const outputs = agentOutputs(item, workflow),
      files: WorkflowFile[] = [],
      result: Record<string, unknown> = { files };
    outputs.forEach((_, i) => (result[`output_${i + 1}`] = []));
    for (const asset of terminal.assets) {
      const content = await this.dependencies.aigcAssets.readOutput(
        task.id,
        asset.id,
        100 * 1024 * 1024,
      );
      const file = await this.dependencies.files.upload(
        Readable.from(content),
        asset.name,
        asset.mediaType,
        ctx.run.origin?.agentId,
        "runtime", ctx.run.id,
      );
      files.push(file);
      const index = outputs.findIndex((o) => o.id === asset.outputId);
      if (index >= 0)
        (result[`output_${index + 1}`] as WorkflowFile[]).push(file);
      else if (outputs.length === 1)
        (result.output_1 as WorkflowFile[]).push(file);
    }
    return Object.fromEntries(
      Object.entries(result).filter(([name]) =>
        ctx.node.outputs.some((f) => f.name === name),
      ),
    );
  }
}
/** 可选单文件与多文件共用入口，不接受任意路径或 URL。 */
function asFiles(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.length > 20) invalid("节点媒体输入最多 20 个文件");
  return values;
}

/** 在 Provider 已构建的请求上合并生成参数，保持消息、工具和连接参数不可被覆写。 */
export function workflowModelPayload(
  payload: unknown,
  api: string,
  c: import("../../shared/workflow-contracts").WorkflowNodeConfig,
): Record<string, unknown> {
  if (!record(payload))
    throw new DomainError(
      "REQUEST_FAILED",
      "模型适配器生成的请求体不是 JSON 对象",
    );
  const result = { ...payload },
    custom = c.customParameters ?? {};
  if (
    !api.includes("completions") &&
    ((c.frequencyPenalty ?? 0) !== 0 || (c.presencePenalty ?? 0) !== 0)
  )
    invalid("该模型协议不支持 frequency/presence penalty，请使用默认值 0");
  if (c.thinking === undefined || c.thinking === "inherit") {
    // 默认档不继承 SDK 的强制关闭字段，让 Provider 使用自身默认行为。
    for (const key of [
      "reasoning",
      "reasoning_effort",
      "thinking",
      "enable_thinking",
      "chat_template_kwargs",
      "chat_template_args",
    ])
      delete result[key];
  }
  if (api.includes("google")) {
    const config = { ...(record(result.config) ? result.config : {}) };
    if (c.thinking === undefined || c.thinking === "inherit")
      delete config.thinkingConfig;
    return { ...result, config: { ...config, topP: c.topP ?? 1, ...custom } };
  }
  if (api.includes("anthropic")) {
    if ((c.topP ?? 1) !== 1) {
      delete result.temperature;
      result.top_p = c.topP;
    }
  } else {
    if (c.topP !== undefined) result.top_p = c.topP;
    if (api.includes("completions")) {
      result.frequency_penalty = c.frequencyPenalty ?? 0;
      result.presence_penalty = c.presencePenalty ?? 0;
    }
  }
  return { ...result, ...custom };
}

/** 按原始参考组的槽位顺序公开参数名，避免以列表位置代替稳定组 ID。 */
export function workflowReferenceGroups(
  workflow?: AigcWorkflowDetail,
): WorkflowReferenceGroup[] {
  return (workflow?.inputGroups ?? []).map((group) => ({
    id: group.id,
    label: group.label,
    type: group.type,
    fields: group.mappingIds.map((id) => {
      const mapping = workflow!.inputMappings.find((m) => m.id === id);
      if (!mapping || mapping.type !== group.type)
        invalid(`参考组 ${group.label} 的成员已失效`);
      return mapping.name;
    }),
  }));
}

/** 数组展开前检查长度及每项媒体类型，禁止截断或跳过无效元素。 */
function checkReferenceArray(
  group: WorkflowReferenceGroup,
  value: unknown,
): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > group.fields.length)
    invalid(
      `参考组 ${group.label} 必须为最多 ${group.fields.length} 项的 ${group.type} 数组`,
    );
  for (const entry of value)
    checkField({ name: group.label, type: group.type, required: true }, entry);
}

/** 数组模式逐项填入原始参数；空槽位不提供，继续使用既有条件分支裁剪。 */
export function expandReferenceGroups(
  node: WorkflowNode,
  inputs: Record<string, unknown>,
  values: Record<string, unknown>,
  groups: WorkflowReferenceGroup[],
): Record<string, unknown> {
  const result = { ...inputs };
  for (const id of Object.keys(node.config.referenceGroups ?? {})) {
    const group = groups.find((g) => g.id === id);
    if (!group) invalid(`节点 ${node.name} 的参考组已变更，请重新配置`);
    // 可选媒体未提供时与空数组等价；非空的非法值仍交给严格校验。
    const value = values[id] ?? [];
    checkReferenceArray(group, value);
    // 防止两种输入方式同时生效，旧的拆分值不能污染数组中的空槽位。
    for (const name of group.fields) delete result[name];
    value.forEach((entry, index) => {
      result[group.fields[index]] = entry;
    });
  }
  return result;
}
