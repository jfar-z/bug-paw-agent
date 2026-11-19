import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { CreateAgentInput, TitleGenerationConfig, UpdateAgentInput } from "../../shared/agent-contracts";
import type { TtsCustomParameters } from "../../shared/tts-custom-parameters";
import { normalizeTtsCustomParameters } from "../../shared/tts-custom-parameters";
import type { AgentStore } from "../agents/agent-store";
import { AgentWorkspaceError } from "../agents/agent-workspace";
import { type AgentPromptFile, AgentPromptStore } from "../agents/agent-prompt-store";
import { processAvatarImage } from "../avatar/avatar-image-processor";
import { receiveAvatarUpload } from "../avatar/avatar-upload";
import { VersionConflictError } from "../configuration/versioned-json-store";
import { DomainError } from "../core/errors";
import { SYSTEM_LIMITS } from "../core/limits";
import type { AgentRemovalPermit } from "../core/agent-lifecycle-gate";
import { statusForDomainError } from "../http/error-handler";
import type { AuthService } from "./auth";
import { sendApiError } from "./http";
import { requireAuthentication } from "./protected";

interface AgentRouteDependencies {
  authService: AuthService;
  store: AgentStore;
  removeAgent?: (agentId: string) => Promise<void>;
  finalizeAgentRemoval?: (agentId: string) => void;
  restoreAgent?: (agentId: string) => void;
  runAgentMutation?<T>(agentId: string, operation: () => Promise<T>): Promise<T>;
  runModelMutation?<T>(operation: () => Promise<T>): Promise<T>;
  beginAgentRemoval?: (agentId: string) => Promise<AgentRemovalPermit>;
  countSessions?: (agentId: string) => Promise<number>;
  prompts?: AgentPromptStore;
  resolveAvailableModel?: (provider: string, modelId: string) => Promise<{
    reasoning: boolean;
    thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  } | undefined>;
}

type ThinkingLevel = NonNullable<CreateAgentInput["defaultThinkingLevel"]>;

/**
 * 注册 Agent Profile 的查询、生命周期和删除接口。
 */
