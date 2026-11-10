import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, RefreshCw, Pencil, Trash2 } from "lucide-react";
import type { WorkflowSemaphoreInput, WorkflowSemaphoreView } from "../../shared/workflow-contracts";
import { api } from "../api";
import { useApiTask } from "../api-task-provider";
import { useOnlineStatus } from "../use-online-status";
import { ConfigurationEditorDialog } from "../components/configuration/configuration-editor-dialog";
import { navigateTo } from "../router";
import "../configuration.css";
import "../workflow-semaphores.css";

/** 共享资源列表沿用工作台主题，编辑与删除复用可访问配置弹层。 */
export function WorkflowSemaphoresPage() {
  const { runApiTask } = useApiTask();
  const online = useOnlineStatus();
  const [items, setItems] = useState<WorkflowSemaphoreView[]>();
  const [editing, setEditing] = useState<(WorkflowSemaphoreInput & { revision?: number })>();
  const [removing, setRemoving] = useState<WorkflowSemaphoreView>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const pending = useRef(false);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const ticket = ++sequence.current;
    setLoading(true);
    const result = await runApiTask(() => api.listWorkflowSemaphores(), { operation: "读取共享资源信号量" });
    if (ticket !== sequence.current) return;
    if (result.status === "success") setItems(result.data.semaphores);
    setLoading(false);
  }, [runApiTask]);
  useEffect(() => { if (online) void reload(); return () => { sequence.current++; }; }, [reload, online]);
  const save = async () => {
    if (!editing || pending.current) return;
    pending.current = true; setBusy(true);
    const result = await runApiTask(() => api.saveWorkflowSemaphore(editing), { operation: "保存共享资源信号量" });
    if (result.status === "success") { setEditing(undefined); await reload(); }
    pending.current = false; setBusy(false);
  };
  const remove = async () => {
    if (!removing || pending.current) return;
    pending.current = true; setBusy(true);
    const result = await runApiTask(() => api.deleteWorkflowSemaphore(removing.code, removing.revision), { operation: "删除共享资源信号量" });
    if (result.status === "success") setRemoving(undefined);
    await reload(); pending.current = false; setBusy(false);
  };
  const valid = editing && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(editing.code) && !!editing.name.trim() && editing.name.length <= 100 && Number.isSafeInteger(editing.limit) && editing.limit > 0;
  return <main className="semaphore-page">
    <header className="semaphore-heading"><div><span>WORKFLOWS · RESOURCES</span><h1>信号量管理</h1><p>为共享资源设置并发额度，工作流通过获取与释放节点协调使用。</p></div><div className="semaphore-actions">
      <button className="configuration-secondary-action" disabled={!online || loading || busy} onClick={() => void reload()}><RefreshCw size={16} aria-hidden="true"/>刷新用量</button>
      <button className="configuration-primary-action" disabled={!online || busy} onClick={() => setEditing({ code: "", name: "", limit: 1 })}><Plus size={16} aria-hidden="true"/>新建信号量</button>
    </div></header>
    <p className="configuration-help">额度不足时按申请顺序等待。工作流完成、报错或取消后，剩余占用自动释放。用量为上次刷新时的状态。</p>
    <section className="semaphore-list" aria-label="共享资源信号量" aria-busy={loading}>
      {!items?.length && <p role="status">{loading ? "正在读取信号量…" : items ? "尚未配置信号量。新建后即可在工作流节点中选择。" : "尚未加载信号量，请刷新重试。"}</p>}
      {items?.map((item) => <article className="semaphore-item" key={item.code}>
        <header><div><h2>{item.name}</h2><code>{item.code}</code></div><div className="semaphore-actions">
          <button className="configuration-secondary-action" aria-label={`编辑 ${item.name}`} disabled={!online || busy} onClick={() => setEditing({ code: item.code, name: item.name, limit: item.limit, revision: item.revision })}><Pencil size={15} aria-hidden="true"/>编辑</button>
          <button className="configuration-secondary-action" aria-label={`删除 ${item.name}`} disabled={!online || busy || item.used > 0 || item.waiting.length > 0} onClick={() => setRemoving(item)}><Trash2 size={15} aria-hidden="true"/>删除</button>
        </div></header>
        <dl>{[["额度上限", item.limit], ["已占用", item.used], ["可用", item.available], ["等待请求", item.waiting.length]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        {!!(item.holders.length || item.waiting.length) && <details><summary>查看占用与等待运行</summary><ul>{[...item.holders.map((entry) => ({ ...entry, state: "占用" })), ...item.waiting.map((entry) => ({ ...entry, state: "等待" }))].map((entry, index) => <li key={`${entry.runId}-${index}`}><span>{entry.state} {entry.count} 个</span><button className="configuration-secondary-action" onClick={() => navigateTo({ page: "workflow-run", runId: entry.runId })}>查看运行 {entry.runId}</button></li>)}</ul></details>}
      </article>)}
    </section>
    {editing && <ConfigurationEditorDialog variant="drawer" title={editing.revision ? "编辑信号量" : "新建信号量"} description="code 是工作流引用标识，创建后不能修改。" busy={busy} onClose={() => setEditing(undefined)} footer={<><button className="configuration-secondary-action" disabled={busy} onClick={() => setEditing(undefined)}>取消</button><button className="configuration-primary-action" disabled={busy || !online || !valid} onClick={() => void save()}>保存信号量</button></>}>
      <div className="semaphore-form"><label>信号量 code<input required maxLength={80} disabled={busy || !!editing.revision} value={editing.code} placeholder="例如 gpu_pool" onChange={(event) => setEditing({ ...editing, code: event.target.value })}/><small>字母开头，可包含数字、下划线和连字符。</small></label>
      <label>信号量名称<input required maxLength={100} disabled={busy} value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })}/></label>
      <label>额度上限<input required type="number" min={1} step={1} disabled={busy} value={editing.limit || ""} onChange={(event) => setEditing({ ...editing, limit: Number(event.target.value) })}/></label></div>
    </ConfigurationEditorDialog>}
    {removing && <ConfigurationEditorDialog variant="confirmation" title="删除信号量" description={`确认删除“${removing.name}”（${removing.code}）？`} busy={busy} onClose={() => setRemoving(undefined)} footer={<><button className="configuration-secondary-action" disabled={busy} onClick={() => setRemoving(undefined)}>取消</button><button className="configuration-primary-action" disabled={busy || !online} onClick={() => void remove()}>确认删除</button></>}><p>存在工作流引用、占用或等待时不能删除，请先处理相关工作流。</p></ConfigurationEditorDialog>}
  </main>;
}
