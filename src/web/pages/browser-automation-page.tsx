import { Button, NumberField, TextField } from "../ui/controls";
import { Checkbox } from "../ui/choice";
import { Plus, Save, ServerCog, Trash2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BrowserAutomationConfig, BrowserAutomationSettingsDocument, BrowserGrantedPermission, TrustedBrowserOrigin } from "../../shared/browser-automation-contracts";
import { api, ApiClientError } from "../api";
import { toUnexpectedErrorNotice } from "../api-error-policy";
import { useErrorToast } from "../error-toast-provider";
import { useApiTask } from "../api-task-provider";
import { useOnlineStatus } from "../use-online-status";
import { useUnsavedChanges } from "../ui/unsaved-changes";
import { ConfigurationEditorDialog } from "../components/configuration/configuration-editor-dialog";
import { Tabs } from "../ui/tabs";
import { recordConfigurationSave } from "../components/configuration/configuration-effect-notice";
import "../configuration.css";
import "../configuration-maintenance.css";

const OFFLINE_KEY = "bugpaw:browser-automation:offline:v1";
type Category = "range" | "permissions" | "advanced";
type OriginEditor = { index: number; initial: string; value: TrustedBrowserOrigin };

/** 保留浏览器安全合同，统一保护整页草稿并按需展示 Origin 权限。 */
export function BrowserAutomationPage() {
  const { runApiTask } = useApiTask();
  const toast = useErrorToast();
  const controller = useRef({ runApiTask, toast }); controller.current = { runApiTask, toast };
  const online = useOnlineStatus();
  const [document, setDocument] = useState<BrowserAutomationSettingsDocument>();
  const [draft, setDraft] = useState<BrowserAutomationConfig>();
  const [category, setCategory] = useState<Category>("range");
  const [editor, setEditor] = useState<OriginEditor>();
  const [confirm, setConfirm] = useState<"disable" | "origin-close">();
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [reload, setReload] = useState(0);
  const [cached, setCached] = useState(false);
  const [readAt, setReadAt] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string }>();
  const submit = useRef(false);
  const editorDirty = Boolean(editor && JSON.stringify(editor.value) !== editor.initial);
  const dirty = Boolean(document && draft && JSON.stringify(document.config) !== JSON.stringify(draft)) || editorDirty;
  const writable = online && !cached && loadState === "ready" && !conflict;
  const guard = useUnsavedChanges({ dirty, busy: saving || testing || refreshing, label: "浏览器执行设置", save, canSave: writable, onDiscard: () => { setDraft(document?.config ? structuredClone(document.config) : undefined); setEditor(undefined); } });
  useEffect(() => {
    let active = true; setLoadState("loading");
    void controller.current.runApiTask(api.getBrowserAutomation, { operation: "读取浏览器执行配置" }).then((result) => {
      if (!active) return;
      if (result.status === "success") {
        if (result.data.deployment?.lastFailureMessage) reportStatusError(result.data.deployment.lastFailureMessage);
        setDocument(result.data); setDraft(structuredClone(result.data.config)); setCached(false); setLoadState("ready"); setConflict(false); setReadAt(new Date().toLocaleString());
        localStorage.setItem(OFFLINE_KEY, JSON.stringify({ revision: result.data.revision, config: result.data.config }));
      } else {
        setLoadState("error");
        // 离线快照只包含配置，绝不能生成虚假的零队列或不可用状态。
        try { const value = JSON.parse(localStorage.getItem(OFFLINE_KEY) ?? "null") as BrowserAutomationSettingsDocument | null; if (value?.revision && value.config && !document) { setDocument({ revision: value.revision, config: value.config }); setDraft(value.config); setCached(true); } }
        catch { /* 损坏缓存不覆盖原始读取错误。 */ }
      }
    });
    return () => { active = false; };
  }, [reload]);

  /** 服务状态中的实际失败也进入统一错误通知，不只显示不可用标签。 */
  function reportStatusError(message: string) { controller.current.toast.push(toUnexpectedErrorNotice(new ApiClientError("INTERNAL_ERROR", message, 502), "浏览器组件健康检查")); }
  function patch(value: Partial<BrowserAutomationConfig>) { setDraft((current) => current ? { ...current, ...value } : current); setNotice(""); }
  function validation(message: string) { setError(message); toast.push(toUnexpectedErrorNotice(new ApiClientError("VALIDATION_FAILED", message, 400), "浏览器设置校验")); }
  /** 编辑器只加入父页草稿；离开前保存也包含未提交的 Origin 编辑。 */
  function prepareOrigin(candidate: BrowserAutomationConfig): BrowserAutomationConfig | undefined {
    if (!editor) return candidate;
    try {
      const url = new URL(editor.value.origin.trim());
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.hostname.includes("*")) throw new Error("请输入不含路径、查询、凭证或通配符的精确 HTTP(S) Origin");
      if (candidate.trustedOrigins.some((item, index) => index !== editor.index && item.origin === url.origin)) throw new Error("该 Origin 已存在");
      const origins = [...candidate.trustedOrigins]; const value = { ...editor.value, origin: url.origin };
      if (editor.index < 0) origins.push(value); else origins[editor.index] = value;
      return { ...candidate, trustedOrigins: origins };
    } catch (reason) { validation(reason instanceof Error ? reason.message : "Origin 校验捕获到非 Error 异常"); return; }
  }
  async function save(): Promise<boolean> {
    if (!document || !draft || !writable || submit.current) return false;
    const candidate = prepareOrigin(draft); if (!candidate) return false;
    submit.current = true; setSaving(true); setError(""); setNotice("");
    try {
      const result = await runApiTask(() => api.updateBrowserAutomation(document.revision, candidate), { operation: "保存浏览器设置", expected: {
        VERSION_CONFLICT: (reason) => { setConflict(true); setError(`${reason.message}。草稿已保留，请重新加载后审阅。`); },
        VALIDATION_FAILED: (reason) => setError(reason.message),
      } });
      if (result.status !== "success") return false;
      setDocument(result.data); setDraft(structuredClone(result.data.config)); setEditor(undefined); setReadAt(new Date().toLocaleString());
      localStorage.setItem(OFFLINE_KEY, JSON.stringify({ revision: result.data.revision, config: result.data.config }));
      recordConfigurationSave("browser", result.data.runtimeRefreshRequired === true);
      if (result.data.postCommitError) { setError(result.data.postCommitError.message); toast.push(toUnexpectedErrorNotice(new ApiClientError("RUNTIME_REFRESH_FAILED", result.data.postCommitError.message, 500, result.data.postCommitError.requestId), "应用已保存浏览器设置")); }
      setNotice(result.data.runtimeRefreshRequired ? "浏览器配置已提交，运行时更新未完成，请前往系统诊断处理；不要重复保存。" : "浏览器配置已保存，运行时更新完成。");
      return true;
    } finally { submit.current = false; setSaving(false); }
  }
  async function refreshStatus() {
    if (refreshing || !online) return; setRefreshing(true);
    try { const result = await runApiTask(api.getBrowserAutomation, { operation: "刷新浏览器运行状态" }); if (result.status === "success") { if (result.data.deployment?.lastFailureMessage) reportStatusError(result.data.deployment.lastFailureMessage); setDocument((current) => current ? { ...current, deployment: result.data.deployment } : current); setReadAt(new Date().toLocaleString()); } }
    finally { setRefreshing(false); }
  }
  async function test() {
    if (testing || !online || cached) return; setTesting(true); setTestResult(undefined);
    try { const result = await runApiTask(api.testBrowserAutomation, { operation: "测试浏览器组件" }); if (result.status === "success") { setTestResult(result.data); if (!result.data.ok) toast.push(toUnexpectedErrorNotice(new ApiClientError("INTERNAL_ERROR", result.data.message, 502), "测试浏览器组件")); } }
    finally { setTesting(false); }
  }
  function openOrigin(index: number) {
    const value: TrustedBrowserOrigin = index < 0 ? { origin: "", allowTextInput: false, allowFormSubmit: false, allowFileUpload: false, grantedPermissions: [] } : structuredClone(draft!.trustedOrigins[index]);
    setEditor({ index, value, initial: JSON.stringify(value) });
  }
  function closeEditor() { if (editorDirty) setConfirm("origin-close"); else setEditor(undefined); }
  if (!document || !draft) return <main className="configuration-page configuration-maintenance-page"><header className="configuration-page__heading"><span className="configuration-eyebrow">BROWSER AUTOMATION</span><h1>浏览器执行</h1></header><p role={loadState === "error" ? "alert" : "status"}>{loadState === "error" ? "配置读取未完成，请查看错误通知并重试。" : "正在读取浏览器配置…"}</p><button type="button" onClick={() => setReload((value) => value + 1)} disabled={!online || loadState === "loading"}>重新加载</button></main>;
  const deployment = cached || !online ? undefined : document.deployment;
  const busy = saving || testing || refreshing;
  return <main className="configuration-page configuration-maintenance-page browser-automation-page">
    <header className="configuration-page__heading"><span className="configuration-eyebrow">BROWSER AUTOMATION</span><h1>浏览器执行</h1><p>管理浏览范围、精确 Origin 交互权限和执行资源。</p></header>
    {cached || !online ? <p className="configuration-save-notice" role="status">离线只读 · 配置快照不包含实时服务状态。</p> : null}
    {loadState === "error" || conflict ? <div className="configuration-inline-error" role="alert">{conflict ? "配置版本冲突，草稿已保留。重新加载会放弃当前草稿。" : "读取未完成，旧配置仅供查看。"}<button type="button" disabled={busy || !online} onClick={() => guard.request(() => { setEditor(undefined); setReload((value) => value + 1); })}>重新加载配置</button></div> : null}
    <section className="configuration-form-card"><div className="maintenance-row"><h2>服务状态</h2><div className="maintenance-item-actions"><Button type="button" className="configuration-secondary-action" disabled={busy || !online || cached} onClick={() => void refreshStatus()}><RefreshCw size={16} />刷新状态</Button><Button type="button" className="configuration-secondary-action" disabled={busy || !online || cached || !deployment?.available} onClick={() => void test()}><ServerCog size={16} />{testing ? "测试中…" : "测试浏览器组件"}</Button></div></div>
      <div className="maintenance-stats"><div><small>组件</small><strong>{deployment ? deployment.available ? "已部署" : "未部署" : "未知"}</strong></div><div><small>Worker / Chromium</small><strong>{deployment ? `${deployment.workerAvailable ? "可用" : "不可用"} / ${deployment.chromiumReady ? "就绪" : "未就绪"}` : "未知"}</strong></div><div><small>活动 Context</small><strong>{deployment?.activeContexts ?? "—"}</strong></div><div><small>排队任务</small><strong>{deployment?.queuedRequests ?? "—"}</strong></div></div>
      <p className="maintenance-muted">最近读取：{readAt || "未知"}。组件测试不使用草稿，也不代表 Agent 已获工具授权。</p>
      {deployment && !deployment.available ? <p className="configuration-inline-error">当前部署未包含组件，请使用 browser 或 full 部署组合。</p> : null}
      {testResult ? <p className={testResult.ok ? "configuration-save-notice" : "configuration-inline-error"} role={testResult.ok ? "status" : "alert"}>{testResult.message}</p> : null}
      <label className="configuration-capability-toggle"><span>启用浏览器执行<small>启用后仍需 Agent 工具权限；保存停用会停止资源池并影响浏览器任务。</small></span><Checkbox aria-label="启用浏览器执行" checked={draft.enabled} disabled={!writable || busy} onChange={(event) => event.target.checked || !document.config.enabled ? patch({ enabled: event.target.checked }) : setConfirm("disable")} /></label>
    </section>
    <Tabs label="配置页面分区" panelId="configuration-maintenance-panel" value={category} onChange={setCategory} items={[{ id: "range", label: "浏览范围" }, { id: "permissions", label: "交互权限" }, { id: "advanced", label: "高级限制" }]} />
    <fieldset role="tabpanel" id="configuration-maintenance-panel" aria-labelledby={`configuration-maintenance-panel-${category}`} className="maintenance-fieldset" disabled={!writable || busy}>
      {category === "range" ? <><BrowserSettingsSection index={1} title="公开浏览范围" description="固定 HTTPS；空清单允许全部公网站点"><p className="configuration-help"><strong>{draft.publicBrowsing.allowedDomains.length ? draft.publicBrowsing.allowedDomains.join("、") : "所有公网 HTTPS 站点"}</strong><br />私网、回环、链路本地、云元数据和重绑定地址始终由受控出口拒绝。</p><BrowserNumberField label="导航超时（秒）" value={draft.publicBrowsing.navigationTimeoutMs / 1000} min={10} max={120} onChange={(value) => patch({ publicBrowsing: { ...draft.publicBrowsing, navigationTimeoutMs: value * 1000 } })} /><BrowserNumberField label="单 Run 打开上限" value={draft.publicBrowsing.maxPagesPerRun} min={1} max={100} onChange={(value) => patch({ publicBrowsing: { ...draft.publicBrowsing, maxPagesPerRun: value } })} /></BrowserSettingsSection><BrowserSettingsSection index={2} title="本地静态页面" description="预览当前 Agent 工作区 HTML"><PermissionSwitches value={draft.localPreview} onChange={(localPreview) => patch({ localPreview })} /><p className="configuration-help">不挂载整个工作区，不使用 file://；拒绝路径穿越和符号链接。</p></BrowserSettingsSection></> : null}
      {category === "permissions" ? <section className="configuration-form-card"><div className="maintenance-row"><h2>受信任 UI Origin</h2><Button variant="primary" type="button" className="configuration-primary-action" data-origin-create onClick={() => openOrigin(-1)}><Plus size={16} />添加 Origin</Button></div><p className="maintenance-muted">编辑只加入页面草稿，保存整页后生效。</p>{draft.trustedOrigins.length ? draft.trustedOrigins.map((item, index) => <article key={item.origin} className="maintenance-item"><div className="maintenance-row"><code>{item.origin}</code><div className="maintenance-item-actions"><Button type="button" className="configuration-secondary-action" onClick={() => openOrigin(index)}>编辑权限</Button><Button variant="danger" type="button" className="configuration-secondary-action configuration-secondary-action--danger" aria-label={`移出 ${item.origin}`} onClick={() => patch({ trustedOrigins: draft.trustedOrigins.filter((_, candidate) => candidate !== index) })}><Trash2 size={15} />移出草稿</Button></div></div><p>{permissionSummary(item)}</p></article>) : <p>尚未信任任何 UI Origin；公开网页只能只读浏览。</p>}</section> : null}
      {category === "advanced" ? <><BrowserSettingsSection index={3} title="资源池" description="调整并发、排队和租约边界"><BrowserNumberField label="全局 Context" value={draft.pool.maxContexts} min={1} max={4} onChange={(value) => patch({ pool: { ...draft.pool, maxContexts: value } })} /><BrowserNumberField label="队列容量" value={draft.pool.queueCapacity} min={1} max={50} onChange={(value) => patch({ pool: { ...draft.pool, queueCapacity: value } })} /><BrowserNumberField label="排队等待（分钟）" value={draft.pool.queueWaitMs / 60000} min={1} max={60} onChange={(value) => patch({ pool: { ...draft.pool, queueWaitMs: value * 60000 } })} /><BrowserNumberField label="孤儿回收（分钟）" value={draft.pool.orphanTimeoutMs / 60000} min={5} max={60} onChange={(value) => patch({ pool: { ...draft.pool, orphanTimeoutMs: value * 60000 } })} /><BrowserNumberField label="Run 总时限（分钟）" value={draft.pool.runTimeoutMs / 60000} min={15} max={180} onChange={(value) => patch({ pool: { ...draft.pool, runTimeoutMs: value * 60000 } })} /></BrowserSettingsSection><BrowserSettingsSection index={4} title="浏览产物" description="仅写入当前 Agent 工作区"><BrowserNumberField label="截图数 / Run" value={draft.artifacts.maxScreenshotsPerRun} min={1} max={50} onChange={(value) => patch({ artifacts: { ...draft.artifacts, maxScreenshotsPerRun: value } })} /><BrowserNumberField label="下载数 / Run" value={draft.artifacts.maxDownloadsPerRun} min={0} max={30} onChange={(value) => patch({ artifacts: { ...draft.artifacts, maxDownloadsPerRun: value } })} /><BrowserNumberField label="单文件下载（MiB）" value={draft.artifacts.maxDownloadBytes / 1048576} min={1} max={100} onChange={(value) => patch({ artifacts: { ...draft.artifacts, maxDownloadBytes: value * 1048576 } })} /><p className="configuration-help">默认拒绝可执行文件、安装包、脚本包和未知二进制；审计不记录页面正文或凭证。</p></BrowserSettingsSection></> : null}
    </fieldset>
    {error ? <p className="configuration-inline-error" role="alert">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    <div className="configuration-save-bar"><small>{dirty ? "有未保存修改，跨分区保留草稿" : "当前显示已保存配置"}</small><Button variant="primary" type="button" className="configuration-primary-action" disabled={!dirty || !writable || busy} onClick={() => void save()}><Save size={16} />{saving ? "保存中…" : "保存浏览器设置"}</Button></div>
    {editor ? <ConfigurationEditorDialog variant="drawer" classPrefix="browser" closeLabel="关闭 Origin 编辑" returnFocusSelector="[data-origin-create]" title={editor.index < 0 ? "新增受信任 Origin" : "编辑 Origin 权限"} description="只加入页面草稿，保存整页后才改变配置。" busy={busy} suspended={Boolean(confirm) || guard.pending} onClose={closeEditor} footer={<Button variant="primary" type="button" className="configuration-primary-action" disabled={!writable || busy} onClick={() => { const candidate = prepareOrigin(draft); if (candidate) { setDraft(candidate); setEditor(undefined); setNotice("Origin 已加入页面草稿，尚未保存。"); } }}>加入页面草稿</Button>}><label><span>精确 Origin</span><TextField aria-label="新增受信任 Origin" value={editor.value.origin} readOnly={editor.index >= 0} disabled={!writable} onChange={(event) => setEditor({ ...editor, value: { ...editor.value, origin: event.target.value } })} /></label><PermissionSwitches value={editor.value} onChange={(next) => setEditor({ ...editor, value: { ...editor.value, ...next } })} /></ConfigurationEditorDialog> : null}
    {confirm ? <ConfigurationEditorDialog variant="confirmation" title={confirm === "disable" ? "停用浏览器执行" : "放弃 Origin 编辑？"} description={confirm === "disable" ? "保存停用会停止浏览器资源池，影响浏览器任务；此确认先更新草稿。" : "未加入页面草稿的输入将被放弃，其他页面修改保留。"} busy={busy} onClose={() => setConfirm(undefined)} footer={<><Button type="button" className="configuration-secondary-action" onClick={() => setConfirm(undefined)}>继续编辑</Button><Button variant="danger" type="button" className="configuration-secondary-action configuration-secondary-action--danger" onClick={() => { if (confirm === "disable") patch({ enabled: false }); else setEditor(undefined); setConfirm(undefined); }}>{confirm === "disable" ? "确认停用草稿" : "放弃 Origin 输入"}</Button></>}><p>操作不会在此刻写入配置。</p></ConfigurationEditorDialog> : null}
    {guard.dialog}
  </main>;
}

/** 汇总实际授权字段，不制造风险分级或 Agent 授权事实。 */
function permissionSummary(value: TrustedBrowserOrigin) {
  const labels = [value.allowTextInput && "文本输入", value.allowFormSubmit && "表单提交", value.allowFileUpload && "文件上传", ...value.grantedPermissions.map((permission) => permission === "clipboard-read" ? "读取剪贴板" : "写入剪贴板")].filter(Boolean);
  return labels.join(" · ") || "只读，无额外交互权限";
}
/** 表单区块沿用配置中心卡片层级。 */
function BrowserSettingsSection({ index, title, description, children }: { index: number; title: string; description: string; children: ReactNode }) {
  return <section className="configuration-form-card"><div className="configuration-section__heading"><div><span>{String(index).padStart(2, "0")}</span><h2>{title}</h2></div><small>{description}</small></div>{children}</section>;
}

/** 精确 Origin 和本地预览共享有限权限字段。 */
function PermissionSwitches({ value, onChange }: { value: Omit<TrustedBrowserOrigin, "origin">; onChange: (value: Omit<TrustedBrowserOrigin, "origin">) => void }) {
  const permissions: Array<{ permission: BrowserGrantedPermission; label: string }> = [
    { permission: "clipboard-read", label: "允许读取剪贴板" },
    { permission: "clipboard-write", label: "允许写入剪贴板" },
  ];
  const togglePermission = (permission: BrowserGrantedPermission, enabled: boolean) => {
    const grantedPermissions = enabled
      ? [...new Set([...value.grantedPermissions, permission])]
      : value.grantedPermissions.filter((candidate) => candidate !== permission);
    onChange({ ...value, grantedPermissions });
  };
  return <>
    {([{ key: "allowTextInput", label: "允许文本输入" }, { key: "allowFormSubmit", label: "允许表单提交" }, { key: "allowFileUpload", label: "允许文件上传" }] as const).map(({ key, label }) => <label className="configuration-capability-toggle" key={key}><span>{label}</span><Checkbox aria-label={label} checked={value[key]} onChange={(event) => onChange({ ...value, [key]: event.target.checked })} /></label>)}
    {permissions.map(({ permission, label }) => <label className="configuration-capability-toggle" key={permission}><span>{label}</span><Checkbox aria-label={label} checked={value.grantedPermissions.includes(permission)} onChange={(event) => togglePermission(permission, event.target.checked)} /></label>)}
  </>;
}

/** 保留空数值输入，交由保存校验拒绝，不能误写为零。 */
function BrowserNumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return <label><span>{label}</span><NumberField aria-label={label} min={min} max={max} value={Number.isNaN(value) ? "" : value} onChange={(event) => onChange(event.target.value === "" ? Number.NaN : Number(event.target.value))} /></label>;
}