export function registerAgentRoutes(app: FastifyInstance, dependencies: AgentRouteDependencies): void {
  app.get("/api/agents", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    return reply.send({ agents: await dependencies.store.list() });
  });

  app.post("/api/agents/order", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : {};
    if (!Array.isArray(body.agentIds) || body.agentIds.some((agentId) => typeof agentId !== "string")) {
      return sendApiError(reply, 400, "INVALID_AGENT_ORDER", "Agent 排序格式无效");
    }
    try {
      return reply.send({ agents: await dependencies.store.reorder(body.agentIds) });
    } catch (error) {
      return sendAgentError(reply, error);
    }
  });

  app.post("/api/agents", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : {};
    if (typeof body.name !== "string" || !body.name.trim()) {
      return sendApiError(reply, 400, "INVALID_AGENT_NAME", "Agent 名称不能为空");
    }
    if (body.instructions !== undefined) {
      return sendApiError(reply, 400, "PROMPT_FILES_ONLY", "提示词请通过独立 Markdown 文件接口保存");
    }
    try {
      const created = await runModelMutation(dependencies, async () => {
        const input = readCreateInput(body);
        await validateModelSelection(input, dependencies);
        return dependencies.store.create(input);
      });
      return reply.code(201).send(created);
    } catch (error) {
      return sendAgentError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/agents/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    try {
      const agent = await dependencies.store.get(request.params.id);
      return agent ? reply.send(agent) : sendApiError(reply, 404, "AGENT_NOT_FOUND", "Agent 不存在");
    } catch (error) {
      return sendAgentError(reply, error);
    }
  });

  app.get<{ Params: { id: string; file: string } }>("/api/agents/:id/prompts/:file", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const file = parsePromptFile(request.params.file);
    if (!file) return sendApiError(reply, 400, "INVALID_PROMPT_FILE", "提示词文件无效");
    try {
      if (!(await dependencies.store.get(request.params.id))) return sendApiError(reply, 404, "AGENT_NOT_FOUND", "Agent 不存在");
      return reply.send({ file, content: await dependencies.prompts?.read(request.params.id, file) ?? "" });
    } catch (error) { return sendAgentError(reply, error); }
  });

  app.put<{ Params: { id: string; file: string } }>("/api/agents/:id/prompts/:file", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const file = parsePromptFile(request.params.file);
    const body = isRecord(request.body) ? request.body : {};
    if (!file) return sendApiError(reply, 400, "INVALID_PROMPT_FILE", "提示词文件无效");
    if (typeof body.content !== "string") return sendApiError(reply, 400, "PROMPT_CONTENT_REQUIRED", "提示词内容必须是字符串");
    const content = body.content;
    try {
      if (!(await dependencies.store.get(request.params.id))) return sendApiError(reply, 404, "AGENT_NOT_FOUND", "Agent 不存在");
      if (!dependencies.prompts) throw new Error("提示词存储尚未就绪");
      return await runAgentMutation(dependencies, request.params.id, async () => {
        await dependencies.prompts!.replace(request.params.id, file, content);
        return reply.send({ file, content });
      });
    } catch (error) { return sendAgentError(reply, error); }
  });

  app.get<{ Params: { id: string } }>("/api/agents/:id/avatar", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    try {
      const avatar = await dependencies.store.readImageAvatar(request.params.id);
      if (!avatar) return sendApiError(reply, 404, "AVATAR_NOT_FOUND", "Agent 未配置图片头像");
      return reply.header("Cache-Control", "private, max-age=31536000, immutable").type(avatar.mediaType).send(avatar.content);
    } catch (error) {
      return sendAgentError(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Querystring: { revision?: string } }>("/api/agents/:id/avatar", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (typeof request.query.revision !== "string") return sendApiError(reply, 400, "REVISION_REQUIRED", "上传头像必须携带 revision");
    try {
      const upload = await receiveAvatarUpload(request);
      let updated;
      try {
        const processed = await processAvatarImage(upload.sourcePath, upload.crop);
        updated = await runAgentMutation(
          dependencies,
          request.params.id,
          () => dependencies.store.setImageAvatar(
            request.params.id,
            processed.content,
            processed.mediaType,
            request.query.revision!,
          ),
        );
      } finally {
        await upload.cleanup();
      }
      return reply.send(updated);
    } catch (error) {
      return sendAgentError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/agents/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : {};
    if (typeof body.revision !== "string") {
      return sendApiError(reply, 400, "REVISION_REQUIRED", "更新 Agent 必须携带 revision");
    }
    if (body.instructions !== undefined) {
      return sendApiError(reply, 400, "PROMPT_FILES_ONLY", "提示词请通过独立 Markdown 文件接口保存");
    }
    try {
      const updated = await runModelMutation(dependencies, async () => {
        const current = await dependencies.store.get(request.params.id);
        if (!current) throw new DomainError("AGENT_NOT_FOUND", "Agent 不存在");
        const input = readUpdateInput(body);
        await validateModelSelection(input, dependencies, current.profile.defaultModel, current.profile.defaultThinkingLevel, current.profile.titleGeneration);
        return runRuntimeProfileMutation(
          dependencies,
          request.params.id,
          () => dependencies.store.update(request.params.id, input, body.revision as string),
        );
      });
      return reply.send(updated);
    } catch (error) {
      return sendAgentError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/clone", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : {};
    try {
      const clone = await runModelMutation(dependencies, () => dependencies.store.clone(request.params.id, {
        name: typeof body.name === "string" ? body.name : undefined,
        copyWorkspace: body.copyWorkspace === true,
      }));
      return reply.code(201).send(clone);
    } catch (error) {
      return sendAgentError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/archive", async (request, reply) => {
    return changeArchiveStatus(request.params.id, true, request.body, reply, dependencies);
  });

  app.delete<{ Params: { id: string } }>("/api/agents/:id/archive", async (request, reply) => {
    return changeArchiveStatus(request.params.id, false, request.body, reply, dependencies);
  });

  app.get<{ Params: { id: string } }>("/api/agents/:id/delete-preview", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    try {
      const agent = await dependencies.store.get(request.params.id);
      if (!agent) return sendApiError(reply, 404, "AGENT_NOT_FOUND", "Agent 不存在");
      const workspace = await summarizeDirectory(agent.profile.cwd);
      const sessionCount = await dependencies.countSessions?.(agent.profile.id) ?? 0;
      return reply.send({ agentId: agent.profile.id, name: agent.profile.name, workspace, sessions: { count: sessionCount } });
    } catch (error) {
      return sendAgentError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : {};
    if (typeof body.removeSessions !== "boolean" || typeof body.removeWorkspace !== "boolean") {
      return sendApiError(reply, 400, "DELETE_OPTIONS_REQUIRED", "必须明确选择是否删除 Session 和工作目录");
    }
    let lifecyclePermit: AgentRemovalPermit | undefined;
    let runtimeRemovalStarted = false;
    try {
      lifecyclePermit = await dependencies.beginAgentRemoval?.(request.params.id);
      runtimeRemovalStarted = true;
      await dependencies.removeAgent?.(request.params.id);
      const removed = await dependencies.store.remove(request.params.id, {
        removeSessions: body.removeSessions,
        removeWorkspace: body.removeWorkspace,
      });
      dependencies.finalizeAgentRemoval?.(request.params.id);
      lifecyclePermit?.finalize();
      return reply.send(removed);
    } catch (error) {
      if (runtimeRemovalStarted) dependencies.restoreAgent?.(request.params.id);
      lifecyclePermit?.restore();
      return sendAgentError(reply, error);
    }
  });
}

async function validateModelSelection(
  input: CreateAgentInput | UpdateAgentInput,
  dependencies: AgentRouteDependencies,
  currentModel?: { provider: string; id: string },
  currentThinking?: ThinkingLevel,
  currentTitleGeneration?: TitleGenerationConfig,
): Promise<void> {
  const selected = input.defaultModel === null ? undefined : input.defaultModel ?? currentModel;
  const requestedThinking = input.defaultThinkingLevel === null ? undefined : input.defaultThinkingLevel ?? currentThinking;
  const titleGeneration = input.titleGeneration === null ? undefined : input.titleGeneration ?? currentTitleGeneration;
  if (!dependencies.resolveAvailableModel) {
    if (input.defaultModel !== undefined || input.titleGeneration !== undefined) throw new Error("模型目录尚未就绪");
    return;
  }
  if (selected) {
    const model = await dependencies.resolveAvailableModel(selected.provider, selected.id);
    if (!model) throw new Error("所选模型当前不可用");
    if (requestedThinking !== undefined && (input.defaultModel !== undefined || input.defaultThinkingLevel !== undefined)) {
      input.defaultThinkingLevel = clampThinkingLevel(model, requestedThinking);
    }
  }
  if (titleGeneration?.modelSource === "custom") {
    const titleModel = await dependencies.resolveAvailableModel(titleGeneration.model!.provider, titleGeneration.model!.id);
    if (!titleModel) throw new Error("所选标题模型当前不可用");
  }
}

function clampThinkingLevel(
  model: { reasoning: boolean; thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>> },
  requested: ThinkingLevel,
): ThinkingLevel {
  const all: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const supported = model.reasoning
    ? all.filter((level) => {
        const mapped = model.thinkingLevelMap?.[level];
        if (mapped === null) return false;
        if (level === "xhigh" || level === "max") return mapped !== undefined;
        return true;
      })
    : ["off" as const];
  if (supported.includes(requested)) return requested;
  const requestedIndex = all.indexOf(requested);
  return all.slice(requestedIndex).find((level) => supported.includes(level))
    ?? all.slice(0, requestedIndex).reverse().find((level) => supported.includes(level))
    ?? "off";
}

async function changeArchiveStatus(
  agentId: string,
  archived: boolean,
  requestBody: unknown,
  reply: FastifyReply,
  dependencies: AgentRouteDependencies,
) {
  if (!(await requireAuthentication(reply.request, reply, dependencies.authService))) return;
  const body = isRecord(requestBody) ? requestBody : {};
  if (typeof body.revision !== "string") return sendApiError(reply, 400, "REVISION_REQUIRED", "操作必须携带 revision");
  try {
    const result = await runRuntimeProfileMutation(dependencies, agentId, () => archived
      ? dependencies.store.archive(agentId, body.revision as string)
      : dependencies.store.restore(agentId, body.revision as string));
    return reply.send(result);
  } catch (error) {
    return sendAgentError(reply, error);
  }
}

function runAgentMutation<T>(
  dependencies: AgentRouteDependencies,
  agentId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return dependencies.runAgentMutation?.(agentId, operation) ?? operation();
}

function runModelMutation<T>(dependencies: AgentRouteDependencies, operation: () => Promise<T>): Promise<T> {
  return dependencies.runModelMutation?.(operation) ?? operation();
}

async function runRuntimeProfileMutation<T>(
  dependencies: AgentRouteDependencies,
  agentId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return runAgentMutation(dependencies, agentId, async () => {
    try {
      // removeAgent 可能在排空租约或落盘检查点时失败；无论失败发生在哪一步，
      // 都必须撤销 RuntimeSupervisor 的删除墓碑，避免 Agent 在本进程内永久不可用。
      await dependencies.removeAgent?.(agentId);
      return await operation();
    } finally {
      dependencies.restoreAgent?.(agentId);
    }
  });
}

function readCreateInput(body: Record<string, unknown>): CreateAgentInput {
  return {
    name: body.name as string,
    cwd: typeof body.cwd === "string" ? body.cwd : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
    avatar: readInitialAvatar(body.avatar),
    defaultModel: readModel(body.defaultModel),
    defaultThinkingLevel: readThinkingLevel(body.defaultThinkingLevel),
    titleGeneration: body.titleGeneration === undefined ? undefined : readTitleGeneration(body.titleGeneration),
    ttsProfileId: typeof body.ttsProfileId === "string" ? body.ttsProfileId : undefined,
    ttsVoice: typeof body.ttsVoice === "string" ? body.ttsVoice : undefined,
    ttsCustomParameters: body.ttsCustomParameters === undefined
      ? undefined
      : readTtsCustomParameters(body.ttsCustomParameters),
    ttsAutoPlay: body.ttsAutoPlay === true,
    ttsStreamPlayback: body.ttsStreamPlayback === true,
    mediaLibraryGrants: readMediaGrants(body.mediaLibraryGrants),
    allowedTools: readStringArray(body.allowedTools),
  };
}

function readUpdateInput(body: Record<string, unknown>): UpdateAgentInput {
  const input: UpdateAgentInput = {};
  if (typeof body.name === "string") input.name = body.name;
  if (typeof body.cwd === "string") input.cwd = body.cwd;
  if (typeof body.description === "string") input.description = body.description;
  if (body.avatar !== undefined) input.avatar = readInitialAvatar(body.avatar);
  if (body.defaultModel === null) input.defaultModel = null;
  else if (body.defaultModel !== undefined) input.defaultModel = readModel(body.defaultModel);
  if (body.defaultThinkingLevel === null) input.defaultThinkingLevel = null;
  else if (body.defaultThinkingLevel !== undefined) input.defaultThinkingLevel = readThinkingLevel(body.defaultThinkingLevel);
  if (body.titleGeneration === null) input.titleGeneration = null;
  else if (body.titleGeneration !== undefined) input.titleGeneration = readTitleGeneration(body.titleGeneration);
  if (body.ttsProfileId === null) input.ttsProfileId = null;
  else if (typeof body.ttsProfileId === "string") input.ttsProfileId = body.ttsProfileId;
  if (body.ttsVoice === null) input.ttsVoice = null;
  else if (typeof body.ttsVoice === "string") input.ttsVoice = body.ttsVoice;
  if (body.ttsCustomParameters === null) input.ttsCustomParameters = null;
  else if (body.ttsCustomParameters !== undefined) input.ttsCustomParameters = readTtsCustomParameters(body.ttsCustomParameters);
  if (typeof body.ttsAutoPlay === "boolean") input.ttsAutoPlay = body.ttsAutoPlay;
  if (typeof body.ttsStreamPlayback === "boolean") input.ttsStreamPlayback = body.ttsStreamPlayback;
  if (body.mediaLibraryGrants !== undefined) input.mediaLibraryGrants = readMediaGrants(body.mediaLibraryGrants);
  if (body.allowedTools !== undefined) input.allowedTools = readStringArray(body.allowedTools);
  return input;
}

function readInitialAvatar(value: unknown): CreateAgentInput["avatar"] {
  if (!isRecord(value) || value.kind !== "initial" || typeof value.value !== "string") return undefined;
  return { kind: "initial", value: value.value.slice(0, 2) };
}

function readModel(value: unknown): CreateAgentInput["defaultModel"] {
  return isRecord(value) && typeof value.provider === "string" && typeof value.id === "string"
    ? { provider: value.provider, id: value.id }
    : undefined;
}

function readThinkingLevel(value: unknown): CreateAgentInput["defaultThinkingLevel"] {
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  return levels.find((level) => level === value);
}

/**
 * 读取并校验 Agent 标题生成策略。
 *
 * @param value HTTP 请求中的标题配置
 */
function readTitleGeneration(value: unknown): TitleGenerationConfig {
  if (!isRecord(value) || typeof value.thinkingEnabled !== "boolean") {
    throw new TypeError("标题生成配置格式无效");
  }
  if (value.modelSource !== "session" && value.modelSource !== "system-default" && value.modelSource !== "custom") {
    throw new TypeError("标题模型来源无效");
  }
  if (value.modelSource !== "custom") return { modelSource: value.modelSource, thinkingEnabled: value.thinkingEnabled };
  const model = readModel(value.model);
  if (!model) throw new TypeError("单独标题模型不能为空");
  return { modelSource: "custom", model, thinkingEnabled: value.thinkingEnabled };
}

function readMediaGrants(value: unknown): CreateAgentInput["mediaLibraryGrants"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > SYSTEM_LIMITS.mediaLibraries)
    throw new DomainError("VALIDATION_FAILED", "媒体库授权列表无效");
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.libraryId !== "string" || !/^[a-f0-9-]{36}$/.test(entry.libraryId)
      || ids.has(entry.libraryId) || typeof entry.read !== "boolean" || typeof entry.upload !== "boolean"
      || typeof entry.publicTransfer !== "boolean" || (entry.publicTransfer && !entry.read))
      throw new DomainError("VALIDATION_FAILED", "媒体库授权须按库唯一设置，公开传输须同时授予读取权限");
    ids.add(entry.libraryId);
    return { libraryId: entry.libraryId, read: entry.read, upload: entry.upload, publicTransfer: entry.publicTransfer };
  });
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

