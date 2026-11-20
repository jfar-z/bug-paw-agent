import { MediaLibraryCatalogStatus, useMediaLibraries } from "../components/media-library-actions";
import { ArrowLeft, Check, Copy, Folder, Save, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AgentInstructions, AgentProfile, MediaLibraryGrant, AgentProfileDocument, TitleGenerationConfig } from "../../shared/agent-contracts";
import type { AvatarCropArea } from "../../shared/avatar-contracts";
import { BUILTIN_TOOL_CATALOG, CAPABILITY_TOOL_CATALOG, DEFAULT_AGENT_TOOL_NAMES, SYSTEM_TOOL_CATALOG } from "../../shared/tool-catalog";
import { api, type ModelSummary, type ResourceCatalog } from "../api";
import { useApiTask, type ApiTaskPolicy } from "../api-task-provider";
import { ConfirmDialog } from "../ui/dialog";
import { AvatarCropDialog } from "../components/avatar/avatar-crop-dialog";
import { validateAvatarFile } from "../components/avatar/avatar-file";
import { FormField } from "../ui/form-field";
import type { AppRoute } from "../router";
import { formatTtsCustomParameters, parseTtsCustomParametersText } from "../tts-custom-parameters-form";
import { useOnlineStatus } from "../use-online-status";
import { ConfigurationEffectNotice, recordConfigurationSave } from "../components/configuration/configuration-effect-notice";
import "../configuration.css";
import "../agents.css";

interface AgentDetailPageProps {
  agentId: string;
  onNavigate: (route: AppRoute) => void;
}

type AgentDetailTab = "basic" | "instructions" | "runtime" | "tools" | "resources" | "effective";

const tabs: Array<{ id: AgentDetailTab; label: string }> = [
  { id: "basic", label: "基本信息" },
  { id: "instructions", label: "角色与行为" },
  { id: "runtime", label: "模型与运行" },
  { id: "tools", label: "工具权限" },
  { id: "resources", label: "资源" },
  { id: "effective", label: "有效配置" },
];

const instructionFields = [
  { key: "role", label: "角色与职责", description: "Agent 是谁、负责什么，以及职责边界。", placeholder: "定义角色定位与职责边界…" },
  { key: "behavior", label: "行为风格", description: "沟通语气、协作方式与执行风格。", placeholder: "描述稳定的行事与沟通风格…" },
  { key: "rules", label: "规则", description: "统一描述工作原则、必须遵守的要求和禁止边界。", placeholder: "用 Markdown 编写原则、要求和禁止事项…" },
  { key: "user", label: "用户", description: "用户的背景、偏好、沟通语言和交付习惯。", placeholder: "描述稳定的用户画像与协作偏好…" },
] as const;

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function fallbackDocument(): AgentProfileDocument {
  const now = new Date(0).toISOString();
  return {
    profile: {
      version: 1,
      id: "default",
      name: "默认 Agent",
      avatar: { kind: "initial", value: "π" },
      description: "当前工作台的默认协作 Agent",
      status: "active",
      cwd: "/data/workspace",
      instructions: { role: "", behavior: "", rules: "", user: "" },
      allowedTools: [...DEFAULT_AGENT_TOOL_NAMES],
      createdAt: now,
      updatedAt: now,
    },
    revision: "fallback",
  };
}

/**
 * 提供 Agent Profile 的完整六页签配置与生命周期操作。
 */
