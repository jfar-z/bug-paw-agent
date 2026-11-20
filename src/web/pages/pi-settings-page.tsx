import { Tabs } from "../ui/tabs";
import { Button, TextField, Textarea, NumberField } from "../ui/controls";
import { Checkbox } from "../ui/choice";
import { SearchSelect } from "../ui/search-select";
import { Check, Save, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentProfileDocument } from "../../shared/agent-contracts";
import type { ScopedConfigDocument, WebPiSettings } from "../../shared/configuration-contracts";
import { api, ApiClientError, type ModelSummary } from "../api";
import { useApiTask, type ApiTaskPolicy } from "../api-task-provider";
import type { ConfigurationDifference } from "../components/configuration/conflict-dialog";
import { useErrorToast } from "../error-toast-provider";
import { toUnexpectedErrorNotice } from "../api-error-policy";
import { navigateTo } from "../router";
import { ConfigurationEditorDialog } from "../components/configuration/configuration-editor-dialog";
import { Section } from "../ui/section";
import { useOnlineStatus } from "../use-online-status";
import { useUnsavedChanges } from "../ui/unsaved-changes";
import { ConfigurationEffectNotice, recordConfigurationSave } from "../components/configuration/configuration-effect-notice";
import "../configuration.css";
import "../pi-settings.css";

type FieldKind = "text" | "number" | "boolean" | "select" | "csv" | "json";
interface SettingField {
  path: string;
  label: string;
  kind: FieldKind;
  options?: string[];
  unit?: string;
  risk?: string;
  globalOnly?: boolean;
}
interface SettingGroup { category: SettingsCategory; title: string; description: string; fields: SettingField[] }

/** 页面内分区只改变展示，全部分区共享同一份作用域草稿。 */
const categories = [
  { id: "common", label: "常用设置" },
  { id: "policy", label: "执行策略" },
  { id: "advanced", label: "高级设置" },
] as const;
type SettingsCategory = typeof categories[number]["id"];

const groups: SettingGroup[] = [
  { category: "common", title: "模型与推理", description: "默认模型和思考策略", fields: [
    { path: "defaultThinkingLevel", label: "默认思考等级", kind: "select", options: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
    { path: "hideThinkingBlock", label: "隐藏思考块", kind: "boolean" },
  ] },
  { category: "policy", title: "压缩", description: "上下文压缩与分支摘要", fields: [
    { path: "compaction.enabled", label: "启用压缩", kind: "boolean" }, { path: "compaction.reserveTokens", label: "压缩保留 Token", kind: "number", unit: "tokens" },
    { path: "compaction.keepRecentTokens", label: "保留最近 Token", kind: "number", unit: "tokens" }, { path: "branchSummary.reserveTokens", label: "分支摘要保留 Token", kind: "number", unit: "tokens" },
  ] },
  { category: "policy", title: "重试", description: "失败恢复和 Provider 超时", fields: [
    { path: "retry.enabled", label: "启用重试", kind: "boolean" }, { path: "retry.maxRetries", label: "最大重试次数", kind: "number", unit: "次" },
    { path: "retry.baseDelayMs", label: "基础退避", kind: "number", unit: "ms" }, { path: "retry.provider.timeoutMs", label: "Provider 超时", kind: "number", unit: "ms" },
    { path: "retry.provider.maxRetries", label: "Provider 最大重试", kind: "number", unit: "次" }, { path: "retry.provider.maxRetryDelayMs", label: "Provider 最大退避", kind: "number", unit: "ms" },
  ] },
  { category: "policy", title: "消息传输", description: "流式通道和队列行为", fields: [
    { path: "transport", label: "传输方式", kind: "select", options: ["auto", "sse", "websocket", "websocket-cached"] },
    { path: "steeringMode", label: "引导消息模式", kind: "select", options: ["all", "one-at-a-time"] }, { path: "followUpMode", label: "后续消息模式", kind: "select", options: ["all", "one-at-a-time"] },
    { path: "httpIdleTimeoutMs", label: "HTTP 空闲超时", kind: "number", unit: "ms" }, { path: "websocketConnectTimeoutMs", label: "WebSocket 连接超时", kind: "number", unit: "ms" },
  ] },
  { category: "common", title: "图片", description: "输入图片处理", fields: [
    { path: "images.autoResize", label: "自动缩放图片", kind: "boolean" }, { path: "images.blockImages", label: "阻止图片输入", kind: "boolean" },
  ] },
  { category: "advanced", title: "Shell 与网络", description: "高风险运行环境选项", fields: [
    { path: "shellPath", label: "Shell 路径", kind: "text", risk: "改变 Agent 执行命令所用的 Shell。" },
    { path: "shellCommandPrefix", label: "Shell 命令前缀", kind: "text", risk: "会添加到每条 Shell 命令前，请确认内容可信。" },
    { path: "npmCommand", label: "npm 命令", kind: "csv", risk: "以逗号分隔命令及参数。" },
    { path: "httpProxy", label: "HTTP 代理", kind: "text", globalOnly: true, risk: "仅全局可改，会影响模型网络请求。" },
  ] },
  { category: "advanced", title: "资源路径", description: "Packages、Skills 与扩展来源", fields: [
    { path: "packages", label: "Packages", kind: "json", risk: "JSON 数组保留字符串及结构化资源对象。" }, { path: "extensions", label: "Extensions", kind: "csv" }, { path: "skills", label: "Skills", kind: "csv" }, { path: "prompts", label: "Prompts", kind: "csv" },
  ] },
];

type SettingsRecord = Record<string, unknown>;

/**
 * 默认模型配置必须同时包含 Provider 与模型标识，避免形成无效组合。
 */
interface DefaultModelChoice {
  provider: string;
  model: string;
}

function getPath(source: unknown, path: string): unknown {
  let current = source;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as SettingsRecord)[segment];
  }
  return current;
}

