import { SearchField, Button, FilePickerButton, Textarea } from "../ui/controls";
import { SearchSelect } from "../ui/search-select";
import { Download, FileClock, RotateCcw, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ConfigurationRestorePreview } from "../../shared/configuration-operations-contracts";
import { api, ApiClientError, type ConfigurationHistoryEntry, type ConfigurationImportPreview } from "../api";
import { useApiTask, type ApiTaskPolicy } from "../api-task-provider";
import { useErrorToast } from "../error-toast-provider";
import { toUnexpectedErrorNotice } from "../api-error-policy";
import { useOnlineStatus } from "../use-online-status";
import { ConfigurationEffectNotice, recordConfigurationSave, configurationRefreshGeneration, confirmConfigurationRefresh } from "../components/configuration/configuration-effect-notice";
import { useUnsavedChanges } from "../ui/unsaved-changes";
import { Tabs } from "../ui/tabs";
import { ConfigurationEditorDialog } from "../components/configuration/configuration-editor-dialog";
import "../configuration.css";
import "../configuration-maintenance.css";

type Category = "import" | "export" | "history";

/** 输入、一次性服务端预览和提交结果分步呈现，恢复必须先审阅绑定版本的安全差异。 */
export function ConfigurationOperationsPage() {
  const { runApiTask } = useApiTask();
  const toast = useErrorToast();
  const controller = useRef({ runApiTask, toast }); controller.current = { runApiTask, toast };
  const online = useOnlineStatus();
  const [category, setCategory] = useState<Category>("import");
  const [source, setSource] = useState("");
  const sourceVersion = useRef(0);
  const [preview, setPreview] = useState<ConfigurationImportPreview>();
  const [applied, setApplied] = useState(false);
  const [history, setHistory] = useState<ConfigurationHistoryEntry[]>([]);
  const [historyState, setHistoryState] = useState<"loading" | "ready" | "error">("loading");
  const [historyReload, setHistoryReload] = useState(0);
  const [filter, setFilter] = useState("all");
  const [scope, setScope] = useState("all");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [generatingPreview, setGeneratingPreview] = useState(false);
  const [restoreEntry, setRestoreEntry] = useState<ConfigurationHistoryEntry>();
  const [restorePreview, setRestorePreview] = useState<ConfigurationRestorePreview>();
  const [restoreState, setRestoreState] = useState<"loading" | "ready" | "error">("loading");
  const [confirmation, setConfirmation] = useState<"import" | "restore">();
  const lock = useRef(false);
  const restoreRequest = useRef(0);
  const guard = useUnsavedChanges({ dirty: Boolean(source.trim() || preview), busy, label: "配置导入输入", save: async () => false, discardOnly: true, onDiscard: () => { changeSource(""); } });
  useEffect(() => {
    let active = true; setHistoryState("loading");
    void controller.current.runApiTask(api.listConfigurationHistory, { operation: "加载配置历史" }).then((result) => {
      if (!active) return;
      if (result.status === "success") { setHistory(result.data.entries); setHistoryState("ready"); }
      else setHistoryState("error");
    });
    return () => { active = false; };
  }, [historyReload]);
  /** 修改输入使所有未完成的预览请求失效，不允许旧响应重新启用应用按钮。 */
  function changeSource(value: string) { sourceVersion.current += 1; setSource(value); setPreview(undefined); setApplied(false); }
  function report(message: string) { setError(message); toast.push(toUnexpectedErrorNotice(new ApiClientError("IMPORT_INVALID", message, 400), "配置导入与恢复")); }
  const expected: ApiTaskPolicy["expected"] = { IMPORT_PREVIEW_EXPIRED: (reason) => setError(reason.message), IMPORT_CONFIRMATION_REQUIRED: (reason) => setError(reason.message), IMPORT_INVALID: (reason) => setError(reason.message), HISTORY_NOT_RESTORABLE: (reason) => setError(reason.message), HISTORY_RESTORE_INVALID: (reason) => setError(reason.message), VERSION_CONFLICT: (reason) => setError(`${reason.message}，请重新预览后审阅。`) };
  async function createPreview() {
    if (lock.current || !online) return;
    let value: unknown;
    try { value = JSON.parse(source); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("导入内容必须是 JSON 对象"); }
    catch (reason) { report(`JSON 校验：${reason instanceof Error ? reason.message : "捕获到非 Error 异常"}`); return; }
    const version = sourceVersion.current;
    lock.current = true;
    setBusy(true);
    setGeneratingPreview(true);
    setError("");
    setPreview(undefined);
    try {
      const result = await runApiTask(() => api.previewConfigurationImport(value), { operation: "生成配置导入预览", expected });
      if (sourceVersion.current === version && result.status === "success") setPreview(result.data);
    } finally {
      lock.current = false;
      setBusy(false);
      setGeneratingPreview(false);
    }
  }
  async function readFile(file?: File) {
    if (!file || !online || lock.current) return;
    const version = ++sourceVersion.current; setPreview(undefined); lock.current = true; setBusy(true);
    try {
      if (file.size > 1024 * 1024) throw new Error("JSON 文件不能超过 1 MiB，请分开导入配置");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      if (version === sourceVersion.current) changeSource(text);
    } catch (reason) { report(`UTF-8 配置文件读取：${reason instanceof Error ? reason.message : "捕获到非 Error 异常"}`); }
    finally { lock.current = false; setBusy(false); }
  }
  async function apply() {
    if (!preview || lock.current || !online || preview.invalid.length || preview.conflicts.length) return;
    const id = preview.previewId; setConfirmation(undefined); setPreview(undefined); lock.current = true; setBusy(true); setError("");
    const generation = configurationRefreshGeneration();
    try {
      const result = await runApiTask(() => api.applyConfigurationImport(id), { operation: "应用配置导入", expected });
      if (result.status !== "success") { setMessage("本次应用未取得成功结果；预览已消费或失效，输入已保留。请核对配置后重新预览，勿重复提交旧预览。"); return; }
      changeSource(""); setApplied(true); recordConfigurationSave("operations", result.data.runtimeRefreshRequired);
      if (!result.data.runtimeRefreshRequired) confirmConfigurationRefresh(generation);
      if (result.data.postCommitError) postCommit(result.data.postCommitError);
      setMessage(result.data.runtimeRefreshRequired ? "配置已导入，运行时刷新未完成；请处理刷新，勿重复导入。" : "配置已导入，运行时刷新完成。"); setHistoryReload((value) => value + 1);
    } finally { lock.current = false; setBusy(false); }
  }
  /** 提交后错误进入统一 Toast，并保持成功写入这一事实。 */
  function postCommit(value: { message: string; requestId: string }) { setError(value.message); toast.push(toUnexpectedErrorNotice(new ApiClientError("RUNTIME_REFRESH_FAILED", value.message, 500, value.requestId), "应用已保存配置")); }
  async function openHistory(entry: ConfigurationHistoryEntry) {
    const sequence = ++restoreRequest.current;
    setRestoreEntry(entry); setRestorePreview(undefined); setRestoreState("loading"); setError("");
    if (!entry.restorable) { setRestoreState("ready"); return; }
    const result = await runApiTask(() => api.previewConfigurationRestore(entry.id), { operation: "读取历史恢复安全差异", expected });
    if (restoreRequest.current !== sequence) return;
    if (result.status === "success") { setRestorePreview(result.data); setRestoreState("ready"); }
    else setRestoreState("error");
  }
  function closeHistory() { if (busy) return; restoreRequest.current += 1; setRestoreEntry(undefined); setRestorePreview(undefined); }
  async function restore() {
    if (!restorePreview || lock.current || !online) return;
    const value = restorePreview; lock.current = true; setBusy(true); setConfirmation(undefined); setError("");
    // 恢复必须提交审阅时的版本，不能临时获取最新版本绕开期间的修改。
    setRestorePreview(undefined);
    try {
      const result = await runApiTask(() => api.restoreConfigurationHistory(value.id, value.revision), { operation: "恢复已审阅历史配置", expected });
      if (result.status !== "success") { setRestoreState("error"); setMessage("恢复未取得成功结果，需重新读取差异后审阅。不要直接重复恢复。"); return; }
      recordConfigurationSave("operations", result.data.runtimeRefreshRequired !== false);
      if (result.data.postCommitError) postCommit(result.data.postCommitError);
      setMessage(result.data.runtimeRefreshRequired === false ? "历史设置已恢复，Agent 运行时刷新完成。" : "历史设置已恢复，请到系统诊断刷新核心配置。");
      setRestoreEntry(undefined); setHistoryReload((v) => v + 1);
    } finally { lock.current = false; setBusy(false); }
  }
  const shownHistory = history.filter((entry) => (filter === "all" || (filter === "restorable" ? entry.restorable : !entry.restorable)) && (scope === "all" || entry.scope === scope) && `${entry.summary} ${entry.targetId ?? ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <main className="configuration-page configuration-maintenance-page configuration-operations-page"><header className="configuration-page__heading"><span className="configuration-eyebrow">IMPORT · EXPORT · HISTORY</span><h1>导入与变更</h1><p>先审阅，再应用；安全导出不是完整生产数据备份。</p></header><ConfigurationEffectNotice configKey="operations" />
    {error ? <p className="configuration-inline-error" role="alert">{error}</p> : null}{message ? <p className="configuration-inline-message" role="status">{message}</p> : null}
    {!online ? <p className="configuration-save-notice">离线只读，导入、导出与恢复暂停。</p> : null}
    <Tabs label="配置页面分区" panelId="configuration-maintenance-panel" value={category} onChange={setCategory} items={[{ id: "import", label: "导入配置" }, { id: "export", label: "安全导出" }, { id: "history", label: "变更历史" }]} />
    <div role="tabpanel" id="configuration-maintenance-panel" aria-labelledby={`configuration-maintenance-panel-${category}`}>
    {category === "import" ? <><div className="maintenance-steps"><span className={!preview && !applied ? "is-active" : undefined}>01 输入</span><span className={preview ? "is-active" : undefined}>02 服务端预览</span><span className={applied ? "is-active" : undefined}>03 应用结果</span></div><section className="configuration-form-card"><h2><Upload size={18} />输入配置</h2><p>导入仅处理 models/settings，不恢复 Agent 档案、凭证、知识库或其他应用数据。</p><div className="bp-field"><FilePickerButton label="配置 JSON 文件" accept=".json,application/json" disabled={!online || busy} onFilesSelected={([file]) => void readFile(file)}>选择 JSON 文件</FilePickerButton><small className="configuration-help">UTF-8 JSON 文件（最多 1 MiB）</small></div><label className="configuration-field"><span>配置包或标准模型配置</span><Textarea aria-label="配置 JSON 内容" value={source} onChange={(event) => changeSource(event.target.value)} disabled={busy || !online} rows={8} spellCheck={false} placeholder="粘贴 JSON 内容" /></label><div className="configuration-button-row">
        <Button variant="primary" type="button" className="configuration-primary-action" onClick={() => void createPreview()} loading={generatingPreview} disabled={!source.trim() || busy || !online}>生成预览</Button>
        <span role="status" className="maintenance-muted">{generatingPreview ? "正在生成预览…" : ""}</span>
      </div>
    </section>
      {preview ? <section className="configuration-form-card"><h2>文件级变更预览</h2><p>预览显示整份文件的应用范围，不是字段级差异。修改输入后预览失效，应用时再次校验版本。</p><div className="import-preview"><PreviewGroup label="新增" values={preview.added} /><PreviewGroup label="变更" values={preview.changed} /><PreviewGroup label="冲突" values={preview.conflicts} /><PreviewGroup label="无效" values={preview.invalid.map((item) => `${item.file}：${item.message}`)} /></div><Button variant="primary" type="button" className="configuration-primary-action" disabled={preview.invalid.length > 0 || preview.conflicts.length > 0 || busy || !online} onClick={() => setConfirmation("import")}>确认并应用</Button></section> : null}
      {applied ? <section className="configuration-form-card"><h2>配置提交完成</h2><p>请按接口实际返回结果查看上方生效提示。历史列表加载失败不会改变配置已提交的事实。</p></section> : null}</> : null}
    {category === "export" ? <section className="configuration-form-card"><h2><Download size={18} />安全导出</h2><p>包含模型配置、运行设置及 Agent 档案；排除 auth.json、应用密码和敏感 Header 值。</p><p>不包含会话、知识库或完整生产数据；Agent 档案不由本页导入恢复。</p>{online ? <a className="configuration-secondary-action" href="/api/v1/configuration/export" download>下载配置包</a> : <Button type="button" className="configuration-secondary-action" disabled>下载配置包</Button>}</section> : null}
    {category === "history" ? <section className="configuration-form-card"><div className="maintenance-row"><h2><FileClock size={18} />变更历史</h2><Button type="button" className="configuration-secondary-action" disabled={!online || historyState === "loading" || busy} onClick={() => setHistoryReload((v) => v + 1)}>重新加载历史</Button></div><div className="maintenance-grid"><label><span>范围</span><SearchSelect
      ariaLabel="历史作用域"
      value={scope}
      onChange={(next) => setScope(next)}
      options={[
        { value: "all", label: "全部作用域" },
        { value: "global", label: "全局" },
        { value: "agent", label: "Agent" },
        { value: "credential", label: "凭证" },
        { value: "resource", label: "资源" },
      ]}
    /></label><label><span>恢复能力</span><SearchSelect
      ariaLabel="历史恢复能力"
      value={filter}
      onChange={(next) => setFilter(next)}
      options={[
        { value: "all", label: "全部记录" },
        { value: "restorable", label: "可恢复设置" },
        { value: "audit", label: "仅审计" },
      ]}
    /></label></div><SearchField label="搜索历史记录" placeholder="搜索摘要或目标" value={search} onChange={setSearch} />
      {historyState === "loading" ? <p role="status">正在读取历史…</p> : null}{historyState === "error" ? <p className="configuration-inline-error" role="alert">历史读取未完成；显示的旧记录不代表列表已更新，请重试。</p> : null}{historyState === "ready" && !history.length ? <p>尚无配置变更记录。</p> : null}{historyState === "ready" && history.length > 0 && !shownHistory.length ? <p>没有匹配记录，请调整筛选。</p> : null}{shownHistory.map((entry) => <article className="maintenance-item" key={entry.id}><div className="maintenance-row"><div><strong>{entry.summary}</strong><p>{new Date(entry.createdAt).toLocaleString()} · {entry.scope} {entry.targetId ?? ""} · {entry.outcome === "success" ? "成功" : "失败"}</p></div><Button type="button" className="configuration-secondary-action" onClick={() => void openHistory(entry)} disabled={busy || !online || historyState !== "ready"}>{entry.restorable ? "查看恢复差异" : "查看审计摘要"}</Button></div></article>)}</section> : null}
    </div>
    {restoreEntry ? <ConfigurationEditorDialog variant="drawer" classPrefix="operations" closeLabel="关闭历史详情" returnFocusSelector="[aria-label='搜索历史记录']" title={restoreEntry.restorable ? "恢复前审阅" : "审计摘要"} description={`${restoreEntry.summary} · ${restoreEntry.scope} ${restoreEntry.targetId ?? ""}`} busy={busy} suspended={Boolean(confirmation) || guard.pending} onClose={closeHistory} footer={restoreEntry.restorable ? <Button variant="primary" type="button" className="configuration-primary-action" disabled={!online || busy || restoreState !== "ready" || !restorePreview} onClick={() => setConfirmation("restore")}><RotateCcw size={16} />确认恢复该目标设置</Button> : <span>仅审计，不可恢复</span>}>
      <p>{new Date(restoreEntry.createdAt).toLocaleString()} · {restoreEntry.outcome === "success" ? "成功" : "失败"}</p>{restoreEntry.restorable ? <><p>恢复的是这次修改之前的整体设置，不是修改后的状态。确认绑定当前审阅的 revision。</p>{restoreState === "loading" ? <p role="status">正在读取安全差异…</p> : null}{restoreState === "error" ? <><p className="configuration-inline-error">差异读取未完成，无法恢复。请查看错误通知后重新审阅。</p><Button type="button" disabled={!online || busy} onClick={() => void openHistory(restoreEntry)}>重新读取差异</Button></> : null}{restorePreview ? restorePreview.differences.length ? restorePreview.differences.map((item) => <div key={item.field} className="maintenance-difference"><strong>{item.field}</strong><pre>当前：{item.current}</pre><pre>恢复后：{item.restored}</pre></div>) : <p>当前声明与快照一致，没有设置差异。</p> : null}</> : <p>这条记录只提供脱敏操作摘要，不包含可恢复快照。</p>}
    </ConfigurationEditorDialog> : null}
    {confirmation ? <ConfigurationEditorDialog variant="confirmation" title={confirmation === "import" ? "确认应用导入" : "确认恢复设置"} description={confirmation === "import" ? "仅应用已预览的 models/settings，重新校验文件版本；预览一次性消费。" : "恢复已审阅的整体设置；若版本变化，必须重新预览。"} busy={busy} onClose={() => setConfirmation(undefined)} footer={<><Button type="button" className="configuration-secondary-action" onClick={() => setConfirmation(undefined)}>取消</Button><Button variant="primary" type="button" className="configuration-primary-action" disabled={!online || busy} onClick={() => void (confirmation === "import" ? apply() : restore())}>确认执行</Button></>}><p>失败或中断后须核对结果，不直接重复提交。</p></ConfigurationEditorDialog> : null}
    {guard.dialog}
  </main>;
}

/** 文件级预览不能暗示接口尚未提供的字段级比较。 */
function PreviewGroup({ label, values }: { label: string; values: string[] }) {
  return <div><strong>{label} · {values.length}</strong>{values.length ? <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul> : <small>无</small>}</div>;
}