export function AgentDetailPage({ agentId, onNavigate }: AgentDetailPageProps) {
  const { runApiTask, runOptionalApiTask } = useApiTask();
  const online = useOnlineStatus();
  const [activeTab, setActiveTab] = useState<AgentDetailTab>("basic");
  const [document, setDocument] = useState<AgentProfileDocument | undefined>(agentId === "default" ? fallbackDocument() : undefined);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [ttsProfiles, setTtsProfiles] = useState<Array<{ id: string; name: string; model: string; voice: string }>>([]);
  const [globalDefaultModel, setGlobalDefaultModel] = useState<{ provider: string; id: string }>();
  const [resources, setResources] = useState<ResourceCatalog>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [avatarFile, setAvatarFile] = useState<File>();
  const [avatarError, setAvatarError] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [removeSessions, setRemoveSessions] = useState(false);
  const [removeWorkspace, setRemoveWorkspace] = useState(false);
  const [deletePreview, setDeletePreview] = useState<{ sessions: { count: number }; workspace: { files: number; bytes: number } }>();
  const [bootsharpOpen, setBootsharpOpen] = useState(false);
  const [bootsharp, setBootsharp] = useState("");
  const [ttsCustomParametersText, setTtsCustomParametersText] = useState("{}");

  useEffect(() => {
    let active = true;
    void runApiTask(() => api.getAgent(agentId), { operation: "加载 Agent 详情", expected: { AGENT_NOT_FOUND: () => { if (active && agentId !== "default") setNotFound(true); } } })
      .then((result) => { if (active && result.status === "success") setDocument(result.data); });
    void runOptionalApiTask(api.listModels, { operation: "加载模型目录", fallbackReason: "模型目录不可用", fallback: () => ({ models: [] }) }).then((result) => { if (active && (result.status === "success" || result.status === "fallback")) setModels(result.data.models ?? []); });
    void runOptionalApiTask(api.getTtsProfiles, { operation: "加载语音配置目录", fallbackReason: "语音能力不可用", fallback: () => ({ revision: "", profiles: [] }) }).then((result) => { if (active && (result.status === "success" || result.status === "fallback")) setTtsProfiles(result.data.profiles ?? []); });
    void runOptionalApiTask(api.getGlobalSettings, { operation: "加载全局默认设置", fallbackReason: "全局默认设置不可用", fallback: () => ({ revision: "", own: {}, effective: {}, diagnostics: [] }) }).then((result) => {
      if (result.status !== "success" && result.status !== "fallback") return;
      const effective = result.data.effective ?? {};
      if (!active) return;
      const { defaultProvider, defaultModel } = effective;
      setGlobalDefaultModel(defaultProvider && defaultModel ? { provider: defaultProvider, id: defaultModel } : undefined);
    });
    void runOptionalApiTask(() => api.listResources(agentId), { operation: "加载 Agent 资源目录", fallbackReason: "资源目录不可用", fallback: () => ({ resources: [], tools: [], diagnostics: [] }) }).then((result) => { if (active && (result.status === "success" || result.status === "fallback")) setResources(result.data); });
    return () => { active = false; };
  }, [agentId, runApiTask, runOptionalApiTask]);

  useEffect(() => {
    setTtsCustomParametersText(formatTtsCustomParameters(document?.profile.ttsCustomParameters));
  }, [agentId, document?.revision]);

  const agent = document?.profile;
  const toolCatalog = useMemo(() => {
    const extensions = resources?.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description || "由已加载的扩展提供",
      source: "extension" as const,
      highRisk: tool.highRisk,
    })) ?? [];
    const known = [...BUILTIN_TOOL_CATALOG, ...SYSTEM_TOOL_CATALOG, ...CAPABILITY_TOOL_CATALOG, ...extensions];
    const knownNames = new Set(known.map((tool) => tool.name));
    const retained = agent?.allowedTools
      .filter((name) => !knownNames.has(name))
      .map((name) => ({ name, description: "当前配置保留的工具；未在本次加载中发现对应实现。", source: "retained" as const, highRisk: true })) ?? [];
    return [...known, ...retained];
  }, [agent?.allowedTools, resources]);
  const inheritedModelLabel = globalDefaultModel ? `${globalDefaultModel.provider} / ${globalDefaultModel.id}` : "全局默认模型";
  const titleGeneration = agent?.titleGeneration ?? { modelSource: "session" as const, thinkingEnabled: false };
  const suggestedTitleModel = globalDefaultModel ?? models[0];
  const selectedTtsProfile = ttsProfiles.find((profile) => profile.id === agent?.ttsProfileId);
  const promptPreview = useMemo(() => agent ? instructionFields
    .filter(({ key }) => agent.instructions[key].trim())
    .map(({ key, label }) => `## ${label}\n\n${agent.instructions[key].trim()}`)
    .join("\n\n") : "", [agent]);

  function updateProfile(patch: Partial<AgentProfile>) {
    setDocument((current) => current ? { ...current, profile: { ...current.profile, ...patch } } : current);
    setNotice("");
  }

  function updateInstructions(patch: Partial<AgentInstructions>) {
    if (!agent) return;
    updateProfile({ instructions: { ...agent.instructions, ...patch } });
  }

  async function save() {
    if (!document || document.revision === "fallback") return;
    let ttsCustomParameters = document.profile.ttsCustomParameters;
    if (activeTab === "runtime" && document.profile.ttsProfileId) {
      try {
        ttsCustomParameters = parseTtsCustomParametersText(ttsCustomParametersText);
      } catch (validationError) {
        setError(validationError instanceof Error ? validationError.message : "TTS 自定义请求参数无效");
        return;
      }
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      if (activeTab === "instructions") {
        const promptResult = await runApiTask(
          () => Promise.all(instructionFields.map((field) => api.replaceAgentPrompt(agentId, field.key, document.profile.instructions[field.key]))),
          { operation: "保存 Agent 提示词", expected: agentDetailExpected(setError) },
        );
        if (promptResult.status === "success") { recordConfigurationSave(`agent:${agentId}`); setNotice("已保存"); }
        return;
      }
      const result = await runApiTask(() => api.updateAgent(agentId, document.revision, {
        name: document.profile.name,
        cwd: document.profile.cwd.trim(),
        description: document.profile.description,
        avatar: document.profile.avatar.kind === "initial" ? document.profile.avatar : undefined,
        defaultModel: document.profile.defaultModel ?? null,
        defaultThinkingLevel: document.profile.defaultThinkingLevel ?? null,
        titleGeneration: document.profile.titleGeneration ?? null,
        allowedTools: document.profile.allowedTools,
        mediaLibraryGrants: document.profile.mediaLibraryGrants,
        ttsProfileId: document.profile.ttsProfileId ?? null,
        ttsVoice: document.profile.ttsVoice?.trim() || null,
        ttsCustomParameters: document.profile.ttsProfileId ? ttsCustomParameters ?? {} : null,
        ttsAutoPlay: document.profile.ttsAutoPlay === true,
        ttsStreamPlayback: document.profile.ttsStreamPlayback === true,
      }), { operation: "保存 Agent", expected: agentDetailExpected(setError) });
      if (result.status !== "success") return;
      setDocument(result.data);
      recordConfigurationSave(`agent:${agentId}`);
      setNotice("已保存");
    } finally {
      setSaving(false);
    }
  }

  async function openBootsharp() {
    setError("");
    const result = await runApiTask(() => api.getAgentPrompt(agentId, "bootsharp"), { operation: "读取 BOOTSHARP", expected: agentDetailExpected(setError) });
    if (result.status === "success") { setBootsharp(result.data.content); setBootsharpOpen(true); }
  }

  async function saveBootsharp() {
    setSaving(true);
    try {
      const result = await runApiTask(() => api.replaceAgentPrompt(agentId, "bootsharp", bootsharp), { operation: "保存 BOOTSHARP", expected: agentDetailExpected(setError) });
      if (result.status === "success") { setBootsharpOpen(false); recordConfigurationSave(`agent:${agentId}`); setNotice("BOOTSHARP 已保存"); }
    } finally { setSaving(false); }
  }

  function selectAvatar(file: File | undefined) {
    if (!file) return;
    const validation = validateAvatarFile(file);
    setAvatarError(validation ?? "");
    if (!validation) setAvatarFile(file);
  }

  async function uploadAvatar(crop: AvatarCropArea) {
    if (!avatarFile || !document || document.revision === "fallback") return;
    setSaving(true);
    setAvatarError("");
    try {
      const result = await runApiTask(
        () => api.uploadAgentAvatar(agentId, document.revision, avatarFile, crop),
        { operation: "上传 Agent 头像", expected: avatarUploadExpected(setAvatarError) },
      );
      if (result.status === "success") {
        setDocument(result.data);
        setNotice("头像已更新");
        setAvatarFile(undefined);
      }
    } finally {
      setSaving(false);
    }
  }

  async function toggleArchive() {
    if (!document || document.revision === "fallback") return;
    const result = await runApiTask(
      () => document.profile.status === "active" ? api.archiveAgent(agentId, document.revision) : api.restoreAgent(agentId, document.revision),
      { operation: document.profile.status === "active" ? "归档 Agent" : "恢复 Agent", expected: agentDetailExpected(setError) },
    );
    if (result.status === "success") { setDocument(result.data); setNotice(result.data.profile.status === "active" ? "已恢复" : "已归档"); }
  }

  async function openDeleteDialog() {
    setDeleteOpen(true);
    const result = await runApiTask(() => api.getAgentDeletePreview(agentId), { operation: "读取 Agent 删除影响", expected: agentDetailExpected(setError) });
    if (result.status === "success") setDeletePreview(result.data);
  }

  async function removeAgent() {
    const result = await runApiTask(() => api.deleteAgent(agentId, removeSessions, removeWorkspace), { operation: "删除 Agent", expected: agentDetailExpected(setError) });
    if (result.status === "success") onNavigate({ page: "agents" });
  }

  if (notFound) {
    return (
      <div className="configuration-page configuration-state">
        <span className="configuration-eyebrow">AGENT PROFILE</span><h1>Agent 不存在</h1><p>未找到 ID 为 <code>{agentId}</code> 的 Agent。</p>
        <button type="button" onClick={() => onNavigate({ page: "agents" })}>返回 Agents</button>
      </div>
    );
  }
  if (!agent) return <div className="configuration-page configuration-state"><p>正在加载 Agent…</p></div>;

  return (
    <div className="configuration-page agent-detail-page">
      <button type="button" className="configuration-back" onClick={() => onNavigate({ page: "agents" })}>
        <ArrowLeft size={16} aria-hidden="true" />返回 Agents
      </button>
      <header className="agent-detail-header">
        <span className="agent-detail-header__avatar">
          {agent.avatar.kind === "image"
            ? <img src={`/api/v1/agents/${encodeURIComponent(agent.id)}/avatar?v=${encodeURIComponent(agent.avatar.revision)}`} alt={`${agent.name} 的头像`} />
            : <span aria-hidden="true">{agent.avatar.value}</span>}
        </span>
        <div><span className="configuration-eyebrow">AGENT · {agent.id}</span><h1>{agent.name}</h1><p>{agent.description || "尚未填写简介"}</p></div>
        <span className="agent-detail-header__status"><i />{agent.status === "active" ? "可用" : "已归档"}</span>
      </header>

      <ConfigurationEffectNotice configKey={`agent:${agentId}`} />
      <nav className="agent-tabs" aria-label="Agent 详情页签">
        {tabs.map((tab) => (
          <button key={tab.id} type="button" className={activeTab === tab.id ? "is-active" : undefined} aria-current={activeTab === tab.id ? "page" : undefined} onClick={() => setActiveTab(tab.id)}>{tab.label}</button>
        ))}
      </nav>

      {error ? <p className="configuration-inline-error" role="alert">{error}</p> : null}
      {notice ? <p className="configuration-save-notice" role="status"><Check size={14} aria-hidden="true" />{notice}</p> : null}

      {activeTab === "basic" ? (
        <div className="agent-detail-grid">
          <section className="configuration-form-card" aria-labelledby="agent-identity-title">
            <div className="configuration-section__heading"><div><span>01</span><h2 id="agent-identity-title">基本身份</h2></div></div>
            <label><span>显示名称<small>在会话和 Agent 列表中使用</small></span><input value={agent.name} onChange={(event) => updateProfile({ name: event.target.value })} /></label>
            <label><span>头像文字<small>保存后使用文字头像，也可上传方形图片</small></span><input aria-label="头像文字" value={agent.avatar.kind === "initial" ? agent.avatar.value : ""} maxLength={2} onChange={(event) => updateProfile({ avatar: { kind: "initial", value: event.target.value } })} /></label>
            <label><span>头像图片<small>PNG、JPEG 或 WebP，原图最大 20 MB；上传前可裁剪，系统将自动压缩。</small></span><input aria-label="上传头像图片" type="file" accept="image/png,image/jpeg,image/webp" disabled={saving} onChange={(event) => { selectAvatar(event.target.files?.[0]); event.target.value = ""; }} /></label>
            {avatarError && !avatarFile ? <div className="configuration-inline-error" role="alert">{avatarError}</div> : null}
            <label><span>简介<small>简短说明这个 Agent 的用途</small></span><textarea rows={3} value={agent.description} onChange={(event) => updateProfile({ description: event.target.value })} /></label>
            <div className="configuration-button-row">
              <button type="button" onClick={toggleArchive}>{agent.status === "active" ? "归档 Agent" : "恢复 Agent"}</button>
              <button type="button" onClick={async () => { const clone = await api.cloneAgent(agentId); onNavigate({ page: "agent-detail", agentId: clone.profile.id }); }}><Copy size={15} aria-hidden="true" />克隆</button>
              <button type="button" className="danger-link" onClick={openDeleteDialog}><Trash2 size={15} aria-hidden="true" />删除</button>
            </div>
          </section>
          <section className="configuration-form-card" aria-labelledby="agent-workspace-title">
            <div className="configuration-section__heading"><div><span>02</span><h2 id="agent-workspace-title">工作目录</h2></div><small>可切换</small></div>
            <label>
              <span>工作目录<small>仅支持 /data/ 下的绝对路径</small></span>
              <input aria-label="工作目录" value={agent.cwd} onChange={(event) => updateProfile({ cwd: event.target.value })} />
            </label>
            <p className="configuration-help">切换时只迁移 <code>.pi</code>；其他项目文件留在原目录。目标目录已有 <code>.pi</code> 时不会覆盖。</p>
          </section>
        </div>
      ) : null}

      {activeTab === "instructions" ? (
        <section className="agent-instructions" aria-labelledby="agent-instructions-title">
          <header className="agent-instructions__heading"><div><span className="configuration-eyebrow">SYSTEM INSTRUCTIONS · 4 SECTIONS</span><h2 id="agent-instructions-title">角色与行为</h2><p>四个分区按固定顺序合并，并持续注入每次 Agent 运行。</p></div><div className="configuration-button-row"><button type="button" className="secondary-button" onClick={() => void openBootsharp()}>修改 BOOTSHARP</button><small>Markdown</small></div></header>
          <div className="agent-instruction-grid">
            {instructionFields.map((field, index) => (
              <label className="agent-instruction-field" key={field.key}>
                <span className="agent-instruction-field__index">0{index + 1}</span>
                <span className="agent-instruction-field__label"><strong>{field.label}</strong><small>{field.description}</small></span>
                <textarea aria-label={field.label} rows={5} placeholder={field.placeholder} value={agent.instructions[field.key]} onChange={(event) => updateInstructions({ [field.key]: event.target.value })} />
              </label>
            ))}
          </div>
          <div className="agent-prompt-preview"><span>最终系统提示词预览</span><pre>{promptPreview || "尚未配置角色指令。"}</pre></div>
        </section>
      ) : null}

      {activeTab === "runtime" ? (
        <section className="configuration-form-card configuration-single-column">
          <FormField label="默认模型" inherit={{ active:!agent.defaultModel, value:inheritedModelLabel, onChange:(inherited) => updateProfile({ defaultModel: inherited ? undefined : globalDefaultModel ?? models[0] ? { provider: (globalDefaultModel ?? models[0]).provider, id: (globalDefaultModel ?? models[0]).id } : undefined }) }}>{(bindings) => <select {...bindings} aria-label="Agent 默认模型" value={agent.defaultModel ? `${agent.defaultModel.provider}:${agent.defaultModel.id}` : ""} onChange={(event) => { const [provider, ...id] = event.target.value.split(":"); updateProfile({ defaultModel: { provider, id: id.join(":") } }); }}>
              <option value="" disabled>{inheritedModelLabel}</option>
              {models.map((model) => <option key={`${model.provider}:${model.id}`} value={`${model.provider}:${model.id}`}>{model.provider} / {model.name}</option>)}
            </select>}</FormField>
          <FormField label="思考级别" inherit={{ active:!agent.defaultThinkingLevel, value:"模型或全局默认值", onChange:(inherited) => updateProfile({ defaultThinkingLevel: inherited ? undefined : "medium" }) }}>{(bindings) => <select {...bindings} aria-label="Agent 思考级别" value={agent.defaultThinkingLevel ?? "medium"} onChange={(event) => updateProfile({ defaultThinkingLevel: event.target.value as AgentProfile["defaultThinkingLevel"] })}>
              {thinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}
            </select>}</FormField>
          <section className="configuration-form-card configuration-single-column">
            <h2>标题生成</h2>
            <p className="configuration-help">同 Agent 会跟随会话实际模型；系统默认使用 Pi 全局默认模型。启用思考后，标题会继承此 Agent 的思考级别。</p>
            <label><span>标题模型来源</span><select aria-label="标题模型来源" value={titleGeneration.modelSource} onChange={(event) => {
              const modelSource = event.target.value as TitleGenerationConfig["modelSource"];
              updateProfile({ titleGeneration: {
                modelSource,
                ...(modelSource === "custom" && suggestedTitleModel ? { model: { provider: suggestedTitleModel.provider, id: suggestedTitleModel.id } } : {}),
                thinkingEnabled: titleGeneration.thinkingEnabled,
              } });
            }}>
              <option value="session">同 Agent</option>
              <option value="system-default">使用系统默认</option>
              <option value="custom">单独选择模型</option>
            </select></label>
            {titleGeneration.modelSource === "custom" ? <label><span>标题单独模型</span><select aria-label="标题单独模型" value={titleGeneration.model ? `${titleGeneration.model.provider}:${titleGeneration.model.id}` : ""} onChange={(event) => { const [provider, ...id] = event.target.value.split(":"); updateProfile({ titleGeneration: { ...titleGeneration, model: { provider, id: id.join(":") } } }); }}>
              <option value="" disabled>请选择标题模型</option>
              {models.map((model) => <option key={`${model.provider}:${model.id}`} value={`${model.provider}:${model.id}`}>{model.provider} / {model.name}</option>)}
            </select></label> : null}
            <label><input aria-label="标题生成启用思考" type="checkbox" checked={titleGeneration.thinkingEnabled} onChange={(event) => updateProfile({ titleGeneration: { ...titleGeneration, thinkingEnabled: event.target.checked } })} />启用思考</label>
          </section>
          <section className="configuration-form-card configuration-single-column">
            <h2>语音回答</h2>
            <p className="configuration-help">选择已配置的语音模型后，可让 Agent 回答自动播放。</p>
            <label><span>语音模型</span><select aria-label="Agent 语音模型" value={agent.ttsProfileId ?? ""} onChange={(event) => {
              if (event.target.value) {
                updateProfile({ ttsProfileId: event.target.value });
                return;
              }
              setTtsCustomParametersText("{}");
              updateProfile({ ttsProfileId: undefined, ttsVoice: undefined, ttsCustomParameters: undefined, ttsAutoPlay: false, ttsStreamPlayback: false });
            }}><option value="">不使用语音</option>{ttsProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model} · {profile.voice}</option>)}</select></label>
            <label><span>Agent 音色<small>留空则继承所选语音模型；填写后仅在此 Agent 运行时覆盖</small></span><input aria-label="Agent 音色" disabled={!agent.ttsProfileId} maxLength={160} placeholder={selectedTtsProfile ? `继承模型音色：${selectedTtsProfile.voice}` : "请先选择语音模型"} value={agent.ttsVoice ?? ""} onChange={(event) => updateProfile({ ttsVoice: event.target.value || undefined })} /></label>
            <label><span>自定义请求参数（JSON）<small>Agent 参数覆盖模型参数，专用音色优先级最高</small></span><textarea aria-label="Agent TTS 自定义请求参数" disabled={!agent.ttsProfileId} rows={7} spellCheck={false} value={ttsCustomParametersText} onChange={(event) => { setTtsCustomParametersText(event.target.value); setNotice(""); }} /></label>
            <p className="configuration-help">不能覆盖 <code>input</code>；不要填写 API Key、账号或身份信息。嵌套对象按顶层字段整体覆盖。</p>
            <label><input aria-label="自动播放语音" type="checkbox" disabled={!agent.ttsProfileId} checked={agent.ttsAutoPlay === true} onChange={(event) => updateProfile({ ttsAutoPlay: event.target.checked, ttsStreamPlayback: event.target.checked ? agent.ttsStreamPlayback : false })} />自动播放语音</label>
            <label><input aria-label="流式播放语音" type="checkbox" disabled={!agent.ttsProfileId || !agent.ttsAutoPlay} checked={agent.ttsStreamPlayback === true} onChange={(event) => updateProfile({ ttsStreamPlayback: event.target.checked })} />流式播放语音</label>
          </section>
        </section>
      ) : null}

      {activeTab === "tools" ? (
        <section className="configuration-form-card configuration-single-column">
          <h2>工具权限</h2><p className="configuration-help">系统工具和扩展工具也遵循这里的授权；扩展默认不启用。高风险工具会直接影响 Agent 的工作目录或业务数据，请按最小权限启用。</p>
          {(["builtin", "system", "capability", "extension", "retained"] as const).map((source) => {
            const tools = toolCatalog.filter((tool) => tool.source === source);
            if (tools.length === 0) return null;
            const title = source === "builtin" ? "内置工具" : source === "system" ? "系统工具" : source === "capability" ? "能力工具" : source === "extension" ? "已加载扩展" : "保留配置";
            return <section key={source} className="tool-permission-group" aria-label={title}><h3>{title}</h3><div className="tool-permission-grid">{tools.map((tool) => <label key={tool.name}><input type="checkbox" checked={agent.allowedTools.includes(tool.name)} onChange={(event) => updateProfile({ allowedTools: event.target.checked ? [...agent.allowedTools, tool.name] : agent.allowedTools.filter((item) => item !== tool.name) })} /><span><strong>{tool.name}</strong><small>{tool.description}</small></span>{tool.highRisk ? <em>高风险</em> : null}</label>)}</div></section>;
          })}
          <AgentMediaGrants key={agentId} grants={agent.mediaLibraryGrants ?? []} disabled={saving || !online}
            onChange={(mediaLibraryGrants) => updateProfile({ mediaLibraryGrants })} />
        </section>
      ) : null}

      {activeTab === "resources" ? <section className="configuration-form-card configuration-single-column"><h2>资源</h2><p className="configuration-help">显示当前 Agent 经核心资源加载器合并后的真实资源与工具。完整安装和启停操作位于“Skills 与扩展”。</p><div className="agent-resource-summary"><div><strong>{resources?.resources.filter((item) => item.type === "skill").length ?? "…"}</strong><small>Skills</small></div><div><strong>{resources?.resources.filter((item) => item.type === "prompt").length ?? "…"}</strong><small>Prompts</small></div><div><strong>{resources?.resources.filter((item) => item.type === "extension").length ?? "…"}</strong><small>Extensions</small></div><div><strong>{resources?.tools.length ?? "…"}</strong><small>Tools</small></div></div><div className="agent-resource-list">{resources?.resources.slice(0, 8).map((item) => <div key={item.id}><span>{item.name}</span><small>{item.type} · {item.scope}{item.inherited ? " · 继承" : ""}</small></div>)}</div><div className="agent-path-preview"><Folder size={18} aria-hidden="true" /><code>{agent.cwd}</code></div></section> : null}
      {activeTab === "effective" ? <section className="configuration-form-card configuration-single-column"><h2>有效配置</h2><p className="configuration-help">这是当前 Agent Profile 的只读快照；未设置的模型与思考级别由运行时继承。</p><pre className="effective-config-preview">{JSON.stringify(agent, null, 2)}</pre></section> : null}

      {activeTab !== "effective" && activeTab !== "resources" ? <div className="configuration-save-bar"><button type="button" className="configuration-primary-action" onClick={save} disabled={saving || document?.revision === "fallback" || !online}><Save size={16} aria-hidden="true" />{saving ? "保存中…" : "保存更改"}</button></div> : null}

      {deleteOpen ? (
        <ConfirmDialog title="删除 Agent" confirmLabel="永久删除 Agent" requireText={agent.name} onCancel={() => setDeleteOpen(false)} onConfirm={removeAgent}>
          <p>Profile 将被删除。工作目录会移动到回收区，不会直接擦除。</p>
          <dl className="delete-impact"><div><dt>Sessions</dt><dd>{deletePreview?.sessions.count ?? "…"}</dd></div><div><dt>工作目录文件</dt><dd>{deletePreview?.workspace.files ?? "…"}</dd></div><div><dt>占用空间</dt><dd>{deletePreview ? `${deletePreview.workspace.bytes} B` : "…"}</dd></div></dl>
          <label><input type="checkbox" checked={removeSessions} onChange={(event) => setRemoveSessions(event.target.checked)} />同时删除关联 Sessions</label>
          <label><input type="checkbox" checked={removeWorkspace} onChange={(event) => setRemoveWorkspace(event.target.checked)} />同时移除工作目录</label>
        </ConfirmDialog>
      ) : null}
      {bootsharpOpen ? <div className="configuration-dialog-backdrop" role="presentation"><section className="configuration-dialog" role="dialog" aria-modal="true" aria-labelledby="bootsharp-title"><header><div><span>INITIALIZATION</span><h2 id="bootsharp-title">修改 BOOTSHARP</h2></div><button type="button" className="icon-button" aria-label="关闭 BOOTSHARP 编辑" onClick={() => setBootsharpOpen(false)}><X size={18} /></button></header><p>此提示仅在文件非空时引导首次协作；清空后将不再注入新会话。</p><label className="configuration-field"><span>BOOTSHARP 内容</span><textarea aria-label="BOOTSHARP 内容" rows={16} value={bootsharp} onChange={(event) => setBootsharp(event.target.value)} /></label><footer><button type="button" className="secondary-button" onClick={() => setBootsharpOpen(false)}>取消</button><button type="button" className="configuration-primary-action" disabled={saving || !online} onClick={() => void saveBootsharp()}>{saving ? "保存中…" : "保存 BOOTSHARP"}</button></footer></section></div> : null}
      {avatarFile ? <AvatarCropDialog
        file={avatarFile}
        busy={saving}
        error={avatarError || undefined}
        onCancel={() => { setAvatarFile(undefined); setAvatarError(""); }}
        onReplace={selectAvatar}
        onConfirm={(crop) => void uploadAvatar(crop)}
      /> : null}
    </div>
  );
}