function setPath(source: SettingsRecord, path: string, value: unknown): SettingsRecord {
  const next = structuredClone(source);
  const parts = path.split(".");
  let current = next;
  for (const part of parts.slice(0, -1)) {
    if (typeof current[part] !== "object" || current[part] === null || Array.isArray(current[part])) current[part] = {};
    current = current[part] as SettingsRecord;
  }
  current[parts.at(-1)!] = value;
  return next;
}

function deletePath(source: SettingsRecord, path: string): SettingsRecord {
  const next = structuredClone(source);
  const parts = path.split(".");
  const stack: Array<[SettingsRecord, string]> = [];
  let current = next;
  for (const part of parts.slice(0, -1)) {
    if (typeof current[part] !== "object" || current[part] === null) return next;
    stack.push([current, part]); current = current[part] as SettingsRecord;
  }
  delete current[parts.at(-1)!];
  for (const [parent, key] of stack.reverse()) if (Object.keys(parent[key] as SettingsRecord).length === 0) delete parent[key];
  return next;
}

function displayValue(value: unknown, kind: FieldKind): string | number {
  if (kind === "csv") return Array.isArray(value) ? value.map(String).join(", ") : "";
  if (kind === "number") return typeof value === "number" ? value : "";
  return typeof value === "string" ? value : "";
}

function inheritedLabel(value: unknown): string {
  if (value === undefined) return "核心默认值（未声明具体值）";
  if (typeof value === "boolean") return value ? "开启" : "关闭";
  if (Array.isArray(value)) return value.map((item) => typeof item === "object" ? JSON.stringify(item) : String(item)).join(", ") || "空列表";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * 从配置对象中读取完整的默认模型组合。
 */
function readDefaultModelChoice(source: unknown): DefaultModelChoice | undefined {
  const provider = getPath(source, "defaultProvider");
  const model = getPath(source, "defaultModel");
  return typeof provider === "string" && typeof model === "string" && provider && model ? { provider, model } : undefined;
}

/**
 * 生成不会受 Provider 或模型标识中分隔符影响的下拉选项值。
 */
function defaultModelChoiceKey(choice: DefaultModelChoice): string {
  return JSON.stringify([choice.provider, choice.model]);
}

/**
 * 解析页面下拉框提交的默认模型组合。
 */
function parseDefaultModelChoice(value: string): DefaultModelChoice | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string") return { provider: parsed[0], model: parsed[1] };
  } catch {
    // 下拉框值来自受控选项，解析失败时按未选择处理，避免写入错误配置。
  }
  return undefined;
}

/**
 * 将已保存但尚未被发现的模型保留在选项中，防止保存其他设置时丢失历史配置。
 */
