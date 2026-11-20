import { Tabs } from "../ui/tabs";
import { Button, SearchField, NumberField, Textarea, TextField } from "../ui/controls";
import { Checkbox } from "../ui/choice";
import { SearchSelect } from "../ui/search-select";
import { Check, PencilLine, Plus, Save, TestTube2, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelConfigDocument, ProviderEditorModel } from "../../shared/configuration-contracts";
import { api, type ApiClientError, type DiscoveredModel, type ModelConnectionTestItem, type ModelConnectionTestRequest, type ProvidersDocument } from "../api";
import { useErrorToast } from "../error-toast-provider";
import { toUnexpectedErrorNotice } from "../api-error-policy";
import { useApiTask, type ApiTaskPolicy } from "../api-task-provider";
import { KeyValueEditor, type KeyValueRow } from "../ui/key-value-editor";
import { ConfigurationEditorDialog } from "../components/configuration/configuration-editor-dialog";
import { ProviderCreateDialog } from "../components/configuration/provider-create-dialog";
import { ProviderRenameDialog } from "../components/configuration/provider-rename-dialog";
import { useUnsavedChanges } from "../ui/unsaved-changes";
import { ConfigurationEffectNotice, recordConfigurationSave } from "../components/configuration/configuration-effect-notice";
import { SecretInput } from "../ui/secret-input";
import { ThinkingLevelMapEditor } from "../components/configuration/thinking-level-map-editor";
import { getThinkingProtocolPreview, thinkingProtocolOptions } from "../components/configuration/thinking-protocol-preview";
import { useOnlineStatus } from "../use-online-status";
import "../configuration.css";
import "../providers.css";

interface ProviderNode extends Record<string, unknown> {
  name?: string;
  baseUrl?: string;
  api?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models?: ProviderEditorModel[];
}

type CompatBooleanKey =
  | "supportsDeveloperRole"
  | "supportsReasoningEffort"
  | "supportsUsageInStreaming"
  | "supportsStore"
  | "requiresToolResultName"
  | "requiresAssistantAfterToolResult"
  | "requiresThinkingAsText"
  | "requiresReasoningContentOnAssistantMessages";

const compatBooleanFields: Array<{ key: CompatBooleanKey; label: string; help?: string }> = [
  { key: "supportsDeveloperRole", label: "支持 developer 角色" },
  { key: "supportsReasoningEffort", label: "支持推理强度" },
  { key: "supportsUsageInStreaming", label: "流式响应支持用量" },
  { key: "supportsStore", label: "支持服务端存储" },
  { key: "requiresToolResultName", label: "工具结果需要名称" },
  { key: "requiresAssistantAfterToolResult", label: "工具结果后需要 assistant" },
  { key: "requiresThinkingAsText", label: "推理内容转文本", help: "llama.cpp/Qwen 续聊时可避免回放不兼容的 reasoning_content。" },
  { key: "requiresReasoningContentOnAssistantMessages", label: "Assistant 消息需要 reasoning_content" },
];

const discoveryApis = new Set(["openai-completions", "openai-responses"]);

function providerMap(document: ProvidersDocument | undefined): Record<string, ProviderNode> {
  const providers = document?.value.providers;
  return typeof providers === "object" && providers !== null ? providers as Record<string, ProviderNode> : {};
}

function rowsFromHeaders(headers: Record<string, string> | undefined): KeyValueRow[] {
  return Object.entries(headers ?? {}).map(([key, value]) => ({ key, value }));
}

function headersFromRows(rows: KeyValueRow[]): Record<string, string> {
  return Object.fromEntries(rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value]));
}

function savedProviderDraft(draft: ProviderNode, headers: KeyValueRow[]): ProviderNode {
  const next = { ...draft };
  const values = headersFromRows(headers);
  if (Object.keys(values).length > 0) next.headers = values;
  else delete next.headers;
  return next;
}