/** 将 Agent、提示词、头像和工作目录业务错误保留在当前编辑页。 */
/** 按库独立配置读写权，撤销读取时同步撤销公网授权。 */
function AgentMediaGrants({ grants, disabled, onChange }: {
  grants: MediaLibraryGrant[];
  disabled: boolean;
  onChange: (grants: MediaLibraryGrant[]) => void;
}) {
  const libraries = useMediaLibraries();
  function change(grant: MediaLibraryGrant) {
    const remaining = grants.filter((entry) => entry.libraryId !== grant.libraryId);
    onChange(grant.read || grant.upload || grant.delete ? [...remaining, grant] : remaining);
  }
  return <section className="tool-permission-group" aria-label="媒体库授权">
    <h3>媒体库授权</h3>
    <p className="configuration-help">按库独立授予读取、上传和删除权限。读取和上传须启用 media_library，删除须启用 media_library_delete 并由用户在会话中确认。允许公网传输后，获准运行的 Grok 可通过公网读取执行副本。</p>
    <MediaLibraryCatalogStatus {...libraries} />
    {libraries.catalog.status === "ready" && libraries.catalog.items.map((library) => {
      const grant = grants.find((entry) => entry.libraryId === library.id)
        ?? { libraryId: library.id, read: false, upload: false, publicTransfer: false };
      return <fieldset key={library.id} className="agent-media-grant" disabled={disabled}>
        <legend>{library.name}</legend>
        <label className="configuration-check-line"><input type="checkbox" checked={grant.read}
          onChange={(event) => change({ ...grant, read: event.target.checked, publicTransfer: event.target.checked && grant.publicTransfer })} />读取</label>
        <label className="configuration-check-line"><input type="checkbox" checked={grant.upload}
          onChange={(event) => change({ ...grant, upload: event.target.checked })} />上传</label>
        <label className="configuration-check-line"><input type="checkbox" checked={grant.delete ?? false}
          onChange={(event) => change({ ...grant, delete: event.target.checked })} />删除</label>
        <label className="configuration-check-line"><input type="checkbox" checked={grant.publicTransfer} disabled={!grant.read}
          onChange={(event) => change({ ...grant, publicTransfer: event.target.checked })} />允许公网传输</label>
      </fieldset>;
    })}
  </section>;
}