function defaultModelOptions(models: ModelSummary[], current: DefaultModelChoice | undefined): ModelSummary[] {
  if (!current || models.some((model) => model.provider === current.provider && model.id === current.model)) return models;
  return [{ provider: current.provider, id: current.model, name: `${current.model}（当前配置，未发现）` }, ...models];
}

/** 将运行设置的可恢复校验错误保留在当前表单。 */
function settingsExpected(setError: (message: string) => void): ApiTaskPolicy["expected"] {
  const show = (error: { message: string }) => setError(error.message);
  return {
    INVALID_SETTINGS_REQUEST: show,
    SETTINGS_INVALID: show,
    GLOBAL_ONLY_SETTING: show,
    INVALID_SETTING_TYPE: show,
    SETTING_OUT_OF_RANGE: show,
    UNKNOWN_SETTING: show,
  };
}

/** 按作用域及使用频率组织运行设置，分别展示草稿、声明来源和保存生效结果。 */
export function PiSettingsPage() {
  const { runApiTask } = useApiTask();
  const toast = useErrorToast();
  // 应用主题或在线状态变化会更新任务函数；读取只由目标和显式重试触发，避免重置草稿。
  const readTask = useRef(runApiTask);
  readTask.current = runApiTask;
  const online = useOnlineStatus();
  const [category, setCategory] = useState<SettingsCategory>("common");
  const [rawInputs, setRawInputs] = useState<Record<string, string>>({});
  const [directoryState, setDirectoryState] = useState<"loading" | "ready" | "error">("loading");
  const [modelState, setModelState] = useState<"loading" | "ready" | "error">("loading");
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [directoryReload, setDirectoryReload] = useState(0);
  const [modelReload, setModelReload] = useState(0);
  const [settingsReload, setSettingsReload] = useState(0);
  const submitLock = useRef(false);
  const [scope, setScope] = useState<"global" | "agent">("global");
  const [agents, setAgents] = useState<AgentProfileDocument[]>([]);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [agentId, setAgentId] = useState("");
  const [document, setDocument] = useState<ScopedConfigDocument<WebPiSettings>>();
  const [draft, setDraft] = useState<SettingsRecord>({});
  const [inherit, setInherit] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<{ latest: ScopedConfigDocument<WebPiSettings>; differences: ConfigurationDifference[] }>();

  const rawChanged = (path: string): boolean => {
    if (rawInputs[path] === undefined) return false;
    const field = groups.flatMap((group) => group.fields).find((item) => item.path === path);
    const own = getPath(document?.own, path);
    if (field?.kind === "number") return !rawInputs[path].trim() || Number(rawInputs[path]) !== own;
    try { return JSON.stringify(JSON.parse(rawInputs[path])) !== JSON.stringify(own); }
    catch { return true; }
  };
  const dirty = Boolean(document) && (JSON.stringify(draft) !== JSON.stringify(document?.own) || Object.keys(rawInputs).some(rawChanged));
  const configKey = scope === "global" ? "settings:global" : `settings:agent:${agentId}`;
  // 全局读取不依赖异步选中的 Agent，避免目录加载完成时重置正在编辑的草稿。
  const settingsTarget = scope === "global" ? "global" : agentId;
  const guard = useUnsavedChanges({ dirty, busy: saving, label: scope === "global" ? "全局运行设置" : `Agent 运行设置 · ${agents.find((item) => item.profile.id === agentId)?.profile.name ?? agentId}`,
    save, canSave: online && Boolean(document) && !conflict && (scope === "global" || directoryState === "ready") });

  useEffect(() => {
    let active = true;
    setDirectoryState("loading");
    void readTask.current(api.listAgents, { operation: "加载 Agent 目录" }).then((result) => {
      if (!active) return;
      if (result.status === "success") {
        setAgents(result.data.agents);
        setAgentId((current) => result.data.agents.some((item) => item.profile.id === current) ? current : result.data.agents[0]?.profile.id || "");
        setDirectoryState("ready");
      } else setDirectoryState("error");
    });
    return () => { active = false; };
  }, [directoryReload]);
  useEffect(() => {
    let active = true;
    setModelState("loading");
    void readTask.current(api.listModels, { operation: "加载模型目录" }).then((result) => {
      if (!active) return;
      if (result.status === "success") { setModels(result.data.models); setModelState("ready"); }
      else setModelState("error");
    });
    return () => { active = false; };
  }, [modelReload]);
  useEffect(() => {
    let active = true;
    setDocument(undefined); setError(""); setNotice(""); setInherit([]); setRawInputs({}); setConflict(undefined); setLoadState("loading");
    if (scope === "agent" && !agentId) return;
    void readTask.current(() => scope === "global" ? api.getGlobalSettings() : api.getAgentSettings(agentId), { operation: "加载运行设置" }).then((result) => {
      if (!active) return;
      if (result.status === "success") { setDocument(result.data); setDraft(structuredClone(result.data.own) as SettingsRecord); setLoadState("ready"); }
      else setLoadState("error");
    });
    return () => { active = false; };
  }, [scope, settingsTarget, settingsReload]);

  /** 恢复缺省必须随保存显式删除已持久化字段，不能只从草稿中移除。 */
  function reset(path: string) {
    setDraft((current) => deletePath(current, path));
    setInherit((current) => [...new Set([...current, path])]);
    setRawInputs((current) => { const next = { ...current }; delete next[path]; return next; });
    setNotice("");
  }

  function update(path: string, value: unknown) {
    setDraft((current) => setPath(current, path, value));
    setInherit((current) => current.filter((item) => item !== path)); setNotice("");
  }

  function toggleInherited(path: string, inherited: boolean) {
    if (inherited) reset(path);
    else {
      // 取消继承使用全局声明，不能复制已保存 effective 中的旧 Agent 覆盖。
      const field = groups.flatMap((group) => group.fields).find((item) => item.path === path);
      update(path, getPath(document?.inherited, path) ?? (field?.kind === "json" || field?.kind === "csv" ? [] : ""));
    }
  }

  /**
   * 在草稿中原子更新默认 Provider 与模型，确保二者始终指向同一项选择。
   */
  function updateDefaultModel(choice: DefaultModelChoice | undefined) {
    setDraft((current) => {
      let next = deletePath(deletePath(current, "defaultProvider"), "defaultModel");
      if (choice) {
        next = setPath(next, "defaultProvider", choice.provider);
        next = setPath(next, "defaultModel", choice.model);
      }
      return next;
    });
    setInherit((current) => choice ? current.filter((item) => item !== "defaultProvider" && item !== "defaultModel") : [...new Set([...current, "defaultProvider", "defaultModel"])]);
    setNotice("");
  }

  /**
   * Agent 作用域将默认 Provider 与模型作为同一个继承单元处理。
   */
  function toggleDefaultModelInherited(inherited: boolean) {
    if (!inherited) {
      const effectiveChoice = readDefaultModelChoice(document?.inherited);
      if (effectiveChoice) updateDefaultModel(effectiveChoice);
      else update("defaultModel", "");
      return;
    }
    setDraft((current) => deletePath(deletePath(current, "defaultProvider"), "defaultModel"));
    setInherit((current) => [...new Set([...current, "defaultProvider", "defaultModel"])]);
    setNotice("");
  }

  /** 校验失败同时保留具体字段信息及全局错误通知，方便用户定位。 */
  function reportValidation(message: string) {
    setError(message);
    toast.push(toUnexpectedErrorNotice(new ApiClientError("INVALID_SETTINGS_REQUEST", message, 400), "保存运行设置"));
  }

  /** 原始数值与 JSON 单独保存，清空数字不能成为 0，解析失败不能丢失输入。 */
  function prepareDraft(): SettingsRecord | undefined {
    let candidate = structuredClone(draft);
    for (const field of groups.flatMap((group) => group.fields)) {
      const raw = rawInputs[field.path];
      if (raw === undefined) {
        if (field.kind === "number" && getPath(candidate, field.path) === "") {
          reportValidation(`${field.label}必须填写有效数字；清空输入不会作为 0 保存。`); return;
        }
        if ((field.kind === "boolean" || field.kind === "select") && getPath(candidate, field.path) === "") {
          reportValidation(`${field.label}尚未选择覆盖值，请选择明确值或恢复继承。`); return;
        }
        continue;
      }
      let value: unknown;
      if (field.kind === "number") {
        if (!raw.trim() || !Number.isFinite(Number(raw))) { reportValidation(`${field.label}必须填写有效数字；清空输入不会作为 0 保存。`); return; }
        value = Number(raw);
      } else {
        try { value = JSON.parse(raw); }
        catch { reportValidation(`${field.label} JSON 解析未通过，请填写有效数组。`); return; }
        if (!Array.isArray(value)) { reportValidation(`${field.label}必须为 JSON 数组，不能替换为其他类型。`); return; }
      }
      candidate = setPath(candidate, field.path, value);
    }
    if (scope === "agent") {
      if ((getPath(candidate, "defaultProvider") !== undefined || getPath(candidate, "defaultModel") !== undefined) && !readDefaultModelChoice(candidate)) {
        reportValidation("默认模型必须同时选择 Provider 和模型，或恢复全局继承。"); return;
      }
      // 兼容历史 Agent 文件中的全局专属字段，只读展示且不回传修改。
      candidate = deletePath(candidate, "httpProxy");
    }
    return candidate;
  }

  function control(field: SettingField, value: unknown, disabled = false) {
    if (field.kind === "boolean" || field.kind === "select") return <SearchSelect
      ariaLabel={field.label}
      disabled={disabled}
      value={value === undefined ? "" : String(value)}
      onChange={(next) => {
      if (!next) {
        if (scope === "global") reset(field.path);
        else update(field.path, "");
      } else update(field.path, field.kind === "boolean" ? next === "true" : next);
    }}
      options={[
        { value: "", label: scope === "agent" && !disabled ? "请选择覆盖值" : "核心默认值" },
        ...(field.kind === "boolean" ? [ { value: "true", label: "开启" }, { value: "false", label: "关闭" } ] : (field.options?.map((option) => ({ value: option, label: option })) ?? [])),
      ]}
    />;
    if (field.kind === "json") return <Textarea aria-label={`${field.label} JSON`} disabled={disabled} spellCheck={false} rows={6} value={rawInputs[field.path] ?? (value === undefined ? "" : JSON.stringify(value, null, 2))} onChange={(event) => { const raw = event.target.value; setRawInputs((current) => ({ ...current, [field.path]: raw })); setNotice(""); }} />;
    const Field = field.kind === "number" ? NumberField : TextField;
    return <Field aria-label={field.label} disabled={disabled} value={rawInputs[field.path] ?? displayValue(value, field.kind)} onChange={(event) => {
      if (field.kind === "number") { const raw = event.target.value; setRawInputs((current) => ({ ...current, [field.path]: raw })); setNotice(""); }
      else update(field.path, field.kind === "csv" ? event.target.value.split(",").map((item) => item.trim()).filter(Boolean) : event.target.value);
    }} />;
  }

  /** 继承值来自全局声明，草稿恢复继承后立即显示正确来源。 */
  function inheritedField(label: string, path: string, own: boolean, child: ReactNode, help?: string) {
    return <fieldset className="pi-setting-inheritance"><legend>{label}</legend><label className="pi-setting-inheritance__switch"><Checkbox aria-label={`${label}继承全局设置`} checked={!own} onChange={(event) => path === "defaultModel" ? toggleDefaultModelInherited(event.target.checked) : toggleInherited(path, event.target.checked)} />继承全局设置</label>
      <p>全局声明：{path === "defaultModel" ? (() => { const choice = readDefaultModelChoice(document?.inherited); return choice ? `${choice.provider} / ${choice.model}` : "核心默认值（未声明具体值）"; })() : inheritedLabel(getPath(document?.inherited, path))} · {own ? "Agent 覆盖" : "当前继承"}</p>{child}{help ? <small>{help}</small> : null}</fieldset>;
  }

  async function save(): Promise<boolean> {
    if (!document || submitLock.current || !online || conflict || (scope === "agent" && directoryState !== "ready")) return false;
    const candidate = prepareDraft();
    if (!candidate) return false;
    submitLock.current = true;
    setSaving(true); setError(""); setNotice("");
    try {
      const result = await runApiTask(
        () => scope === "global" ? api.updateGlobalSettings(document.revision, candidate, inherit) : api.updateAgentSettings(agentId, document.revision, candidate, inherit),
        {
          operation: "保存运行设置",
          expected: {
            ...settingsExpected(setError),
            VERSION_CONFLICT: async () => {
              const latest = scope === "global" ? await api.getGlobalSettings() : await api.getAgentSettings(agentId);
              setConflict({ latest, differences: collectDifferences(candidate, latest.own as SettingsRecord) });
              setError("");
            },
          },
        },
      );
      if (result.status === "success") { setDocument(result.data); setDraft(structuredClone(result.data.own) as SettingsRecord); setInherit([]); setRawInputs({}); recordConfigurationSave(configKey, result.data.runtimeRefreshRequired !== false); setNotice("设置已保存"); return true; }
      return false;
    }
    finally { submitLock.current = false; setSaving(false); }
  }

  async function reapplyConflict() {
    if (!conflict || submitLock.current || !online) return;
    const candidate = prepareDraft();
    if (!candidate) return;
    submitLock.current = true;
    setSaving(true);
    try {
      const result = await runApiTask(
        () => scope === "global" ? api.updateGlobalSettings(conflict.latest.revision, candidate, inherit) : api.updateAgentSettings(agentId, conflict.latest.revision, candidate, inherit),
        { operation: "重新应用运行设置", expected: {
          ...settingsExpected(setError),
          VERSION_CONFLICT: async () => {
            const latest = scope === "global" ? await api.getGlobalSettings() : await api.getAgentSettings(agentId);
            setConflict({ latest, differences: collectDifferences(candidate, latest.own as SettingsRecord) });
          },
        } },
      );
      if (result.status === "success") { setDocument(result.data); setDraft(structuredClone(result.data.own) as SettingsRecord); setInherit([]); setRawInputs({}); setConflict(undefined); recordConfigurationSave(configKey, result.data.runtimeRefreshRequired !== false); setNotice("设置已在最新版本上重新应用"); }

    }
    finally { submitLock.current = false; setSaving(false); }
  }

  /** 分区计数只包含本页字段；默认 Provider 与模型作为一项组合。 */
  function categorySummary(id: SettingsCategory): string {
    const fields = groups.filter((group) => group.category === id).flatMap((group) => group.fields);
    const changed = fields.some((field) => JSON.stringify(getPath(draft, field.path)) !== JSON.stringify(getPath(document?.own, field.path)) || rawChanged(field.path))
      || (id === "common" && ["defaultProvider", "defaultModel"].some((path) => getPath(draft, path) !== getPath(document?.own, path)));
    const count = fields.filter((field) => !field.globalOnly && getPath(draft, field.path) !== undefined).length + (id === "common" && getPath(draft, "defaultModel") !== undefined ? 1 : 0);
    return `${scope === "agent" ? ` · ${count} 项覆盖` : ""}${changed ? " · 未保存" : ""}`;
  }

  function renderDefaultModel() {
    const ownChoice = readDefaultModelChoice(draft);
    const inheritedChoice = readDefaultModelChoice(document?.inherited);
    const hasOverride = getPath(draft, "defaultModel") !== undefined || getPath(draft, "defaultProvider") !== undefined;
    const currentChoice = scope === "agent" && !hasOverride ? inheritedChoice : ownChoice;
    const options = defaultModelOptions(models, currentChoice);
    const selector = <SearchSelect
      ariaLabel="默认模型"
      disabled={scope === "agent" && !hasOverride}
      value={currentChoice ? defaultModelChoiceKey(currentChoice) : ""}
      onChange={(next) => {
      if (scope === "agent" && !next) update("defaultModel", "");
      else updateDefaultModel(parseDefaultModelChoice(next));
    }}
      options={[
        { value: "", label: scope === "agent" && hasOverride ? "请选择覆盖模型" : "核心默认值" },
        ...options.map((model) => ({ value: defaultModelChoiceKey({ provider: model.provider, model: model.id }), label: `${model.provider} / ${model.name || model.id}` })),
      ]}
    />;
    if (scope === "agent") return inheritedField("默认模型", "defaultModel", hasOverride, selector, "同时覆盖 Provider 与模型。");
    return <label><span>默认模型<small>选择已配置的 Provider 与模型</small></span>{selector}</label>;
  }

  return (
    <div className="configuration-page pi-settings-page configuration-quick-wins-page">
      {guard.dialog}
      {conflict && !guard.pending ? <ConfigurationEditorDialog variant="confirmation" title="配置已在磁盘上发生变化" description="请重新加载，或把本地字段应用到最新 revision 后再次校验。" busy={saving} returnFocusSelector=".pi-settings-save-bar button" onClose={() => setConflict(undefined)} footer={<>
        <Button type="button" className="configuration-secondary-action" disabled={saving} onClick={() => setConflict(undefined)}>继续编辑</Button>
        <Button type="button" className="configuration-secondary-action" disabled={saving} onClick={() => { setDocument(conflict.latest); setDraft(structuredClone(conflict.latest.own) as SettingsRecord); setInherit([]); setRawInputs({}); setConflict(undefined); }}>放弃修改并重新加载</Button>
        <Button variant="primary" type="button" className="configuration-primary-action" disabled={saving || !online} onClick={() => void reapplyConflict()}>在新版本上重新应用</Button>
      </>}><div className="conflict-differences"><div className="conflict-difference conflict-difference--heading"><strong>字段</strong><strong>本地修改</strong><strong>磁盘值</strong></div>{conflict.differences.map((difference) => <div className="conflict-difference" key={difference.field}><code>{difference.field}</code><span>{inheritedLabel(difference.local)}</span><span>{inheritedLabel(difference.disk)}</span></div>)}</div>{error ? <p className="configuration-inline-error" role="alert">{error}</p> : null}</ConfigurationEditorDialog> : null}
      <header className="configuration-page__heading"><span className="configuration-eyebrow">RUNTIME SETTINGS</span><h1>运行设置</h1><p>管理默认模型和运行策略，按需为 Agent 设置独立覆盖。</p></header>
      <section className="settings-scope-bar" aria-label="设置作用域">
        <div className="settings-scope-actions"><Button aria-pressed={scope === "global"} disabled={saving} onClick={() => { if (scope !== "global") guard.request(() => setScope("global")); }}>全局设置</Button><Button aria-pressed={scope === "agent"} disabled={saving} onClick={() => { if (scope !== "agent") guard.request(() => setScope("agent")); }}>Agent 覆盖</Button></div>
        {scope === "agent" && agents.length > 0 ? <label>当前 Agent<SearchSelect
          ariaLabel="选择 Agent"
          value={agentId}
          disabled={saving || directoryState !== "ready"}
          onChange={(next) => guard.request(() => setAgentId(next))}
          options={agents.map(({ profile }) => ({ value: profile.id, label: profile.name }))}
        /></label> : null}
        <p>{scope === "global" ? "全局声明提供基础配置；Agent 可以覆盖部分字段。" : `当前对象：${agents.find((item) => item.profile.id === agentId)?.profile.name ?? "尚未选择"}。仅覆盖明确声明的字段；恢复继承需保存后才会移除覆盖。`}</p>
        {directoryState === "error" ? <div className="pi-settings-load-error" role="alert">Agent 目录未能加载，错误详情已通过通知展示。<Button type="button" disabled={saving} onClick={() => guard.request(() => setDirectoryReload((value) => value + 1))}>重新加载 Agent 目录</Button></div> : null}
      </section>
      <ConfigurationEffectNotice configKey={configKey} dirty={dirty} />
      {error ? <p className="configuration-inline-error" role="alert">{error}</p> : null}
      {notice ? <p className="configuration-save-notice" role="status"><Check size={14} aria-hidden="true" />{notice}</p> : null}
      {scope === "agent" && directoryState === "loading" ? <div className="configuration-state"><p>正在加载 Agent 目录…</p></div>
        : scope === "agent" && directoryState === "error" ? null
        : scope === "agent" && agents.length === 0 ? <div className="configuration-state"><h2>还没有 Agent</h2><p>先创建 Agent，再设置独立运行覆盖。</p><Button type="button" onClick={() => navigateTo({ page: "agents" })}>前往 Agents</Button></div>
        : !document ? <div className="configuration-state"><p>{loadState === "error" ? "运行设置未能加载，错误详情已通过通知展示。" : "正在加载设置…"}</p>{loadState === "error" ? <Button type="button" onClick={() => setSettingsReload((value) => value + 1)}>重新加载运行设置</Button> : null}</div> : <>
        {modelState === "error" ? <div className="pi-settings-load-error" role="alert">模型目录未能加载；保留当前配置的模型，错误详情已通过通知展示。<Button type="button" disabled={saving} onClick={() => setModelReload((value) => value + 1)}>重新加载模型目录</Button></div> : null}
        <Tabs className="pi-settings-tabs" label="运行设置分类" tabIdPrefix="pi-settings-tab"
          panelId={(id) => `pi-settings-panel-${id}`} value={category} disabled={saving} onChange={setCategory}
          items={categories.map((item) => ({ id: item.id, label: <>{item.label}<small>{categorySummary(item.id)}</small></> }))} />
        {categories.map((item) => <section key={item.id} role="tabpanel" tabIndex={0} hidden={category !== item.id} id={`pi-settings-panel-${item.id}`} aria-labelledby={`pi-settings-tab-${item.id}`}>
          <fieldset className="configuration-interaction-fields" disabled={saving || (scope === "agent" && directoryState !== "ready")}><div className="settings-groups">{groups.filter((group) => group.category === item.id).map((group) => <Section key={group.title} index={groups.indexOf(group) + 1} title={group.title} description={group.description}>
            {group.title === "模型与推理" ? renderDefaultModel() : null}
            {group.fields.map((field) => {
              const ownValue = getPath(draft, field.path);
              const inheritedValue = getPath(document.inherited, field.path);
              const help = field.risk || (field.unit ? `单位：${field.unit}` : undefined);
              if (scope === "agent" && !field.globalOnly) return <div key={field.path}>{inheritedField(field.label, field.path, ownValue !== undefined, control(field, ownValue === undefined ? inheritedValue : ownValue, ownValue === undefined), help)}</div>;
              return <label key={field.path}><span>{field.label}<small>{field.risk ? <><ShieldAlert size={12} aria-hidden="true" />{field.risk}</> : field.unit ? `单位：${field.unit}` : ownValue === undefined ? "未声明 · 核心默认值" : "全局声明"}</small></span>{control(field, scope === "agent" ? inheritedValue : ownValue, scope === "agent" && field.globalOnly)}</label>;
            })}
          </Section>)}</div></fieldset>
        </section>)}
        <details className="effective-settings"><summary><strong>已保存配置与来源</strong><small>声明合并结果，不代表运行中快照</small></summary>
          <p>{dirty ? "当前有未保存草稿，下列摘要与 JSON 未包含这些修改。" : "仅展示已保存声明；未声明的核心默认值不在此推测。"}</p>
          <dl className="pi-settings-sources">{[
            { path: "defaultModel", label: "默认模型" },
            ...groups.flatMap((group) => group.fields).filter((field) => ["defaultThinkingLevel", "compaction.enabled", "retry.enabled", "transport", "httpProxy"].includes(field.path)),
          ].map((field) => {
            const own = getPath(document.own, field.path);
            const global = scope === "global" ? own : getPath(document.inherited, field.path);
            const value = scope === "agent" && field.path !== "httpProxy" ? own ?? global : global;
            const choice = field.path === "defaultModel" ? readDefaultModelChoice(scope === "agent" ? document.effective : document.own) : undefined;
            return <div key={field.path}><dt>{field.label}</dt><dd>{choice ? `${choice.provider} / ${choice.model}` : inheritedLabel(value)}<small>{scope === "agent" && field.path !== "httpProxy" && own !== undefined ? "Agent 覆盖" : global !== undefined ? "全局声明" : "核心默认值"}</small></dd></div>;
          })}</dl>
          <details><summary>查看已保存合并 JSON</summary><pre>{JSON.stringify(document.effective, null, 2)}</pre></details>
        </details>
        <div className="configuration-save-bar pi-settings-save-bar"><div><strong>{dirty ? "有未保存的修改" : "当前没有未保存修改"}</strong><small>保存当前作用域所有页签的修改</small></div><Button variant="primary" type="button" className="configuration-primary-action" onClick={() => void save()} disabled={saving || !online || !dirty || Boolean(conflict) || (scope === "agent" && directoryState !== "ready")} title={!online ? "离线时不能保存配置" : undefined}><Save size={16} aria-hidden="true" />{saving ? "保存中…" : scope === "global" ? "保存全局设置" : "保存 Agent 覆盖"}</Button></div>
      </>}
    </div>
  );
}

function collectDifferences(local: SettingsRecord, disk: SettingsRecord): ConfigurationDifference[] {
  const fields = new Set([...flattenPaths(local), ...flattenPaths(disk)]);
  return [...fields].filter((field) => JSON.stringify(getPath(local, field)) !== JSON.stringify(getPath(disk, field))).map((field) => ({ field, local: getPath(local, field), disk: getPath(disk, field) }));
}

function flattenPaths(value: SettingsRecord, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof child === "object" && child !== null && !Array.isArray(child) ? flattenPaths(child as SettingsRecord, path) : [path];
  });
}