function comparableProvider(provider: ProviderNode): ProviderNode {
  const next = { ...provider };
  if (next.headers && Object.keys(next.headers).length === 0) {
    delete next.headers;
  }
  return next;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validProviderId(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(value);
}

function emptyModel(): ProviderEditorModel {
  return { id: "new-model", name: "新模型", reasoning: false, thinkingLevelMap: {}, compat: {}, input: ["text"], contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}

/** 将 Provider 编辑和排序的可恢复业务错误保留在当前表单中。 */
function providerExpected(reportError: (error: ApiClientError) => void): ApiTaskPolicy["expected"] {
  const show = reportError;
  return {
    VERSION_CONFLICT: show,
    PROVIDER_ID_EXISTS: show,
    PROVIDER_INVALID: show,
    PROVIDER_IN_USE: show,
    PROVIDER_NOT_FOUND: show,
    PROVIDER_RENAME_CONFIRMATION_REQUIRED: show,
    PROVIDER_RENAME_HISTORY_LIMIT: show,
    INVALID_PROVIDER_ID: show,
    INVALID_PROVIDER_ORDER: show,
    INVALID_PROVIDER_REQUEST: show,
    INVALID_PROVIDER_BASE_URL: show,
    MODEL_IN_USE: show,
    MODEL_SCHEMA_INVALID: show,
  };
}

/** 将 Provider 凭证的并发和校验错误保留在凭证编辑区。 */
function providerCredentialExpected(reportError: (error: ApiClientError) => void): ApiTaskPolicy["expected"] {
  const show = reportError;
  return { VERSION_CONFLICT: show, INVALID_CREDENTIAL: show, CREDENTIAL_NOT_FOUND: show };
}

/** 将模型发现和连接测试的可恢复状态保留在结果区域。 */
function providerDiscoveryExpected(reportError: (error: ApiClientError) => void): ApiTaskPolicy["expected"] {
  const show = reportError;
  return {
    MODEL_TEST_IN_PROGRESS: show,
    MODEL_DISCOVERY_IN_PROGRESS: show,
    MODEL_DISCOVERY_TIMEOUT: show,
    MODEL_DISCOVERY_FAILED: show,
    MODEL_RUNTIME_UNAVAILABLE: show,
    MODEL_NOT_FOUND: show,
    PROVIDER_NOT_FOUND: show,
    INVALID_MODEL_TEST_REQUEST: show,
  };
}

/**
 * 将来源 ID 插入目标 ID 前方，生成一份不修改原数组的新顺序。
 */
function moveId(ids: string[], sourceId: string, targetId: string): string[] {
  if (sourceId === targetId) return ids;
  const remaining = ids.filter((id) => id !== sourceId);
  const targetIndex = remaining.indexOf(targetId);
  return targetIndex < 0 ? ids : [...remaining.slice(0, targetIndex), sourceId, ...remaining.slice(targetIndex)];
}

/**
 * 规范化模型输入能力，确保 Pi 始终能接收文本消息。
 */
function modelInput(model: ProviderEditorModel | undefined): Array<"text" | "image"> {
  return model?.input?.includes("image") ? ["text", "image"] : ["text"];
}

/**
 * 以普通表单为主编辑 Provider、模型和只写凭证，高级 JSON 仅作为兜底。
 */
export function ProvidersPage() {
  const { runApiTask } = useApiTask();
  const toast = useErrorToast();
  const online = useOnlineStatus();
  const [document, setDocument] = useState<ProvidersDocument>();
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<ProviderNode>({});
  const [headers, setHeaders] = useState<KeyValueRow[]>([]);
  const [selectedModelIndex, setSelectedModelIndex] = useState(-1);
  const [apiKey, setApiKey] = useState("");
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [testResults, setTestResults] = useState<ModelConnectionTestItem[]>([]);
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([]);
  const [selectedDiscoveredIds, setSelectedDiscoveredIds] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<false | "saving" | "credential" | "test-current" | "test-all" | "discovering">(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [revealedKey, setRevealedKey] = useState("");
  const [advancedText, setAdvancedText] = useState<string>();
  const [draggingProviderId, setDraggingProviderId] = useState<string>();
  const [draggingModelId, setDraggingModelId] = useState<string>();

  const [tab, setTab] = useState<"connection" | "models" | "tests">("connection");
  const [search, setSearch] = useState("");
  const [modelMode, setModelMode] = useState<"new" | "edit">("edit");
  const [testModelId, setTestModelId] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<"provider" | "model" | "credential">();
  const taskLock = useRef(false);
  const [loading, setLoading] = useState(true);
  const [synchronized, setSynchronized] = useState(true);

  const providers = providerMap(document);
  const ids = Object.keys(providers);
  const selectedModel = draft.models?.[selectedModelIndex];
  const thinkingProtocol = thinkingProtocolOptions.find((option) => option.value === selectedModel?.compat?.thinkingFormat)?.value ?? "auto";
  const thinkingProtocolPreview = selectedModel && thinkingProtocol !== "auto"
    ? getThinkingProtocolPreview(thinkingProtocol, selectedModel)
    : undefined;
  const credential = document?.credentials.find((item) => item.providerId === selectedId);
  const providerDraft = useMemo(() => savedProviderDraft(draft, headers), [draft, headers]);
  const savedProvider = providers[selectedId];
  const isDirty = Boolean(savedProvider) && (stableJson(comparableProvider(savedProvider)) !== stableJson(comparableProvider(providerDraft)));
  const advancedJson = useMemo(() => JSON.stringify({ ...draft, headers: headersFromRows(headers) }, null, 2), [draft, headers]);
  const credentialDirty = Boolean(apiKey && apiKey !== revealedKey);
  const advancedDirty = advancedText !== undefined && advancedText !== advancedJson;
  const dirty = isDirty || credentialDirty || advancedDirty;
  const testDisabled = !online || !synchronized || busy !== false || dirty;
  const canTestCurrent = !testDisabled && Boolean(testModelId && savedProvider?.models?.some((model) => model.id === testModelId));
  const canTestAll = !testDisabled && (savedProvider?.models?.length ?? 0) > 0;
  const canDiscover = ids.includes(selectedId)
    && !dirty
    && online && synchronized
    && busy === false
    && Boolean(draft.baseUrl?.trim())
    && discoveryApis.has(draft.api ?? "");

  const guard = useUnsavedChanges({ dirty, busy: busy !== false || Boolean(deleteTarget) || renameOpen || createOpen,
    label: `Provider · ${savedProvider?.name || selectedId}`, save: saveAllChanges, canSave: online && synchronized });

  /** 服务端业务错误同时保留表单与统一弹窗，错误码和请求标识可追踪。 */
  function reportError(error: ApiClientError) {
    setError(error.message);
    toast.push(toUnexpectedErrorNotice(error, `配置 Provider · ${savedProvider?.name || selectedId}`));
  }

  /** 切换前分别保存 Provider 与凭证；任何一项失败都保留当前对象与剩余草稿。 */
  async function saveAllChanges(): Promise<boolean> {
    const key = credentialDirty ? apiKey : "";
    if ((isDirty || advancedDirty) && !await saveProvider()) return false;
    if (key && !await saveCredential(key)) { setApiKey(key); if (isDirty || advancedDirty) setNotice("连接与模型已保存；凭证尚未保存，输入已保留。"); return false; }
    return true;
  }

  function selectProvider(id: string, source = providers) {
    setError("");
    const node = structuredClone(source[id] ?? {});
    setSelectedId(id);
    setDraft(node);
    setHeaders(rowsFromHeaders(node.headers));
    setSelectedModelIndex(-1);
    setTab("connection");
    setTestModelId(node.models?.[0]?.id ?? "");
    setTestResults([]);
    setDiscoveredModels([]);
    setSelectedDiscoveredIds(new Set());
    setApiKey("");
    setRevealedKey("");
    setAdvancedText(undefined);
    setApiKeyVisible(false);
    setNotice("");
  }

  /**
   * 合并新建接口返回的模型配置，并立即进入新 Provider 的凭证设置区。
   */
  function acceptCreatedProvider(providerId: string, updated: ModelConfigDocument) {
    if (!document) return;
    const nextDocument: ProvidersDocument = {
      ...document,
      ...updated,
      credentials: document.credentials,
      credentialRevision: document.credentialRevision,
    };
    setDocument(nextDocument);
    selectProvider(providerId, providerMap(nextDocument));
    setCreateOpen(false);
    recordConfigurationSave("providers");
    setNotice("Provider 已创建，请继续配置 API Key");
  }

  useEffect(() => {
    let active = true;
    void runApiTask(api.listProviders, { operation: "加载 Provider 配置" }).then((result) => {
      if (active) setLoading(false);
      if (result.status !== "success") return;
      const loaded = result.data;
      if (!active) return;
      setDocument(loaded);
    });
    return () => { active = false; };
  }, [runApiTask]);

  function updateModel(patch: Partial<ProviderEditorModel>) {
    setDraft((current) => ({ ...current, models: (current.models ?? []).map((model, index) => index === selectedModelIndex ? { ...model, ...patch } : model) }));
  }

  /**
   * 根据图片开关更新当前模型的 Pi 输入能力声明。
   */
  function setImageInput(enabled: boolean) {
    updateModel({ input: enabled ? ["text", "image"] : ["text"] });
  }

  /**
   * 从表单值读取正整数；空值表示让 Pi 使用其默认值。
   */
  function updateModelCapacity(field: "contextWindow" | "maxTokens", value: string) {
    const parsed = Number(value);
    updateModel({ [field]: Number.isInteger(parsed) && parsed > 0 ? parsed : undefined });
  }

  /**
   * 更新当前模型的兼容配置；自动模式将字段交回 Pi 推断。
   */
  function updateCompatValue(key: string, value: string) {
    const compat = { ...(selectedModel?.compat ?? {}) };
    if (value === "auto") delete compat[key];
    else compat[key] = value === "on";
    updateModel({ compat });
  }

  /**
   * 更新当前模型的枚举兼容配置；自动模式移除原有覆盖值。
   */
  function updateCompatOption(key: "maxTokensField" | "thinkingFormat", value: string) {
    const compat = { ...(selectedModel?.compat ?? {}) };
    if (value === "auto") delete compat[key];
    else compat[key] = value;
    updateModel({ compat });
  }

  function compatBooleanValue(key: CompatBooleanKey): "auto" | "on" | "off" {
    const value = selectedModel?.compat?.[key];
    return value === true ? "on" : value === false ? "off" : "auto";
  }

  /**
   * 删除当前模型草稿或已保存模型，并保持 Provider 列表与 revision 同步。
   */
  async function deleteSelectedModel() {
    if (!document || !selectedId || !selectedModel || !online) return;
    const savedModels = savedProvider?.models ?? [];
    const saved = savedModels.some((model) => model.id === selectedModel.id);
    if (!saved) {
      setDraft((current) => ({ ...current, models: (current.models ?? []).filter((_, index) => index !== selectedModelIndex) }));
      setSelectedModelIndex(-1); setDeleteTarget(undefined);
      return;
    }
    if (dirty) {
      setError("请先保存连接、模型与凭证更改后再删除已保存模型。");
      return;
    }
    if (taskLock.current) return;
    taskLock.current = true; setBusy("saving");
    setError("");
    try {
      const result = await runApiTask(
        () => api.removeProviderModel(selectedId, selectedModel.id, document.revision),
        { operation: "删除 Provider 模型", expected: providerExpected(reportError) },
      );
      if (result.status !== "success") return;
      const updated = result.data;
      setDocument({ ...document, ...updated });
      const updatedProviders = providerMap({ ...document, ...updated });
      setDraft(structuredClone(updatedProviders[selectedId])); setSelectedModelIndex(-1); setDeleteTarget(undefined); setAdvancedText(undefined);
      setTestModelId(updatedProviders[selectedId].models?.[0]?.id ?? "");
      recordConfigurationSave("providers"); setNotice("模型已删除");
    } finally {
      taskLock.current = false; setBusy(false);
    }
  }

  async function saveProvider(): Promise<boolean> {
    if (!document || !selectedId || !savedProvider || !online || !synchronized || busy !== false || taskLock.current) return false;
    let nextProviderDraft = providerDraft;
    if (advancedText !== undefined) {
      try {
        nextProviderDraft = parseProviderJson(advancedText);
      } catch (error) { setError(`Provider 高级 JSON 校验未通过：${error instanceof Error ? error.message : "节点结构无效"}；输入已保留。`); return false; }
    }
    if (!validProviderId(selectedId)) {
      setError("Provider ID 只能使用字母、数字、点、下划线或连字符，且不能以符号开头或结尾。");
      return false;
    }
    const invalidCapacity = (nextProviderDraft.models ?? []).some((model) => model.contextWindow !== undefined
      && model.maxTokens !== undefined
      && model.contextWindow < model.maxTokens);
    if (invalidCapacity) {
      setError("上下文窗口不能小于最大返回 Token。");
      return false;
    }
    taskLock.current = true; setBusy("saving"); setError(""); setNotice("");
    try {
      const result = await runApiTask(
        () => api.saveProvider(selectedId, document.revision, nextProviderDraft),
        { operation: "保存 Provider", expected: providerExpected(reportError) },
      );
      if (result.status !== "success") return false;
      const updated = result.data;
      setDocument({ ...document, ...updated });
      const updatedProviders = providerMap({ ...document, ...updated });
      // 保存连接与模型不清除独立凭证草稿，也不切换当前管理页签。
      const node = structuredClone(updatedProviders[selectedId]);
      setDraft(node); setHeaders(rowsFromHeaders(node.headers)); setAdvancedText(undefined);
      setSelectedModelIndex(-1); setTestModelId(node.models?.[0]?.id ?? "");
      setDiscoveredModels([]);
      setSelectedDiscoveredIds(new Set());
      recordConfigurationSave("providers");
      setNotice("连接与模型已保存；API Key 需独立保存。");
      return true;
    } finally { taskLock.current = false; setBusy(false); }
  }

  async function saveCredential(key = apiKey): Promise<boolean> {
    if (!document || !selectedId || !key || !online || !synchronized || taskLock.current) return false;
    taskLock.current = true; setBusy("credential"); setError("");
    try {
      const task = await runApiTask(
        () => api.saveProviderCredential(selectedId, document.credentialRevision, key),
        { operation: "保存 Provider 凭证", expected: providerCredentialExpected(reportError) },
      );
      if (task.status !== "success") return false;
      const result = task.data;
      setDocument((current) => current ? { ...current, credentialRevision: result.credentialRevision, credentials: [...current.credentials.filter((item) => item.providerId !== selectedId), result.status] } : current);
      setApiKey(""); setApiKeyVisible(false); setRevealedKey(""); recordConfigurationSave("providers"); setNotice("凭证已替换，可点击小眼睛查看");
      return true;
    } finally { taskLock.current = false; setBusy(false); }
  }

  async function removeCredential() {
    if (!document || !selectedId || !online) return;
    if (taskLock.current) return;
    taskLock.current = true; setBusy("saving"); setError("");
    try {
      const task = await runApiTask(
        () => api.removeProviderCredential(selectedId, document.credentialRevision),
        { operation: "删除 Provider 凭证", expected: providerCredentialExpected(reportError) },
      );
      if (task.status !== "success") return;
      const result = task.data;
      setDocument({ ...document, credentialRevision: result.credentialRevision, credentials: document.credentials.filter((item) => item.providerId !== selectedId) });
      setApiKey("");
      setApiKeyVisible(false); setRevealedKey(""); setDeleteTarget(undefined);
      recordConfigurationSave("providers"); setNotice("凭证已删除");
    } finally {
      taskLock.current = false; setBusy(false);
    }
  }

  /** 按需读取已保存凭证，避免在配置摘要与缓存中保留明文。 */
  async function toggleApiKeyVisibility() {
    if (apiKeyVisible) {
      setApiKeyVisible(false);
      return;
    }
    if (credential?.configured && !apiKey) {
      if (taskLock.current) return;
      taskLock.current = true; setBusy("saving");
      try {
        const result = await runApiTask(() => api.getProviderCredential(selectedId),
          { operation: "读取 Provider API Key", expected: providerCredentialExpected(reportError) });
        if (result.status !== "success") return;
        setApiKey(result.data.apiKey); setRevealedKey(result.data.apiKey);
      } finally { taskLock.current = false; setBusy(false); }
    }
    setApiKeyVisible(true);
  }

  async function renameProvider(targetId: string) {
    if (!document || !savedProvider || !selectedId || !online || dirty) return;
    if (!validProviderId(targetId)) {
      setError("Provider ID 格式无效。");
      return;
    }
    if (taskLock.current) return;
    taskLock.current = true; setBusy("saving"); setError(""); setNotice("");
    try {
      const result = await runApiTask(
        () => api.renameProvider(selectedId, targetId, document.revision),
        { operation: "重命名 Provider", expected: providerExpected(reportError) },
      );
      if (result.status !== "success") return;
      const updated = result.data;
      // 改名同时迁移凭证，必须重读凭证 revision 后才能继续写入。
      const next = { ...document, ...updated, credentials: document.credentials.map((item) => item.providerId === selectedId ? { ...item, providerId: targetId } : item) };
      setDocument(next); selectProvider(targetId, providerMap(next)); setRenameOpen(false);
      setSynchronized(false); recordConfigurationSave("providers");
      const refreshed = await runApiTask(api.listProviders, { operation: "改名后同步 Provider 与凭证版本" });
      if (refreshed.status === "success") {
        setDocument(refreshed.data); selectProvider(targetId, providerMap(refreshed.data)); setSynchronized(true);
        setNotice("Provider 已改名，引用与凭证已迁移。");
      } else setNotice("Provider 已改名，但配置版本尚未重新同步。请重新加载后再修改。");
    } finally {
      taskLock.current = false; setBusy(false);
    }
  }

  async function discoverModels() {
    if (!selectedId || !canDiscover) return;
    if (taskLock.current) return;
    taskLock.current = true; setBusy("discovering"); setError(""); setNotice("");
    setDiscoveredModels([]); setSelectedDiscoveredIds(new Set());
    try {
      const task = await runApiTask(
        () => api.discoverProviderModels(selectedId),
        { operation: "发现 Provider 模型", expected: providerDiscoveryExpected(reportError) },
      );
      if (task.status !== "success") return;
      setDiscoveredModels(task.data.models);
      setSelectedDiscoveredIds(new Set(task.data.models.filter((model) => !model.exists).map((model) => model.id)));
      setNotice(`已发现 ${task.data.models.length} 个模型`);
    } finally {
      taskLock.current = false; setBusy(false);
    }
  }

  function toggleDiscoveredModel(modelId: string, checked: boolean) {
    setSelectedDiscoveredIds((current) => {
      const next = new Set(current);
      if (checked) next.add(modelId);
      else next.delete(modelId);
      return next;
    });
  }

  function importDiscoveredModels() {
    const existingIds = new Set((draft.models ?? []).map((model) => model.id));
    const imported = discoveredModels
      .filter((model) => !model.exists && selectedDiscoveredIds.has(model.id) && !existingIds.has(model.id))
      .map((model) => ({ ...emptyModel(), id: model.id, name: model.name }));
    if (imported.length === 0) return;
    setDraft((current) => ({ ...current, models: [...(current.models ?? []), ...imported] }));
    setSelectedModelIndex(-1);
    setDiscoveredModels([]);
    setSelectedDiscoveredIds(new Set());
    setNotice(`已导入 ${imported.length} 个模型草稿，请保存连接与模型`);
  }

  async function testConnection(request: ModelConnectionTestRequest) {
    if (!selectedId || testDisabled) return;
    if (taskLock.current) return;
    taskLock.current = true; setBusy(request.scope === "current" ? "test-current" : "test-all");
    setError("");
    setTestResults([]);
    try {
      const result = await runApiTask(
        () => api.testProvider(selectedId, request),
        { operation: "测试 Provider 连接", expected: providerDiscoveryExpected(reportError) },
      );
      if (result.status === "success") {
        setTestResults(result.data.results);
        // 测试接口可能以成功响应返回逐模型错误，仍需进入全局可观测链路。
        for (const item of result.data.results.filter((item) => !item.ok)) {
          toast.push(toUnexpectedErrorNotice(new Error(`${item.modelName}：${item.message ?? "连接测试未返回诊断消息"}（${item.errorCode ?? "MODEL_CONNECTION_TEST_FAILED"}）`), "Provider 模型连接测试"));
        }
      }
    } finally {
      taskLock.current = false; setBusy(false);
    }
  }

  /**
   * 保存 Provider 在 Pi models.json 中的原生键顺序。
   */
  async function moveProvider(targetId: string) {
    if (!document || !draggingProviderId || dirty || busy !== false || !online || search.trim() || taskLock.current) {
      if (dirty) setError("请先保存连接、模型与凭证修改后再排序。");
      return;
    }
    const nextIds = moveId(ids, draggingProviderId, targetId);
    if (nextIds === ids) return;
    setDraggingProviderId(undefined);
    taskLock.current = true; setBusy("saving"); setError("");
    try {
      const result = await runApiTask(
        () => api.reorderProviders(nextIds, document.revision),
        { operation: "保存 Provider 排序", expected: providerExpected(reportError) },
      );
      if (result.status !== "success") return;
      const updated = result.data;
      const nextDocument = { ...document, ...updated };
      setDocument(nextDocument);
      if (selectedId) setDraft(structuredClone(providerMap(nextDocument)[selectedId]));
      recordConfigurationSave("providers"); setNotice("Provider 排序已保存");
    } finally {
      taskLock.current = false; setBusy(false);
      setDraggingProviderId(undefined);
    }
  }

  /**
   * 保存当前 Provider 内模型在 Pi models.json 中的原生数组顺序。
   */
  async function moveModel(targetId: string) {
    if (!document || !selectedId || !draggingModelId || dirty || busy !== false || !online || taskLock.current) {
      if (dirty) setError("请先保存连接、模型与凭证修改后再排序。");
      return;
    }
    const modelIds = (draft.models ?? []).map((model) => model.id);
    const nextIds = moveId(modelIds, draggingModelId, targetId);
    if (nextIds === modelIds) return;
    setDraggingModelId(undefined);
    taskLock.current = true; setBusy("saving"); setError("");
    try {
      const result = await runApiTask(
        () => api.reorderProviderModels(selectedId, nextIds, document.revision),
        { operation: "保存模型排序", expected: providerExpected(reportError) },
      );
      if (result.status !== "success") return;
      const updated = result.data;
      const nextDocument = { ...document, ...updated };
      setDocument(nextDocument);
      if (selectedId) setDraft(structuredClone(providerMap(nextDocument)[selectedId]));
      recordConfigurationSave("providers"); setNotice("模型排序已保存");
    } finally {
      taskLock.current = false; setBusy(false);
      setDraggingModelId(undefined);
    }
  }


  /** 为新增模型分配未占用的草稿 ID，避免连续新增产生重复键。 */
  function addModel() {
    const ids = new Set((draft.models ?? []).map((model) => model.id));
    let suffix = 1;
    while (ids.has(`new-model-${suffix}`)) suffix += 1;
    setDraft((current) => ({ ...current, models: [...(current.models ?? []), { ...emptyModel(), id: `new-model-${suffix}` }] }));
    setSelectedModelIndex(draft.models?.length ?? 0); setModelMode("new");
  }

  /** 文件读取期间阻止关闭和切换，防止晚到的导入结果污染其他对象。 */
  async function importModelFile(file: File) {
    if (!online || taskLock.current) return;
    taskLock.current = true; setBusy("saving");
    try {
      const result = await runApiTask(async () => parseImportedModels(await file.text()), { operation: "读取并解析模型 JSON 文件" });
      if (result.status !== "success") return;
      setDraft((current) => ({ ...current, models: [...(current.models ?? []), ...result.data] }));
      setSelectedModelIndex(-1); setError(""); setNotice("已导入模型草稿，请保存连接与模型。");
    } finally { taskLock.current = false; setBusy(false); }
  }

  /** 关闭抽屉时只清除内存草稿与凭证，不修改持久化配置。 */
  function closeEditor() {
    setSelectedId(""); setDraft({}); setHeaders([]); setSelectedModelIndex(-1);
    setApiKey(""); setRevealedKey(""); setApiKeyVisible(false); setAdvancedText(undefined);
    setDeleteTarget(undefined); setRenameOpen(false); setError("");
  }

  /** 初始加载失败允许重试，不将加载失败伪装成空列表。 */
  async function reload() {
    setLoading(true);
    try {
      const result = await runApiTask(api.listProviders, { operation: "重新加载 Provider" });
      if (result.status === "success") { setDocument(result.data); setSynchronized(true); if (selectedId) selectProvider(selectedId, providerMap(result.data)); }
    } finally { setLoading(false); }
  }

  /** Provider 删除只移除连接与模型，独立凭证按服务端合同保留。 */
  async function removeProvider() {
    if (!document || !selectedId || !online || taskLock.current) return;
    taskLock.current = true; setBusy("saving"); setError("");
    try {
      const result = await runApiTask(() => api.removeProvider(selectedId, document.revision), { operation: "删除 Provider", expected: providerExpected(reportError) });
      if (result.status !== "success") return;
      setDocument((current) => current ? { ...current, ...result.data } : current);
      closeEditor(); recordConfigurationSave("providers"); setNotice("Provider 已删除，独立凭证保留。");
    } finally { taskLock.current = false; setBusy(false); }
  }

  /** 键盘上移与拖动使用相同排序合同，筛选列表不允许写入局部顺序。 */
  async function reorderProvider(id: string) {
    const index = ids.indexOf(id);
    if (!document || index < 1 || !online || taskLock.current || dirty || search.trim()) return;
    taskLock.current = true; setBusy("saving");
    try {
      const result = await runApiTask(() => api.reorderProviders(moveId(ids, id, ids[index - 1]), document.revision), { operation: "保存 Provider 排序", expected: providerExpected(reportError) });
      if (result.status === "success") { setDocument((current) => current ? { ...current, ...result.data } : current); recordConfigurationSave("providers"); }
    } finally { taskLock.current = false; setBusy(false); }
  }

  /** 模型排序即时保存；脏草稿不能因排序响应被覆盖。 */
  async function reorderModel(id: string, index: number) {
    if (!document || index < 1 || dirty || !online || taskLock.current) return;
    taskLock.current = true; setBusy("saving");
    try {
      const modelIds = (draft.models ?? []).map((model) => model.id);
      const result = await runApiTask(() => api.reorderProviderModels(selectedId, moveId(modelIds, id, modelIds[index - 1]), document.revision), { operation: "保存模型排序", expected: providerExpected(reportError) });
      if (result.status === "success") { const next = { ...document, ...result.data }; setDocument(next); setDraft(structuredClone(providerMap(next)[selectedId])); recordConfigurationSave("providers"); }
    } finally { taskLock.current = false; setBusy(false); }
  }

  const filteredIds = ids.filter((id) => `${providers[id].name ?? ""} ${id}`.toLowerCase().includes(search.trim().toLowerCase()));
  const writable = online && synchronized && busy === false;
  const modelDirty = Boolean(savedProvider) && stableJson(draft.models) !== stableJson(savedProvider.models);
  const deletionDescription = deleteTarget === "provider"
    ? `将删除“${savedProvider?.name || selectedId}”及其模型配置，独立 API Key 保留。Agent 默认模型引用会阻止删除，此操作不可撤销。${dirty ? "当前草稿将被丢弃。" : ""}`
    : deleteTarget === "credential" ? "仅删除当前 Provider 的独立 API Key，不删除连接与模型。认证请求可能无法继续，未保存的新 Key 也将清除。"
    : `将${savedProvider?.models?.some((model) => model.id === selectedModel?.id) ? "删除已保存模型" : "移除本地模型草稿"}“${selectedModel?.name || selectedModel?.id}”。已保存模型被 Agent 默认配置引用时不能删除。`;
  return <>
    <main className="configuration-page providers-page configuration-quick-wins-page" inert={Boolean(selectedId) || createOpen || undefined} aria-hidden={Boolean(selectedId) || createOpen || undefined}>
      <header className="configuration-page__heading configuration-page__heading--actions"><div><span className="configuration-eyebrow">MODEL RUNTIME</span><h1>模型与凭证</h1><p>整理服务连接、模型能力与 API Key，明确每次保存的范围。</p></div><Button variant="primary" type="button" data-provider-create className="configuration-primary-action" disabled={!writable || !document} onClick={() => guard.request(() => { closeEditor(); setCreateOpen(true); })}><Plus size={16} />新建 Provider</Button></header>
      {!selectedId && error ? <p className="configuration-inline-error" role="alert">{error}</p> : null}
      {!selectedId && notice ? <p className="configuration-save-notice" role="status"><Check size={14} />{notice}</p> : null}
      <ConfigurationEffectNotice configKey="providers" dirty={dirty} />
      <section className="provider-summary-list" aria-labelledby="provider-list-title" aria-busy={loading}><div className="provider-list-heading"><h2 id="provider-list-title">Provider <small>{document ? `${ids.length} 项` : "尚未加载"}</small></h2><SearchField label="搜索 Provider" placeholder="搜索名称或 ID" value={search} onChange={setSearch} /></div>
        {filteredIds.map((id, index) => <article key={id} className="provider-summary" draggable={writable && !search.trim()} onDragStart={() => setDraggingProviderId(id)} onDragEnd={() => setDraggingProviderId(undefined)} onDragOver={(event) => event.preventDefault()} onDrop={() => void moveProvider(id)}><div><h3>{providers[id].name || id}</h3><code>{id}</code><dl><div><dt>协议</dt><dd>{providers[id].api ?? "自动"}</dd></div><div><dt>模型</dt><dd>{providers[id].models?.length ?? 0}</dd></div><div><dt>API Key</dt><dd>{document?.credentials.some((item) => item.providerId === id && item.configured) ? "已配置" : "未配置"}</dd></div></dl><small>{providerAddressSummary(providers[id].baseUrl)}</small></div><div className="configuration-button-row"><Button type="button" className="configuration-secondary-action" aria-label={`向上移动 Provider ${providers[id].name || id}`} disabled={!writable || Boolean(search.trim()) || index === 0} onClick={() => void reorderProvider(id)}>上移</Button><Button type="button" className="configuration-secondary-action" aria-label={`管理 Provider ${providers[id].name || id}`} disabled={!document || busy !== false} onClick={() => selectProvider(id)}>管理</Button></div></article>)}
        {!synchronized ? <Button type="button" className="configuration-secondary-action" disabled={!online || loading || busy !== false} onClick={() => void reload()}>重新加载 Provider 与凭证版本</Button> : null}
        {loading ? <p className="configuration-help">正在加载 Provider…</p> : document && !filteredIds.length ? <div className="provider-empty"><h3>{ids.length ? "没有匹配的 Provider" : "尚未创建 Provider"}</h3><p className="configuration-help">{ids.length ? "试试其他名称或 ID。" : "使用右上角新建 Provider，创建后再配置凭证和模型。"}</p></div> : !document ? <Button type="button" className="configuration-secondary-action" onClick={() => void reload()}>重新加载 Provider</Button> : null}
      </section><p className="configuration-help">配置摘要不代表连接成功或 Agent 授权。{search.trim() ? "筛选时不能调整顺序。" : "可拖动或使用上移按钮调整顺序。"}</p>
    </main>
    {selectedId && savedProvider ? <ConfigurationEditorDialog variant="drawer" classPrefix="provider" closeLabel="关闭 Provider 管理" returnFocusSelector="[data-provider-create]" title={`管理 Provider · ${savedProvider.name || selectedId}`} description={`${selectedId} · 连接和模型共用保存，API Key 独立保存。`} busy={busy !== false} suspended={guard.pending || Boolean(deleteTarget) || renameOpen} onClose={() => guard.request(closeEditor)} footer={<><span className="configuration-editing-state">{isDirty || advancedDirty ? "连接与模型未保存" : "连接与模型无修改"} · {credentialDirty ? "凭证未保存" : "凭证无修改"}</span><div><Button type="button" className="configuration-secondary-action" disabled={busy !== false} onClick={() => guard.request(closeEditor)}>关闭</Button><Button variant="primary" type="button" className="configuration-primary-action" disabled={!writable || !(isDirty || advancedDirty)} onClick={() => void saveProvider()}><Save size={16} />保存连接与模型</Button></div></>}>
      <Tabs className="provider-tabs" label="Provider 管理分区" tabIdPrefix="provider-tab"
        panelId={(id) => `provider-panel-${id}`} value={tab} onChange={setTab}
        items={[{ id: "connection", label: "连接与凭证" }, { id: "models", label: "模型管理" }, { id: "tests", label: "连接测试" }]} />
      <fieldset className="configuration-interaction-fields" disabled={busy !== false || !online || !synchronized}>
        <section id="provider-panel-connection" role="tabpanel" aria-labelledby="provider-tab-connection" hidden={tab !== "connection"}>
          <div className="configuration-form-card provider-form">
            <div className="configuration-section__heading"><div><span>01</span><h3>连接参数</h3></div><small>{savedProvider ? selectedId : "未保存"}</small></div>
            <label><span>显示名称</span><TextField value={draft.name ?? ""} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
            <label><span>Base URL</span><TextField value={draft.baseUrl ?? ""} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} /></label>
            <label><span>API 协议</span><SearchSelect
              ariaLabel="API 协议"
              value={draft.api ?? "openai-completions"}
              onChange={(next) => setDraft({ ...draft, api: next })}
              options={[
                { value: "openai-completions", label: "OpenAI Completions" },
                { value: "openai-responses", label: "OpenAI Responses" },
                { value: "anthropic-messages", label: "Anthropic Messages" },
                { value: "google-generative-ai", label: "Google Generative AI" },
              ]}
            /></label>
            <label><span>认证 Header</span><Checkbox checked={draft.authHeader !== false} onChange={(event) => setDraft({ ...draft, authHeader: event.target.checked })} /></label>
            <details className="provider-advanced"><summary>高级连接 Headers</summary><KeyValueEditor keyPlaceholder="Header 名称" emptyLabel="没有自定义 Header。" label="Headers" rows={headers} onChange={setHeaders} /></details>
            <section className="provider-credential"><h3>独立凭证</h3><p className="configuration-help">只保存 API Key；留空不替换。连接参数和模型使用底部保存按钮。</p><label><span>API Key<small>留空不会修改现有凭证</small></span><SecretInput aria-label="API Key" autoComplete="new-password" value={apiKey} visible={apiKeyVisible} onVisibilityChange={() => void toggleApiKeyVisibility()} onChange={(event) => setApiKey(event.target.value)} placeholder={credential ? "输入新 Key 以替换" : "输入 API Key"} /></label>
            <div className="configuration-button-row"><Button type="button" loading={busy === "credential"} disabled={!savedProvider || !credentialDirty || busy !== false || !online} onClick={() => void saveCredential()}>保存凭证</Button>{credential ? <Button type="button" variant="danger" disabled={!online || busy !== false} onClick={() => { setError(""); setDeleteTarget("credential"); }}>删除凭证</Button> : null}<small>{savedProvider ? (credential ? "已配置 · 点击小眼睛查看" : "未配置") : "请先创建 Provider"}</small></div>
            </section>
          </div>
          <details className="provider-advanced"><summary>高级 JSON</summary><p>仅编辑当前 Provider 节点；离开编辑框时解析，并仍由核心配置结构校验。</p><Textarea key={`${selectedId}-${document?.revision}`} aria-label="Provider 高级 JSON" rows={14} value={advancedText ?? advancedJson} onChange={(event) => setAdvancedText(event.target.value)} onBlur={() => { if (advancedText === undefined) return; try { const parsed = parseProviderJson(advancedText); setDraft(parsed); setHeaders(rowsFromHeaders(parsed.headers)); setAdvancedText(undefined); setError(""); } catch (error) { setError(`Provider 高级 JSON 校验未通过：${error instanceof Error ? error.message : "节点结构无效"}；尚未应用。`); } }} /></details>
          <section className="provider-danger-zone"><div><h3>Provider 管理</h3><p className="configuration-help">改名迁移引用；删除 Provider 保留独立凭证。改名前需保存所有草稿。</p></div><div className="configuration-button-row"><Button type="button" className="configuration-secondary-action" disabled={!writable || dirty} onClick={() => setRenameOpen(true)}><PencilLine size={15} />重命名</Button><Button variant="danger" type="button" className="configuration-secondary-action configuration-secondary-action--danger" disabled={!writable} onClick={() => { setError(""); setDeleteTarget("provider"); }}><Trash2 size={16} />删除 Provider</Button></div></section>
        </section>
        <section id="provider-panel-models" role="tabpanel" aria-labelledby="provider-tab-models" hidden={tab !== "models"}>
          <div className="configuration-form-card provider-form">
            <div className="configuration-section__heading"><div><span>02</span><h3>模型目录</h3></div><div className="provider-model-actions"><Button type="button" loading={busy === "discovering"} disabled={!canDiscover} title={dirty ? "请先保存连接、模型与凭证后发现模型" : undefined} onClick={() => void discoverModels()}>发现模型</Button><Button type="button" disabled={busy !== false} onClick={addModel}><Plus size={14} aria-hidden="true" />新增模型</Button></div></div>
            {dirty && selectedId ? <p className="configuration-help">请先保存连接、模型与凭证后发现模型。</p> : null}
            {!draft.baseUrl?.trim() ? <p className="configuration-help">填写并保存 Base URL 后可发现模型。</p> : null}
            {draft.api && !discoveryApis.has(draft.api) ? <p className="configuration-help">当前协议不支持模型发现。</p> : null}
            {discoveredModels.length ? <fieldset className="provider-discovery-list" aria-label="发现的模型"><legend>发现的模型</legend>{discoveredModels.map((model) => <label className="provider-discovery-row" key={model.id}><Checkbox aria-label={`选择 ${model.id}`} checked={selectedDiscoveredIds.has(model.id)} disabled={model.exists || busy !== false} onChange={(event) => toggleDiscoveredModel(model.id, event.target.checked)} /><span>{model.name}</span><small>{model.exists ? "已存在" : "待导入"}</small></label>)}<Button type="button" disabled={busy !== false || ![...selectedDiscoveredIds].some((id) => discoveredModels.some((model) => model.id === id && !model.exists))} onClick={importDiscoveredModels}>导入所选模型</Button></fieldset> : null}
            {selectedModelIndex < 0 ? <div className="provider-model-list">{draft.models?.map((model, index) => <article className="provider-model-row" key={`${model.id}-${index}`} draggable={!dirty && busy === false && online} onDragStart={() => setDraggingModelId(model.id)} onDragEnd={() => setDraggingModelId(undefined)} onDragOver={(event) => event.preventDefault()} onDrop={() => void moveModel(model.id)}><div><strong>{model.name || model.id}</strong><code>{model.id}</code><p>{modelInput(model).includes("image") ? "文本 + 图片" : "文本"} · {model.reasoning ? "推理模型" : "普通模型"} · 上下文 {model.contextWindow ?? "默认"}</p><small>{savedProvider?.models?.some((item) => item.id === model.id) ? stableJson(savedProvider.models.find((item) => item.id === model.id)) === stableJson(model) ? "已保存" : "有修改" : "新增草稿"}</small></div><div className="configuration-button-row"><Button type="button" aria-label={`向上移动模型 ${model.name || model.id}`} disabled={index === 0 || dirty || busy !== false || !online} onClick={() => void reorderModel(model.id, index)}>上移</Button><Button type="button" aria-label={`编辑模型 ${model.name || model.id}`} disabled={busy !== false} onClick={() => { setSelectedModelIndex(index); setModelMode("edit"); }}>编辑</Button></div></article>)}</div> : <div className="provider-model-edit-heading"><h3>{modelMode === "new" ? "新增模型" : `编辑模型 · ${selectedModel?.name || selectedModel?.id}`}</h3><Button type="button" className="configuration-secondary-action" onClick={() => setSelectedModelIndex(-1)}>完成编辑</Button><p className="configuration-help">完成编辑只返回目录，修改仍需保存连接与模型。</p></div>}

            {selectedModel ? <div className="model-editor-fields"><label><span>模型 ID</span><TextField value={selectedModel.id} onChange={(event) => updateModel({ id: event.target.value })} /></label><label><span>显示名称</span><TextField value={selectedModel.name ?? ""} onChange={(event) => updateModel({ name: event.target.value })} /></label><fieldset className="model-input-capabilities"><legend>输入能力</legend><div><label><Checkbox aria-label="文本输入" checked disabled /><span>文本输入</span></label><label><Checkbox aria-label="图片输入" checked={modelInput(selectedModel).includes("image")} onChange={(event) => setImageInput(event.target.checked)} /><span>图片输入</span></label></div><small>该设置声明模型可接受图片输入；实际视觉能力仍由 Provider 和远端模型决定。</small></fieldset><label><span>上下文窗口</span><NumberField aria-label="上下文窗口" min="1" step="1" value={selectedModel.contextWindow ?? ""} onChange={(event) => updateModelCapacity("contextWindow", event.target.value)} /></label><label><span>最大返回 Token</span><NumberField aria-label="最大返回 Token" min="1" step="1" value={selectedModel.maxTokens ?? ""} onChange={(event) => updateModelCapacity("maxTokens", event.target.value)} /></label><label><span>推理模型</span><Checkbox aria-label="推理模型" checked={selectedModel.reasoning} onChange={(event) => updateModel({ reasoning: event.target.checked })} /></label>{selectedModel.reasoning ? <section className="thinking-protocol" aria-labelledby="thinking-protocol-title"><label><span id="thinking-protocol-title">思考协议<small>决定 Pi 如何开启或关闭该模型的思考能力。</small></span><SearchSelect
              ariaLabel="思考协议"
              value={thinkingProtocol}
              onChange={(next) => updateCompatOption("thinkingFormat", next)}
              options={thinkingProtocolOptions.map((option) => ({ value: option.value, label: option.label }))}
            /></label>{thinkingProtocolPreview ? <section className="thinking-protocol-preview" aria-label="思考协议请求参数预览">{([{ title: "开启思考", item: thinkingProtocolPreview.enabled }, { title: "关闭思考", item: thinkingProtocolPreview.disabled }]).map(({ title, item }) => <section key={title} className="thinking-protocol-preview__item"><strong>{title}</strong>{item.json ? <pre><code>{JSON.stringify(item.json, null, 2)}</code></pre> : <p>{item.note}</p>}</section>)}</section> : <p className="configuration-help">由 Pi 根据 Provider 和地址推断，不追加固定思考参数。</p>}</section> : null}<ThinkingLevelMapEditor value={selectedModel.thinkingLevelMap ?? {}} onChange={(thinkingLevelMap) => updateModel({ thinkingLevelMap })} /><details className="provider-advanced"><summary>兼容性</summary><p>自动会由核心根据 Provider 和 URL 推断；仅在模型服务不兼容时覆盖。</p><div className="model-editor-fields">{compatBooleanFields.map((field) => <label key={field.key}><span>{field.label}{field.help ? <small>{field.help}</small> : null}</span><SearchSelect
              ariaLabel={field.label}
              value={compatBooleanValue(field.key)}
              onChange={(next) => updateCompatValue(field.key, next)}
              options={[
                { value: "auto", label: "自动" },
                { value: "on", label: "开启" },
                { value: "off", label: "关闭" },
              ]}
            /></label>)}<label><span>最大 Token 字段</span><SearchSelect
              ariaLabel="最大 Token 字段"
              value={typeof selectedModel.compat?.maxTokensField === "string" ? selectedModel.compat.maxTokensField : "auto"}
              onChange={(next) => updateCompatOption("maxTokensField", next)}
              options={[
                { value: "auto", label: "自动" },
                { value: "max_tokens", label: "max_tokens" },
                { value: "max_completion_tokens", label: "max_completion_tokens" },
              ]}
            /></label></div></details><Button type="button" variant="danger" disabled={busy !== false || (Boolean(savedProvider?.models?.some((model) => model.id === selectedModel.id)) && dirty)} onClick={() => { setError(""); setDeleteTarget("model"); }}><Trash2 size={14} aria-hidden="true" />删除模型</Button></div> : !draft.models?.length ? <p className="configuration-help">尚未配置模型，请新增或发现并导入模型。</p> : null}
            <label className="provider-import"><span>批量导入模型 JSON<small>接受模型对象数组，导入后仍可逐项审阅</small></span><input type="file" accept="application/json" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importModelFile(file); }} /></label>
          </div>
        </section><section id="provider-panel-tests" role="tabpanel" aria-labelledby="provider-tab-tests" hidden={tab !== "tests"}><div className="configuration-form-card provider-form"><h3>连接测试</h3><p className="configuration-help">使用已保存的连接、模型与凭证，结果仅表示本次测试。测试不会替代核心配置生效确认。</p><label><span>已保存模型</span><SearchSelect
          ariaLabel="连接测试模型"
          value={testModelId}
          onChange={(next) => setTestModelId(next)}
          options={(savedProvider?.models?.map((model) => ({ value: model.id, label: model.name || model.id })) ?? [])}
        /></label><div className="configuration-button-row"><Button type="button" loading={busy === "test-current"} disabled={!canTestCurrent} onClick={() => void testConnection({ scope: "current", modelId: testModelId })}><TestTube2 size={14} />测试所选模型</Button><Button type="button" loading={busy === "test-all"} disabled={!canTestAll} onClick={() => void testConnection({ scope: "all" })}><TestTube2 size={14} />测试全部模型</Button></div>{dirty ? <p className="configuration-help">请先保存连接、模型与凭证的修改，再测试。</p> : null}{testResults.length ? <ol className="connection-logs">{testResults.map((result) => <li key={result.modelId}>{result.modelName}：{result.ok ? `成功 · ${result.durationMs} ms${result.responsePreview ? ` · ${result.responsePreview}` : ""}` : `失败 · ${result.durationMs} ms · ${result.message ?? `连接测试未返回诊断消息（${result.errorCode ?? "NO_ERROR_CODE"}）`}`}</li>)}</ol> : null}</div></section>
      </fieldset>
      {!synchronized ? <Button type="button" className="configuration-secondary-action" disabled={!online || loading || busy !== false} onClick={() => void reload()}>重新加载 Provider 与凭证版本</Button> : null}
      <ConfigurationEffectNotice configKey="providers" dirty={dirty} />
      {error ? <p className="configuration-inline-error" role="alert">{error}</p> : null}
      {notice ? <p className="configuration-save-notice" role="status"><Check size={14} />{notice}</p> : null}
    </ConfigurationEditorDialog> : null}
    {createOpen && document ? <ProviderCreateDialog revision={document.revision} online={online} onCreated={acceptCreatedProvider} onClose={() => setCreateOpen(false)} /> : null}
    {renameOpen && selectedId && savedProvider ? <ProviderRenameDialog currentId={selectedId} busy={busy === "saving"} error={error} onCancel={() => setRenameOpen(false)} onConfirm={(targetId) => void renameProvider(targetId)} /> : null}
    {deleteTarget ? <ConfigurationEditorDialog variant="confirmation" classPrefix="provider" returnFocusSelector="[data-provider-create]" title={deleteTarget === "provider" ? "删除 Provider？" : deleteTarget === "credential" ? "删除凭证？" : "删除模型？"} description={deletionDescription} busy={busy !== false} onClose={() => setDeleteTarget(undefined)} footer={<><Button type="button" className="configuration-secondary-action" disabled={busy !== false} onClick={() => setDeleteTarget(undefined)}>取消</Button><Button variant="danger" type="button" className="configuration-secondary-action configuration-secondary-action--danger" disabled={!writable} onClick={() => void (deleteTarget === "provider" ? removeProvider() : deleteTarget === "credential" ? removeCredential() : deleteSelectedModel())}>确认删除</Button></>}>{error ? <p className="configuration-inline-error" role="alert">{error}</p> : null}</ConfigurationEditorDialog> : null}
    {guard.dialog}
  </>;
}

