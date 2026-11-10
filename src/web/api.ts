import type { WorkflowSemaphoreInput, WorkflowSemaphoreView, WorkflowSemaphore } from "../shared/workflow-contracts";
import type { WorkflowSummary, WorkflowDefinition, WorkflowDraft, WorkflowRun, WorkflowCatalog, WorkflowFile, WorkflowFilePage, WorkflowScriptAssistRequest, WorkflowScriptAssistProgress } from "../shared/workflow-contracts";
import type { LoginResponse, SecurityProof, SecurityStatus, TotpSetup } from "../shared/security-contracts";
import type { ConfigurationOverviewDocument, ConfigurationRestorePreview, ConfigurationPostCommitError } from "../shared/configuration-operations-contracts";
import type { AgentProfileDocument, CreateAgentInput, UpdateAgentInput } from "../shared/agent-contracts";
import type { CredentialStatus, ModelConfigDocument, ScopedConfigDocument, ThinkingLevel, WebPiSettings } from "../shared/configuration-contracts";
import type { ChatRunSummary, ComposerCatalog, DataFileSummary, DataFileTextPreview, WorkspaceEntry, WorkspaceFileSummary, WorkspaceTextPreview } from "../shared/contracts";
import type { AgentReference, AgentReferenceInput } from "../shared/agent-reference-contracts";
import type { CreateScheduledTaskInput, ScheduledTask, ScheduledTaskRun, UpdateScheduledTaskInput } from "../shared/scheduled-task-contracts";
import type {
  CreateSearchProviderInput,
  UpdateSearchProviderInput,
  WebResearchGlobalConfig,
  WebResearchSettingsDocument,
} from "../shared/web-research-contracts";
import type { TtsProfileInput, TtsProfileSummary, TtsSettingsDocument } from "../shared/tts-contracts";
import type { EmbeddingConfigInput, EmbeddingSettingsDocument } from "../shared/knowledge-retrieval-contracts";
import type { SessionBulkAction, SessionBulkPreview, SessionBulkResult, SessionBulkTarget } from "../shared/session-bulk-contracts";
import type { SessionHistoryPage, SessionHistoryResult } from "../shared/session-history-contracts";
import type { BrowserAutomationConfig, BrowserAutomationSettingsDocument } from "../shared/browser-automation-contracts";
import type { SessionTextSearchPage } from "../shared/session-text-search";
import type { PendingQuestionProjection, SubmitQuestionAnswers } from "../shared/session-question-contracts";
import type { QuestionAnswerSubmissionResult } from "../shared/question-response-protocol";
import type { AvatarCropArea } from "../shared/avatar-contracts";
import type {
  AigcMediaProject,
  AigcMediaProjectCreateInput,
  AigcMediaProjectDocument,
  AigcMediaProjectUpdateInput,
  AigcMediaRenderJob,
} from "../shared/aigc-media-editor-contracts";
import type {
  AigcChannelInput,
  AigcComfyUiInputFile,
  AigcCreateChannelInput,
  AigcInterfaceDocument,
  AigcInterfaceInput,
  AigcInterfaceRecord,
  AigcMcpClient,
  AigcMcpOperation,
  AigcOutputKind,
  AigcOutputPage,
  AigcPublicDirectoryEntry,
  AigcPublicFileDocument,
  AigcPublicFileSummary,
  AigcRunRequest,
  AigcRuntimeChannelSummary,
  AigcSettingsDocument,
  AigcTaskDocument,
  AigcTaskRecord,
  AigcUpdateChannelInput,
  AigcUploadedAsset,
  AigcWorkflowCreateInput,
  AigcWorkflowDetail,
  AigcWorkflowDetailDocument,
  ComfyUiNodeMetadataSyncResult,
  AigcWorkflowDocument,
  AigcWorkflowReplaceInput,
  AigcWorkflowReplacementPreview,
  AigcWorkflowUpdateInput,
} from "../shared/aigc-contracts";

export type { ScheduledTask, ScheduledTaskRun, SessionBulkAction, SessionBulkPreview, SessionBulkResult, SessionBulkTarget };

export interface ServiceStatus {
  initialized: boolean;
  authenticated: boolean;
}

export interface SetupRequest {
  password: string;
  confirmPassword: string;
  provider: {
    type: string;
    apiKey: string;
    baseUrl?: string;
    defaultModel: string;
  };
}

export interface SetupResponse {
  initialized: true;
}

export interface UserProfile {
  displayName: string;
  avatar?: { kind: "image"; revision: string; mediaType: "image/png" | "image/jpeg" | "image/webp" };
}

export interface UserProfileDocument {
  revision: string;
  profile: UserProfile;
}

export interface ModelSummary {
  provider: string;
  id: string;
  name: string;
  thinkingLevels?: readonly ThinkingLevel[];
}

export interface SessionSummary {
  id: string;
  agentId?: string;
  name?: string;
  firstMessage: string;
  modified: string;
  messageCount: number;
  pinned?: boolean;
  scheduledTaskCount?: number;
}

export interface SessionSnapshot {
  id: string;
  agentId?: string;
  messages: unknown[];
  history: SessionHistoryPage;
  model?: ModelSummary;
  thinkingLevel?: ThinkingLevel;
  run?: ChatRunSummary;
  pendingQuestion?: PendingQuestionProjection;
  lastEventId: number;
}

export interface SessionEditDraft { text: string; filePaths: string[]; references: AgentReference[]; missingFilePaths: string[] }

export interface ProvidersDocument extends ModelConfigDocument {
  credentials: CredentialStatus[];
  credentialRevision: string;
}

export type ModelConnectionTestRequest =
  | { scope: "current"; modelId: string }
  | { scope: "all" };

export interface ModelConnectionTestItem {
  modelId: string;
  modelName: string;
  ok: boolean;
  durationMs: number;
  responsePreview?: string;
  errorCode?: string;
  message?: string;
}

export interface ModelConnectionTestResult {
  providerId: string;
  results: ModelConnectionTestItem[];
}

export interface DiscoveredModel {
  id: string;
  name: string;
  exists: boolean;
}

export interface DiscoverModelsResult {
  providerId: string;
  models: DiscoveredModel[];
}