function agentDetailExpected(setError: (message: string) => void): ApiTaskPolicy["expected"] {
  const show = (error: { message: string }) => setError(error.message);
  return {
    AGENT_INVALID: show,
    AGENT_NOT_FOUND: show,
    AGENT_ARCHIVED: show,
    INVALID_AGENT_NAME: show,
    VERSION_CONFLICT: show,
    AGENT_HAS_SESSIONS: show,
    AGENT_REMOVAL_IN_PROGRESS: show,
    DELETE_OPTIONS_REQUIRED: show,
    WORKSPACE_IN_USE: show,
    WORKSPACE_OUTSIDE_DATA: show,
    WORKSPACE_PI_CONFLICT: show,
    WORKSPACE_NOT_ABSOLUTE: show,
    WORKSPACE_ROOT_FORBIDDEN: show,
    WORKSPACE_NOT_DIRECTORY: show,
    INVALID_PROMPT_FILE: show,
    PROMPT_CONTENT_REQUIRED: show,
    PROMPT_FILES_ONLY: show,
    AVATAR_REQUIRED: show,
    AVATAR_NOT_FOUND: show,
    AVATAR_TOO_LARGE: show,
    INVALID_AVATAR: show,
    INVALID_AVATAR_TYPE: show,
  };
}

/** 头像错误留在裁剪器内，避免丢失用户已经调整的裁剪状态。 */
function avatarUploadExpected(setError: (message: string) => void): ApiTaskPolicy["expected"] {
  const show = (error: { message: string }) => setError(error.message);
  return {
    INVALID_AVATAR_CROP: show,
    AVATAR_TOO_LARGE: show,
    INVALID_AVATAR_TYPE: show,
    AVATAR_TOO_MANY_PIXELS: show,
    AVATAR_PROCESSING_FAILED: show,
    VERSION_CONFLICT: show,
  };
}