/** 批量模型导入必须保留原始字段，同时拒绝非数组或无标识的节点。 */
function parseImportedModels(text: string): ProviderEditorModel[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.some((item) => !validEditorModel(item))) {
    throw new Error("模型 JSON 必须是包含有效模型 ID 的对象数组");
  }
  return parsed as ProviderEditorModel[];
}

/** 列表地址摘要不展示内嵌认证、查询参数或片段，防止敏感连接字段进入摘要。 */
function providerAddressSummary(value: string | undefined): string {
  if (!value) return "未设置地址";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "地址格式待校验";
    return `${url.origin}${url.pathname}`;
  } catch { return "地址格式待校验"; }
}

/** 未完成服务端结构校验前，先保障模型字段可被表单安全读取。 */
function validEditorModel(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const model = value as Record<string, unknown>;
  return typeof model.id === "string" && Boolean(model.id.trim())
    && (model.name === undefined || typeof model.name === "string")
    && (model.input === undefined || Array.isArray(model.input) && model.input.every((item) => item === "text" || item === "image"))
    && (model.reasoning === undefined || typeof model.reasoning === "boolean")
    && ["compat", "thinkingLevelMap"].every((key) => model[key] === undefined || model[key] !== null && typeof model[key] === "object" && !Array.isArray(model[key]));
}

/** 高级 JSON 无效时保留原表单，避免将不可渲染的节点写入 React 状态。 */
function parseProviderJson(text: string): ProviderNode {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Provider 节点必须是 JSON 对象");
  const provider = parsed as ProviderNode;
  if (["name", "baseUrl", "api"].some((key) => provider[key] !== undefined && typeof provider[key] !== "string")
    || provider.models !== undefined && (!Array.isArray(provider.models) || provider.models.some((model) => !validEditorModel(model)))) {
    throw new Error("Provider 的名称、地址、协议或模型字段结构无效");
  }
  return provider;
}