async function summarizeDirectory(root: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  let entries = 0;
  const deadline = Date.now() + SYSTEM_LIMITS.workspaceScanTimeoutMs;
  const pending = [{ path: root, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > SYSTEM_LIMITS.workspaceDepth) throw new DomainError("WORKSPACE_SCAN_LIMIT", "工作区扫描超过系统允许的深度");
    const directory = await opendir(current.path);
    for await (const entry of directory) {
      entries += 1;
      if (entries > SYSTEM_LIMITS.workspaceEntries || Date.now() > deadline) throw new DomainError("WORKSPACE_SCAN_LIMIT", "工作区扫描超过系统允许的范围");
      const path = join(current.path, entry.name);
      if (entry.isDirectory()) pending.push({ path, depth: current.depth + 1 });
      else {
        const info = await lstat(path);
        files += 1;
        bytes += info.size;
      }
    }
  }
  return { files, bytes };
}

function sendAgentError(reply: FastifyReply, error: unknown) {
  if (error instanceof DomainError) {
    return sendApiError(reply, statusForDomainError(error.code), error.code, error.message);
  }
  if (error instanceof VersionConflictError) return sendApiError(reply, 409, "VERSION_CONFLICT", error.message);
  if (error instanceof AgentWorkspaceError) {
    const conflicts = new Set(["WORKSPACE_IN_USE", "WORKSPACE_PI_CONFLICT"]);
    return sendApiError(reply, conflicts.has(error.code) ? 409 : 400, error.code, error.message);
  }
  const message = error instanceof Error ? error.message : "Agent API 捕获到非 Error 异常";
  return sendApiError(reply, 400, "AGENT_INVALID", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把共享参数校验错误映射为稳定的 Agent API 业务错误。 */
function readTtsCustomParameters(value: unknown): TtsCustomParameters {
  try {
    return normalizeTtsCustomParameters(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : "TTS 自定义请求参数无效";
    throw new DomainError("VALIDATION_FAILED", message);
  }
}

/** 将路由参数限制为 Agent 可编辑的五个固定提示词文件。 */
function parsePromptFile(value: string): AgentPromptFile | undefined {
  return (["role", "behavior", "rules", "user", "bootsharp"] as const).find((file) => file === value);
}