export interface ResourceCatalogItem { id: string; type: "skill" | "prompt" | "extension" | "theme"; name: string; description: string; path: string; source: string; scope: "global" | "agent"; origin: "package" | "top-level"; enabled: boolean; inherited: boolean; mode?: "enabled" | "disabled" | "inherit" | "default" }
export interface ResourceCatalog { resources: ResourceCatalogItem[]; tools: Array<{ name: string; description: string; extensionPath: string; highRisk: boolean }>; diagnostics: Array<{ type: string; message: string; path?: string }>; packages?: Array<{ source: string; scope: "user" | "project"; filtered: boolean; installedPath?: string }> }
export type AgentPromptFile = "role" | "behavior" | "rules" | "user" | "bootsharp";
export interface DiagnosticsReport { generatedAt: string; version: { app: string; node: string; pi: string }; mounts: Array<{ source: string; target: string; writable: boolean }>; diagnostics: Array<{ source: string; severity: "info" | "warning" | "error"; code: string; message: string; field?: string }>; backgroundErrors?: { total: number; latestCode?: string; latestAt?: string }; operational?: { database: { quickCheck: string; journalMode: string }; runtime: { activeLeases: number; trackedAgents: number }; limits: Record<string, number> } }
export interface ConfigurationHistoryEntry { id: string; createdAt: string; scope: "global" | "agent" | "credential" | "resource"; targetId?: string; summary: string; outcome: "success" | "failed"; restorable?: boolean }
export interface ConfigurationImportPreview { previewId: string; added: string[]; changed: string[]; conflicts: string[]; invalid: Array<{ file: string; message: string }> }
export interface KnowledgeDocumentSummary { id: string; knowledgeBaseId: string; name: string; mediaType: string; status: "indexed" | "needs_ocr" | "failed"; failureReason?: string; createdAt: string; text?: string; textTruncated?: boolean }
/** 管理端查看的一段已建立索引的知识库文本。 */
export interface KnowledgeDocumentChunk { chunkId: string; documentId: string; index: number; text: string; page?: number }
export interface KnowledgeBaseDetail { id: string; name: string; description: string; createdAt: string; updatedAt: string; agentIds: string[]; documents: KnowledgeDocumentSummary[] }
export interface KnowledgeSearchResult { chunkId: string; documentId: string; index: number; text: string; page?: number; score?: number }

export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly requestId?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

/** 将应用内部 API 资源路径映射到当前稳定版本。 */
export function apiV1Url(url: string): string {
  return url.startsWith("/api/") && !url.startsWith("/api/v1/")
    ? `/api/v1/${url.slice("/api/".length)}`
    : url;
}

/** 生成可内联预览或明确下载的 AIGC 任务产物地址。 */
export function aigcTaskAssetUrl(taskId: string, assetId: string, download = false): string {
  const suffix = download ? "?download=1" : "";
  return apiV1Url(`/api/aigc/tasks/${encodeURIComponent(taskId)}/assets/${encodeURIComponent(assetId)}${suffix}`);
}

/** 生成 AIGC 临时入参文件的内联预览地址。 */
export function aigcInputAssetUrl(assetId: string): string {
  return apiV1Url(`/api/aigc/inputs/${encodeURIComponent(assetId)}`);
}

/** 生成不暴露 ComfyUI 渠道地址的同源 input 媒体预览地址。 */
export function aigcComfyUiInputContentUrl(channelId: string, file: AigcComfyUiInputFile): string {
  const query = new URLSearchParams({ channelId, filename: file.filename, type: file.type ?? "input" });
  if (file.subfolder) query.set("subfolder", file.subfolder);
  return apiV1Url(`/api/aigc/comfyui-input-files/content?${query.toString()}`);
}

/** 生成 AIGC 图片产物的服务端缩略图地址。 */
export function aigcTaskThumbnailUrl(taskId: string, assetId: string): string {
  return apiV1Url(`/api/aigc/tasks/${encodeURIComponent(taskId)}/assets/${encodeURIComponent(assetId)}/thumbnail`);
}

/** 生成轻剪辑导出结果的预览或下载地址。 */
export function aigcMediaRenderUrl(renderId: string, download = false): string {
  const suffix = download ? "?download=1" : "";
  return apiV1Url(`/api/aigc/media-renders/${encodeURIComponent(renderId)}/output${suffix}`);
}

/** 根据公开文件稳定地址生成预览或下载链接。 */
export function aigcPublicFileUrl(url: string, download = false): string {
  if (!download) return url;
  return `${url}${url.includes("?") ? "&" : "?"}download=1`;
}

