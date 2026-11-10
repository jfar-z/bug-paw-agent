import "../media-lightbox.css";
import { Activity, AlertTriangle, AudioLines, Boxes, CheckCircle2, Copy, Download, File, Film, GitFork, Image as ImageIcon, Play, Plus, RefreshCw, Save, TestTube2, Trash2, Upload, X } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type {
  AigcChannelSummary,
  AigcComfyUiInputFile,
  AigcInterfaceCapability,
  AigcInterfaceInput,
  AigcOpenAiInterfaceConfig,
  AigcOpenAiParameterDefinition,
  AigcOpenAiParameterType,
  AigcOpenAiParameterValue,
  AigcInterfaceRecord,
  AigcInterfaceProtocol,
  AigcPublicFileSummary,
  AigcRunInputValue,
  AigcRunMediaSource,
  AigcRuntimeChannelSummary,
  AigcSettingsDocument,
  AigcTaskDocument,
  AigcTaskAsset,
  AigcTaskExecutionState,
  AigcTaskRecord,
  AigcTaskStatus,
  AigcTaskSummary,
  AigcUploadedAsset,
  AigcWorkflowDetail,
  AigcWorkflowDocument,
  AigcWorkflowInputGroup,
  AigcWorkflowInputMapping,
  AigcWorkflowOutputMapping,
  AigcWorkflowReplacementPreview,
  AigcWorkflowSummary,
  ComfyUiFieldMetadata,
} from "../../shared/aigc-contracts";
import { AIGC_TASK_BULK_DELETE_LIMIT } from "../../shared/aigc-contracts";
import { createDefaultOpenAiParameters, resolveOpenAiParameterDefinitions } from "../../shared/aigc-openai-parameters";
import { aigcComfyUiInputContentUrl, aigcInputAssetUrl, aigcTaskAssetUrl, api } from "../api";
import { useApiTask, type ApiTaskPolicy } from "../api-task-provider";
import { ConfirmationDialog } from "../components/configuration/confirmation-dialog";
import { ConfigurationSelect } from "../components/configuration/configuration-select";
import { useOnlineStatus } from "../use-online-status";
import { navigateTo, NAVIGATION_BEFORE_EVENT, type AppRoute } from "../router";
import "../configuration.css";
import "../aigc.css";
import "../aigc-run-reference-groups.css";

const AigcInterfacesPage = lazy(async () => {
  const module = await import("./aigc-interfaces-page");
  return { default: module.AigcInterfacesPage };
});

const AigcWorkflowComposer = lazy(async () => {
  const module = await import("./aigc-workflow-composer");
  return { default: module.AigcWorkflowComposer };
});

interface AigcWorkbenchPageProps {
  route: AppRoute;
}

/** AIGC 工作台页面，按二级路由呈现概览、接口、任务与工作流。 */
export function AigcWorkbenchPage({ route }: AigcWorkbenchPageProps) {
  if (route.page === "aigc-interfaces") return <Suspense fallback={<p className="configuration-help">正在加载接口配置…</p>}><AigcInterfacesPage /></Suspense>;
  if (route.page === "aigc-interface-detail") return <AigcInterfaceDetail interfaceId={route.interfaceId} />;
  if (route.page === "aigc-run") return <AigcRunPage preferredInterfaceId={route.interfaceId} />;
  if (route.page === "aigc-tasks") return <AigcTasksPage />;
  if (route.page === "aigc-task-detail") return <AigcTaskDetail taskId={route.taskId} />;
  if (route.page === "aigc-workflows") return <AigcWorkflowsPage />;
  if (route.page === "aigc-workflow-detail") return <AigcWorkflowDetail key={route.workflowId} workflowId={route.workflowId} />;
  return <AigcOverview />;
}

/** 概览页汇总渠道、接口、工作流与任务状态。 */
function AigcOverview() {
  const { runApiTask } = useApiTask();
  const [channels, setChannels] = useState<AigcSettingsDocument>();
  const [interfaces, setInterfaces] = useState<AigcInterfaceRecord[]>([]);
  const [workflows, setWorkflows] = useState<AigcWorkflowDocument>();
  const [tasks, setTasks] = useState<{ total: number; running: number; failed: number }>();
  const [connectionResult, setConnectionResult] = useState<{ channelId: string; ok: boolean; message: string }>();
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    void runApiTask(async () => {
      const [channelDocument, interfaceDocument, workflowDocument, taskDocument] = await Promise.all([
        api.getAigcChannels(),
        api.getAigcInterfaces(),
        api.getAigcWorkflows(),
        api.getAigcTasks(),
      ]);
      setChannels(channelDocument);
      setInterfaces(interfaceDocument.interfaces);
      setWorkflows(workflowDocument);
      setTasks({
        total: taskDocument.tasks.length,
        running: taskDocument.tasks.filter((task) => task.status === "queued" || task.status === "running").length,
        failed: taskDocument.tasks.filter((task) => task.status === "failed").length,
      });
      return { channelDocument, interfaceDocument, workflowDocument, taskDocument };
    }, { operation: "加载 AIGC 概览" });
  }, [runApiTask]);

  const enabledComfyChannels = (channels?.channels ?? []).filter((item) => item.type === "comfyui" && item.enabled);
  const runnableComfyInterfaces = interfaces.filter((item) => {
    if (item.protocol !== "comfyui" || !item.enabled) return false;
    const workflowId = (item.config as { workflowId?: string }).workflowId;
    return enabledComfyChannels.some((channel) => channel.id === item.channelId)
      && (workflows?.workflows ?? []).some((workflow) => workflow.id === workflowId);
  });
  const primaryComfyChannel = enabledComfyChannels.find((channel) => channel.id === runnableComfyInterfaces[0]?.channelId) ?? enabledComfyChannels[0];

  async function testComfyUi() {
    if (!primaryComfyChannel || testing) return;
    setTesting(true);
    const result = await runApiTask(() => api.testAigcChannel(primaryComfyChannel.id), { operation: "测试 ComfyUI 连接" });
    setTesting(false);
    if (result.status === "success") setConnectionResult({ channelId: primaryComfyChannel.id, ...result.data });
  }

  const cards = [
    { label: "渠道", value: channels?.channels?.length ?? "—", detail: `${channels?.channels?.filter((item) => item.enabled).length ?? 0} 个已启用` },
    { label: "接口", value: interfaces.length || "—", detail: `${interfaces.filter((item) => item.enabled).length} 个可试运行` },
    { label: "工作流", value: workflows?.workflows.length ?? "—", detail: "ComfyUI 编排资产" },
    { label: "任务", value: tasks?.total ?? "—", detail: `${tasks?.running ?? 0} 运行中 · ${tasks?.failed ?? 0} 失败` },
  ];

  return (
    <div className="aigc-workbench-page">
      <header className="aigc-page-heading"><h1>概览</h1><p>从这里确认创作链路是否就绪，并快速进入 OpenAI、Grok 或 ComfyUI 运行。</p></header>
      <div className="aigc-overview-grid">
        {cards.map((card) => (
          <section key={card.label} className="aigc-overview-card">
            <span>{card.label}</span><strong>{card.value}</strong><small>{card.detail}</small>
          </section>
        ))}
      </div>
      <section className="configuration-form-card aigc-readiness-card">
        <div className="configuration-section__heading"><div><span>01</span><h2>ComfyUI 运行就绪检查</h2></div><small>{runnableComfyInterfaces.length ? `${runnableComfyInterfaces.length} 个接口可运行` : "尚未就绪"}</small></div>
        <div className="aigc-readiness-list">
          <ReadinessItem ok={enabledComfyChannels.length > 0} label="已启用 ComfyUI 渠道" detail={enabledComfyChannels.length ? enabledComfyChannels.map((item) => item.name).join("、") : "请先创建并启用渠道"} />
          <ReadinessItem ok={(workflows?.workflows.length ?? 0) > 0} label="已导入工作流" detail={workflows?.workflows.length ? `${workflows.workflows.length} 个工作流可配置` : "请导入 ComfyUI API 工作流 JSON"} />
          <ReadinessItem ok={runnableComfyInterfaces.length > 0} label="已创建运行接口" detail={runnableComfyInterfaces.length ? runnableComfyInterfaces.map((item) => item.name).join("、") : "接口需同时引用已启用渠道和现有工作流"} />
          <ReadinessItem
            ok={connectionResult?.ok === true}
            pending={!connectionResult || connectionResult.channelId !== primaryComfyChannel?.id}
            label="实时连接测试"
            detail={connectionResult && connectionResult.channelId === primaryComfyChannel?.id ? connectionResult.message : "尚未检测，不会仅凭配置宣称可用"}
          />
        </div>
        <div className="aigc-readiness-actions">
          {primaryComfyChannel ? <button type="button" className="configuration-secondary-action" disabled={testing} onClick={() => void testComfyUi()}><TestTube2 size={15} />{testing ? "检测中…" : "测试 ComfyUI 连接"}</button> : <button type="button" className="configuration-secondary-action" onClick={() => navigateTo({ page: "aigc-channels" })}>配置 ComfyUI 渠道</button>}
          {!workflows?.workflows.length ? <button type="button" className="configuration-secondary-action" onClick={() => navigateTo({ page: "aigc-workflows" })}>导入工作流</button> : null}
          {!runnableComfyInterfaces.length ? <button type="button" className="configuration-secondary-action" onClick={() => navigateTo({ page: "aigc-interfaces" })}>创建运行接口</button> : null}
          {runnableComfyInterfaces[0] ? <button type="button" className="configuration-primary-action" onClick={() => navigateTo({ page: "aigc-run", interfaceId: runnableComfyInterfaces[0].id })}><Play size={15} />运行 ComfyUI</button> : null}
        </div>
      </section>
    </div>
  );
}

/** 展示一项可操作的运行前置检查。 */
function ReadinessItem({ ok, pending = false, label, detail }: { ok: boolean; pending?: boolean; label: string; detail: string }) {
  return (
    <div className={ok ? "aigc-readiness-item is-ready" : pending ? "aigc-readiness-item is-pending" : "aigc-readiness-item is-missing"}>
      {ok ? <CheckCircle2 size={18} aria-hidden="true" /> : <AlertTriangle size={18} aria-hidden="true" />}
      <span><strong>{label}</strong><small>{detail}</small></span>
    </div>
  );
}

/** 在 AIGC 编辑表单仍有改动时阻止站内导航与浏览器关闭。 */
export function useAigcUnsavedNavigation(isDirty: boolean) {
  const [pendingRoute, setPendingRoute] = useState<AppRoute>();
  const allowNavigation = useRef(false);

  useEffect(() => {
    if (!isDirty) return;
    const preventUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    const preventNavigation = (event: Event) => {
      if (allowNavigation.current) return;
      event.preventDefault();
      setPendingRoute((event as CustomEvent<AppRoute>).detail);
    };
    window.addEventListener("beforeunload", preventUnload);
    window.addEventListener(NAVIGATION_BEFORE_EVENT, preventNavigation);
    return () => {
      window.removeEventListener("beforeunload", preventUnload);
      window.removeEventListener(NAVIGATION_BEFORE_EVENT, preventNavigation);
    };
  }, [isDirty]);

  return {
    pendingRoute,
    cancel: () => setPendingRoute(undefined),
    confirm: () => {
      if (!pendingRoute) return;
      allowNavigation.current = true;
      const route = pendingRoute;
      setPendingRoute(undefined);
      navigateTo(route);
      window.queueMicrotask(() => { allowNavigation.current = false; });
    },
  };
}

/** 创作台入参字段定义。 */
interface AigcRunFieldDefinition {
  name: string;
  label: string;
  type: AigcWorkflowInputMapping["type"];
  required: boolean;
  options?: Array<string | number | boolean>;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  multiline?: boolean;
  help?: string;
  /** 为 true 时图片或视频输入使用公共 URL 下拉，而不是本地临时上传。 */
  publicUrl?: boolean;
  /** ComfyUI 媒体入参对应的节点类型，用于读取 input 目录候选。 */
  nodeClass?: string;
  /** ComfyUI 媒体入参的字段路径，例如 inputs.image。 */
  fieldPath?: string;
}

