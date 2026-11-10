import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, File, FolderOpen, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import type { WorkflowFilePage, WorkflowManagedFile } from "../../shared/workflow-contracts";
import type { WorkspaceEntry } from "../../shared/contracts";
import { api } from "../api";
import { useApiTask } from "../api-task-provider";
import { useOnlineStatus } from "../use-online-status";
import { ConfigurationEditorDialog } from "../components/configuration/configuration-editor-dialog";
import { WorkspaceFilePreview } from "../components/workspace-file-preview";
import "../resources.css";
import "../configuration-dialog.css";
import "../workflow-files.css";

/** 文件管理复用资源列表和预览，目录、引用和删除保护以服务端为准。 */
export function WorkflowFilesPage() {
  const {runApiTask} = useApiTask(), online = useOnlineStatus();
  const [directory, setDirectory] = useState<"runtime" | "constants">("runtime");
  const [query, setQuery] = useState(""), [workflowId, setWorkflowId] = useState(""), [runId, setRunId] = useState(""), [type, setType] = useState(""), [role, setRole] = useState("");
  const [page, setPage] = useState(1), [data, setData] = useState<WorkflowFilePage>();
  const [selected, setSelected] = useState<string[]>([]), [preview, setPreview] = useState<WorkflowManagedFile>();
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
  const [clearingDirectory, setClearingDirectory] = useState<"runtime" | "constants">();
  const [cleanupResult, setCleanupResult] = useState("");
  const sequence = useRef(0), pending = useRef(false);
  const reload = useCallback(async () => {
    const ticket = ++sequence.current;
    setLoading(true);
    const result = await runApiTask(() => api.listWorkflowFiles({directory, q: query, workflowId, runId, type, role, page: String(page)}), {operation: "读取工作流文件"});
    if (ticket !== sequence.current) return;
    if (result.status === "success") {
      if (page > 1 && !result.data.files.length) { setPage(page - 1); return; }
      setData(result.data);
      // 文件在其他页面变成常量引用后，清除已经不允许删除的旧选择。
      setSelected((current) => current.filter((id) => result.data.files.some((file) => file.assetId === id && !file.blockedReason)));
    }
    setLoading(false);
  }, [directory, query, workflowId, runId, type, role, page, runApiTask]);
  useEffect(() => { setData(undefined); setSelected([]); setPreview(undefined); void reload(); return () => {sequence.current++;}; }, [reload]);
  const changeFilter = (change: () => void) => { change(); setPage(1); };
  const remove = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    const result = await runApiTask(() => api.deleteWorkflowFiles(selected), {operation: "批量删除工作流文件"});
    if (result.status === "success") { setConfirming(false); setSelected([]); setPreview(undefined); await reload(); }
    else await reload();
    pending.current = false; setBusy(false);
  };
  /** 确认时固定目标目录，避免切换筛选或重复点击改变删除范围。 */
  const clearDirectory = async () => {
    if (!clearingDirectory || pending.current) return;
    pending.current = true; setBusy(true); setCleanupResult("");
    const target = clearingDirectory;
    try {
      const result = await runApiTask(() => api.clearWorkflowDirectory(target), {operation: "清理工作流文件目录"});
      if (result.status === "success") {
        setClearingDirectory(undefined); setSelected([]); setPreview(undefined);
        setCleanupResult(`${target === "runtime" ? "运行文件" : "文件常量"}目录清理完成：已删除 ${result.data.deleted} 个文件，跳过 ${result.data.skipped} 个受保护文件。`);
      }
      // 即使清理中途发生磁盘错误，也重新读取已经完成的删除结果。
      await reload();
    } finally { pending.current = false; setBusy(false); }
  };
  const upload = async (files: File[]) => {
    if (!files.length || pending.current) return;
    pending.current = true; setBusy(true);
    await runApiTask(async () => { for (const file of files) await api.uploadWorkflowFile(file, "constants"); }, {operation: "上传工作流文件常量"});
    await reload(); pending.current = false; setBusy(false);
  };
  const available = data?.files.filter((file) => !file.blockedReason) ?? [];
  const entries = data?.files ?? [];
  const previewEntry: WorkspaceEntry | undefined = preview && {name: preview.name, path: preview.assetId, mediaType: preview.mediaType, size: preview.size, kind: "file", modifiedAt: preview.createdAt};
  return <div className="workflow-files-page">
    <section className="workspace-resources-page__main">
      <header className="workspace-resources-page__heading"><div><span>WORKFLOWS · FILES</span><h1>工作流文件管理</h1><p>查看运行输入与产物，管理独立存放的文件常量。</p></div></header>
      <nav className="workflow-file-directories" aria-label="工作流文件目录">
        {([['runtime','运行文件'],['constants','文件常量']] as const).map(([value,label]) => <button type="button" key={value} aria-current={directory === value ? "page" : undefined} onClick={() => changeFilter(() => { setDirectory(value); setRole(""); })}><FolderOpen size={18} aria-hidden="true" />{label}</button>)}
      </nav>
      <div className="workspace-resources-page__toolbar">
        <label className="workspace-search"><Search size={16} aria-hidden="true"/><input aria-label="搜索工作流文件" placeholder="搜索文件名" value={query} onChange={(event) => changeFilter(() => setQuery(event.target.value))}/></label>
        <button className="configuration-secondary-action" disabled={loading || busy || !online} onClick={() => void reload()}><RefreshCw size={15} aria-hidden="true"/>刷新</button>
        {directory === "constants" && <label className="configuration-secondary-action workspace-upload" aria-disabled={busy || !online}><Upload size={15} aria-hidden="true"/>上传常量<input aria-label="上传文件常量" type="file" multiple disabled={busy || !online} onChange={(event) => { const files = [...event.target.files ?? []]; event.target.value = ""; void upload(files); }}/></label>}
        <button className="workspace-danger-button" disabled={!online || busy || !selected.length} onClick={() => setConfirming(true)}><Trash2 size={15} aria-hidden="true"/>删除所选 {selected.length} 项</button>
        <button className="workspace-danger-button" disabled={!online || busy || loading} onClick={() => setClearingDirectory(directory)}><Trash2 size={15} aria-hidden="true"/>清理目录</button>
      </div>
      {cleanupResult && <p role="status">{cleanupResult}</p>}
      <div className="workflow-file-filters">
        <select aria-label="筛选工作流" value={workflowId} onChange={(event) => changeFilter(() => setWorkflowId(event.target.value))}><option value="">全部工作流</option>{data?.workflows.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        <input aria-label="筛选运行批次" placeholder="运行批次 ID" value={runId} onChange={(event) => changeFilter(() => setRunId(event.target.value))}/>
        <select aria-label="筛选文件类型" value={type} onChange={(event) => changeFilter(() => setType(event.target.value))}><option value="">全部文件类型</option><option value="image">图片</option><option value="video">视频</option><option value="audio">音频</option><option value="file">其他文件</option></select>
        {directory === "runtime" && <select aria-label="筛选文件用途" value={role} onChange={(event) => changeFilter(() => setRole(event.target.value))}><option value="">全部用途</option><option value="input">运行输入</option><option value="output">运行输出</option></select>}
      </div>
      <p className="workflow-file-note">{directory === "constants" ? "被工作流或运行快照引用的常量不可删除；未引用的常量可选择后清理。" : "运行中的文件不可删除。删除后保留运行记录，并显示文件已删除。"}</p>
      <div className="workspace-table-wrap" aria-busy={loading}><table><thead><tr>
        <th><input type="checkbox" aria-label="选择本页可删除文件" disabled={!available.length || busy || !online} checked={!!available.length && available.every((file) => selected.includes(file.assetId))} onChange={(event) => setSelected(event.target.checked ? available.map((file) => file.assetId) : [])}/></th><th>名称</th><th>关联工作流 / 运行</th><th>大小</th><th>创建时间</th><th>状态</th><th>操作</th>
      </tr></thead><tbody>{entries.map((file) => <tr key={file.assetId}><td><input type="checkbox" aria-label={`选择 ${file.name}`} disabled={!!file.blockedReason || busy || !online} checked={selected.includes(file.assetId)} onChange={(event) => setSelected(event.target.checked ? [...selected,file.assetId] : selected.filter((id) => id !== file.assetId))}/></td>
        <td><span className="workspace-entry-name"><File size={16} aria-hidden="true"/><span title={file.name}>{file.name}</span></span></td>
        <td><div className="workflow-file-usages">{file.usages.length ? file.usages.map((usage,index) => <span key={index}>{usage.workflowName} · {usage.role === "constant" ? "常量" : usage.role === "input" ? "输入" : "输出"}{usage.runId ? ` · ${usage.runId}` : ""}</span>) : "尚未引用"}</div></td>
        <td>{formatSize(file.size)}</td><td>{new Date(file.createdAt).toLocaleString("zh-CN")}</td><td>{file.blockedReason ?? "可删除"}</td><td><div className="workspace-entry-actions"><button aria-label={`预览 ${file.name}`} onClick={() => setPreview(file)}><Eye size={16}/></button><a href={fileUrl({path:file.assetId},true)} download={file.name}>下载</a></div></td></tr>)}</tbody></table></div>
      {!entries.length && <p role="status">{loading ? "正在读取文件…" : "当前目录没有符合条件的文件。"}</p>}
      <footer className="workflow-file-pagination"><span>{data ? `共 ${data.total} 个文件 · 第 ${page} 页` : ""}</span><button className="configuration-secondary-action" disabled={page === 1 || loading} onClick={() => setPage(page - 1)}>上一页</button><button className="configuration-secondary-action" disabled={!data || page * 50 >= data.total || loading} onClick={() => setPage(page + 1)}>下一页</button></footer>
    </section>
    {previewEntry && <WorkspaceFilePreview agentId="" entry={previewEntry} mode="side" allowHtmlPreview={false} onClose={() => setPreview(undefined)} fileUrl={fileUrl} getText={api.getWorkflowFileText}/>}
    {clearingDirectory && <ConfigurationEditorDialog variant="confirmation" title="清理目录" description={`将永久删除“${clearingDirectory === "runtime" ? "运行文件" : "文件常量"}”目录内所有可删除文件，覆盖全部分页，不受搜索和筛选条件限制。文件内容无法恢复。`} busy={busy} onClose={() => setClearingDirectory(undefined)} footer={<><button className="configuration-secondary-action" disabled={busy} onClick={() => setClearingDirectory(undefined)}>取消</button><button className="workspace-danger-button" disabled={busy || !online} onClick={() => void clearDirectory()}>{busy ? "正在清理…" : "确认清理"}</button></>}><p>提交时重新检查引用和运行状态，自动跳过受保护文件，运行记录继续保留。</p></ConfigurationEditorDialog>}
    {confirming && <ConfigurationEditorDialog variant="confirmation" title="删除工作流文件" description={`将永久删除所选 ${selected.length} 个文件。运行记录继续保留，文件内容无法恢复。`} busy={busy} onClose={() => setConfirming(false)} footer={<><button className="configuration-secondary-action" disabled={busy} onClick={() => setConfirming(false)}>取消</button><button className="workspace-danger-button" disabled={busy || !online || !selected.length} onClick={() => void remove()}>确认删除</button></>}><p>提交时将重新检查引用和运行状态，受保护文件不会被删除。</p></ConfigurationEditorDialog>}
  </div>;
}
/** 文件预览始终走认证路由，不暴露磁盘路径。 */
function fileUrl(entry: {path: string}, download: boolean): string { return `/api/v1/workflow-files/${encodeURIComponent(entry.path)}${download ? "" : "?preview=1"}`; }
/** 与资源管理保持一致的可读文件大小。 */
function formatSize(size: number): string { return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / 1024 / 1024).toFixed(1)} MiB`; }