/**
 * 对 fetch 做统一 JSON 和错误协议处理。
 */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const hasJsonBody = init?.body !== undefined && !(init.body instanceof FormData);
  const method = init?.method ?? "GET";
  let response: Response;
  try {
    response = await fetch(apiV1Url(url), {
      credentials: "same-origin",
      ...init,
      headers: {
        ...(hasJsonBody ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    const browserMessage = error instanceof Error && error.message.trim()
      ? `：${sanitizeClientErrorMessage(error.message)}`
      : "";
    throw new ApiClientError(
      "API_NETWORK_ERROR",
      `浏览器未收到 BugPaw API 响应（${method}）${browserMessage}`,
      0,
      undefined,
      { stage: "network", method },
    );
  }
  if (response.status === 204) {
    return undefined as T;
  }
  const responseText = await response.text();
  let payload: unknown;
  try {
    payload = responseText ? JSON.parse(responseText) as unknown : undefined;
  } catch {
    throw new ApiClientError(
      "API_RESPONSE_INVALID",
      `BugPaw API 返回了无法解析的 JSON 响应（HTTP ${response.status}）`,
      response.status,
      response.headers.get("X-Request-Id") ?? undefined,
      { stage: "response-parse", method },
    );
  }
  if (!response.ok) {
    const error = readApiError(payload);
    throw new ApiClientError(
      error?.code ?? "API_RESPONSE_INVALID",
      error?.message ?? `BugPaw API 返回 HTTP ${response.status}，但响应缺少统一错误文档`,
      response.status,
      error?.requestId ?? response.headers.get("X-Request-Id") ?? undefined,
      error?.details ?? { stage: "error-document", method },
    );
  }
  return payload as T;
}

/** 清理浏览器网络异常中的控制字符和疑似凭据，保留可诊断事实。 */
function sanitizeClientErrorMessage(message: string): string {
  return message
    .replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ")
    .replace(/\b(Bearer|Token)\s+[^\s,;]+/giu, "$1 [已隐藏]")
    .replace(/\b(authorization|api[_ -]?key|cookie|password|secret)\s*[:=]\s*[^\s,;]+/giu, "$1: [已隐藏]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 300);
}

/**
 * 将 cwd 相对路径转换为经过逐段编码的文件接口地址。
 */
export function workspaceFileUrl(agentId: string, path: string, download = false): string {
  const encodedPath = path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  const base = apiV1Url(`/api/agents/${encodeURIComponent(agentId)}/files/${encodedPath}`);
  return download ? `${base}?download=1` : base;
}

/** 将 Markdown 文件路径转换为 `/data` 只读接口地址。 */
export function dataFileUrl(agentId: string, path: string, download = false): string {
  const query = new URLSearchParams({ path });
  if (download) query.set("download", "1");
  return apiV1Url(`/api/agents/${encodeURIComponent(agentId)}/data-files?${query.toString()}`);
}

/** 点击文件链接后按需读取真实文件元数据。 */
async function getDataFile(agentId: string, path: string): Promise<DataFileSummary> {
  const response = await fetch(dataFileUrl(agentId, path), { method: "HEAD", credentials: "same-origin" });
  if (!response.ok) {
    throw new ApiClientError("FILE_NOT_FOUND", "文件不存在、不可读取或不在 /data 目录内", response.status);
  }
  return {
    path: decodeHeader(response.headers.get("X-BugPaw-File-Path")) ?? path,
    name: decodeHeader(response.headers.get("X-BugPaw-File-Name")) ?? linkFileName(path),
    mediaType: response.headers.get("Content-Type")?.split(";", 1)[0] || "application/octet-stream",
    size: Number(response.headers.get("Content-Length") ?? 0),
    modifiedAt: response.headers.get("Last-Modified") ?? "",
  };
}

async function getDataFileText(agentId: string, path: string): Promise<DataFileTextPreview> {
  return request<DataFileTextPreview>(`/api/agents/${encodeURIComponent(agentId)}/data-files/text?path=${encodeURIComponent(path)}`);
}

function decodeHeader(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function linkFileName(path: string): string {
  const pathOnly = path.split(/[?#]/, 1)[0] ?? path;
  try {
    return decodeURIComponent(pathOnly).split("/").at(-1) || "file";
  } catch {
    return pathOnly.split("/").at(-1) || "file";
  }
}

/**
 * 读取工作目录文件的实时元数据，避免在会话中持久化易过期的信息。
 */
async function getWorkspaceFile(agentId: string, path: string): Promise<WorkspaceFileSummary> {
  const response = await fetch(workspaceFileUrl(agentId, path), {
    method: "HEAD",
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new ApiClientError("FILE_NOT_FOUND", "工作目录文件不存在或不可读取", response.status);
  }
  const name = path.split("/").at(-1) || path;
  return {
    path,
    name,
    mediaType: response.headers.get("Content-Type")?.split(";", 1)[0] || "application/octet-stream",
    size: Number(response.headers.get("Content-Length") ?? 0),
    modifiedAt: response.headers.get("Last-Modified") ?? "",
  };
}

async function synthesizeAgentSpeech(agentId: string, input: string, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(apiV1Url(`/api/agents/${encodeURIComponent(agentId)}/tts`), {
    method: "POST",
    credentials: "same-origin",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });
  if (!response.ok) throw new ApiClientError("TTS_REQUEST_FAILED", "语音合成服务暂时不可用", response.status);
  return response;
}

/** 上传浏览器录音并交给本机服务器 Whisper 转写。 */
async function transcribeSpeech(audio: Blob): Promise<{ text: string; language: string; duration: number }> {
  const extension = audio.type.includes("ogg") ? "ogg" : audio.type.includes("mp4") ? "m4a" : "webm";
  const form = new FormData();
  form.append("audio", audio, `speech.${extension}`);
  return request<{ text: string; language: string; duration: number }>("/api/speech/transcriptions", {
    method: "POST",
    body: form,
  });
}

function readApiError(payload: unknown): {
  code?: string;
  message?: string;
  requestId?: string;
  details?: Record<string, unknown>;
} | undefined {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) {
    return undefined;
  }
  const error = payload.error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return undefined;
  const record = error as Record<string, unknown>;
  return {
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...(typeof record.requestId === "string" ? { requestId: record.requestId } : {}),
    ...(isRecord(record.details) ? { details: record.details } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const api = {
  listWorkflows: () => request<{ workflows: WorkflowSummary[] }>("/api/workflows"),
  getWorkflow: (id: string) => request<WorkflowDefinition>(`/api/workflows/${encodeURIComponent(id)}`),
  saveWorkflow: (draft: WorkflowDraft, id?: string, revision?: number) => request<WorkflowDefinition>(id ? `/api/workflows/${encodeURIComponent(id)}` : "/api/workflows", { method: id ? "PUT" : "POST", body: JSON.stringify({ ...draft, revision }) }),
  deleteWorkflow: (id: string, revision: number) => request<void>(`/api/workflows/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ revision }) }),
  validateWorkflow: (draft: WorkflowDraft, id?: string) => request<{ valid: boolean }>("/api/workflows/validate", { method: "POST", body: JSON.stringify({ ...draft, id }) }),
  assistWorkflowScript: async (input: WorkflowScriptAssistRequest, signal?: AbortSignal, onProgress?: (event: WorkflowScriptAssistProgress) => void) => {
    const controller = new AbortController();
    const activeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let requestId: string | undefined;
    try {
      const response = await fetch(apiV1Url("/api/workflows/script-assist"), {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(input), signal: activeSignal,
      });
      requestId = response.headers.get("X-Request-Id") ?? undefined;
      const { readWorkflowScriptAssistStream } = await import("./features/workflows/workflow-script-assist-api");
      return await readWorkflowScriptAssistStream(response, activeSignal, onProgress);
    } catch (error) {
      if (signal?.aborted) throw new DOMException("脚本辅助生成已取消", "AbortError");
      if (error instanceof ApiClientError) throw error;
      const detail = error instanceof Error ? `：${sanitizeClientErrorMessage(error.message)}` : "";
      throw new ApiClientError("API_NETWORK_ERROR", `读取脚本辅助生成流时连接中断${detail}`, 0, requestId);
    } finally {
      controller.abort();
    }
  },
  listWorkflowSemaphores: () => request<{ semaphores: WorkflowSemaphoreView[] }>("/api/workflow-semaphores"),
  saveWorkflowSemaphore: (input: WorkflowSemaphoreInput & { revision?: number }) => request<WorkflowSemaphore>("/api/workflow-semaphores", { method: "POST", body: JSON.stringify(input) }),
  deleteWorkflowSemaphore: (code: string, revision: number) => request<void>(`/api/workflow-semaphores/${encodeURIComponent(code)}`, { method: "DELETE", body: JSON.stringify({ revision }) }),
  getWorkflowCatalog: () => request<WorkflowCatalog>("/api/workflows/catalog"),
  runWorkflow: (id: string, inputs: Record<string, unknown>, requestKey: string) => request<WorkflowRun>(`/api/workflows/${encodeURIComponent(id)}/run`, { method: "POST", body: JSON.stringify({ inputs, requestKey }) }),
  getWorkflowRun: (id: string) => request<WorkflowRun>(`/api/workflow-runs/${encodeURIComponent(id)}`),
  cancelWorkflowRun: (id: string) => request<WorkflowRun>(`/api/workflow-runs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  listWorkflowRuns: () => request<{ runs: (Pick<WorkflowRun, "id" | "workflowId" | "status" | "createdAt" | "finishedAt" | "error"> & { name: string })[] }>("/api/workflow-runs"),
  uploadWorkflowFile: (file: File, directory: "runtime" | "constants" = "runtime") => { const data = new FormData(); data.append("file", file); return request<WorkflowFile>(`/api/workflow-files${directory === "constants" ? "?directory=constants" : ""}`, { method: "POST", body: data }); },
  listWorkflowFiles: (params: Record<string, string> = {}) => request<WorkflowFilePage>(`/api/workflow-files?${new URLSearchParams(params)}`),
  deleteWorkflowFiles: (ids: string[]) => request<void>("/api/workflow-files", { method: "DELETE", body: JSON.stringify({ ids }) }),
  getWorkflowFileText: (id: string) => request<WorkspaceTextPreview>(`/api/workflow-files/${encodeURIComponent(id)}/text`),

  getBrowserAutomation: () => request<BrowserAutomationSettingsDocument>("/api/capabilities/browser"),
  updateBrowserAutomation: (revision: string, config: BrowserAutomationConfig) => request<BrowserAutomationSettingsDocument>("/api/capabilities/browser", { method: "PATCH", body: JSON.stringify({ revision, config }) }),
  testBrowserAutomation: () => request<{ ok: boolean; message: string }>("/api/capabilities/browser/test", { method: "POST" }),
  getKnowledgeRetrieval: () => request<EmbeddingSettingsDocument>("/api/capabilities/knowledge-retrieval"),
  updateKnowledgeRetrieval: (revision: string, config: EmbeddingConfigInput) => request<EmbeddingSettingsDocument>("/api/capabilities/knowledge-retrieval", { method: "PATCH", body: JSON.stringify({ revision, config }) }),
  getKnowledgeRetrievalCredential: () => request<{ apiKey: string }>("/api/capabilities/knowledge-retrieval/credential"),
  rebuildKnowledgeRetrieval: () => request<{ totalBases: number; rebuiltBases: number; failedBases: string[]; failures?: Array<{ baseId: string; message: string }> }>("/api/capabilities/knowledge-retrieval/rebuild", { method: "POST" }),
  getTtsProfiles: () => request<TtsSettingsDocument>("/api/capabilities/tts"),
  getTtsProfileCredential: (profileId: string) => request<{ apiKey: string }>(`/api/capabilities/tts/${encodeURIComponent(profileId)}/credential`),
  createTtsProfile: (input: TtsProfileInput) => request<{ revision: string; profile: TtsProfileSummary }>("/api/capabilities/tts", { method: "POST", body: JSON.stringify(input) }),
  updateTtsProfile: (id: string, revision: string, input: TtsProfileInput) => request<{ revision: string; profile: TtsProfileSummary }>(`/api/capabilities/tts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ revision, ...input }) }),
  deleteTtsProfile: (id: string, revision: string) => request<void>(`/api/capabilities/tts/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ revision }) }),
  getAigcChannels: () => request<AigcSettingsDocument>("/api/capabilities/aigc/channels"),
  getAigcRuntimeChannels: () => request<{ channels: AigcRuntimeChannelSummary[] }>("/api/aigc/runtime-channels"),
  createAigcChannel: (input: AigcCreateChannelInput) => request<AigcSettingsDocument>("/api/capabilities/aigc/channels", { method: "POST", body: JSON.stringify(input) }),
  updateAigcChannel: (id: string, input: AigcUpdateChannelInput) => request<AigcSettingsDocument>(`/api/capabilities/aigc/channels/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteAigcChannel: (id: string, configRevision: string, credentialRevision: string) => request<void>(`/api/capabilities/aigc/channels/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ configRevision, credentialRevision }) }),
  testAigcChannel: (id: string) => request<{ ok: boolean; message: string }>(`/api/capabilities/aigc/channels/${encodeURIComponent(id)}/test`, { method: "POST" }),
  getAigcChannelCredential: (id: string) => request<{ apiKey: string }>(`/api/capabilities/aigc/channels/${encodeURIComponent(id)}/credential`),
  getAigcWorkflows: () => request<AigcWorkflowDocument>("/api/aigc/workflows"),
  createAigcWorkflow: (input: AigcWorkflowCreateInput) => request<AigcWorkflowDetail>("/api/aigc/workflows", { method: "POST", body: JSON.stringify(input) }),
  getAigcWorkflow: (id: string) => request<AigcWorkflowDetailDocument>(`/api/aigc/workflows/${encodeURIComponent(id)}`),
  updateAigcWorkflow: (id: string, revision: string, input: AigcWorkflowUpdateInput) => request<AigcWorkflowDetail>(`/api/aigc/workflows/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ revision, ...input }) }),
  previewAigcWorkflowReplacement: (id: string, revision: string, input: AigcWorkflowReplaceInput) => request<AigcWorkflowReplacementPreview>(`/api/aigc/workflows/${encodeURIComponent(id)}/replace-preview`, { method: "POST", body: JSON.stringify({ revision, ...input }) }),
  replaceAigcWorkflow: (id: string, revision: string, input: AigcWorkflowReplaceInput) => request<AigcWorkflowDetailDocument>(`/api/aigc/workflows/${encodeURIComponent(id)}/replace`, { method: "POST", body: JSON.stringify({ revision, ...input }) }),
  syncAigcWorkflowNodeMetadata: (id: string, channelId: string, revision: string) => request<ComfyUiNodeMetadataSyncResult & AigcWorkflowDetailDocument>(`/api/aigc/workflows/${encodeURIComponent(id)}/sync-node-metadata`, { method: "POST", body: JSON.stringify({ channelId, revision }) }),
  deleteAigcWorkflow: (id: string, revision: string) => request<void>(`/api/aigc/workflows/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ revision }) }),
  getAigcInterfaces: () => request<AigcInterfaceDocument>("/api/aigc/interfaces"),
  getAigcMcpClients: () => request<{ clients: AigcMcpClient[] }>("/api/aigc/mcp/clients"),
  createAigcMcpClient: (input: { name: string; interfaceIds: string[]; operations: AigcMcpOperation[] }) => request<{ client: AigcMcpClient; token: string }>("/api/aigc/mcp/clients", { method: "POST", body: JSON.stringify(input) }),
  updateAigcMcpClient: (id: string, input: { name: string; interfaceIds: string[]; operations: AigcMcpOperation[] }) => request<{ client: AigcMcpClient }>(`/api/aigc/mcp/clients/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  revokeAigcMcpClient: (id: string) => request<void>(`/api/aigc/mcp/clients/${encodeURIComponent(id)}`, { method: "DELETE" }),
  createAigcInterface: (input: AigcInterfaceInput) => request<AigcInterfaceRecord>("/api/aigc/interfaces", { method: "POST", body: JSON.stringify(input) }),
  updateAigcInterface: (id: string, revision: string, input: AigcInterfaceInput) => request<AigcInterfaceRecord>(`/api/aigc/interfaces/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ revision, ...input }) }),
  deleteAigcInterface: (id: string, revision: string) => request<void>(`/api/aigc/interfaces/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ revision }) }),
  getAigcTasks: () => request<AigcTaskDocument>("/api/aigc/tasks"),
  getAigcTask: (id: string) => request<AigcTaskRecord>(`/api/aigc/tasks/${encodeURIComponent(id)}`),
  getAigcOutputs: (kind: AigcOutputKind, sort: "asc" | "desc", page: number, pageSize = 24) => request<AigcOutputPage>(`/api/aigc/outputs?kind=${encodeURIComponent(kind)}&sort=${sort}&page=${page}&pageSize=${pageSize}`),
  getAigcMediaProjects: () => request<AigcMediaProjectDocument>("/api/aigc/media-projects"),
  getAigcMediaProject: (id: string) => request<AigcMediaProject>(`/api/aigc/media-projects/${encodeURIComponent(id)}`),
  createAigcMediaProject: (input: AigcMediaProjectCreateInput) => request<AigcMediaProject>("/api/aigc/media-projects", { method: "POST", body: JSON.stringify(input) }),
  updateAigcMediaProject: (id: string, input: AigcMediaProjectUpdateInput) => request<AigcMediaProject>(`/api/aigc/media-projects/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteAigcMediaProject: (id: string) => request<void>(`/api/aigc/media-projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
  renderAigcMediaProject: (id: string) => request<AigcMediaRenderJob>(`/api/aigc/media-projects/${encodeURIComponent(id)}/render`, { method: "POST" }),
  getAigcMediaRender: (id: string) => request<AigcMediaRenderJob>(`/api/aigc/media-renders/${encodeURIComponent(id)}`),
  cancelAigcMediaRender: (id: string) => request<AigcMediaRenderJob>(`/api/aigc/media-renders/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  deleteAigcTask: (id: string) => request<void>(`/api/aigc/tasks/${encodeURIComponent(id)}`, { method: "DELETE" }),
  deleteSelectedAigcTasks: (ids: string[]) => request<{ removedIds: string[] }>("/api/aigc/tasks", { method: "DELETE", body: JSON.stringify({ ids }) }),
  runAigcInterface: (input: AigcRunRequest) => request<AigcTaskRecord>("/api/aigc/tasks", { method: "POST", body: JSON.stringify(input) }),
  cancelAigcTask: (id: string) => request<AigcTaskRecord>(`/api/aigc/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  retryAigcTask: (id: string) => request<AigcTaskRecord>(`/api/aigc/tasks/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  uploadAigcInput: (file: File) => {
    const form = new FormData();
    form.append("file", file, file.name);
    return request<{ asset: AigcUploadedAsset }>("/api/aigc/inputs", { method: "POST", body: form });
  },
  getAigcComfyUiInputFiles: (channelId: string, nodeClass: string, field: string) => {
    const query = new URLSearchParams({ channelId, nodeClass, field });
    return request<{ files: AigcComfyUiInputFile[] }>(`/api/aigc/comfyui-input-files?${query.toString()}`);
  },
  getAigcPublicFiles: () => request<AigcPublicFileDocument>("/api/aigc/public-files"),
  uploadAigcPublicFile: (file: File) => {
    const form = new FormData();
    form.append("file", file, file.name);
    return request<{ file: AigcPublicFileSummary }>("/api/aigc/public-files", { method: "POST", body: form });
  },
  deleteAigcPublicFile: (id: string) => request<void>(`/api/aigc/public-files/${encodeURIComponent(id)}`, { method: "DELETE" }),
  listAigcPublicDirectoryEntries: (directory = "") => request<{ entries: AigcPublicDirectoryEntry[] }>(`/api/aigc/public-directory/entries?directory=${encodeURIComponent(directory)}`),
  searchAigcPublicDirectoryEntries: (query: string) => request<{ entries: AigcPublicDirectoryEntry[] }>(`/api/aigc/public-directory/search?query=${encodeURIComponent(query)}`),
  getAigcPublicDirectoryText: (path: string) => request<WorkspaceTextPreview>(`/api/aigc/public-directory/text?path=${encodeURIComponent(path)}`),
  uploadAigcPublicDirectoryFiles: (directory: string, files: File[]) => {
    const form = new FormData();
    files.forEach((file) => form.append("files", file, file.name));
    return request<{ files: AigcPublicFileSummary[] }>(`/api/aigc/public-directory/uploads?directory=${encodeURIComponent(directory)}`, { method: "POST", body: form });
  },
  createAigcPublicDirectory: (directory: string, name: string) => request<AigcPublicDirectoryEntry>("/api/aigc/public-directory/directories", { method: "POST", body: JSON.stringify({ directory, name }) }),
  updateAigcPublicDirectoryEntry: (body: { operation: "rename"; path: string; name: string } | { operation: "move"; path: string; targetDirectory: string; createTargetDirectory?: boolean }) => request<AigcPublicDirectoryEntry>("/api/aigc/public-directory/entries", { method: "PATCH", body: JSON.stringify(body) }),
  deleteAigcPublicDirectoryEntries: (paths: string[]) => request<void>("/api/aigc/public-directory/entries", { method: "DELETE", body: JSON.stringify({ paths }) }),
  getWebResearch: () => request<WebResearchSettingsDocument>("/api/capabilities/web-research"),
  updateWebResearchGlobal: (revision: string, config: WebResearchGlobalConfig) => request<WebResearchSettingsDocument>("/api/capabilities/web-research/global", { method: "PATCH", body: JSON.stringify({ revision, config }) }),
  createWebResearchProvider: (input: CreateSearchProviderInput) => request<WebResearchSettingsDocument>("/api/capabilities/web-research/providers", { method: "POST", body: JSON.stringify(input) }),
  updateWebResearchProvider: (providerId: string, input: UpdateSearchProviderInput) => request<WebResearchSettingsDocument>(`/api/capabilities/web-research/providers/${encodeURIComponent(providerId)}`, { method: "PATCH", body: JSON.stringify(input) }),
  reorderWebResearchProviders: (revision: string, providerIds: string[]) => request<WebResearchSettingsDocument>("/api/capabilities/web-research/providers/order", { method: "PUT", body: JSON.stringify({ revision, providerIds }) }),
  deleteWebResearchProvider: (providerId: string, configRevision: string, credentialRevision: string) => request<void>(`/api/capabilities/web-research/providers/${encodeURIComponent(providerId)}`, { method: "DELETE", body: JSON.stringify({ configRevision, credentialRevision }) }),
  testWebResearchProvider: (providerId: string) => request<{ ok: boolean; message: string }>(`/api/capabilities/web-research/providers/${encodeURIComponent(providerId)}/test`, { method: "POST" }),
  getWebResearchProviderCredential: (providerId: string) => request<{ apiKey: string }>(`/api/capabilities/web-research/providers/${encodeURIComponent(providerId)}/credential`),
  getStatus: () => request<ServiceStatus>("/api/status"),
  setup: (input: SetupRequest) =>
    request<SetupResponse>("/api/setup", { method: "POST", body: JSON.stringify(input) }),
  login: (password: string, remember: boolean) =>
    request<LoginResponse>("/api/login", { method: "POST", cache: "no-store", body: JSON.stringify({ password, remember }) }),
  verifyLoginTotp: (code: string, recovery: boolean) => request<{ authenticated: true }>("/api/login/totp", { method: "POST", cache: "no-store", body: JSON.stringify({ code, recovery }) }),
  getSecurityStatus: () => request<SecurityStatus>("/api/security/totp", { cache: "no-store" }),
  beginTotpSetup: (password: string) => request<TotpSetup>("/api/security/totp/setup", { method: "POST", cache: "no-store", body: JSON.stringify({ password }) }),
  cancelTotpSetup: () => request<void>("/api/security/totp/setup", { method: "DELETE", cache: "no-store" }),
  confirmTotpSetup: (code: string) => request<{ recoveryCodes: string[] }>("/api/security/totp/confirm", { method: "POST", cache: "no-store", body: JSON.stringify({ code }) }),
  manageTotp: (action: "disable" | "recovery", proof: SecurityProof) => request<{ recoveryCodes: string[] }>(`/api/security/totp/${action}`, { method: "POST", cache: "no-store", body: JSON.stringify(proof) }),
  logout: () => request<void>("/api/logout", { method: "POST" }),
  getProfile: () => request<UserProfileDocument>("/api/profile"),
  updateProfile: (revision: string, displayName: string) =>
    request<UserProfileDocument>("/api/profile", { method: "PATCH", body: JSON.stringify({ revision, displayName }) }),
  uploadProfileAvatar: (revision: string, file: File, crop: AvatarCropArea) => {
    const form = new FormData();
    form.append("avatar", file, file.name);
    form.append("crop", JSON.stringify(crop));
    return request<UserProfileDocument>(`/api/profile/avatar?revision=${encodeURIComponent(revision)}`, { method: "POST", body: form });
  },
  listAgents: () => request<{ agents: AgentProfileDocument[] }>("/api/agents"),
  reorderAgents: (agentIds: string[]) => request<{ agents: AgentProfileDocument[] }>("/api/agents/order", {
    method: "POST", body: JSON.stringify({ agentIds }),
  }),
  getAgent: (agentId: string) => request<AgentProfileDocument>(`/api/agents/${encodeURIComponent(agentId)}`),
  getAgentPrompt: (agentId: string, file: AgentPromptFile) => request<{ file: AgentPromptFile; content: string }>(`/api/agents/${encodeURIComponent(agentId)}/prompts/${file}`),
  replaceAgentPrompt: (agentId: string, file: AgentPromptFile, content: string) => request<{ file: AgentPromptFile; content: string }>(`/api/agents/${encodeURIComponent(agentId)}/prompts/${file}`, {
    method: "PUT", body: JSON.stringify({ content }),
  }),
  createAgent: (input: CreateAgentInput) => request<AgentProfileDocument>("/api/agents", {
    method: "POST",
    body: JSON.stringify(input),
  }),
  updateAgent: (agentId: string, revision: string, patch: UpdateAgentInput) =>
    request<AgentProfileDocument>(`/api/agents/${encodeURIComponent(agentId)}`, {
      method: "PATCH",
      body: JSON.stringify({ revision, ...patch }),
    }),
  archiveAgent: (agentId: string, revision: string) =>
    request<AgentProfileDocument>(`/api/agents/${encodeURIComponent(agentId)}/archive`, {
      method: "POST", body: JSON.stringify({ revision }),
    }),
  restoreAgent: (agentId: string, revision: string) =>
    request<AgentProfileDocument>(`/api/agents/${encodeURIComponent(agentId)}/archive`, {
      method: "DELETE", body: JSON.stringify({ revision }),
    }),
  cloneAgent: (agentId: string, name?: string, copyWorkspace = false) =>
    request<AgentProfileDocument>(`/api/agents/${encodeURIComponent(agentId)}/clone`, {
      method: "POST", body: JSON.stringify({ name, copyWorkspace }),
    }),
  getAgentDeletePreview: (agentId: string) => request<{
    agentId: string; name: string; sessions: { count: number }; workspace: { files: number; bytes: number };
  }>(`/api/agents/${encodeURIComponent(agentId)}/delete-preview`),
  deleteAgent: (agentId: string, removeSessions: boolean, removeWorkspace: boolean) =>
    request<{ trashPath?: string }>(`/api/agents/${encodeURIComponent(agentId)}`, {
      method: "DELETE", body: JSON.stringify({ removeSessions, removeWorkspace }),
    }),
  uploadAgentAvatar: (agentId: string, revision: string, file: File, crop: AvatarCropArea) => {
    const form = new FormData();
    form.append("avatar", file, file.name);
    form.append("crop", JSON.stringify(crop));
    return request<AgentProfileDocument>(`/api/agents/${encodeURIComponent(agentId)}/avatar?revision=${encodeURIComponent(revision)}`, {
      method: "POST",
      body: form,
    });
  },
  listProviders: () => request<ProvidersDocument>("/api/providers"),
  createProvider: (providerId: string, revision: string, provider: Record<string, unknown>) =>
    request<ModelConfigDocument>("/api/providers", {
      method: "POST", body: JSON.stringify({ id: providerId, revision, provider }),
    }),
  saveProvider: (providerId: string, revision: string, provider: Record<string, unknown>) =>
    request<ModelConfigDocument>(`/api/providers/${encodeURIComponent(providerId)}`, {
      method: "PUT", body: JSON.stringify({ revision, provider }),
    }),
  renameProvider: (providerId: string, targetId: string, revision: string) =>
    request<ModelConfigDocument>(`/api/providers/${encodeURIComponent(providerId)}/rename`, {
      method: "POST", body: JSON.stringify({ id: targetId, revision, confirmed: true }),
    }),
  reorderProviders: (providerIds: string[], revision: string) =>
    request<ModelConfigDocument>("/api/providers/order", {
      method: "POST", body: JSON.stringify({ providerIds, revision }),
    }),
  reorderProviderModels: (providerId: string, modelIds: string[], revision: string) =>
    request<ModelConfigDocument>(`/api/providers/${encodeURIComponent(providerId)}/models/order`, {
      method: "POST", body: JSON.stringify({ modelIds, revision }),
    }),
  removeProvider: (providerId: string, revision: string) =>
    request<ModelConfigDocument>(`/api/providers/${encodeURIComponent(providerId)}`, {
      method: "DELETE", body: JSON.stringify({ revision }),
    }),
  removeProviderModel: (providerId: string, modelId: string, revision: string) =>
    request<ModelConfigDocument>(`/api/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`, {
      method: "DELETE", body: JSON.stringify({ revision }),
    }),
  saveProviderCredential: (providerId: string, revision: string, apiKey: string) =>
    request<{ credentialRevision: string; status: CredentialStatus }>(`/api/providers/${encodeURIComponent(providerId)}/credential`, {
      method: "PUT", body: JSON.stringify({ revision, apiKey }),
    }),
  getProviderCredential: (providerId: string) =>
    request<{ apiKey: string }>(`/api/providers/${encodeURIComponent(providerId)}/credential`),
  removeProviderCredential: (providerId: string, revision: string) =>
    request<{ credentialRevision: string; status: null }>(`/api/providers/${encodeURIComponent(providerId)}/credential`, {
      method: "DELETE", body: JSON.stringify({ revision }),
    }),
  testProvider: (providerId: string, test: ModelConnectionTestRequest) =>
    request<ModelConnectionTestResult>(`/api/providers/${encodeURIComponent(providerId)}/test`, {
      method: "POST", body: JSON.stringify(test),
    }),
  discoverProviderModels: (providerId: string) =>
    request<DiscoverModelsResult>(`/api/providers/${encodeURIComponent(providerId)}/discover-models`, { method: "POST" }),
  getGlobalSettings: () => request<ScopedConfigDocument<WebPiSettings>>("/api/configuration/global"),
  updateGlobalSettings: (revision: string, set: Record<string, unknown>, inherit: string[] = []) =>
    request<ScopedConfigDocument<WebPiSettings>>("/api/configuration/global", { method: "PATCH", body: JSON.stringify({ revision, set, inherit }) }),
  getAgentSettings: (agentId: string) => request<ScopedConfigDocument<WebPiSettings>>(`/api/agents/${encodeURIComponent(agentId)}/settings`),
  updateAgentSettings: (agentId: string, revision: string, set: Record<string, unknown>, inherit: string[]) =>
    request<ScopedConfigDocument<WebPiSettings>>(`/api/agents/${encodeURIComponent(agentId)}/settings`, { method: "PATCH", body: JSON.stringify({ revision, set, inherit }) }),
  getResourceTask: (taskId: string) => request<{ status: "running" | "completed" | "failed" }>(`/api/configuration/tasks/${encodeURIComponent(taskId)}`),
  listResources: (agentId?: string) => request<ResourceCatalog>(`/api/resources${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`),
  getResourceContent: (resourceId: string, agentId?: string) => request<{ content: string }>(`/api/resources/content?id=${encodeURIComponent(resourceId)}${agentId ? `&agentId=${encodeURIComponent(agentId)}` : ""}`),
  setResourceMode: (resourceId: string, mode: "enabled" | "disabled" | "inherit", target: "global" | "agent", agentId?: string) => request<ResourceCatalog>(`/api/resources/${encodeURIComponent(resourceId)}`, { method: "PATCH", body: JSON.stringify({ mode, target, agentId }) }),
  installResource: (source: string, scope: "global" | "agent", agentId?: string) => request<{ taskId: string }>("/api/resources/install", { method: "POST", body: JSON.stringify({ source, scope, agentId, confirmed: true }) }),
  removeResourcePackage: (source: string, scope: "global" | "agent", agentId?: string) => request<{ taskId: string }>("/api/resources/remove", { method: "POST", body: JSON.stringify({ source, scope, agentId, confirmed: true }) }),
  getDiagnostics: () => request<DiagnosticsReport>("/api/configuration/diagnostics"),
  refreshPiRuntime: () => request<{ abortedSessions: number }>("/api/configuration/refresh-runtime", { method: "POST" }),
  previewConfigurationImport: (value: unknown) => request<ConfigurationImportPreview>("/api/configuration/import/preview", { method: "POST", body: JSON.stringify(value) }),
  applyConfigurationImport: (previewId: string) => request<{ applied: true; runtimeRefreshRequired: boolean; postCommitError?: ConfigurationPostCommitError }>("/api/configuration/import/apply", { method: "POST", body: JSON.stringify({ previewId, confirmed: true }) }),
  getConfigurationOverview: () => request<ConfigurationOverviewDocument>("/api/configuration/overview"),
  previewConfigurationRestore: (id: string) => request<ConfigurationRestorePreview>(`/api/configuration/history/${encodeURIComponent(id)}/preview`),
  listConfigurationHistory: () => request<{ entries: ConfigurationHistoryEntry[] }>("/api/configuration/history"),
  restoreConfigurationHistory: (id: string, revision: string) => request<ScopedConfigDocument<WebPiSettings>>(`/api/configuration/history/${encodeURIComponent(id)}/restore`, { method: "POST", body: JSON.stringify({ revision }) }),
  listModels: () => request<{ models: ModelSummary[] }>("/api/models"),
  listScheduledTasks: (agentId: string) => request<{ tasks: ScheduledTask[] }>(`/api/agents/${encodeURIComponent(agentId)}/scheduled-tasks`),
  createScheduledTask: (agentId: string, input: Omit<CreateScheduledTaskInput, "agentId">) => request<ScheduledTask>(`/api/agents/${encodeURIComponent(agentId)}/scheduled-tasks`, { method: "POST", body: JSON.stringify(input) }),
  updateScheduledTask: (taskId: string, input: UpdateScheduledTaskInput) => request<ScheduledTask>(`/api/scheduled-tasks/${encodeURIComponent(taskId)}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteScheduledTask: (taskId: string) => request<void>(`/api/scheduled-tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" }),
  runScheduledTask: (taskId: string) => request<ScheduledTaskRun>(`/api/scheduled-tasks/${encodeURIComponent(taskId)}/run`, { method: "POST" }),
  listScheduledTaskRuns: (taskId: string) => request<{ runs: ScheduledTaskRun[] }>(`/api/scheduled-tasks/${encodeURIComponent(taskId)}/runs`),
  getScheduledTaskTimezones: () => request<{ serverTimeZone: string; timezones: string[] }>("/api/scheduled-tasks/timezones"),
  listSessions: (agentId: string, archived = false) => request<{ sessions: SessionSummary[] }>(
    `/api/sessions?agentId=${encodeURIComponent(agentId)}${archived ? "&archived=true" : ""}`,
  ),
  searchSessions: (agentId: string, input: { query: string; cursor?: string }, signal?: AbortSignal) =>
    request<SessionTextSearchPage>(
      `/api/sessions/search?agentId=${encodeURIComponent(agentId)}&query=${encodeURIComponent(input.query)}${input.cursor ? `&cursor=${encodeURIComponent(input.cursor)}` : ""}`,
      { signal },
    ),
  previewSessionBulk: (action: SessionBulkAction, target: SessionBulkTarget) => request<SessionBulkPreview>("/api/sessions/bulk/preview", {
    method: "POST",
    body: JSON.stringify({ action, target }),
  }),
  executeSessionBulk: (action: SessionBulkAction, target: SessionBulkTarget, fingerprint: string) => request<SessionBulkResult>("/api/sessions/bulk", {
    method: "POST",
    body: JSON.stringify({ action, target, fingerprint }),
  }),
  createSession: (agentId: string) => request<SessionSnapshot>("/api/sessions", { method: "POST", body: JSON.stringify({ agentId }) }),
  openSession: (sessionId: string, signal?: AbortSignal) => request<SessionSnapshot>(
    `/api/sessions/${encodeURIComponent(sessionId)}`,
    { signal },
  ),
  loadSessionHistory: (sessionId: string, before: string, branchToken: string, signal?: AbortSignal) =>
    request<SessionHistoryResult>(
      `/api/sessions/${encodeURIComponent(sessionId)}/history?before=${encodeURIComponent(before)}&branch=${encodeURIComponent(branchToken)}`,
      { signal },
    ),
  loadSessionHistoryTarget: (sessionId: string, entryId: string, branchToken: string, signal?: AbortSignal) =>
    request<SessionHistoryResult>(
      `/api/sessions/${encodeURIComponent(sessionId)}/history-window?entryId=${encodeURIComponent(entryId)}&branch=${encodeURIComponent(branchToken)}`,
      { signal },
    ),
  loadSessionHistoryAfter: (sessionId: string, after: string, branchToken: string, signal?: AbortSignal) =>
    request<SessionHistoryResult>(
      `/api/sessions/${encodeURIComponent(sessionId)}/history?after=${encodeURIComponent(after)}&branch=${encodeURIComponent(branchToken)}`,
      { signal },
    ),
  sendMessage: (sessionId: string, text: string, filePaths: string[] = [], references: AgentReferenceInput[] = []) =>
    request<ChatRunSummary>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, filePaths, references }),
    }),
  submitQuestionAnswers: (sessionId: string, questionRecordId: string, input: SubmitQuestionAnswers) =>
    request<QuestionAnswerSubmissionResult>(`/api/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionRecordId)}/answers`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  sendBranchMessage: (sessionId: string, entryId: string, text: string, filePaths: string[] = [], references: AgentReferenceInput[] = []) =>
    request<{ snapshot: SessionSnapshot; run: ChatRunSummary }>(`/api/sessions/${encodeURIComponent(sessionId)}/branches/${encodeURIComponent(entryId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, filePaths, references }),
    }),
  editSessionBranch: (sessionId: string, entryId: string) => request<{ snapshot: SessionSnapshot; draft: SessionEditDraft }>(`/api/sessions/${encodeURIComponent(sessionId)}/branches/${encodeURIComponent(entryId)}/edit`, { method: "POST" }),
  navigateSessionBranch: (sessionId: string, entryId: string) => request<SessionSnapshot>(`/api/sessions/${encodeURIComponent(sessionId)}/branches/${encodeURIComponent(entryId)}/navigate`, { method: "POST" }),
  regenerateSessionBranch: (sessionId: string, entryId: string) => request<{ snapshot: SessionSnapshot; run: ChatRunSummary }>(`/api/sessions/${encodeURIComponent(sessionId)}/branches/${encodeURIComponent(entryId)}/regenerate`, { method: "POST" }),
  getComposerCatalog: (agentId: string) => request<ComposerCatalog>(`/api/agents/${encodeURIComponent(agentId)}/composer-catalog`),
  uploadAttachments: (agentId: string, files: File[]) => {
    const form = new FormData();
    files.forEach((file) => form.append("files", file, file.name));
    return request<{ files: WorkspaceFileSummary[] }>(`/api/agents/${encodeURIComponent(agentId)}/attachments`, {
      method: "POST",
      body: form,
    });
  },
  listKnowledgeBases: () => request<{ knowledgeBases: KnowledgeBaseDetail[] }>("/api/knowledge-bases"),
  getKnowledgeBase: (knowledgeBaseId: string) => request<KnowledgeBaseDetail>(`/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`),
  createKnowledgeBase: (input: { name: string; description?: string; agentIds?: string[] }) => request<KnowledgeBaseDetail>("/api/knowledge-bases", { method: "POST", body: JSON.stringify(input) }),
  updateKnowledgeBase: (knowledgeBaseId: string, input: { name?: string; description?: string; agentIds?: string[] }) => request<KnowledgeBaseDetail>(`/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteKnowledgeBase: (knowledgeBaseId: string) => request<void>(`/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`, { method: "DELETE" }),
  uploadKnowledgeDocuments: (knowledgeBaseId: string, files: File[]) => {
    const form = new FormData();
    files.forEach((file) => form.append("files", file, file.name));
    return request<{ documents: KnowledgeDocumentSummary[] }>(`/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents`, { method: "POST", body: form });
  },
  getKnowledgeDocument: (knowledgeBaseId: string, documentId: string) => request<KnowledgeDocumentSummary>(`/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}`),
  listKnowledgeDocumentChunks: (knowledgeBaseId: string, documentId: string) => request<{ chunks: KnowledgeDocumentChunk[] }>(`/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}/chunks`),
  knowledgeDocumentSourceUrl: (knowledgeBaseId: string, documentId: string) => apiV1Url(`/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}/source`),
  deleteKnowledgeDocument: (knowledgeBaseId: string, documentId: string) => request<void>(`/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" }),
  searchKnowledgeBase: (knowledgeBaseId: string, query: string) => request<{ results: KnowledgeSearchResult[] }>(`/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/search`, { method: "POST", body: JSON.stringify({ query }) }),
  listWorkspaceEntries: (agentId: string, directory = "", includeHidden = false) => request<{ entries: WorkspaceEntry[] }>(`/api/agents/${encodeURIComponent(agentId)}/workspace/entries?directory=${encodeURIComponent(directory)}${includeHidden ? "&includeHidden=true" : ""}`),
  searchWorkspaceEntries: (agentId: string, query: string, includeHidden = false) => request<{ entries: WorkspaceEntry[] }>(`/api/agents/${encodeURIComponent(agentId)}/workspace/search?query=${encodeURIComponent(query)}${includeHidden ? "&includeHidden=true" : ""}`),
  getWorkspaceText: (agentId: string, path: string) => request<WorkspaceTextPreview>(`/api/agents/${encodeURIComponent(agentId)}/workspace/text?path=${encodeURIComponent(path)}`),
  uploadWorkspaceFiles: (agentId: string, directory: string, files: File[]) => {
    const form = new FormData();
    files.forEach((file) => form.append("files", file, file.name));
    return request<{ entries: WorkspaceEntry[] }>(`/api/agents/${encodeURIComponent(agentId)}/workspace/uploads?directory=${encodeURIComponent(directory)}`, { method: "POST", body: form });
  },
  createWorkspaceDirectory: (agentId: string, directory: string, name: string) => request<WorkspaceEntry>(`/api/agents/${encodeURIComponent(agentId)}/workspace/directories`, { method: "POST", body: JSON.stringify({ directory, name }) }),
  updateWorkspaceEntry: (agentId: string, body: { operation: "rename"; path: string; name: string } | { operation: "move"; path: string; targetDirectory: string; createTargetDirectory?: boolean }) => request<WorkspaceEntry>(`/api/agents/${encodeURIComponent(agentId)}/workspace/entries`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteWorkspaceEntries: (agentId: string, paths: string[]) => request<void>(`/api/agents/${encodeURIComponent(agentId)}/workspace/entries`, { method: "DELETE", body: JSON.stringify({ paths }) }),
  getWorkspaceFile,
  getDataFile,
  getDataFileText,
  synthesizeAgentSpeech,
  transcribeSpeech,
  abort: (sessionId: string) =>
    request<void>(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, { method: "POST" }),
  setModel: (sessionId: string, provider: string, modelId: string) =>
    request<void>(`/api/sessions/${encodeURIComponent(sessionId)}/model`, {
      method: "PUT",
      body: JSON.stringify({ provider, modelId }),
    }),
  setThinkingLevel: (sessionId: string, thinkingLevel: ThinkingLevel) =>
    request<void>(`/api/sessions/${encodeURIComponent(sessionId)}/thinking-level`, {
      method: "PUT",
      body: JSON.stringify({ thinkingLevel }),
    }),
  renameSession: (sessionId: string, name: string) =>
    request<void>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  pinSession: (sessionId: string) =>
    request<void>(`/api/sessions/${encodeURIComponent(sessionId)}/pin`, { method: "PUT" }),
  unpinSession: (sessionId: string) =>
    request<void>(`/api/sessions/${encodeURIComponent(sessionId)}/pin`, { method: "DELETE" }),
  archiveSession: (sessionId: string) =>
    request<void>(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, { method: "POST" }),
  unarchiveSession: (sessionId: string) =>
    request<void>(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, { method: "DELETE" }),
  deleteSession: (sessionId: string, confirmBoundTasks = false) =>
    request<void>(`/api/sessions/${encodeURIComponent(sessionId)}${confirmBoundTasks ? "?confirmBoundTasks=true" : ""}`, { method: "DELETE" }),
};