/** 创作台：选择已启用接口，按能力或 ComfyUI 映射动态生成入参并提交试运行。 */
function AigcRunPage({ preferredInterfaceId }: { preferredInterfaceId?: string }) {
  const { runApiTask } = useApiTask();
  const online = useOnlineStatus();
  const [interfaces, setInterfaces] = useState<AigcInterfaceRecord[]>([]);
  const [channels, setChannels] = useState<AigcRuntimeChannelSummary[]>([]);
  const [provider, setProvider] = useState<AigcInterfaceProtocol>("openai");
  const [selectedId, setSelectedId] = useState("");
  const [workflow, setWorkflow] = useState<AigcWorkflowDetail>();
  const [values, setValues] = useState<Record<string, AigcRunInputValue>>({});
  const [uploads, setUploads] = useState<Record<string, AigcUploadedAsset>>({});
  const [publicFiles, setPublicFiles] = useState<AigcPublicFileSummary[]>([]);
  const [mediaSources, setMediaSources] = useState<Record<string, AigcRunMediaSource>>({});
  const [comfyInputFiles, setComfyInputFiles] = useState<Record<string, AigcComfyUiInputFile[]>>({});
  const [comfyInputLoading, setComfyInputLoading] = useState<Record<string, boolean>>({});
  const [uploading, setUploading] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [createdTask, setCreatedTask] = useState<AigcTaskRecord>();
  const [activeAssetId, setActiveAssetId] = useState("");
  const [previewAsset, setPreviewAsset] = useState<AigcTaskAsset>();
  const [connectionResult, setConnectionResult] = useState<{ ok: boolean; message: string }>();
  const [testingConnection, setTestingConnection] = useState(false);

  const enabledInterfaces = interfaces.filter((item) => item.enabled);
  const providerInterfaces = enabledInterfaces.filter((item) => item.protocol === provider);
  const selected = enabledInterfaces.find((item) => item.id === selectedId);
  const fields = selected ? runFields(selected, workflow) : [];
  const selectedChannelReady = Boolean(selected && channels.some((channel) => channel.id === selected.channelId && channel.enabled));
  const selectedReady = Boolean(selected && selectedChannelReady && (selected.protocol !== "comfyui" || workflow));
  const taskActive = createdTask?.status === "queued" || createdTask?.status === "running";

  useEffect(() => {
    void runApiTask(async () => {
      const [document, channelDocument] = await Promise.all([api.getAigcInterfaces(), api.getAigcRuntimeChannels()]);
      setInterfaces(document.interfaces);
      setChannels(channelDocument.channels);
      return document;
    }, { operation: "加载可用的 AIGC 接口" }).then((result) => {
      if (result.status !== "success") return;
      const preferred = result.data.interfaces.find((item) => item.enabled && item.id === preferredInterfaceId);
      const firstEnabled = preferred ?? result.data.interfaces.find((item) => item.enabled);
      if (firstEnabled) setProvider(firstEnabled.protocol);
      if (firstEnabled) setSelectedId(firstEnabled.id);
    });
  }, [preferredInterfaceId, runApiTask]);

  useEffect(() => {
    void runApiTask(async () => {
      const document = await api.getAigcPublicFiles();
      setPublicFiles(document.files);
      return document;
    }, { operation: "加载 AIGC 公共文件" });
  }, [runApiTask]);

  useEffect(() => {
    setCreatedTask(undefined);
    setActiveAssetId("");
    setPreviewAsset(undefined);
    setMessage("");
    setConnectionResult(undefined);
    if (!selected) {
      setWorkflow(undefined);
      setValues({});
      setUploads({});
      setMediaSources({});
      setComfyInputFiles({});
      setComfyInputLoading({});
      return;
    }
    if (selected.protocol !== "comfyui") {
      setWorkflow(undefined);
      setValues(initialGrokOrOpenAiValues(selected));
      setUploads({});
      setMediaSources({});
      setComfyInputFiles({});
      setComfyInputLoading({});
      return;
    }
    const workflowId = (selected.config as { workflowId?: string }).workflowId;
    if (!workflowId) {
      setWorkflow(undefined);
      setValues({});
      setUploads({});
      setMediaSources({});
      setComfyInputFiles({});
      setComfyInputLoading({});
      return;
    }
    void runApiTask(async () => {
      const next = await api.getAigcWorkflow(workflowId);
      setWorkflow(next.workflow);
      setValues(initialComfyUiValues(next.workflow));
      setUploads({});
      setMediaSources({});
      setComfyInputFiles({});
      setComfyInputLoading({});
      return next;
    }, { operation: "加载 ComfyUI 入参", expected: aigcExpected(setMessage) });
  }, [runApiTask, selected?.id]);

  useEffect(() => {
    const taskId = createdTask?.id;
    if (!taskId || (createdTask.status !== "queued" && createdTask.status !== "running")) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await api.getAigcTask(taskId);
        if (!disposed) setCreatedTask((current) => current?.id === taskId ? next : current);
      } catch {
        // 短暂的轮询失败不覆盖已展示的任务状态，下一轮继续尝试。
      }
    };
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [createdTask?.id, createdTask?.status]);

  useEffect(() => {
    const assets = createdTask?.assets ?? [];
    setActiveAssetId((current) => assets.some((asset) => asset.id === current) ? current : assets[0]?.id ?? "");
  }, [createdTask?.id, createdTask?.assets]);

  useEffect(() => {
    if (!previewAsset) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewAsset(undefined);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [previewAsset]);

  function changeProvider(nextProvider: AigcInterfaceProtocol) {
    if (taskActive) return;
    setProvider(nextProvider);
    setSelectedId(enabledInterfaces.find((item) => item.protocol === nextProvider)?.id ?? "");
  }

  async function testSelectedConnection() {
    if (!selected || testingConnection) return;
    setTestingConnection(true);
    const result = await runApiTask(() => api.testAigcChannel(selected.channelId), { operation: `测试 ${interfaceProtocolName(selected.protocol)} 连接`, expected: aigcExpected(setMessage) });
    setTestingConnection(false);
    if (result.status === "success") setConnectionResult(result.data);
  }

  async function uploadFile(field: AigcRunFieldDefinition, file?: File) {
    if (!file) return;
    setMessage("");
    setUploading(field.name);
    const result = await runApiTask(() => api.uploadAigcInput(file), { operation: `上传 ${field.label}`, expected: aigcExpected(setMessage) });
    setUploading(undefined);
    if (result.status !== "success") return;
    setUploads((current) => ({ ...current, [field.name]: result.data.asset }));
    setValues((current) => ({
      ...current,
      [field.name]: {
        assetId: result.data.asset.id,
        name: result.data.asset.name,
        mediaType: result.data.asset.mediaType,
      },
    }));
  }

  async function uploadPublicFile(field: AigcRunFieldDefinition, file?: File) {
    if (!file) return;
    setMessage("");
    setUploading(field.name);
    const result = await runApiTask(() => api.uploadAigcPublicFile(file), { operation: `上传 ${field.label} 公共文件`, expected: aigcExpected(setMessage) });
    setUploading(undefined);
    if (result.status !== "success") return;
    setPublicFiles((current) => [result.data.file, ...current.filter((item) => item.id !== result.data.file.id)]);
    setValues((current) => ({
      ...current,
      [field.name]: {
        url: result.data.file.url,
        name: result.data.file.name,
        mediaType: result.data.file.mediaType,
      },
    }));
  }

  function changeMediaSource(field: AigcRunFieldDefinition, source: AigcRunMediaSource) {
    if (source === "comfyui_input" && selected?.protocol !== "comfyui") return;
    setMediaSources((current) => ({ ...current, [field.name]: source }));
    setValues((current) => {
      const next = { ...current };
      delete next[field.name];
      return next;
    });
    setUploads((current) => {
      const next = { ...current };
      delete next[field.name];
      return next;
    });
    if (source === "comfyui_input") void loadComfyInputFiles(field);
  }

  async function loadComfyInputFiles(field: AigcRunFieldDefinition) {
    if (!selected || !field.nodeClass || !field.fieldPath) return;
    setComfyInputLoading((current) => ({ ...current, [field.name]: true }));
    const result = await runApiTask(
      () => api.getAigcComfyUiInputFiles(selected.channelId, field.nodeClass!, field.fieldPath!),
      { operation: `读取 ComfyUI input`, expected: aigcExpected(setMessage) },
    );
    setComfyInputLoading((current) => ({ ...current, [field.name]: false }));
    if (result.status !== "success") return;
    setComfyInputFiles((current) => ({ ...current, [field.name]: result.data.files }));
  }

  function selectPublicMediaFile(field: AigcRunFieldDefinition, file: AigcPublicFileSummary) {
    setValues((current) => ({
      ...current,
      [field.name]: {
        assetId: file.id,
        name: file.name,
        mediaType: file.mediaType,
        source: "public",
      },
    }));
  }

  function selectComfyInputFile(field: AigcRunFieldDefinition, file: AigcComfyUiInputFile) {
    if (selected?.protocol !== "comfyui") return;
    setValues((current) => ({
      ...current,
      [field.name]: {
        filename: file.filename,
        name: file.name,
        mediaType: file.mediaType,
        ...(file.subfolder ? { subfolder: file.subfolder } : {}),
        ...(file.type ? { type: file.type } : {}),
        source: "comfyui_input",
      },
    }));
  }

  async function submit() {
    if (!selected || !online || submitting || taskActive) return;
    setMessage("");
    setCreatedTask(undefined);
    setActiveAssetId("");
    setPreviewAsset(undefined);
    const inputs: Record<string, AigcRunInputValue> = {};
    for (const field of fields) {
      const value = coerceRunValue(field, values[field.name]);
      if (field.required && (value === undefined || value === "")) {
        setMessage(`请填写 ${field.label}`);
        return;
      }
      if (value !== undefined && value !== "") inputs[field.name] = value;
    }
    if (!selectedReady) {
      setMessage("当前接口的渠道或工作流尚未就绪，请先修复运行检查项。");
      return;
    }
    setSubmitting(true);
    const result = await runApiTask(() => api.runAigcInterface({ interfaceId: selected.id, inputs }), {
      operation: "创建 AIGC 生成任务",
      expected: aigcExpected(setMessage),
    });
    setSubmitting(false);
    if (result.status !== "success") return;
    setCreatedTask(result.data);
    setActiveAssetId(result.data.assets[0]?.id ?? "");
    setMessage("生成任务已创建，运行状态与产物会在当前页面更新。");
  }

  const actionStatus = runActionStatus({ task: createdTask, uploading: uploading !== undefined, ready: selectedReady });
  const displayItems = runDisplayItems(fields, workflow, values);

  function renderRunField(field: AigcRunFieldDefinition) {
    return (
      <AigcRunField
        key={field.name}
        field={field}
        value={values[field.name]}
        uploaded={uploads[field.name]}
        uploading={uploading === field.name}
        publicFiles={publicFiles}
        mediaSource={mediaSources[field.name] ?? "upload"}
        allowComfyInput={selected?.protocol === "comfyui"}
        comfyInputFiles={comfyInputFiles[field.name] ?? []}
        comfyInputLoading={comfyInputLoading[field.name] === true}
        comfyChannelId={selected?.protocol === "comfyui" ? selected.channelId : undefined}
        onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
        onFile={(file) => void uploadFile(field, file)}
        onPublicFile={(file) => void uploadPublicFile(field, file)}
        onMediaSourceChange={(source) => changeMediaSource(field, source)}
        onSelectPublicFile={(file) => selectPublicMediaFile(field, file)}
        onSelectComfyInputFile={(file) => selectComfyInputFile(field, file)}
      />
    );
  }

  function clearRunField(field: AigcRunFieldDefinition) {
    setValues((current) => { const next = { ...current }; delete next[field.name]; return next; });
    setUploads((current) => { const next = { ...current }; delete next[field.name]; return next; });
  }

  return (
    <div className={selected?.protocol === "comfyui" ? "aigc-workbench-page aigc-run-page has-readiness" : "aigc-workbench-page aigc-run-page"}>
      <div className="aigc-run-toolbar">
        <header className="aigc-page-heading aigc-run-heading">
          <h1>创作与运行</h1>
          <p className={message ? "aigc-run-message" : "aigc-run-message is-empty"} role="status">{message || "选择渠道、接口和参数后开始生成"}</p>
        </header>
        <AigcProviderControl
          options={(["openai", "grok", "comfyui"] as const).map((item) => ({
            value: item,
            label: interfaceProtocolName(item),
            count: enabledInterfaces.filter((candidate) => candidate.protocol === item).length,
          }))}
          value={provider}
          onChange={changeProvider}
          disabled={taskActive}
        />
        <label className="aigc-run-control">
          <span>接口</span>
          <select aria-label="AIGC 接口" value={selectedId} disabled={taskActive} onChange={(event) => setSelectedId(event.target.value)}>
            <option value="">请选择已启用接口</option>
            {providerInterfaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
      </div>

      {selected?.protocol === "comfyui" ? (
        <section className="aigc-run-readiness" aria-label="ComfyUI 运行检查">
          <AigcRunReadinessItem ok={selectedChannelReady} label="执行渠道" detail={channels.find((channel) => channel.id === selected.channelId)?.name ?? "引用的渠道不存在"} />
          <AigcRunReadinessItem ok={Boolean(workflow)} label="工作流" detail={workflow?.name ?? "引用的工作流不存在或尚未加载"} />
          <AigcRunReadinessItem ok={connectionResult?.ok === true} pending={!connectionResult} label="连接检查" detail={connectionResult?.message ?? "尚未检测"} />
          <button type="button" className="configuration-secondary-action" disabled={testingConnection} onClick={() => void testSelectedConnection()}><TestTube2 size={14} />{testingConnection ? "检测中…" : "测试连接"}</button>
        </section>
      ) : null}

      <div className="aigc-run-workspace">
        <section className="aigc-run-parameters" aria-labelledby="aigc-run-parameters-title">
          <div className="configuration-section__heading aigc-run-pane-heading">
            <div><h2 id="aigc-run-parameters-title">生成参数</h2><small>{selected ? `${capabilityLabel(selected.protocol, selected.capability)} · ${fields.length} 项` : "尚未选择接口"}</small></div>
          </div>
          <div className="aigc-run-parameter-scroll">
            {selected ? displayItems.map((item) => item.kind === "field" ? renderRunField(item.field) : (
              <section key={item.group.id} className="aigc-run-reference-group" aria-labelledby={`reference-group-${item.group.id}`}>
                <div className="aigc-run-reference-group__heading"><div><strong id={`reference-group-${item.group.id}`}>{item.group.label}</strong><small>{item.filledCount}/{item.fields.length} 已添加</small></div><span>{item.group.type}</span></div>
                <div className="aigc-run-reference-group__slots">
                  {item.visibleFields.map((field) => <div key={field.name} className="aigc-run-reference-slot"><div className="aigc-run-reference-slot__heading"><span>槽位 {item.fields.indexOf(field) + 1}</span>{hasRunValue(values[field.name]) ? <button type="button" className="icon-button" aria-label={`清空${field.label}`} title="清空槽位" onClick={() => clearRunField(field)}><Trash2 size={14} /></button> : null}</div>{renderRunField(field)}</div>)}
                </div>
              </section>
            )) : (
              <div className="aigc-run-empty"><Boxes size={22} aria-hidden="true" /><p>暂无已启用的 {interfaceProtocolName(provider)} 接口。</p><button type="button" className="configuration-secondary-action" onClick={() => navigateTo({ page: "aigc-interfaces" })}>创建接口</button></div>
            )}
            {selected && !fields.length ? <p className="configuration-help">该接口无需额外入参，可直接开始生成。</p> : null}
            {selected && !selectedChannelReady ? <p className="configuration-help aigc-warning-copy">引用的渠道不存在或未启用，请先修复接口配置。</p> : null}
          </div>
          <div className="aigc-run-action-bar">
            <span className="aigc-run-action-status" role="status" aria-live="polite" title={actionStatus.full}>{actionStatus.short}</span>
            <button type="button" className="configuration-primary-action" disabled={!online || !selectedReady || submitting || uploading !== undefined || taskActive} onClick={() => void submit()}>
              <Play size={15} />{submitting ? "正在创建…" : taskActive ? "生成中" : "开始生成"}
            </button>
          </div>
        </section>

        <AigcRunPreview
          task={createdTask}
          activeAssetId={activeAssetId}
          onActiveAssetChange={setActiveAssetId}
          onOpenImage={setPreviewAsset}
        />
      </div>
      {previewAsset && createdTask ? <div className="media-lightbox" role="dialog" aria-modal="true" aria-label={`${previewAsset.name} 大图预览`}><button type="button" className="media-lightbox__close" aria-label="关闭产物预览" onClick={() => setPreviewAsset(undefined)}><X size={20} /></button><div className="media-lightbox__stage"><img src={aigcTaskAssetUrl(createdTask.id, previewAsset.id)} alt={previewAsset.name} /></div></div> : null}
    </div>
  );
}

interface AigcProviderOption<T extends string> {
  value: T;
  label: string;
  count: number;
}

/** 渠道较少时使用分段控件，超过三个时切换为等高下拉框。 */
export function AigcProviderControl<T extends string>({ options, value, onChange, disabled = false }: {
  options: readonly AigcProviderOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="aigc-run-control">
      <span>渠道</span>
      {options.length > 3 ? (
        <ConfigurationSelect
          ariaLabel="渠道"
          options={options.map((option) => ({ value: option.value, label: option.label, description: `${option.count} 个接口` }))}
          value={value}
          disabled={disabled}
          onChange={onChange}
        />
      ) : (
        <div className="scheduled-task-segmented aigc-run-provider-tabs" role="tablist" aria-label="生成服务">
          {options.map((option) => (
            <button key={option.value} type="button" role="tab" aria-selected={value === option.value} disabled={disabled} className={value === option.value ? "is-active" : undefined} onClick={() => onChange(option.value)}>
              <span>{option.label}</span><small> · {option.count}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 紧凑展示一项 ComfyUI 运行前置状态。 */
function AigcRunReadinessItem({ ok, pending = false, label, detail }: { ok: boolean; pending?: boolean; label: string; detail: string }) {
  return (
    <div className={ok ? "aigc-readiness-item aigc-run-readiness-item is-ready" : pending ? "aigc-readiness-item aigc-run-readiness-item is-pending" : "aigc-readiness-item aigc-run-readiness-item is-missing"}>
      {ok ? <CheckCircle2 size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}
      <span><strong>{label}</strong><small>{detail}</small></span>
    </div>
  );
}

/** 在创作台中展示当前任务状态，并支持切换图片、视频和音频产物。 */
function AigcRunPreview({ task, activeAssetId, onActiveAssetChange, onOpenImage }: {
  task?: AigcTaskRecord;
  activeAssetId: string;
  onActiveAssetChange: (assetId: string) => void;
  onOpenImage: (asset: AigcTaskAsset) => void;
}) {
  const activeAsset = task?.assets.find((asset) => asset.id === activeAssetId) ?? task?.assets[0];
  const source = task && activeAsset ? aigcTaskAssetUrl(task.id, activeAsset.id) : "";
  return (
    <section className="aigc-run-preview" aria-labelledby="aigc-run-preview-title">
      <div className="configuration-section__heading aigc-run-pane-heading">
        <div><h2 id="aigc-run-preview-title">产物预览</h2><small>{task ? `${task.interfaceName} · ${task.assets.length} 个产物` : "等待生成"}</small></div>
        <div className="aigc-run-preview-actions">
          {task ? <span className={`aigc-status-badge is-${task.status}`}>{taskStatusLabel(task.status)}</span> : null}
          {task && activeAsset ? <a className="icon-button" href={aigcTaskAssetUrl(task.id, activeAsset.id, true)} download={activeAsset.name} aria-label={`下载 ${activeAsset.name}`} title="下载产物"><Download size={15} /></a> : null}
          {task ? <a className="icon-button" href={`/aigc/tasks/${encodeURIComponent(task.id)}`} aria-label="查看任务详情" title="查看任务详情" onClick={(event) => { event.preventDefault(); navigateTo({ page: "aigc-task-detail", taskId: task.id }); }}><Activity size={15} /></a> : null}
        </div>
      </div>
      <div className="aigc-run-preview-stage">
        {task && activeAsset?.mediaType.startsWith("image/") ? <button type="button" className="aigc-run-preview-image" aria-label={`放大预览 ${activeAsset.name}`} onClick={() => onOpenImage(activeAsset)}><img src={source} alt={activeAsset.name} /></button> : null}
        {task && activeAsset?.mediaType.startsWith("video/") ? <video key={activeAsset.id} src={source} controls preload="metadata" aria-label={activeAsset.name} /> : null}
        {task && activeAsset?.mediaType.startsWith("audio/") ? <div className="aigc-run-audio"><AudioLines size={34} aria-hidden="true" /><strong>{activeAsset.name}</strong><audio key={activeAsset.id} src={source} controls preload="metadata" aria-label={activeAsset.name} /></div> : null}
        {task && activeAsset && !isPreviewableMedia(activeAsset.mediaType) ? <div className="aigc-run-preview-empty"><File size={30} aria-hidden="true" /><strong>{activeAsset.name}</strong><p>{activeAsset.mediaType}</p></div> : null}
        {task && !activeAsset ? <AigcRunPreviewState task={task} /> : null}
        {!task ? <div className="aigc-run-preview-empty"><ImageIcon size={30} aria-hidden="true" /><strong>等待生成</strong><p>尚未创建任务</p></div> : null}
      </div>
      {task && task.assets.length ? (
        <div className="aigc-task-actions aigc-run-output-switcher" role="tablist" aria-label="产物切换">
          {task.assets.map((asset, index) => (
            <button key={asset.id} type="button" role="tab" aria-selected={activeAsset?.id === asset.id} className={activeAsset?.id === asset.id ? "is-selected" : undefined} onClick={() => onActiveAssetChange(asset.id)}>
              <AigcAssetIcon mediaType={asset.mediaType} />
              <span><strong>{asset.name}</strong><small> · {index + 1} / {task.assets.length} · {formatFileSize(asset.size)}</small></span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** 根据未产出文件的任务终态展示明确反馈。 */
function AigcRunPreviewState({ task }: { task: AigcTaskRecord }) {
  if (task.status === "failed") return <div className="aigc-run-preview-empty is-error"><AlertTriangle size={30} aria-hidden="true" /><strong>生成失败</strong><p>{task.error?.message ?? "上游服务未返回可用结果"}</p></div>;
  if (task.status === "cancelled") return <div className="aigc-run-preview-empty"><X size={30} aria-hidden="true" /><strong>任务已取消</strong><p>可以调整参数后重新生成。</p></div>;
  if (task.status === "succeeded") return <div className="aigc-run-preview-empty"><File size={30} aria-hidden="true" /><strong>未提取到产物</strong><p>请检查接口或工作流输出映射。</p></div>;
  return <div className="aigc-run-preview-empty is-running"><RefreshCw size={30} aria-hidden="true" /><strong>{task.status === "queued" ? "等待执行" : "正在生成"}</strong><p>{task.queueReason ?? "任务状态每 3 秒自动更新。"}</p></div>;
}

/** 生成动作栏的短状态，完整内容通过 title 保留。 */
function runActionStatus({ task, uploading, ready }: { task?: AigcTaskRecord; uploading: boolean; ready: boolean }): { short: string; full: string } {
  if (uploading) return { short: "正在上传入参…", full: "正在将生成入参上传到 BugPaw" };
  if (!task) {
    const text = ready ? "接口已就绪" : "请先完成运行检查";
    return { short: text, full: text };
  }
  if (task.status === "succeeded") {
    const text = `生成完成 · ${task.assets.length} 个产物`;
    return { short: text, full: text };
  }
  if (task.status === "failed") return { short: "生成失败", full: task.error?.message ?? "生成失败" };
  if (task.status === "cancelled") return { short: "任务已取消", full: "任务已取消" };
  if (task.queueReason) return { short: "本地排队中", full: task.queueReason };
  if (!task.execution) {
    const text = task.status === "queued" ? "任务排队中" : "正在生成";
    return { short: text, full: text };
  }
  return executionStatusText(task.execution);
}

/** 把节点事件压缩成动作栏可安全截断的一行文本。 */
function executionStatusText(state: AigcTaskExecutionState): { short: string; full: string } {
  if (state.phase === "uploading") return { short: "上传 ComfyUI 入参", full: "正在向 ComfyUI 上传工作流媒体入参" };
  if (state.phase === "submitting") return { short: "提交 ComfyUI 工作流", full: "正在向 ComfyUI 提交工作流" };
  if (state.phase === "queued") {
    const text = state.queueAhead && state.queueAhead > 0 ? `排队中 · 前方 ${state.queueAhead} 个任务` : "等待 ComfyUI 执行";
    return { short: text, full: text };
  }
  if (state.phase === "downloading") return { short: "整理生成产物", full: "工作流已完成，正在下载并整理生成产物" };
  const nodeName = state.currentNodeName || state.currentNodeType || (state.currentNodeId ? `节点 ${state.currentNodeId}` : "工作流节点");
  const nodeProgress = state.progressMax && state.progressMax > 0 && state.progressValue !== undefined
    ? ` · ${state.progressValue}/${state.progressMax}`
    : "";
  const short = `执行中 · ${nodeName}${nodeProgress}`;
  const nodeId = state.currentNodeId ? `（节点 ${state.currentNodeId}）` : "";
  const completed = state.completedNodes !== undefined && state.totalNodes !== undefined
    ? `，已完成 ${state.completedNodes}/${state.totalNodes} 个节点`
    : "";
  return { short, full: `正在执行 ${nodeName}${nodeId}${nodeProgress}${completed}` };
}

/** 返回适合产物类型的轻量图标。 */
function AigcAssetIcon({ mediaType }: { mediaType: string }) {
  if (mediaType.startsWith("image/")) return <ImageIcon size={16} aria-hidden="true" />;
  if (mediaType.startsWith("video/")) return <Film size={16} aria-hidden="true" />;
  if (mediaType.startsWith("audio/")) return <AudioLines size={16} aria-hidden="true" />;
  return <File size={16} aria-hidden="true" />;
}

/** 判断浏览器能否在创作台内联预览该媒体类型。 */
function isPreviewableMedia(mediaType: string): boolean {
  return mediaType.startsWith("image/") || mediaType.startsWith("video/") || mediaType.startsWith("audio/");
}

/** 渲染单个 AIGC 入参字段。 */
function AigcRunField(props: {
  field: AigcRunFieldDefinition;
  value: AigcRunInputValue | undefined;
  uploaded?: AigcUploadedAsset;
  uploading: boolean;
  publicFiles: AigcPublicFileSummary[];
  mediaSource: AigcRunMediaSource;
  allowComfyInput: boolean;
  comfyInputFiles: AigcComfyUiInputFile[];
  comfyInputLoading: boolean;
  comfyChannelId?: string;
  onChange: (value: AigcRunInputValue) => void;
  onFile: (file?: File) => void;
  onPublicFile: (file?: File) => void;
  onMediaSourceChange: (source: AigcRunMediaSource) => void;
  onSelectPublicFile: (file: AigcPublicFileSummary) => void;
  onSelectComfyInputFile: (file: AigcComfyUiInputFile) => void;
}) {
  const {
    field,
    value,
    uploaded,
    uploading,
    publicFiles,
    mediaSource,
    allowComfyInput,
    comfyInputFiles,
    comfyInputLoading,
    comfyChannelId,
    onChange,
    onFile,
    onPublicFile,
    onMediaSourceChange,
    onSelectPublicFile,
    onSelectComfyInputFile,
  } = props;
  if (field.type === "bool") {
    return (
      <label className="configuration-check-line aigc-run-field aigc-run-field--bool">
        <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
        <span>{field.label}{field.required ? " *" : ""}</span>
      </label>
    );
  }
  if (field.type === "enum") {
    return (
      <div className="aigc-run-field">
        <span>{field.label}{field.required ? " *" : ""}</span>
        <ConfigurationSelect
          ariaLabel={field.label}
          options={(field.options ?? []).map((option) => ({ value: option, label: String(option) }))}
          value={typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined}
          onChange={onChange}
        />
        {field.help ? <small>{field.help}</small> : null}
      </div>
    );
  }
  if (field.type === "image" || field.type === "video" || field.type === "audio") {
    const accept = field.type === "video" ? "video/*" : field.type === "audio" ? "audio/*" : "image/*";
    if (field.publicUrl) {
      const selectedUrl = publicUrlFromValue(value);
      const availableFiles = publicFiles.filter((file) => file.mediaType.startsWith(`${field.type}/`));
      return (
        <div className="configuration-field-row aigc-run-field aigc-run-field--wide">
          <label>
            <span>{field.label}{field.required ? " *" : ""}</span>
            <ConfigurationSelect
              ariaLabel={`${field.label}公共文件`}
              options={availableFiles.map((file) => ({ value: file.url, label: file.name }))}
              value={selectedUrl}
              placeholder="请选择公共文件"
              onChange={(url) => {
                const selectedFile = availableFiles.find((file) => file.url === url);
                if (selectedFile) {
                  onChange({ url: selectedFile.url, name: selectedFile.name, mediaType: selectedFile.mediaType });
                }
              }}
            />
          </label>
          <label>
            <span>上传到公共区</span>
            <input type="file" accept={accept} aria-label={`上传${field.label}到公共区`} onChange={(event) => onPublicFile(event.target.files?.[0])} />
          </label>
          <small className="configuration-help">{uploading ? "上传中…" : selectedUrl || "选择公共文件或上传后自动填充公网地址"}</small>
        </div>
      );
    }
    const availableFiles = publicFiles.filter((file) => file.mediaType.startsWith(`${field.type}/`));
    const selectedPublicId = publicMediaIdFromValue(value);
    const selectedComfyInput = comfyInputFileFromValue(value);
    return (
      <div className="aigc-run-field aigc-run-field--wide aigc-media-input">
        <div className="aigc-media-input__controls">
          <span>{field.label}{field.required ? " *" : ""}</span>
          <div className="aigc-media-source-tabs" role="tablist" aria-label={`${field.label}输入来源`}>
            {mediaSourceOptions.filter((option) => option.value !== "comfyui_input" || allowComfyInput).map((option) => (
              <button
                key={option.value}
                type="button"
                role="tab"
                aria-selected={mediaSource === option.value}
                className={mediaSource === option.value ? "is-selected" : undefined}
                onClick={() => onMediaSourceChange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {mediaSource === "upload" ? (
            <label className="aigc-media-input-upload">
              <span>本地上传</span>
              <input type="file" accept={accept} aria-label={field.label} onChange={(event) => onFile(event.target.files?.[0])} />
              <small className="configuration-help">{uploading ? "上传中…" : uploaded?.name ?? "上传后作为生成入参"}</small>
            </label>
          ) : null}
          {mediaSource === "public" ? (
            <label>
              <span>BugPaw 公开目录</span>
              <ConfigurationSelect
                ariaLabel={`${field.label}公开目录`}
                options={availableFiles.map((file) => ({ value: file.id, label: file.name }))}
                value={selectedPublicId}
                placeholder="请选择公开目录文件"
                onChange={(id) => {
                  const selectedFile = availableFiles.find((file) => file.id === id);
                  if (selectedFile) onSelectPublicFile(selectedFile);
                }}
              />
            </label>
          ) : null}
          {allowComfyInput && mediaSource === "comfyui_input" ? (
            <label>
              <span>ComfyUI input</span>
              <ConfigurationSelect
                ariaLabel={`${field.label}ComfyUI input`}
                options={comfyInputFiles.map((file) => ({
                  value: comfyInputFileKey(file),
                  label: file.name,
                  ...(file.subfolder ? { description: file.subfolder } : {}),
                }))}
                value={selectedComfyInput ? comfyInputFileKey(selectedComfyInput) : undefined}
                disabled={comfyInputLoading}
                placeholder={comfyInputLoading ? "正在读取 input 目录…" : "请选择 ComfyUI input 文件"}
                onChange={(key) => {
                  const selectedFile = comfyInputFiles.find((file) => comfyInputFileKey(file) === key);
                  if (selectedFile) onSelectComfyInputFile(selectedFile);
                }}
              />
            </label>
          ) : null}
          {field.help ? <small className="configuration-help">{field.help}</small> : null}
        </div>
        <div className="aigc-media-input__preview">
          <MediaInputPreview
            field={field}
            value={value}
            uploaded={uploaded}
            publicFiles={publicFiles}
            comfyChannelId={comfyChannelId}
          />
        </div>
      </div>
    );
  }
  const isNumber = field.type === "int" || field.type === "double";
  const inputValue = typeof value === "number" || typeof value === "string" ? value : "";
  const multiline = field.type === "string" && (field.multiline || field.name === "prompt" || field.label.includes("提示词"));
  return (
    <label className={multiline ? "aigc-run-field aigc-run-field--wide" : "aigc-run-field"}>
      <span>{field.label}{field.required ? " *" : ""}</span>
      {multiline ? <textarea rows={4} placeholder={field.placeholder} aria-label={field.label} value={inputValue} onChange={(event) => onChange(event.target.value)} /> : (
        <input
          type={isNumber ? "number" : "text"}
          min={field.min}
          max={field.max}
          step={field.step ?? (field.type === "double" ? "any" : undefined)}
          placeholder={field.placeholder}
          aria-label={field.label}
          value={inputValue}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {field.help ? <small>{field.help}</small> : null}
    </label>
  );
}

const mediaSourceOptions: Array<{ value: AigcRunMediaSource; label: string }> = [
  { value: "upload", label: "本地上传" },
  { value: "public", label: "公开目录" },
  { value: "comfyui_input", label: "ComfyUI input" },
];

/** 从媒体入参中读取 BugPaw 公共文件 ID。 */
function publicMediaIdFromValue(value: AigcRunInputValue | undefined): string | undefined {
  if (typeof value === "object" && value !== null && "assetId" in value && value.source === "public") return value.assetId;
  return undefined;
}

/** 从媒体入参中读取 ComfyUI input 文件。 */
function comfyInputFileFromValue(value: AigcRunInputValue | undefined): AigcComfyUiInputFile | undefined {
  if (typeof value === "object" && value !== null && "filename" in value && value.source === "comfyui_input") {
    return {
      filename: value.filename,
      name: value.name,
      mediaType: value.mediaType,
      ...(typeof value.subfolder === "string" ? { subfolder: value.subfolder } : {}),
      ...(typeof value.type === "string" ? { type: value.type } : {}),
    };
  }
  return undefined;
}

/** 使用完整文件定位信息区分 ComfyUI input 中可能同名的候选。 */
function comfyInputFileKey(file: Pick<AigcComfyUiInputFile, "filename" | "subfolder" | "type">): string {
  return JSON.stringify([file.type ?? "input", file.subfolder ?? "", file.filename]);
}

/** 为已选择的媒体入参展示内联预览和来源说明。 */
function MediaInputPreview({ field, value, uploaded, publicFiles, comfyChannelId }: {
  field: AigcRunFieldDefinition;
  value: AigcRunInputValue | undefined;
  uploaded?: AigcUploadedAsset;
  publicFiles: AigcPublicFileSummary[];
  comfyChannelId?: string;
}) {
  const source = mediaPreviewSource(field, value, uploaded, publicFiles, comfyChannelId);
  if (!source.url) {
    return <small className="configuration-help">{source.label}</small>;
  }
  if (source.mediaType.startsWith("image/")) return <img className="aigc-media-input-preview" src={source.url} alt={source.label} />;
  if (source.mediaType.startsWith("video/")) return <video className="aigc-media-input-preview" src={source.url} controls preload="metadata" aria-label={source.label} />;
  if (source.mediaType.startsWith("audio/")) return <audio className="aigc-media-input-preview" src={source.url} controls preload="metadata" aria-label={source.label} />;
  return <small className="configuration-help">{source.label}</small>;
}

/** 汇总媒体入参的预览地址与说明。 */
function mediaPreviewSource(
  field: AigcRunFieldDefinition,
  value: AigcRunInputValue | undefined,
  uploaded: AigcUploadedAsset | undefined,
  publicFiles: AigcPublicFileSummary[],
  comfyChannelId: string | undefined,
): { url?: string; mediaType: string; label: string } {
  if (typeof value !== "object" || value === null) {
    return { mediaType: "application/octet-stream", label: "请先选择生成入参" };
  }
  if ("url" in value && typeof value.url === "string") {
    return { url: value.url, mediaType: value.mediaType, label: value.name };
  }
  if ("assetId" in value && value.source === "public") {
    const publicFile = publicFiles.find((file) => file.id === value.assetId);
    return {
      url: publicFile?.url,
      mediaType: value.mediaType,
      label: publicFile?.name ?? value.name,
    };
  }
  if ("assetId" in value && value.source !== "public") {
    return {
      url: aigcInputAssetUrl(value.assetId),
      mediaType: value.mediaType,
      label: uploaded?.name ?? value.name,
    };
  }
  if ("filename" in value) {
    const file = comfyInputFileFromValue(value);
    return {
      url: comfyChannelId && file ? aigcComfyUiInputContentUrl(comfyChannelId, file) : undefined,
      mediaType: value.mediaType,
      label: value.name,
    };
  }
  return { mediaType: "application/octet-stream", label: "请先选择生成入参" };
}

/** 从公共 URL 类型输入值中读取当前地址。 */
function publicUrlFromValue(value: AigcRunInputValue | undefined): string {
  if (typeof value === "object" && value !== null && "url" in value && typeof value.url === "string") return value.url;
  return "";
}

/** 根据接口协议和工作流映射生成创作台字段。 */
function runFields(item: AigcInterfaceRecord, workflow?: AigcWorkflowDetail): AigcRunFieldDefinition[] {
  if (item.protocol === "comfyui") {
    return (workflow?.inputMappings ?? []).map((mapping) => {
      const node = workflow?.nodes.find((candidate) => candidate.id === mapping.nodeId);
      const metadata = workflow ? resolvedWorkflowFieldMetadata(workflow, mapping.nodeId, mapping.field) : undefined;
      return {
        name: mapping.name,
        label: mapping.description || mapping.name,
        type: mapping.type,
        required: mapping.required,
        options: metadata?.enumOptions?.length ? metadata.enumOptions : mapping.enumOptions,
        placeholder: metadata?.placeholder || mapping.description || `输入 ${mapping.name}`,
        min: metadata?.min,
        max: metadata?.max,
        step: metadata?.step,
        multiline: metadata?.multiline,
        help: [metadata?.tooltip || runFieldRangeHelp(metadata), mapping.defaultValue === undefined && metadata?.defaultValue !== undefined ? `节点默认值 ${String(metadata.defaultValue)}` : ""].filter(Boolean).join(" · ") || undefined,
        nodeClass: node?.type,
        fieldPath: mapping.field,
      };
    });
  }
  if (item.protocol === "grok") return grokRunFields(item);
  const fields: AigcRunFieldDefinition[] = [{ name: "prompt", label: "提示词", type: "string", required: true, placeholder: "描述要生成的画面或图片" }];
  if (item.capability === "image-edit") {
    fields.push({ name: "image", label: "参考图片（可选）", type: "image", required: false, help: "不提供图片时执行文生图，提供图片时执行图片编辑。" });
  }
  for (const parameter of resolveOpenAiParameterDefinitions(item.config as AigcOpenAiInterfaceConfig)) {
    fields.push(openAiParameterRunField(parameter));
  }
  return fields;
}

/** 将 OpenAI 参数定义转换为创作台字段。 */
function openAiParameterRunField(parameter: AigcOpenAiParameterDefinition): AigcRunFieldDefinition {
  return {
    name: parameter.name,
    label: parameter.name,
    type: parameter.enumValues?.length ? "enum" : parameter.type === "integer" ? "int" : parameter.type === "number" ? "double" : parameter.type === "boolean" ? "bool" : "string",
    required: false,
    ...(parameter.enumValues?.length ? { options: parameter.enumValues } : {}),
    ...(parameter.defaultValue !== undefined ? { placeholder: String(parameter.defaultValue) } : {}),
    ...(parameter.description ? { help: parameter.description } : {}),
  };
}

type AigcRunDisplayItem =
  | { kind: "field"; field: AigcRunFieldDefinition }
  | { kind: "group"; group: AigcWorkflowInputGroup; fields: AigcRunFieldDefinition[]; visibleFields: AigcRunFieldDefinition[]; filledCount: number };

/** 按工作流入参顺序展示顶层参数，参考组仅展开已有值和下一个空槽位。 */
function runDisplayItems(fields: AigcRunFieldDefinition[], workflow: AigcWorkflowDetail | undefined, values: Record<string, AigcRunInputValue>): AigcRunDisplayItem[] {
  const groups = workflow?.inputGroups ?? [];
  if (!groups.length || !workflow) return fields.map((field) => ({ kind: "field", field }));
  const fieldByMappingId = new Map(workflow.inputMappings.map((mapping) => [mapping.id, fields.find((field) => field.name === mapping.name)]));
  const groupByMappingId = new Map(groups.flatMap((group) => group.mappingIds.map((mappingId) => [mappingId, group] as const)));
  const emittedGroups = new Set<string>();
  const result: AigcRunDisplayItem[] = [];
  for (const mapping of workflow.inputMappings) {
    const group = groupByMappingId.get(mapping.id);
    const field = fieldByMappingId.get(mapping.id);
    if (!group) {
      if (field) result.push({ kind: "field", field });
      continue;
    }
    if (emittedGroups.has(group.id)) continue;
    emittedGroups.add(group.id);
    const groupFields = group.mappingIds.map((mappingId) => fieldByMappingId.get(mappingId)).filter((candidate): candidate is AigcRunFieldDefinition => Boolean(candidate));
    const firstEmpty = groupFields.find((candidate) => !hasRunValue(values[candidate.name]));
    const visibleFields = groupFields.filter((candidate) => hasRunValue(values[candidate.name]) || candidate === firstEmpty);
    result.push({ kind: "group", group, fields: groupFields, visibleFields, filledCount: groupFields.filter((candidate) => hasRunValue(values[candidate.name])).length });
  }
  return result;
}

/** 判断运行参数是否已经占用参考槽位。 */
function hasRunValue(value: AigcRunInputValue | undefined): boolean {
  if (value === undefined || value === null || value === "") return false;
  return typeof value !== "object" || Object.keys(value).length > 0;
}

/** 将数值元数据压缩为运行表单中的范围提示。 */
function runFieldRangeHelp(metadata?: ComfyUiFieldMetadata): string | undefined {
  if (!metadata) return undefined;
  const range = metadata.min !== undefined || metadata.max !== undefined ? `${metadata.min ?? "−∞"}–${metadata.max ?? "+∞"}` : "";
  return [range, metadata.step !== undefined ? `步进 ${metadata.step}` : ""].filter(Boolean).join(" · ") || undefined;
}

/** 根据 Grok 能力生成创作台入参字段。 */
function grokRunFields(item: AigcInterfaceRecord): AigcRunFieldDefinition[] {
  const isOptionalPrompt = item.capability === "video-extend";
  const fields: AigcRunFieldDefinition[] = [{
    name: "prompt",
    label: isOptionalPrompt ? "续写提示词（可选）" : "提示词",
    type: "string",
    required: !isOptionalPrompt,
    placeholder: isOptionalPrompt ? "描述视频续写方向" : "描述要生成的画面或视频",
  }];
  if (item.capability === "text-to-image") {
    fields.push({ name: "count", label: "生成数量", type: "int", required: false, placeholder: "1" });
  }
  if (item.capability === "image-edit" || item.capability === "image-to-video") {
    fields.push({ name: "image", label: "图片公网地址", type: "image", required: true, publicUrl: true });
  }
  if (item.capability === "video-edit" || item.capability === "video-extend") {
    fields.push({ name: "video", label: "视频公网地址", type: "video", required: true, publicUrl: true });
  }
  if (["text-to-image", "image-edit", "text-to-video", "image-to-video"].includes(item.capability)) {
    fields.push({ name: "size", label: "输出尺寸", type: "string", required: false, placeholder: "例如 1024x1024" });
  }
  if (["text-to-video", "image-to-video", "video-extend"].includes(item.capability)) {
    fields.push({ name: "duration", label: "时长（秒）", type: "int", required: false, placeholder: "1 到 300" });
  }
  return fields;
}

/** 为 OpenAI 或 Grok 接口生成初始表单值。 */
function initialGrokOrOpenAiValues(item: AigcInterfaceRecord): Record<string, AigcRunInputValue> {
  const values: Record<string, AigcRunInputValue> = { prompt: "" };
  if (item.protocol === "grok" && item.capability === "text-to-image") values.count = 1;
  if (item.protocol === "grok") {
    const config = item.config as { size?: string; duration?: number };
    if (config.size) values.size = config.size;
    if (config.duration !== undefined) values.duration = config.duration;
  }
  if (item.protocol === "openai") {
    for (const parameter of resolveOpenAiParameterDefinitions(item.config as AigcOpenAiInterfaceConfig)) {
      if (parameter.defaultValue !== undefined) values[parameter.name] = parameter.defaultValue;
    }
  }
  return values;
}

/** 为 ComfyUI 工作流映射生成初始值。 */
function initialComfyUiValues(workflow: AigcWorkflowDetail): Record<string, AigcRunInputValue> {
  const values: Record<string, AigcRunInputValue> = {};
  for (const mapping of workflow.inputMappings) {
    const metadata = resolvedWorkflowFieldMetadata(workflow, mapping.nodeId, mapping.field);
    const defaultValue = mapping.defaultValue ?? metadata?.defaultValue;
    if (mapping.type === "bool") values[mapping.name] = typeof defaultValue === "boolean" ? defaultValue : false;
    else if (mapping.type === "int" || mapping.type === "double") values[mapping.name] = typeof defaultValue === "number" ? defaultValue : "";
    else if (mapping.type === "enum") values[mapping.name] = defaultValue ?? metadata?.enumOptions?.[0] ?? mapping.enumOptions?.[0] ?? "";
    else if (mapping.type === "string") values[mapping.name] = typeof defaultValue === "string" ? defaultValue : "";
  }
  return values;
}

/** 优先读取服务端解析的实例级字段约束，并兼容旧详情的类级定义。 */
function resolvedWorkflowFieldMetadata(workflow: AigcWorkflowDetail, nodeId: string, field: string): ComfyUiFieldMetadata | undefined {
  const resolved = workflow.resolvedFieldMetadata?.[nodeId]?.[field];
  if (resolved) return resolved;
  const nodeType = workflow.nodes.find((node) => node.id === nodeId)?.type;
  return nodeType ? workflow.nodeMetadata?.[nodeType]?.fields[field] : undefined;
}

/** 将表单值转换为提交给服务端的 AIGC 入参。 */
function coerceRunValue(field: AigcRunFieldDefinition, value: AigcRunInputValue | undefined): AigcRunInputValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (field.type === "bool") return value === true;
  if (field.type === "int" || field.type === "double") {
    if (value === "") return undefined;
    const number = Number(value);
    if (!Number.isFinite(number)) return undefined;
    return field.type === "int" ? Math.trunc(number) : number;
  }
  if (field.type === "string") {
    const text = String(value).trim();
    return text;
  }
  if (field.type === "enum") return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
  if (typeof value === "object" && ("assetId" in value || "url" in value || "filename" in value)) return value;
  return undefined;
}

/** 返回接口能力的展示文案。 */
export function capabilityLabel(protocol: AigcInterfaceProtocol, capability: AigcInterfaceCapability): string {
  return capabilityOptions(protocol).find((option) => option.value === capability)?.label ?? capability;
}

/** 接口页协议卡的展示名称。 */
export function interfaceProtocolName(protocol: AigcInterfaceProtocol): string {
  if (protocol === "openai") return "OpenAI";
  if (protocol === "grok") return "Grok";
  return "ComfyUI";
}

/** 接口页协议卡的简短能力说明。 */
export function interfaceProtocolDescription(protocol: AigcInterfaceProtocol): string {
  if (protocol === "openai") return "图片生成与编辑";
  if (protocol === "grok") return "图片与视频全流程";
  return "工作流节点编排";
}

/** 将服务端接口记录转换成稳定的编辑表单基线。 */
function interfaceInputFromRecord(item: AigcInterfaceRecord): AigcInterfaceInput {
  return {
    name: item.name,
    description: item.description,
    toolDescription: item.toolDescription ?? item.description,
    protocol: item.protocol,
    capability: item.capability,
    channelId: item.channelId,
    enabled: item.enabled,
    toolPublishEnabled: item.toolPublishEnabled,
    mcpPublishEnabled: item.mcpPublishEnabled === true,
    config: item.config as AigcInterfaceInput["config"],
  };
}

/** 编辑 OpenAI 兼容渠道的参数名、类型、枚举、默认值与说明。 */
export function OpenAiParameterEditor({ config, onChange }: {
  config: AigcOpenAiInterfaceConfig;
  onChange: (config: AigcOpenAiInterfaceConfig) => void;
}) {
  const parameters = resolveOpenAiParameterDefinitions(config);

  function replace(next: AigcOpenAiParameterDefinition[]) {
    onChange({ model: config.model, parameters: next });
  }

  function update(index: number, next: AigcOpenAiParameterDefinition) {
    replace(parameters.map((parameter, parameterIndex) => parameterIndex === index ? next : parameter));
  }

  function add() {
    const names = new Set(parameters.map((parameter) => parameter.name));
    let suffix = 1;
    let name = "custom_parameter";
    while (names.has(name)) name = `custom_parameter_${++suffix}`;
    replace([...parameters, { name, type: "string", description: "" }]);
  }

  return (
    <div className="aigc-fieldset">
      <div className="aigc-fieldset__heading"><strong>请求参数</strong><small>参数名会原样发送给上游；默认值可在创作时覆盖，空值不发送。</small></div>
      <div className="configuration-button-row">
        <button type="button" className="configuration-secondary-action" onClick={add}><Plus size={15} />新增参数</button>
      </div>
      {parameters.map((parameter, index) => (
        <div className="aigc-fieldset" key={index}>
          <div className="configuration-field-row">
            <label><span>参数名</span><input aria-label={`OpenAI 参数 ${index + 1} 名称`} value={parameter.name} onChange={(event) => update(index, { ...parameter, name: event.target.value })} /></label>
            <label><span>数据类型</span><select aria-label={`OpenAI 参数 ${parameter.name} 类型`} value={parameter.type} onChange={(event) => update(index, { name: parameter.name, type: event.target.value as AigcOpenAiParameterType, description: parameter.description })}>{openAiParameterTypeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          </div>
          <div className="configuration-field-row">
            <label><span>枚举值<small>每行一个；留空表示允许任意同类型值</small></span><textarea aria-label={`OpenAI 参数 ${parameter.name} 枚举值`} rows={3} value={formatOpenAiEnumValues(parameter.enumValues)} onChange={(event) => update(index, { ...parameter, enumValues: parseOpenAiEnumValues(event.target.value, parameter.type), defaultValue: undefined })} /></label>
            <OpenAiParameterDefaultEditor parameter={parameter} onChange={(defaultValue) => update(index, { ...parameter, ...(defaultValue === undefined ? { defaultValue: undefined } : { defaultValue }) })} />
          </div>
          <label><span>参数说明</span><textarea aria-label={`OpenAI 参数 ${parameter.name} 说明`} rows={2} value={parameter.description} onChange={(event) => update(index, { ...parameter, description: event.target.value })} /></label>
          <div className="configuration-button-row">
            <button type="button" className="configuration-secondary-action configuration-secondary-action--danger" aria-label={`删除 OpenAI 参数 ${parameter.name}`} onClick={() => replace(parameters.filter((_, parameterIndex) => parameterIndex !== index))}><Trash2 size={15} />删除参数</button>
          </div>
        </div>
      ))}
      {!parameters.length ? <p className="configuration-help">当前接口不发送额外请求参数。</p> : null}
    </div>
  );
}

/** 编辑参数默认值，并保留“不设置”状态。 */
function OpenAiParameterDefaultEditor({ parameter, onChange }: {
  parameter: AigcOpenAiParameterDefinition;
  onChange: (value: AigcOpenAiParameterValue | undefined) => void;
}) {
  if (parameter.enumValues?.length) {
    const selectedIndex = parameter.enumValues.findIndex((value) => Object.is(value, parameter.defaultValue));
    return <label><span>默认值</span><select aria-label={`OpenAI 参数 ${parameter.name} 默认值`} value={selectedIndex < 0 ? "" : String(selectedIndex)} onChange={(event) => onChange(event.target.value === "" ? undefined : parameter.enumValues?.[Number(event.target.value)])}><option value="">不设置</option>{parameter.enumValues.map((value, index) => <option key={`${typeof value}:${String(value)}`} value={index}>{String(value)}</option>)}</select></label>;
  }
  if (parameter.type === "boolean") {
    return <label><span>默认值</span><select aria-label={`OpenAI 参数 ${parameter.name} 默认值`} value={parameter.defaultValue === undefined ? "" : String(parameter.defaultValue)} onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value === "true")}><option value="">不设置</option><option value="true">true</option><option value="false">false</option></select></label>;
  }
  const numberType = parameter.type === "integer" || parameter.type === "number";
  return <label><span>默认值</span><input type={numberType ? "number" : "text"} step={parameter.type === "number" ? "any" : undefined} aria-label={`OpenAI 参数 ${parameter.name} 默认值`} value={parameter.defaultValue === undefined ? "" : String(parameter.defaultValue)} onChange={(event) => onChange(event.target.value === "" ? undefined : numberType ? Number(event.target.value) : event.target.value)} /></label>;
}

const openAiParameterTypeOptions: Array<{ value: AigcOpenAiParameterType; label: string }> = [
  { value: "string", label: "字符串" },
  { value: "integer", label: "整数" },
  { value: "number", label: "数值" },
  { value: "boolean", label: "布尔" },
];

/** 将枚举值转换为便于逐行编辑的文本。 */
function formatOpenAiEnumValues(values?: AigcOpenAiParameterValue[]): string {
  return values?.map(String).join("\n") ?? "";
}

/** 按参数类型解析逐行枚举值，输入中的空行会被忽略。 */
function parseOpenAiEnumValues(text: string, type: AigcOpenAiParameterType): AigcOpenAiParameterValue[] | undefined {
  const values: AigcOpenAiParameterValue[] = [];
  for (const value of text.split(/\r?\n/u).map((candidate) => candidate.trim()).filter(Boolean)) {
    if (type === "string") {
      values.push(value);
      continue;
    }
    if (type === "boolean") {
      if (value === "true") values.push(true);
      if (value === "false") values.push(false);
      continue;
    }
    const number = Number(value);
    if (Number.isFinite(number) && (type !== "integer" || Number.isInteger(number))) values.push(number);
  }
  return values.length ? values : undefined;
}

/** 接口详情页复用编辑表单。 */
function AigcInterfaceDetail({ interfaceId }: { interfaceId: string }) {
  const { runApiTask } = useApiTask();
  const [item, setItem] = useState<AigcInterfaceRecord>();
  const [channels, setChannels] = useState<AigcChannelSummary[]>([]);
  const [workflows, setWorkflows] = useState<{ id: string; name: string }[]>([]);
  const [draft, setDraft] = useState<AigcInterfaceInput>(emptyInterface);
  const [message, setMessage] = useState("");
  const detailDirty = Boolean(item && JSON.stringify(draft) !== JSON.stringify(interfaceInputFromRecord(item)));
  const navigationGuard = useAigcUnsavedNavigation(detailDirty);

  useEffect(() => {
    void runApiTask(async () => {
      const [channelsDocument, workflowsDocument] = await Promise.all([api.getAigcChannels(), api.getAigcWorkflows()]);
      const found = (await api.getAigcInterfaces()).interfaces.find((candidate) => candidate.id === interfaceId);
      if (!found) throw new Error("接口不存在");
      setChannels(channelsDocument.channels);
      setWorkflows(workflowsDocument.workflows.map((workflow) => ({ id: workflow.id, name: workflow.name })));
      setItem(found);
      setDraft({
        name: found.name,
        description: found.description,
        toolDescription: found.toolDescription ?? found.description,
        protocol: found.protocol,
        capability: found.capability,
        channelId: found.channelId,
        enabled: found.enabled,
        toolPublishEnabled: found.toolPublishEnabled,
        mcpPublishEnabled: found.mcpPublishEnabled === true,
        config: found.config as AigcInterfaceInput["config"],
      });
      return found;
    }, { operation: "加载 AIGC 接口详情" });
  }, [interfaceId, runApiTask]);

  async function save() {
    if (!item) return;
    const result = await runApiTask(async () => {
      const document = await api.getAigcInterfaces();
      return api.updateAigcInterface(item.id, document.revision, draft);
    }, { operation: "保存 AIGC 接口", expected: aigcExpected(setMessage) });
    if (result.status === "success") {
      setItem(result.data);
      setMessage("已保存 AIGC 接口");
    }
  }

  return (
    <div className="aigc-workbench-page">
      <header className="aigc-page-heading"><h1>接口详情</h1><p>编辑接口的协议、能力与目标工作流。</p></header>
      {message ? <p className="configuration-help" role="status">{message}</p> : null}
      <section className="configuration-form-card">
        <label><span>名称</span><input aria-label="AIGC 接口名称" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label><span>描述</span><textarea aria-label="AIGC 接口描述" rows={2} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
        <label><span>接口说明（Agent）</span><textarea aria-label="AIGC Agent 接口说明" rows={4} value={draft.toolDescription ?? ""} onChange={(event) => setDraft({ ...draft, toolDescription: event.target.value })} /><small>Agent 查询接口明细时使用，建议写清适用场景、约束和出参含义。</small></label>
        <p className="configuration-help">协议、渠道与能力已在接口列表中创建；如需变更协议，请删除后重新创建。</p>
        {draft.protocol === "comfyui" ? <p className="configuration-help">工作流：{workflows.find((item) => item.id === (draft.config as { workflowId?: string }).workflowId)?.name ?? "未找到"}</p> : null}
        <label className="configuration-check-line"><input type="checkbox" checked={draft.toolPublishEnabled} onChange={(event) => setDraft({ ...draft, toolPublishEnabled: event.target.checked })} /><span>发布为 Agent 工具</span></label>
        <label className="configuration-check-line"><input type="checkbox" checked={draft.mcpPublishEnabled} onChange={(event) => setDraft({ ...draft, mcpPublishEnabled: event.target.checked })} /><span>开放给外部 MCP</span></label>
        <div className="configuration-save-bar"><button type="button" className="configuration-primary-action" onClick={() => void save()}><Save size={16} />保存接口</button></div>
      </section>
      {navigationGuard.pendingRoute ? <ConfirmationDialog title="离开并放弃修改？" description="接口详情仍有未保存内容。离开页面后，这些修改将丢失。" confirmLabel="离开页面" destructive={false} onCancel={navigationGuard.cancel} onConfirm={navigationGuard.confirm} /> : null}
    </div>
  );
}

/** 任务列表页。 */
function AigcTasksPage() {
  const { runApiTask } = useApiTask();
  const [document, setDocument] = useState<AigcTaskDocument>();
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "succeeded" | "failed">("all");
  const [sort, setSort] = useState<"asc" | "desc">("desc");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<AigcTaskSummary>();
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  async function refresh() {
    const next = await api.getAigcTasks();
    setDocument(next);
    setSelectedIds((current) => current.filter((id) => next.tasks.some((task) => task.id === id)));
    return next;
  }

  useEffect(() => {
    void runApiTask(refresh, { operation: "加载 AIGC 任务" });
    const timer = window.setInterval(() => {
      void runApiTask(refresh, { operation: "轮询 AIGC 任务" });
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [runApiTask]);

  useEffect(() => {
    setSelectedIds([]);
    setBulkDeleteOpen(false);
  }, [filter]);

  async function cancel(id: string) {
    const result = await runApiTask(() => api.cancelAigcTask(id), { operation: "取消 AIGC 任务", expected: aigcExpected(setMessage) });
    if (result.status === "success") await refresh();
  }

  async function retry(id: string) {
    const result = await runApiTask(() => api.retryAigcTask(id), { operation: "重试 AIGC 任务", expected: aigcExpected(setMessage) });
    if (result.status === "success") await refresh();
  }

  async function remove() {
    if (!deleteTarget) return;
    const result = await runApiTask(() => api.deleteAigcTask(deleteTarget.id), { operation: "删除 AIGC 任务", expected: aigcExpected(setMessage) });
    if (result.status === "success") {
      setDeleteTarget(undefined);
      setMessage("任务及其产物已删除");
      await refresh();
    }
  }

  /** 删除用户明确勾选的任务，已交付到 Agent 工作区的附件由工作区继续持有。 */
  async function removeSelected() {
    if (!selectedIds.length || bulkDeleting) return;
    setBulkDeleting(true);
    const batches = chunkTaskIds(selectedIds);
    let removedCount = 0;
    try {
      for (const [index, ids] of batches.entries()) {
        const operation = batches.length > 1
          ? `删除选中的 AIGC 任务（第 ${index + 1}/${batches.length} 批）`
          : "删除选中的 AIGC 任务";
        const result = await runApiTask(
          () => api.deleteSelectedAigcTasks(ids),
          { operation },
        );
        if (result.status !== "success") {
          if (removedCount > 0) {
            await refresh();
            setMessage(`已删除 ${removedCount} 个任务，剩余任务因错误未删除`);
          }
          return;
        }
        removedCount += result.data.removedIds.length;
      }
      setSelectedIds([]);
      setBulkDeleteOpen(false);
      setMessage(`已删除 ${removedCount} 个任务及其 AIGC 产物，Agent 工作目录附件已保留`);
      await refresh();
    } finally {
      setBulkDeleting(false);
    }
  }

  const visibleTasks = (document?.tasks ?? []).filter((task) => {
    if (filter === "active") return task.status === "queued" || task.status === "running";
    if (filter === "failed") return task.status === "prepared" || task.status === "failed" || task.status === "cancelled";
    if (filter === "succeeded") return task.status === "succeeded";
    return true;
  }).sort((left, right) => {
    const order = left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
    return sort === "asc" ? order : -order;
  });
  const selectedSet = new Set(selectedIds);
  const selectedTasks = (document?.tasks ?? []).filter((task) => selectedSet.has(task.id));
  const selectedAssetCount = selectedTasks.reduce((total, task) => total + task.assetCount, 0);

  function toggleSelection(id: string, checked: boolean) {
    setSelectedIds((current) => checked ? [...current, id] : current.filter((selectedId) => selectedId !== id));
  }

  return (
    <div className="aigc-workbench-page">
      <header className="aigc-page-heading"><h1>任务与产物</h1><p>按创作状态查看进度、失败原因，并进入详情直接预览生成结果。</p></header>
      {message ? <p className="configuration-help" role="status">{message}</p> : null}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
        <div className="scheduled-task-segmented aigc-task-filters" role="group" aria-label="任务状态筛选">
          {([{ value: "all", label: "全部" }, { value: "active", label: "进行中" }, { value: "succeeded", label: "已完成" }, { value: "failed", label: "需处理" }] as const).map((item) => <button key={item.value} type="button" className={filter === item.value ? "is-active" : undefined} onClick={() => setFilter(item.value)}>{item.label}</button>)}
        </div>
        <div className="aigc-task-actions" style={{ alignItems: "flex-end" }}>
          <label style={{ display: "grid", gap: 4, color: "var(--text-tertiary)", fontSize: 10 }}>创建时间<select style={{ minHeight: 40, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 7, color: "var(--text-secondary)", background: "var(--surface)", fontSize: 11 }} aria-label="任务创建时间排序" value={sort} onChange={(event) => setSort(event.target.value as "asc" | "desc")}><option value="desc">最新在前</option><option value="asc">最早在前</option></select></label>
          <button type="button" disabled={!visibleTasks.length} onClick={() => setSelectedIds(visibleTasks.map((task) => task.id))}>全选</button>
          <button type="button" disabled={!selectedIds.length} onClick={() => setSelectedIds([])}>取消全选</button>
          <button type="button" className="danger-button" style={{ borderColor: "color-mix(in srgb, var(--danger) 55%, var(--border))", color: "var(--danger)", background: "color-mix(in srgb, var(--danger) 8%, var(--surface))" }} disabled={!selectedIds.length} onClick={() => setBulkDeleteOpen(true)}>删除选中{selectedIds.length ? `（${selectedIds.length}）` : ""}</button>
        </div>
      </div>
      <div className="aigc-task-list">
        {visibleTasks.map((task) => (
          <section key={task.id} className="aigc-task-row">
            <div><input type="checkbox" aria-label={`选择任务 ${task.id}`} checked={selectedSet.has(task.id)} onChange={(event) => toggleSelection(task.id, event.target.checked)} /><strong>{task.interfaceName}</strong><span className={`aigc-status-badge is-${task.status}`}>{taskStatusLabel(task.status)}</span><small>{formatAigcTime(task.createdAt)}</small></div>
            <p>{task.queueReason ?? (task.error ? task.error.message : task.status === "succeeded" ? `${task.assetCount} 个产物可预览` : task.status === "running" ? "正在生成，请保持页面打开或稍后回来查看" : task.status === "prepared" ? "参数已校验，等待 Agent 显式运行" : "等待执行")}</p>
            <div className="aigc-task-actions">
              {(task.status === "prepared" || task.status === "queued" || task.status === "running") ? <button type="button" onClick={() => void cancel(task.id)}>取消</button> : null}
              {(task.status === "failed" || task.status === "cancelled") && !task.requiresNewTask ? <button type="button" onClick={() => void retry(task.id)}><RefreshCw size={14} />重试</button> : null}
              <a href={`/aigc/tasks/${encodeURIComponent(task.id)}`} onClick={(event) => { event.preventDefault(); navigateTo({ page: "aigc-task-detail", taskId: task.id }); }}>查看</a>
              <button type="button" aria-label={`删除任务 ${task.id}`} title="删除任务" onClick={() => setDeleteTarget(task)}><Trash2 size={14} /></button>
            </div>
          </section>
        ))}
        {!visibleTasks.length ? <p className="configuration-help">当前筛选下没有任务。</p> : null}
      </div>
      {deleteTarget ? <ConfirmationDialog title="删除任务？" description={`任务 ${deleteTarget.id} 及其 ${deleteTarget.assetCount} 个 AIGC 产物将被永久删除；已交付至 Agent 工作目录的附件会保留。`} confirmLabel="删除任务和产物" onCancel={() => setDeleteTarget(undefined)} onConfirm={() => void remove()} /> : null}
      {bulkDeleteOpen ? <ConfirmationDialog title={`删除选中的 ${selectedIds.length} 个任务？`} description={`这些任务及其 ${selectedAssetCount} 个 AIGC 产物将被永久删除；已交付至 Agent 工作目录的附件会保留。`} confirmLabel="删除选中" busy={bulkDeleting} onCancel={() => setBulkDeleteOpen(false)} onConfirm={() => void removeSelected()} /> : null}
    </div>
  );
}

/** 按服务端单次上限拆分任务标识，避免“全选”超过接口保护阈值。 */
function chunkTaskIds(ids: string[]): string[][] {
  const batches: string[][] = [];
  for (let offset = 0; offset < ids.length; offset += AIGC_TASK_BULK_DELETE_LIMIT) {
    batches.push(ids.slice(offset, offset + AIGC_TASK_BULK_DELETE_LIMIT));
  }
  return batches;
}

/** 任务详情页。 */
function AigcTaskDetail({ taskId }: { taskId: string }) {
  const { runApiTask } = useApiTask();
  const [task, setTask] = useState<AigcTaskRecord>();
  const [message, setMessage] = useState("");
  const [previewAsset, setPreviewAsset] = useState<AigcTaskAsset>();
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    void runApiTask(() => api.getAigcTask(taskId).then((next) => { setTask(next); return next; }), { operation: "加载 AIGC 任务详情" });
    const timer = window.setInterval(() => {
      void runApiTask(
        () => api.getAigcTask(taskId).then((next) => { setTask(next); return next; }),
        { operation: "轮询 AIGC 任务详情" },
      );
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [runApiTask, taskId]);

  useEffect(() => {
    if (!previewAsset) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewAsset(undefined);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [previewAsset]);

  async function retry() {
    const result = await runApiTask(() => api.retryAigcTask(taskId), { operation: "重试 AIGC 任务", expected: aigcExpected(setMessage) });
    if (result.status === "success" && result.data) setTask(result.data);
  }

  async function remove() {
    const result = await runApiTask(() => api.deleteAigcTask(taskId), { operation: "删除 AIGC 任务", expected: aigcExpected(setMessage) });
    if (result.status === "success") navigateTo({ page: "aigc-tasks" });
  }

  if (!task) return <div className="aigc-workbench-page"><p className="configuration-help">正在加载任务…</p></div>;
  return (
    <div className="aigc-workbench-page">
      <header className="aigc-page-heading"><h1>创作结果</h1><p>{task.interfaceName} · {taskStatusLabel(task.status)}</p><button type="button" className="danger-button" onClick={() => setDeleteOpen(true)}><Trash2 size={15} />删除任务</button></header>
      {message ? <p className="configuration-help" role="status">{message}</p> : null}
      <section className="configuration-form-card">
        <div className="aigc-task-meta"><span>任务 ID</span><code>{task.id}</code></div>
        {task.queueReason && <p role="status">{task.queueReason}</p>}
        <div className="aigc-task-meta"><span>状态</span><strong className={`aigc-status-badge is-${task.status}`}>{taskStatusLabel(task.status)}</strong></div>
        <div className="aigc-task-meta"><span>创建时间</span><time>{formatAigcTime(task.createdAt)}</time></div>
        {typeof task.inputs.prompt === "string" && task.inputs.prompt ? <div className="aigc-task-prompt"><span>创作描述</span><p>{task.inputs.prompt}</p></div> : null}
        {task.error ? <p className="configuration-help">错误：{task.error.code} {task.error.message}</p> : null}
        <div className="configuration-section__heading"><div><span>01</span><h2>产物预览</h2></div><small>{task.assets.length} 个文件</small></div>
        <div className="aigc-asset-gallery">
          {task.assets.map((asset) => {
            const source = aigcTaskAssetUrl(task.id, asset.id);
            return (
              <figure key={asset.id} className="aigc-asset-card">
                <div className="aigc-asset-card__preview">
                  {asset.mediaType.startsWith("image/") ? <button type="button" className="aigc-asset-card__open" aria-label={`放大预览 ${asset.name}`} onClick={() => setPreviewAsset(asset)}><img src={source} alt={asset.name} loading="lazy" /></button> : null}
                  {asset.mediaType.startsWith("video/") ? <video src={source} controls preload="metadata" aria-label={asset.name} /> : null}
                  {asset.mediaType.startsWith("audio/") ? <audio src={source} controls preload="metadata" aria-label={asset.name} /> : null}
                  {!asset.mediaType.startsWith("image/") && !asset.mediaType.startsWith("video/") && !asset.mediaType.startsWith("audio/") ? <div className="aigc-asset-card__file"><span>{asset.mediaType}</span></div> : null}
                </div>
                <figcaption><span><strong>{asset.name}</strong><small>{formatFileSize(asset.size)} · {asset.mediaType}</small></span><a href={aigcTaskAssetUrl(task.id, asset.id, true)} download={asset.name} aria-label="下载"><Download size={15} /><span>下载</span></a></figcaption>
              </figure>
            );
          })}
        </div>
        {!task.assets.length ? <p className="configuration-help">{task.status === "prepared" ? "参数已校验，等待 Agent 显式运行。" : task.status === "succeeded" ? "任务已完成，但没有提取到产物，请检查接口或工作流输出映射。" : "生成完成后，图片、视频和音频会直接显示在这里。"}</p> : null}
        {(task.status === "failed" || task.status === "cancelled") && !task.preparation ? <button type="button" className="configuration-secondary-action" onClick={() => void retry()}><RefreshCw size={15} />重试</button> : null}
      </section>
      {previewAsset ? <div className="media-lightbox" role="dialog" aria-modal="true" aria-label={`${previewAsset.name} 大图预览`}><button type="button" className="media-lightbox__close" aria-label="关闭产物预览" onClick={() => setPreviewAsset(undefined)}><X size={20} /></button><div className="media-lightbox__stage"><img src={aigcTaskAssetUrl(task.id, previewAsset.id)} alt={previewAsset.name} /></div></div> : null}
      {deleteOpen ? <ConfirmationDialog title="删除任务？" description={`任务 ${task.id} 及其 ${task.assets.length} 个 AIGC 产物将被永久删除；已交付至 Agent 工作目录的附件会保留。`} confirmLabel="删除任务和产物" onCancel={() => setDeleteOpen(false)} onConfirm={() => void remove()} /> : null}
    </div>
  );
}

/** 工作流导入与列表页。 */
function AigcWorkflowsPage() {
  const { runApiTask } = useApiTask();
  const online = useOnlineStatus();
  const [document, setDocument] = useState<AigcWorkflowDocument>();
  const [name, setName] = useState("");
  const [fileName, setFileName] = useState("");
  const [rawText, setRawText] = useState("");
  const [message, setMessage] = useState("");
  const [interfaces, setInterfaces] = useState<AigcInterfaceRecord[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<AigcWorkflowSummary>();

  async function refresh() {
    const [next, interfaceDocument] = await Promise.all([api.getAigcWorkflows(), api.getAigcInterfaces()]);
    setDocument(next);
    setInterfaces(interfaceDocument.interfaces);
    return next;
  }

  useEffect(() => {
    void runApiTask(refresh, { operation: "加载 ComfyUI 工作流" });
  }, [runApiTask]);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    setName(file.name.replace(/\.json$/iu, ""));
    setRawText(await file.text());
  }

  async function save() {
    if (!online) return;
    setMessage("");
    let workflowJson: unknown;
    try {
      workflowJson = JSON.parse(rawText);
    } catch {
      setMessage("ComfyUI 工作流 JSON 格式无效");
      return;
    }
    const result = await runApiTask(() => api.createAigcWorkflow({ name, fileName, workflowJson, inputMappings: [], outputMappings: [] }), {
      operation: "导入 ComfyUI 工作流",
      expected: aigcExpected(setMessage),
    });
    if (result.status !== "success") return;
    await refresh();
    setName("");
    setFileName("");
    setRawText("");
    setMessage("已导入 ComfyUI 工作流");
  }

  async function remove() {
    if (!document || !deleteTarget) return;
    const result = await runApiTask(() => api.deleteAigcWorkflow(deleteTarget.id, document.revision), { operation: "删除 ComfyUI 工作流", expected: aigcExpected(setMessage) });
    if (result.status === "success") {
      setDeleteTarget(undefined);
      await refresh();
    }
  }

  return (
    <div className="aigc-workbench-page">
      <header className="aigc-page-heading"><h1>工作流</h1><p>导入 ComfyUI JSON，解析节点后配置输入与输出映射。</p></header>
      {message ? <p className="configuration-help" role="status">{message}</p> : null}
      <section className="configuration-form-card">
        <div className="configuration-section__heading"><div><span>01</span><h2>导入工作流</h2></div></div>
        <label><span>JSON 文件</span><input type="file" accept=".json,application/json" aria-label="ComfyUI 工作流文件" onChange={(event) => void onFile(event.target.files?.[0])} /></label>
        <label><span>工作流名称</span><input aria-label="工作流名称" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label><span>原始 JSON</span><textarea aria-label="ComfyUI 工作流 JSON" rows={10} spellCheck={false} value={rawText} onChange={(event) => setRawText(event.target.value)} /></label>
        <div className="configuration-save-bar"><button type="button" className="configuration-primary-action" disabled={!online} onClick={() => void save()}><Upload size={15} />导入并解析</button></div>
      </section>
      <div className="aigc-task-list">
        {(document?.workflows ?? []).map((workflow) => (
          <section key={workflow.id} className="aigc-task-row">
            <div><strong>{workflow.name}</strong><span>{workflow.fileName}</span><small>{workflow.nodeCount} 节点 · {workflow.edgeCount} 连线</small></div>
            <p>{workflow.inputCount} 个入参 · {workflow.outputCount} 个输出映射</p>
            <div className="aigc-task-actions">
              {interfaces.find((item) => item.enabled && item.protocol === "comfyui" && (item.config as { workflowId?: string }).workflowId === workflow.id) ? <button type="button" onClick={() => { const item = interfaces.find((candidate) => candidate.enabled && candidate.protocol === "comfyui" && (candidate.config as { workflowId?: string }).workflowId === workflow.id); if (item) navigateTo({ page: "aigc-run", interfaceId: item.id }); }}><Play size={14} />运行</button> : <button type="button" onClick={() => navigateTo({ page: "aigc-interfaces" })}><Boxes size={14} />创建运行接口</button>}
              <a href={`/aigc/workflows/${encodeURIComponent(workflow.id)}`} onClick={(event) => { event.preventDefault(); navigateTo({ page: "aigc-workflow-detail", workflowId: workflow.id }); }}>配置映射</a>
              <button type="button" onClick={() => setDeleteTarget(workflow)}><Trash2 size={14} />删除</button>
            </div>
          </section>
        ))}
        {!document?.workflows.length ? <p className="configuration-help">尚未导入工作流。</p> : null}
      </div>
      {deleteTarget ? <ConfirmationDialog title={`删除工作流“${deleteTarget.name}”？`} description={`删除后无法恢复。${interfaces.filter((item) => item.protocol === "comfyui" && (item.config as { workflowId?: string }).workflowId === deleteTarget.id).length} 个接口正在引用它，相关创作入口将无法运行。`} confirmLabel="删除工作流" onCancel={() => setDeleteTarget(undefined)} onConfirm={() => void remove()} /> : null}
    </div>
  );
}

/** 工作流详情页，提供节点与字段点选的可视化映射编排。 */
function AigcWorkflowDetail({ workflowId }: { workflowId: string }) {
  const { runApiTask } = useApiTask();
  const replaceFileInputRef = useRef<HTMLInputElement>(null);
  const [detail, setDetail] = useState<AigcWorkflowDetail>();
  const [revision, setRevision] = useState("");
  const [name, setName] = useState("");
  const [inputMappings, setInputMappings] = useState<AigcWorkflowInputMapping[]>([]);
  const [inputGroups, setInputGroups] = useState<AigcWorkflowInputGroup[]>([]);
  const [outputMappings, setOutputMappings] = useState<AigcWorkflowOutputMapping[]>([]);
  const [message, setMessage] = useState("");
  const [channels, setChannels] = useState<AigcChannelSummary[]>([]);
  const [channelId, setChannelId] = useState("");
  const [syncingMetadata, setSyncingMetadata] = useState(false);
  const [replacement, setReplacement] = useState<{ fileName: string; workflowJson: unknown; preview: AigcWorkflowReplacementPreview }>();
  const [checkingReplacement, setCheckingReplacement] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const isDirty = Boolean(detail && (name !== detail.name || JSON.stringify(inputMappings) !== JSON.stringify(detail.inputMappings) || JSON.stringify(inputGroups) !== JSON.stringify(detail.inputGroups ?? []) || JSON.stringify(outputMappings) !== JSON.stringify(detail.outputMappings)));
  const navigationGuard = useAigcUnsavedNavigation(isDirty);

  useEffect(() => {
    void runApiTask(async () => {
      const [next, channelDocument] = await Promise.all([api.getAigcWorkflow(workflowId), api.getAigcChannels()]);
      const comfyChannels = channelDocument.channels.filter((channel) => channel.type === "comfyui" && channel.enabled);
      setDetail(next.workflow);
      setRevision(next.revision);
      setName(next.workflow.name);
      setInputMappings(next.workflow.inputMappings);
      setInputGroups(next.workflow.inputGroups ?? []);
      setOutputMappings(next.workflow.outputMappings);
      setChannels(comfyChannels);
      setChannelId((current) => current || comfyChannels[0]?.id || "");
      return next;
    }, { operation: "加载 ComfyUI 工作流详情" });
  }, [runApiTask, workflowId]);

  async function save() {
    const result = await runApiTask(() => api.updateAigcWorkflow(workflowId, revision, { name, inputMappings, inputGroups, outputMappings }), {
      operation: "保存 ComfyUI 工作流映射",
      expected: aigcExpected(setMessage),
    });
    if (result.status === "success") {
      setMessage("已保存工作流映射");
      const next = await api.getAigcWorkflow(workflowId);
      setRevision(next.revision);
      setDetail(next.workflow);
      setInputMappings(next.workflow.inputMappings);
      setInputGroups(next.workflow.inputGroups ?? []);
      setOutputMappings(next.workflow.outputMappings);
    }
  }

  async function syncNodeMetadata() {
    if (!channelId || isDirty) return;
    setSyncingMetadata(true);
    try {
      const result = await runApiTask(() => api.syncAigcWorkflowNodeMetadata(workflowId, channelId, revision), {
        operation: "同步 ComfyUI 节点定义",
        expected: aigcExpected(setMessage),
      });
      if (result.status === "success") {
        setDetail(result.data.workflow);
        setRevision(result.data.revision);
        setName(result.data.workflow.name);
        setInputMappings(result.data.workflow.inputMappings);
        setInputGroups(result.data.workflow.inputGroups ?? []);
        setOutputMappings(result.data.workflow.outputMappings);
        setMessage(`已同步 ${result.data.syncedNodeClasses.length} 类节点${result.data.missingNodeClasses.length ? `，${result.data.missingNodeClasses.length} 类未识别` : ""}`);
      }
    } finally {
      setSyncingMetadata(false);
    }
  }

  async function prepareReplacement(file: File | undefined) {
    if (!file || checkingReplacement || replacing || syncingMetadata || isDirty) return;
    setMessage("");
    setReplacement(undefined);
    setCheckingReplacement(true);
    try {
      const result = await runApiTask(async () => {
        const text = await file.text();
        let workflowJson: unknown;
        try { workflowJson = JSON.parse(text) as unknown; }
        catch { throw new TypeError("ComfyUI 替换文件的 JSON 格式无效，请修正文件后重新选择"); }
        const pending = { fileName: file.name, workflowJson };
        const preview = await api.previewAigcWorkflowReplacement(workflowId, revision, pending);
        return { ...pending, preview };
      }, { operation: "检查 ComfyUI 工作流替换影响" });
      if (result.status === "success") setReplacement(result.data);
    } finally {
      setCheckingReplacement(false);
      if (replaceFileInputRef.current) replaceFileInputRef.current.value = "";
    }
  }

  async function replaceWorkflow() {
    if (!replacement || replacing || isDirty) return;
    const pending = replacement;
    setReplacing(true);
    try {
      const result = await runApiTask(() => api.replaceAigcWorkflow(workflowId, pending.preview.revision, {
        fileName: pending.fileName, workflowJson: pending.workflowJson, confirmationToken: pending.preview.confirmationToken,
      }), {
        operation: "替换 ComfyUI 原始工作流",
      });
      // 保存失败后必须重新检查，不能继续使用可能已失效的确认结果。
      setReplacement(undefined);
      if (result.status !== "success") return;
      const removedNames = pending.preview.removedMappings.map((item) => item.name);
      setDetail(result.data.workflow);
      setRevision(result.data.revision);
      setName(result.data.workflow.name);
      setInputMappings(result.data.workflow.inputMappings);
      setInputGroups(result.data.workflow.inputGroups ?? []);
      setOutputMappings(result.data.workflow.outputMappings);
      setMessage(removedNames.length > 0
        ? `已替换原始工作流；已移除不兼容映射：${removedNames.join("、")}`
        : "已替换原始工作流，现有映射和接口配置保持不变");
    } finally {
      setReplacing(false);
    }
  }

  return (
    <div className="aigc-workbench-page">
      <header className="aigc-page-heading"><h1>工作流详情</h1><p>{detail?.fileName ?? workflowId}</p></header>
      <div className="aigc-workflow-sync-bar">
        <div className="aigc-config-field"><span>ComfyUI 渠道</span><ConfigurationSelect
          ariaLabel="节点定义同步渠道"
          options={channels.map((channel) => ({ value: channel.id, label: channel.name }))}
          value={channelId || undefined}
          placeholder="暂无可用渠道"
          disabled={!channels.length}
          onChange={setChannelId}
        /></div>
        <button type="button" className="configuration-secondary-action" disabled={!detail || !channelId || isDirty || syncingMetadata || checkingReplacement || replacing || Boolean(replacement)} title={isDirty ? "请先保存映射后再同步" : undefined} onClick={() => void syncNodeMetadata()}><RefreshCw size={15} />{syncingMetadata ? "同步中…" : "同步节点定义"}</button>
        <input ref={replaceFileInputRef} hidden type="file" accept=".json,application/json" aria-label="替换原始工作流文件" onChange={(event) => void prepareReplacement(event.target.files?.[0])} />
        <button type="button" className="configuration-secondary-action" disabled={!detail || isDirty || replacing || checkingReplacement || syncingMetadata || Boolean(replacement)} title={isDirty ? "请先保存映射后再替换" : undefined} onClick={() => replaceFileInputRef.current?.click()}><Upload size={15} />{checkingReplacement ? "检查中…" : replacing ? "替换中…" : "替换原始工作流"}</button>
        <small>{detail?.nodeMetadataSyncedAt ? `最近同步 ${formatAigcTime(detail.nodeMetadataSyncedAt)}` : "尚未同步节点定义"}</small>
      </div>
      {message ? <p className="configuration-help" role="status">{message}</p> : null}
      {detail ? (
        <Suspense fallback={<p className="configuration-help">正在加载工作流编排器…</p>}>
          <div inert={checkingReplacement || replacing || Boolean(replacement)}><AigcWorkflowComposer
            workflow={detail}
            name={name}
            onNameChange={setName}
            inputMappings={inputMappings}
            inputGroups={inputGroups}
            outputMappings={outputMappings}
            onInputMappingsChange={setInputMappings}
            onInputGroupsChange={setInputGroups}
            onOutputMappingsChange={setOutputMappings}
          /></div>
        </Suspense>
      ) : <p className="configuration-help">正在加载工作流节点…</p>}
      <div className="configuration-save-bar">
        <button type="button" className="configuration-primary-action" disabled={!detail || !isDirty || checkingReplacement || replacing || Boolean(replacement)} onClick={() => void save()}><Save size={15} />{isDirty ? "保存映射" : "已保存"}</button>
      </div>
      {replacement ? <ConfirmationDialog
        title={`替换为“${replacement.fileName}”？`}
        description={replacement.preview.removedMappings.length
          ? `检测到 ${replacement.preview.removedMappings.length} 项映射或参数组无法保留。继续替换会移除下列配置，无法撤回；取消将保留原工作流和全部映射。`
          : "检查通过，全部映射均可保留。确认后替换原始工作流，工作流 ID 和接口配置保持不变。"}
        confirmLabel={replacement.preview.removedMappings.length ? "移除上述映射并替换" : "确认替换"}
        destructive={replacement.preview.removedMappings.length > 0}
        busy={replacing}
        onCancel={() => setReplacement(undefined)}
        onConfirm={() => void replaceWorkflow()}
      >
        {replacement.preview.removedMappings.length ? <ul aria-label="无法保留的映射与参数组" style={{ margin: 0, paddingLeft: 20 }}>
          {replacement.preview.removedMappings.map((item) => <li key={`${item.kind}-${item.id}`} style={{ padding: "6px 0" }}>
            <strong>{item.kind === "input" ? "入参" : item.kind === "output" ? "出参" : "参数组"}：{item.name}</strong>
            <p>节点 {item.nodeId} · {item.field}</p><p>{item.reason}</p>
          </li>)}
        </ul> : null}
      </ConfirmationDialog> : null}
      {navigationGuard.pendingRoute ? <ConfirmationDialog title="离开并放弃修改？" description="工作流映射仍有未保存内容。离开页面后，这些修改将丢失。" confirmLabel="离开页面" destructive={false} onCancel={navigationGuard.cancel} onConfirm={navigationGuard.confirm} /> : null}
    </div>
  );
}

export const emptyInterface: AigcInterfaceInput = {
  name: "",
  description: "",
  toolDescription: "",
  protocol: "openai",
  capability: "text-to-image",
  channelId: "",
  enabled: true,
  toolPublishEnabled: false,
  mcpPublishEnabled: false,
  config: { model: "", parameters: createDefaultOpenAiParameters() },
};

export function defaultCapability(protocol: AigcInterfaceProtocol): AigcInterfaceCapability {
  if (protocol === "grok") return "text-to-video";
  if (protocol === "comfyui") return "text-to-image";
  return "text-to-image";
}

export function capabilityOptions(protocol: AigcInterfaceProtocol): Array<{ value: AigcInterfaceCapability; label: string }> {
  if (protocol === "openai") return [{ value: "text-to-image", label: "文生图" }, { value: "image-edit", label: "图片生成与编辑" }];
  if (protocol === "grok") return [
    { value: "text-to-image", label: "文生图" },
    { value: "image-edit", label: "图片编辑" },
    { value: "text-to-video", label: "文生视频" },
    { value: "image-to-video", label: "图生视频" },
    { value: "video-edit", label: "视频编辑" },
    { value: "video-extend", label: "视频续写" },
  ];
  return [{ value: "text-to-image", label: "文生图" }, { value: "image-edit", label: "图片编辑" }, { value: "text-to-video", label: "文生视频" }, { value: "image-to-video", label: "图生视频" }];
}

/** 将内部任务状态转换为面向创作者的中文状态。 */
function taskStatusLabel(status: AigcTaskStatus): string {
  if (status === "prepared") return "待运行";
  if (status === "queued") return "等待中";
  if (status === "running") return "生成中";
  if (status === "succeeded") return "已完成";
  if (status === "failed") return "生成失败";
  return "已取消";
}

/** 使用稳定中文格式展示 AIGC 任务时间。 */
function formatAigcTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

/** 以便于识别的单位展示产物大小。 */
function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

/** 将可恢复业务错误保留在当前页面。 */
export function aigcExpected(setMessage: (message: string) => void): ApiTaskPolicy["expected"] {
  const show = (error: { message: string }) => setMessage(error.message);
  return {
    VERSION_CONFLICT: show,
    VALIDATION_FAILED: show,
    NOT_FOUND: show,
  };
}
