import { Button } from "../ui/controls";
import { Checkbox } from "../ui/choice";
import { SearchSelect } from "../ui/search-select";
import { DatabaseZap, RefreshCw, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { EmbeddingConfigInput, EmbeddingSettingsDocument } from "../../shared/knowledge-retrieval-contracts";
import { api, ApiClientError } from "../api";
import { useApiTask } from "../api-task-provider";
import { useErrorToast } from "../error-toast-provider";
import { toUnexpectedErrorNotice } from "../api-error-policy";
import { SecretInput } from "../ui/secret-input";
import { useOnlineStatus } from "../use-online-status";
import { useUnsavedChanges } from "../ui/unsaved-changes";
import { Tabs } from "../ui/tabs";
import { ConfigurationEditorDialog } from "../components/configuration/configuration-editor-dialog";
import "../configuration.css";
import "../configuration-maintenance.css";

const CACHE_KEY = "pi-agent:knowledge-retrieval-cache";
type RebuildResult = Awaited<ReturnType<typeof api.rebuildKnowledgeRetrieval>>;

/** 显式展示服务模式，保存与已保存配置的索引重建保持独立。 */
export function KnowledgeRetrievalPage() {
  const { runApiTask } = useApiTask();
  const toast = useErrorToast();
  const controller = useRef({ runApiTask, toast }); controller.current = { runApiTask, toast };
  const online = useOnlineStatus();
  const [document, setDocument] = useState<EmbeddingSettingsDocument>();
  const [draft, setDraft] = useState<EmbeddingConfigInput>();
  const [baseline, setBaseline] = useState("");
  const [batch, setBatch] = useState("");
  const [category, setCategory] = useState<"connection" | "index">("connection");
  const [visible, setVisible] = useState(false);
  const [revealed, setRevealed] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [cached, setCached] = useState(false);
  const [reload, setReload] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [rebuildResult, setRebuildResult] = useState<RebuildResult>();
  const [rebuildUnknown, setRebuildUnknown] = useState(false);
  const [needsRebuild, setNeedsRebuild] = useState(false);
  const lock = useRef(false);
  const dirty = Boolean(draft) && (JSON.stringify(draft) !== baseline || batch.trim() === "" || Number(batch) !== draft?.batchSize);
  const writable = online && !cached && loadState === "ready" && !conflict;
  const guard = useUnsavedChanges({ dirty, busy, label: "语义检索配置", save, canSave: writable });
  /** 已保存密钥与读取显示状态分离，查看密钥不会生成待保存值。 */
  function apply(value: EmbeddingSettingsDocument) {
    const config = value.config;
    const next: EmbeddingConfigInput = { baseUrl: config?.baseUrl ?? "", model: config?.model ?? "", batchSize: config?.batchSize ?? 32, apiKey: "", enabled: config?.enabled ?? true, mode: config?.isManaged ? "managed" : "external" };
    setDocument(value); setDraft(next); setBaseline(JSON.stringify(next)); setBatch(String(next.batchSize)); setVisible(false); setRevealed(""); setKeyEdited(false); setConflict(false);
  }
  useEffect(() => {
    let active = true; setLoadState("loading");
    void controller.current.runApiTask(api.getKnowledgeRetrieval, { operation: "加载语义检索配置" }).then((result) => {
      if (!active) return;
      if (result.status === "success") { apply(result.data); setLoadState("ready"); setCached(false); localStorage.setItem(CACHE_KEY, JSON.stringify(result.data)); }
      else {
        setLoadState("error");
        try { const value = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as EmbeddingSettingsDocument | null; if (!document && value?.revision && value.config) { apply(value); setCached(true); } }
        catch { /* 损坏的脱敏缓存不掩盖原读取错误。 */ }
      }
    });
    return () => { active = false; };
  }, [reload]);
  function report(message: string, operation = "语义检索配置") { setError(message); toast.push(toUnexpectedErrorNotice(new ApiClientError("VALIDATION_FAILED", message, 400), operation)); }
  function update<K extends keyof EmbeddingConfigInput>(key: K, value: EmbeddingConfigInput[K]) { setDraft((current) => current ? { ...current, [key]: value } : current); setMessage(""); }
  async function reveal() {
    if (visible) { setVisible(false); return; }
    if (!document?.config?.hasApiKey || draft?.apiKey) { setVisible(true); return; }
    if (busy || !online || cached) return;
    setBusy(true);
    try { const result = await runApiTask(api.getKnowledgeRetrievalCredential, { operation: "读取 Embedding API Key" }); if (result.status === "success") { setRevealed(result.data.apiKey); setVisible(true); } }
    finally { setBusy(false); }
  }
  async function save(): Promise<boolean> {
    if (!document || !draft || lock.current || !writable) return false;
    const maximum = draft.mode === "managed" ? document.managed?.maxBatchSize ?? 4 : 128;
    if (!batch.trim() || !Number.isInteger(Number(batch)) || Number(batch) < 1 || Number(batch) > maximum) { report(`每批切片数必须为 1–${maximum} 的整数`); return false; }
    lock.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const result = await runApiTask(() => api.updateKnowledgeRetrieval(document.revision, { ...draft, batchSize: Number(batch) }), { operation: "保存语义检索配置", expected: {
        VERSION_CONFLICT: (reason) => { setConflict(true); setError(`${reason.message}。草稿已保留，请重新读取后审阅。`); },
        VALIDATION_FAILED: (reason) => setError(reason.message),
      } });
      if (result.status !== "success") return false;
      const previous = document.config, next = result.data.config;
      if (next?.enabled && (!previous?.enabled || next.model !== previous.model || next.baseUrl !== previous.baseUrl)) setNeedsRebuild(true);
      apply(result.data); localStorage.setItem(CACHE_KEY, JSON.stringify(result.data)); setRebuildResult(undefined);
      setMessage(next?.enabled ? "连接配置已保存，尚未执行索引重建。" : "语义检索已关闭；后续上传仅建立全文索引。"); return true;
    } finally { lock.current = false; setBusy(false); }
  }
  async function rebuild() {
    if (!writable || dirty || !document?.config?.enabled || lock.current) return;
    lock.current = true; setConfirm(false); setBusy(true); setRebuildResult(undefined); setError(""); setRebuildUnknown(false);
    try {
      const result = await runApiTask(api.rebuildKnowledgeRetrieval, { operation: "重建全部语义索引" });
      if (result.status === "success") {
        setRebuildResult(result.data); setNeedsRebuild(result.data.failedBases.length > 0);
        if (result.data.failedBases.length) report(`部分知识库重建未完成：${(result.data.failures ?? result.data.failedBases.map((baseId) => ({ baseId, message: "接口未返回具体错误，请检查知识库重建记录" }))).map((item) => `${item.baseId}：${item.message}`).join("；")}`, "重建全部语义索引");
      } else { setRebuildUnknown(true); setMessage("重建请求未取得完整结果，不能确认执行状态；请检查知识库后再决定是否重试。不会自动重提。"); }
    } finally { lock.current = false; setBusy(false); }
  }
  if (!document || !draft) return <main className="configuration-page configuration-maintenance-page"><header className="configuration-page__heading"><span className="configuration-eyebrow">SEMANTIC RETRIEVAL</span><h1>语义检索</h1></header><p role={loadState === "error" ? "alert" : "status"}>{loadState === "error" ? "配置读取未完成，请查看错误通知并重试。" : "正在读取配置…"}</p><button type="button" disabled={!online || loadState === "loading"} onClick={() => setReload((v) => v + 1)}>重新加载</button></main>;
  return <main className="configuration-page configuration-maintenance-page"><header className="configuration-page__heading"><span className="configuration-eyebrow">SEMANTIC RETRIEVAL</span><h1>语义检索</h1><p>选择 Embedding 服务，并使用已保存配置维护知识库索引。</p></header>
    {cached || !online ? <p className="configuration-save-notice" role="status">离线只读 · 显示上次保存的脱敏配置，不能保存或重建。</p> : null}
    {conflict || loadState === "error" ? <section className="configuration-inline-error" role="alert"><p>{conflict ? "版本冲突，修改保留；重新读取将放弃当前草稿。" : "配置读取未完成，旧配置仅供查看。"}</p><button type="button" disabled={!online || busy} onClick={() => guard.request(() => setReload((v) => v + 1))}>重新读取配置</button></section> : null}
    <section className="configuration-form-card"><small>已保存配置</small><h2>{document.config ? `${document.config.isManaged ? "内置服务" : "外部兼容服务"} · ${document.config.enabled ? "启用" : "关闭"}` : "尚未配置服务"}</h2><p className="maintenance-muted">服务模式是配置事实，不代表连接健康或索引已最新。</p></section>
    <Tabs label="配置页面分区" panelId="configuration-maintenance-panel" value={category} onChange={setCategory} items={[{ id: "connection", label: "连接配置" }, { id: "index", label: "索引维护" }]} />
    <div role="tabpanel" id="configuration-maintenance-panel" aria-labelledby={`configuration-maintenance-panel-${category}`}>
    {category === "connection" ? <><section className="configuration-form-card"><fieldset className="maintenance-fieldset" disabled={!writable || busy}><label><span>服务模式</span><SearchSelect
      ariaLabel="服务模式"
      value={draft.mode}
      onChange={(next) => { const mode = next as "managed" | "external"; update("mode", mode); setBatch(mode === "managed" ? String(document.managed?.maxBatchSize ?? 4) : "32"); setVisible(false); setRevealed(""); }}
      options={[
        { value: "managed", label: `内置服务${document.managed?.available === false ? "（当前部署未提供）" : ""}`, disabled: !document.managed?.available && !document.config?.isManaged },
        { value: "external", label: "外部 OpenAI 兼容服务" },
      ]}
    /></label>
      <label className="configuration-capability-toggle"><span>启用语义检索<small>启用时上传建立全文与向量索引；重新启用后需要重建已有资料。</small></span><Checkbox aria-label="启用语义检索" checked={draft.enabled} onChange={(event) => update("enabled", event.target.checked)} /></label>
      {draft.mode === "managed" ? <div className="maintenance-summary"><strong>{document.managed?.model ?? document.config?.model}</strong><p>部署随附 CPU 服务，地址由服务端管理，无需 API Key。</p></div> : <><label><span>API Base URL</span><input aria-label="Embedding API Base URL" value={draft.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} /></label><label><span>模型</span><input aria-label="Embedding 模型" value={draft.model} onChange={(event) => update("model", event.target.value)} /></label><label><span>API Key<small>{document.config?.hasApiKey ? "留空保留已有密钥；更换地址时核对密钥归属。" : "仅保存到服务端。"}</small></span><SecretInput aria-label="Embedding API Key" autoComplete="new-password" value={keyEdited ? draft.apiKey : visible ? revealed : draft.apiKey} visible={visible} onVisibilityChange={() => void reveal()} onChange={(event) => { setKeyEdited(true); update("apiKey", event.target.value); }} /></label></>}
      <label><span>每批切片数<small>{draft.mode === "managed" ? "内置范围 1–4。" : "外部范围 1–128。"}</small></span><input type="number" aria-label="每批切片数" min={1} max={draft.mode === "managed" ? 4 : 128} value={batch} onChange={(event) => { setBatch(event.target.value); setMessage(""); }} /></label></fieldset></section><div className="configuration-save-bar"><small>{dirty ? "有未保存修改" : "当前显示已保存配置"}</small><Button variant="primary" type="button" className="configuration-primary-action" disabled={!dirty || !writable || busy} onClick={() => void save()}><Save size={16} />{busy ? "处理中…" : "保存连接配置"}</Button></div></> : <section className="configuration-form-card"><h2><DatabaseZap size={18} />使用已保存配置重建</h2><p>对全部知识库执行；原有全文检索仍可使用。保存连接不会自动重建已有资料。</p>{dirty ? <p className="configuration-inline-error">还有未保存修改，请先回到连接配置保存。</p> : null}{needsRebuild ? <p className="configuration-save-notice">本次观察到服务模型变更、重新启用或部分重建失败，请重建已有索引。</p> : null}<Button type="button" className="configuration-secondary-action" disabled={!writable || busy || dirty || !document.config?.enabled} onClick={() => setConfirm(true)}><RefreshCw size={16} />{busy ? "正在执行重建…" : "手动重建索引"}</Button><p className="maintenance-muted">接口同步等待完成，不提供实时百分比或取消；未显示提醒不代表索引已最新。</p>{rebuildResult ? <div role="status"><p>已重建 {rebuildResult.rebuiltBases} / {rebuildResult.totalBases} 个知识库。</p>{rebuildResult.failures?.map((item) => <p key={item.baseId} className="configuration-inline-error">{item.baseId}：{item.message}</p>)}</div> : null}{rebuildUnknown ? <p className="configuration-inline-error">执行结果未确认，请检查知识库后决定下一步。</p> : null}</section>}
    </div>
    {error ? <p className="configuration-inline-error" role="alert">{error}</p> : null}{message ? <p role="status">{message}</p> : null}
    {confirm ? <ConfigurationEditorDialog variant="confirmation" title="重建全部语义索引" description="使用已保存的 Embedding 配置，覆盖所有知识库；不提供实时进度或取消。" busy={busy} onClose={() => setConfirm(false)} footer={<><Button type="button" className="configuration-secondary-action" onClick={() => setConfirm(false)}>取消</Button><Button variant="primary" type="button" className="configuration-primary-action" disabled={!writable || dirty || busy} onClick={() => void rebuild()}>开始重建</Button></>}><p>请确认服务和模型已保存。页面关闭不代表服务端停止执行。</p></ConfigurationEditorDialog> : null}
    {guard.dialog}
  </main>;
}
