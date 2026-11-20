import { Tabs } from "../ui/tabs";
import { Checkbox } from "../ui/choice";
import { SearchField, Button, TextField } from "../ui/controls";
import { ConfirmDialog } from "../ui/dialog";
import { SearchSelect } from "../ui/search-select";
import { Eye, PackagePlus, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { AgentProfileDocument } from "../../shared/agent-contracts";
import { api, ApiClientError, type ResourceCatalog, type ResourceCatalogItem } from "../api";
import { useApiTask } from "../api-task-provider";
import { TaskLog, type ResourceTaskStatus } from "../components/configuration/task-log";
import { ConfigurationEditorDialog as ResourceDialog } from "../components/configuration/configuration-editor-dialog";
import { useUnsavedChanges } from "../ui/unsaved-changes";
import { ConfigurationEffectNotice, recordConfigurationSave } from "../components/configuration/configuration-effect-notice";
import { useOnlineStatus } from "../use-online-status";
import "../configuration.css";
import "../resource-catalog.css";

/** 页内分区保留同一作用域，搜索分别记录，避免混淆资源与包的操作范围。 */
type ResourceTab = "resources" | "packages" | "tools";
type ResourcePackage = NonNullable<ResourceCatalog["packages"]>[number];
type ResourceTool = ResourceCatalog["tools"][number];
interface PackageTask {
  /** 提交时锁定目标，之后切换 Agent 不能改变任务归属。 */
  id: string;
  agentId: string;
  targetName: string;
  source: string;
  action: "安装" | "卸载";
  status: ResourceTaskStatus;
  attempt: number;
}
const tabs: Array<{ id: ResourceTab; label: string }> = [{ id: "resources", label: "资源目录" }, { id: "packages", label: "扩展包" }, { id: "tools", label: "注册工具" }];

/** 资源目录、包操作与只读工具分区呈现，声明状态不冒充运行时快照。 */
export function ResourcesPage() {
  const { runApiTask } = useApiTask();
  // 目录读取按目标启动，应用重渲染仅更新执行器，不重置本页状态。
  const runner = useRef(runApiTask);
  runner.current = runApiTask;
  const online = useOnlineStatus();
  const tabId = useId();
  const [agents, setAgents] = useState<AgentProfileDocument[]>([]);
  const [agentLoading, setAgentLoading] = useState(true);
  const [agentError, setAgentError] = useState(false);
  const [scope, setScope] = useState<"global" | "agent">("global");
  const [agentId, setAgentId] = useState("");
  const selectedAgent = scope === "agent" ? agentId : "";
  const targetRef = useRef(selectedAgent);
  targetRef.current = selectedAgent;
  const [catalog, setCatalog] = useState<ResourceCatalog>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const loadSequence = useRef(0);
  const mounted = useRef(true);
  const [tab, setTab] = useState<ResourceTab>("resources");
  const [queries, setQueries] = useState({ resources: "", packages: "", tools: "" });
  const [type, setType] = useState("all");
  const [source, setSource] = useState("all");
  const [state, setState] = useState("all");
  const [selected, setSelected] = useState<ResourceCatalogItem>();
  const [tool, setTool] = useState<ResourceTool>();
  const [content, setContent] = useState<string>();
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState(false);
  const contentSequence = useRef(0);
  const [installOpen, setInstallOpen] = useState(false);
  const [packageSource, setPackageSource] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [packageToRemove, setPackageToRemove] = useState<ResourcePackage>();
  const [busy, setBusy] = useState(false);
  const mutationLock = useRef(false);
  const [error, setError] = useState("");
  const [task, setTask] = useState<PackageTask>();
  const taskRef = useRef(task);
  taskRef.current = task;
  const [taskReloadError, setTaskReloadError] = useState(false);
  const [taskMessage, setTaskMessage] = useState("");
  const unresolvedTask = task?.status === "running" || task?.status === "unknown";
  const configKey = selectedAgent ? `resources:agent:${selectedAgent}` : "resources:global";
  const targetName = selectedAgent ? agents.find((item) => item.profile.id === selectedAgent)?.profile.name ?? selectedAgent : "全局资源";
  const dirty = installOpen && Boolean(packageSource.trim() || confirmed);
  const clearInstall = () => { setPackageSource(""); setConfirmed(false); setInstallOpen(false); };
  const guard = useUnsavedChanges({ dirty, busy, label: `安装扩展包 · ${targetName}`, save: async () => false, discardOnly: true, onDiscard: clearInstall });
  const editorOpen = Boolean(selected || tool || installOpen);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; loadSequence.current++; contentSequence.current++; }; }, []);

  /** 读取失败保留错误出口，不能把失败的 Agent 目录当成真正空目录。 */
  const loadAgents = useCallback(async () => {
    setAgentLoading(true); setAgentError(false);
    const result = await runner.current(api.listAgents, { operation: "加载资源 Agent 目录" });
    if (!mounted.current) return;
    if (result.status === "success") { setAgents(result.data.agents); setAgentId((current) => current || result.data.agents[0]?.profile.id || ""); }
    else setAgentError(true);
    setAgentLoading(false);
  }, []);
  useEffect(() => { void loadAgents(); }, [loadAgents]);

  /** 序号与提交目标双重校验，避免快速切换时旧目录覆盖当前 Agent。 */
  const loadCatalog = useCallback(async (target: string): Promise<boolean> => {
    if (targetRef.current !== target || !mounted.current) return false;
    const sequence = ++loadSequence.current;
    setLoading(true); setLoadError(false); setCatalog(undefined);
    const result = await runner.current(() => api.listResources(target || undefined), { operation: "加载资源目录" });
    if (!mounted.current || sequence !== loadSequence.current || targetRef.current !== target) return false;
    setLoading(false);
    if (result.status !== "success") { setLoadError(true); return false; }
    setCatalog(result.data);
    const errors = result.data.diagnostics.filter((item) => item.type === "error");
    if (errors.length) {
      // 诊断对象在页面可定位；弹窗只传递去除内部路径后的故障事实。
      const message = errors.map((item) => item.path ? item.message.split(item.path).join("[资源文件]") : item.message).join("；");
      void runner.current(async () => { throw new ApiClientError("INTERNAL_ERROR", `资源目录加载诊断：${message}`, 500); }, { operation: "检查资源目录诊断" });
    }
    return true;
  }, []);
  useEffect(() => {
    if (scope === "agent" && !selectedAgent) { setLoading(false); setCatalog(undefined); return; }
    void loadCatalog(selectedAgent);
  }, [selectedAgent, scope, loadCatalog]);

  /** 对话框关闭立即使内容请求失效，错误或迟到内容不混入另一资源。 */
  function closeDetails() { contentSequence.current++; setSelected(undefined); setTool(undefined); setContent(undefined); setContentError(false); setContentLoading(false); setError(""); }
  function switchTarget(nextScope: "global" | "agent", nextAgent = agentId) {
    guard.request(() => { closeDetails(); clearInstall(); setScope(nextScope); setAgentId(nextAgent); setError(""); setCatalog(undefined); });
  }
  function openResource(item: ResourceCatalogItem) { closeDetails(); setSelected(item); }

  /** 内容只读且有界，失败保留当前对象，允许明确重试。 */
  async function readContent() {
    if (!selected) return;
    const item = selected, target = selectedAgent, sequence = ++contentSequence.current;
    setContentLoading(true); setContentError(false);
    const result = await runApiTask(() => api.getResourceContent(item.id, target || undefined), { operation: `读取资源内容 · ${item.name}` });
    if (!mounted.current || contentSequence.current !== sequence || targetRef.current !== target) return;
    setContentLoading(false);
    if (result.status === "success") setContent(result.data.content); else setContentError(true);
  }

  /** 即时变更返回确切目录；失败不把本地选择伪装成已写入。 */
  async function changeMode(next: "enabled" | "disabled" | "inherit") {
    if (!selected || !online || mutationLock.current || unresolvedTask) return;
    const item = selected, target = selectedAgent;
    mutationLock.current = true; setBusy(true); setError("");
    try {
      const result = await runApiTask(async () => {
        try { return await api.setResourceMode(item.id, next, target ? "agent" : "global", target || undefined); }
        catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : "保存资源模式返回非 Error 异常"); throw failure; }
      }, { operation: `保存资源模式 · ${item.name}` });
      if (!mounted.current || targetRef.current !== target) return;
      if (result.status === "success") { setCatalog(result.data); setSelected(result.data.resources.find((entry) => entry.id === item.id)); recordConfigurationSave(target ? `resources:agent:${target}` : "resources:global"); }
    } finally { mutationLock.current = false; if (mounted.current) setBusy(false); }
  }

  /** 包操作提交前固定目标；只把 taskId 视为受理，不声称已经完成。 */
  async function submitPackage(action: "安装" | "卸载") {
    if (!online || mutationLock.current || unresolvedTask) return;
    if (action === "安装" && (!confirmed || !packageSource.trim())) return;
    if (action === "卸载" && !packageToRemove) return;
    const item = packageToRemove;
    const target = action === "卸载" && item?.scope === "user" ? "" : selectedAgent;
    const name = target ? agents.find((entry) => entry.profile.id === target)?.profile.name ?? target : "全局资源";
    const sourceValue = action === "安装" ? packageSource.trim() : item!.source;
    mutationLock.current = true; setBusy(true); setError("");
    try {
      const result = await runApiTask(async () => {
        try { return action === "安装" ? await api.installResource(sourceValue, target ? "agent" : "global", target || undefined) : await api.removeResourcePackage(sourceValue, target ? "agent" : "global", target || undefined); }
        catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : "提交资源包任务返回非 Error 异常"); throw failure; }
      }, { operation: `${action}扩展包` });
      if (!mounted.current || result.status !== "success") return;
      clearInstall(); setPackageToRemove(undefined); setTaskReloadError(false); setTaskMessage("");
      setTask({ id: result.data.taskId, agentId: target, targetName: name, source: sourceValue, action, status: "running", attempt: 0 });
    } finally { mutationLock.current = false; if (mounted.current) setBusy(false); }
  }

  /** 终态与目录重读分开处理；重读失败不能抹去已完成的安装事实。 */
  async function completed(completedTask: PackageTask) {
    recordConfigurationSave(completedTask.agentId ? `resources:agent:${completedTask.agentId}` : "resources:global");
    const currentTarget = targetRef.current;
    const relevant = !completedTask.agentId || completedTask.agentId === currentTarget;
    if (!relevant) { setTaskMessage("任务已完成；切回提交目标时将重新读取目录。核心配置待刷新。"); return; }
    closeDetails();
    const refreshed = await loadCatalog(currentTarget);
    if (!mounted.current || taskRef.current?.id !== completedTask.id) return;
    if (targetRef.current !== currentTarget) { setTaskMessage("任务已完成；当前作用域已切换，目录按新目标读取。"); return; }
    setTaskReloadError(!refreshed);
    setTaskMessage(refreshed ? "任务已完成，目录已重新读取；核心配置仍需刷新。" : "任务已完成，目录更新失败。请重新加载目录；不要重复提交包操作。");
  }

  /** 重连只查询原任务；失效日志必须明确说明，不能重新提交包操作。 */
  async function reconnectTask() {
    if (!task || !online || mutationLock.current) return;
    mutationLock.current = true; setBusy(true);
    const original = task.id;
    try {
      const result = await runApiTask(() => api.getResourceTask(original), { operation: "确认原资源任务是否仍可订阅" });
      if (!mounted.current || taskRef.current?.id !== original) return;
      if (result.status === "success") setTask((current) => current ? { ...current, status: "running", attempt: current.attempt + 1 } : current);
      else setTaskMessage("原任务结果无法确认；任务可能已过期或服务已重启。请检查实际目录与错误详情，不要重复提交包操作。");
    } finally { mutationLock.current = false; if (mounted.current) setBusy(false); }
  }

  const query = queries[tab].trim().toLowerCase();
  const visible = catalog?.resources.filter((item) => (type === "all" || item.type === type) && (source === "all" || item.scope === source) && (state === "all" || item.enabled === (state === "enabled")) && `${item.name} ${item.description}`.toLowerCase().includes(query)) ?? [];
  const packages = catalog?.packages?.filter((item) => item.source.toLowerCase().includes(query)) ?? [];
  const tools = catalog?.tools.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(query)) ?? [];
  const writable = online && !busy && !loading && !loadError && Boolean(catalog) && !unresolvedTask;
  const modeValue = selected?.mode ?? "default";
  const agentUnavailable = scope === "agent" && (agentLoading || agentError || !agents.length);
  const tabLabel = tabs.find((item) => item.id === tab)!.label;
  const emptyFiltered = Boolean(query || tab === "resources" && (type !== "all" || source !== "all" || state !== "all"));
  const empty = (tab === "resources" ? visible : tab === "packages" ? packages : tools).length === 0;
  const resetFilters = () => { setQueries((current) => ({ ...current, [tab]: "" })); setType("all"); setSource("all"); setState("all"); };
  const openInstall = () => { if (!writable) return; setError(""); setPackageSource(""); setConfirmed(false); setInstallOpen(true); };
  const closeInstall = () => guard.request(clearInstall);

  return <>
    <main className="configuration-page resources-page" inert={editorOpen || guard.pending ? true : undefined} aria-hidden={editorOpen || guard.pending ? true : undefined}>
      <header className="configuration-page__heading configuration-page__heading--actions"><div><span className="configuration-eyebrow">SKILLS &amp; EXTENSIONS</span><h1>Skills 与扩展</h1><p>查找资源、管理扩展包，并了解扩展注册的工具。</p></div><Button variant="primary" type="button" data-resource-install className="configuration-primary-action" disabled={!writable} onClick={openInstall}><PackagePlus size={16} />安装扩展包</Button></header>
      <section className="resource-scope" aria-label="资源作用域"><div className="resource-segments"><Button aria-pressed={scope === "global"} disabled={busy} onClick={() => switchTarget("global")}>全局资源</Button><Button aria-pressed={scope === "agent"} disabled={busy} onClick={() => switchTarget("agent")}>Agent 资源</Button></div>
        {scope === "agent" && agents.length ? <label>当前 Agent<SearchSelect
          ariaLabel="资源 Agent"
          disabled={busy || agentLoading || agentError}
          value={agentId}
          onChange={(next) => switchTarget("agent", next)}
          options={agents.map(({ profile }) => ({ value: profile.id, label: profile.name }))}
        /></label> : null}
        <p>{scope === "global" ? "管理全局配置；安装和资源模式修改面向全局。" : "目录包含全局与 Agent 来源；资源覆盖和安装面向当前 Agent。卸载全局包仍影响全局配置。"}</p>
      </section>
      {agentError ? <p className="configuration-inline-error" role="alert">Agent 目录读取失败。<Button type="button" className="configuration-secondary-action" onClick={() => void loadAgents()}>重新加载 Agent 目录</Button></p> : null}
      <ConfigurationEffectNotice configKey={configKey} />
      {!online ? <p className="configuration-help" role="status">离线只读：禁止修改资源模式或提交包操作。</p> : null}
      {error && !editorOpen && !packageToRemove ? <p className="configuration-inline-error" role="alert">{error}</p> : null}
      {task ? <section className="resource-task" aria-label="资源包任务"><h2>{task.action} {task.source}</h2><p>提交目标：{task.targetName} · <strong>{({ running: "进行中", completed: "已完成", failed: "执行失败", unknown: "结果未确认" })[task.status]}</strong></p>
        <p className="configuration-help">{task.status === "unknown" ? taskMessage || "尚未收到终态；后台任务可能继续执行。重新订阅原任务确认结果，不要重复提交。" : task.status === "failed" ? "任务执行器已返回失败；检查日志及实际目录，不推断失败前的配置变更。" : taskMessage || "包管理器在后台执行；离开页面不会取消任务。刷新页面不会自动恢复任务历史。"}</p>
        <details><summary>查看任务日志</summary><TaskLog key={task.id} taskId={task.id} attempt={task.attempt} onStatus={(status) => setTask((current) => current?.id === task.id ? { ...current, status } : current)} onCompleted={() => void completed(task)} /></details>
        <div className="resource-task-actions">{task.status === "unknown" ? <Button type="button" className="configuration-secondary-action" disabled={!online || busy} onClick={() => void reconnectTask()}>重新订阅原任务</Button> : null}
          {taskReloadError ? <Button type="button" className="configuration-secondary-action" disabled={loading || !online} onClick={() => void completed(task)}>重新加载目录</Button> : null}
          {!unresolvedTask ? <Button type="button" className="configuration-secondary-action" disabled={loading} onClick={() => { setTask(undefined); setTaskMessage(""); setTaskReloadError(false); }}>收起任务</Button> : null}</div>
      </section> : null}
      <Tabs className="resource-tabs" label="资源管理分区" tabIdPrefix={tabId} panelId={`${tabId}-panel`}
        items={tabs} value={tab} onChange={setTab} />
      <section id={`${tabId}-panel`} role="tabpanel" aria-labelledby={`${tabId}-${tab}`} aria-busy={loading}>
        <div className="resource-catalog-filters"><SearchField label={`搜索${tabLabel}`} placeholder={tab === "packages" ? "搜索包来源" : "搜索名称或描述"} value={queries[tab]} onChange={(next) => setQueries((current) => ({ ...current, [tab]: next }))} />
          {tab === "resources" ? <><SearchSelect
            ariaLabel="资源类型"
            value={type}
            onChange={(next) => setType(next)}
            options={[
              { value: "all", label: "全部类型" },
              { value: "skill", label: "Skills" },
              { value: "prompt", label: "Prompts" },
              { value: "extension", label: "Extensions" },
              { value: "theme", label: "Themes" },
            ]}
          /><SearchSelect
            ariaLabel="资源来源"
            value={source}
            onChange={(next) => setSource(next)}
            options={[
              { value: "all", label: "全部来源" },
              { value: "global", label: "全局来源" },
              { value: "agent", label: "Agent 来源" },
            ]}
          /><SearchSelect
            ariaLabel="资源状态"
            value={state}
            onChange={(next) => setState(next)}
            options={[
              { value: "all", label: "全部状态" },
              { value: "enabled", label: "配置启用" },
              { value: "disabled", label: "配置屏蔽" },
            ]}
          /></> : null}
        </div>
        {agentUnavailable ? <div className="resource-catalog-empty"><h2>{agentLoading ? "正在加载 Agent 目录…" : agentError ? "无法读取 Agent 目录" : "还没有 Agent"}</h2><p>{!agentLoading && !agentError ? "请先到 Agents 创建对象，再管理 Agent 资源。" : "目录尚未可用，不展示空资源作为加载结果。"}</p></div>
          : loading ? <p className="configuration-help">正在加载资源目录…</p> : loadError ? <div className="resource-catalog-empty"><h2>资源目录读取失败</h2><p>具体故障见错误弹窗；未展示旧目录或空列表作为成功结果。</p><Button type="button" className="configuration-secondary-action" disabled={!online || busy} onClick={() => void loadCatalog(selectedAgent)}>重新加载资源目录</Button></div>
          : catalog ? <div className="resource-catalog-list"><header><h2>{tabLabel} <small>{(tab === "resources" ? visible : tab === "packages" ? packages : tools).length} 项</small></h2><span>本次目录加载结果</span></header>
            {tab === "resources" ? visible.map((item) => <article key={item.id} className="resource-catalog-row"><div><h3>{item.name}</h3><p>{item.description}</p><div className="resource-catalog-badges"><span>{item.type}</span><span>{item.scope === "global" ? "全局来源" : "Agent 来源"}</span><span>配置{item.enabled ? "启用" : "屏蔽"}{item.mode === "inherit" ? " · 继承全局" : item.mode === "enabled" || item.mode === "disabled" ? " · 显式声明" : " · 发现/过滤规则"}</span></div></div><Button type="button" className="configuration-secondary-action" disabled={busy} aria-label={`查看资源 ${item.name}`} onClick={() => openResource(item)}><Eye size={14} />查看详情</Button></article>) : null}
            {tab === "packages" ? packages.map((item) => <article key={`${item.scope}:${item.source}`} className="resource-catalog-row"><div><h3>{item.source}</h3><p>{item.scope === "user" ? "全局包" : `Agent 包 · ${targetName}`} · {item.filtered ? "设置了资源过滤，不代表安装失败" : "未设置资源过滤"}</p></div><Button variant="danger" disabled={!writable} aria-label={`卸载 ${item.source}`} onClick={() => { setError(""); setPackageToRemove(item); }}>卸载</Button></article>) : null}
            {tab === "tools" ? tools.map((item) => <article key={`${item.extensionPath}:${item.name}`} className="resource-catalog-row"><div><h3>{item.name}</h3><p>{item.description}</p><div className="resource-catalog-badges"><span>来源 {pathName(item.extensionPath)}</span>{item.highRisk ? <span><ShieldAlert size={13} />第三方代码 · 高风险</span> : null}</div></div><Button type="button" className="configuration-secondary-action" aria-label={`查看工具 ${item.name}`} onClick={() => { closeDetails(); setTool(item); }}>查看详情</Button></article>) : null}
            {empty ? <div className="resource-catalog-empty"><h3>{emptyFiltered ? "没有匹配的条目" : `当前没有${tabLabel === "资源目录" ? "资源" : tabLabel}`}</h3><p>{emptyFiltered ? "调整关键词或清除筛选。" : tab === "tools" ? "没有注册工具不代表没有扩展包；此区仅展示本次加载得到的工具。" : "安装或配置资源后重新读取目录。"}</p>{emptyFiltered ? <Button type="button" className="configuration-secondary-action" onClick={resetFilters}>清除筛选</Button> : tab !== "tools" ? <Button type="button" className="configuration-secondary-action" disabled={!writable} onClick={openInstall}>安装扩展包</Button> : null}</div> : null}
          </div> : null}
      </section>
      {catalog?.diagnostics.length ? <details className="resource-diagnostics"><summary>目录诊断 · {catalog.diagnostics.length} 项</summary>{catalog.diagnostics.map((item, index) => <article key={index}><strong>{item.type}{item.path ? ` · ${pathName(item.path)}` : ""}</strong><p>{item.message}</p></article>)}</details> : null}
      <p className="configuration-help">目录解析状态与注册工具均不代表运行中 Agent 已应用或已获授权。第三方扩展可能以容器最大权限运行。</p>
    </main>
    {selected ? <ResourceDialog variant="drawer" classPrefix="resource" title={`资源详情 · ${selected.name}`} description="只读查看资源，按当前目标即时保存模式。" closeLabel="关闭资源详情" returnFocusSelector="[data-resource-install]" busy={busy} onClose={closeDetails} footer={<><span className="configuration-editing-state">目标：{targetName} · 配置{selected.enabled ? "启用" : "屏蔽"}</span><Button type="button" className="configuration-secondary-action" disabled={busy} onClick={closeDetails}>关闭</Button></>}>
      <p className="configuration-help">{selected.description}</p><div className="resource-catalog-badges"><span>{selected.type}</span><span>{selected.scope === "global" ? "全局来源" : "Agent 来源"}</span></div>
      <label className="resource-detail-field">当前目标模式<SearchSelect
        ariaLabel="当前资源模式"
        value={modeValue}
        disabled={!writable}
        onChange={(next) => { if (next !== "default") void changeMode(next as "enabled" | "disabled" | "inherit"); }}
        options={[
          { value: "default", label: "原生发现或过滤规则", disabled: true },
          ...(selected.scope === "global" && scope === "agent" ? [{ value: "inherit", label: "继承全局" }] : (modeValue === "inherit" ? [{ value: "inherit", label: "继承全局", disabled: true }] : [])),
          { value: "enabled", label: "显式启用" },
          { value: "disabled", label: "显式屏蔽" },
        ]}
      /></label>
      <p className="configuration-help">选择后立即保存；恢复继承移除当前资源的精确覆盖，不删除其他过滤规则。保存后仍需刷新核心配置。</p><ConfigurationEffectNotice configKey={configKey} />
      {error ? <p className="configuration-inline-error" role="alert">{error}</p> : null}<details><summary>来源与完整路径</summary><p>{selected.source}</p><code>{selected.path}</code></details>
      <section className="resource-content-view"><h3>只读内容</h3><p className="configuration-help">最多读取前 256 KiB，不保证为全文；不提供在线编辑。</p><Button type="button" className="configuration-secondary-action" disabled={contentLoading} onClick={() => void readContent()}>{contentLoading ? "正在读取…" : contentError ? "重新读取资源内容" : content === undefined ? "查看资源内容" : "重新读取内容"}</Button>{contentError ? <p className="configuration-inline-error" role="alert">内容读取失败，具体故障见错误弹窗。</p> : null}{content !== undefined && !contentError ? <pre>{content}</pre> : null}</section>
    </ResourceDialog> : null}
    {tool ? <ResourceDialog variant="drawer" classPrefix="resource" title={`工具详情 · ${tool.name}`} description="来自本次扩展加载的注册工具，不代表运行中授权。" closeLabel="关闭工具详情" returnFocusSelector="[data-resource-install]" busy={false} onClose={closeDetails} footer={<Button type="button" className="configuration-secondary-action" onClick={closeDetails}>关闭</Button>}><p>{tool.description}</p>{tool.highRisk ? <p className="resource-risk">第三方扩展可能执行任意代码。</p> : null}<h3>扩展来源</h3><code>{tool.extensionPath}</code>{catalog?.resources.some((item) => item.path === tool.extensionPath && item.type === "extension") ? <p><Button type="button" className="configuration-secondary-action" onClick={() => openResource(catalog.resources.find((item) => item.path === tool.extensionPath && item.type === "extension")!)}>查看来源扩展</Button></p> : null}<p className="configuration-help">此区只读；不提供调用测试，不推断当前 Agent 已授权。</p></ResourceDialog> : null}
    {installOpen ? <ResourceDialog variant="confirmation" title="安装扩展包" description={`提交目标：${targetName}。安装成功后保存来源，仍需刷新核心配置。`} returnFocusSelector="[data-resource-install]" busy={busy} suspended={guard.pending} onClose={closeInstall} footer={<><Button type="button" className="configuration-secondary-action" disabled={busy} onClick={closeInstall}>取消</Button><Button variant="primary" type="button" className="configuration-primary-action" loading={busy} disabled={!writable || !confirmed || !packageSource.trim()} onClick={() => void submitPackage("安装")}>开始安装</Button></>}>
      <label className="resource-detail-field">来源<TextField aria-label="扩展包来源" disabled={busy} value={packageSource} onChange={(event) => { setPackageSource(event.target.value); setConfirmed(false); }} placeholder="npm:example-skills" /></label><p className="configuration-help">支持 npm:、git:、HTTPS 或容器内本地路径。</p><p className="resource-risk">第三方扩展可能以容器最大权限执行任意代码，请先审阅来源。</p><label className="resource-confirm-line"><Checkbox disabled={busy} checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>我已审阅来源，并理解扩展会执行任意代码。</span></label>{error ? <p className="configuration-inline-error" role="alert">{error}</p> : null}
    </ResourceDialog> : null}
    {packageToRemove ? <ConfirmDialog title="确认卸载扩展包" confirmLabel="确认卸载" confirmDisabled={!writable}
      description={`将卸载 ${packageToRemove.source}。实际范围：${packageToRemove.scope === "user" ? "全局配置；即使从 Agent 视图操作也影响全局。" : `Agent · ${targetName}。`}可能影响依赖该资源的 Agent；全局包被 Agent 项目包引用时服务端会拒绝。`}
      busy={busy} onCancel={() => setPackageToRemove(undefined)} onConfirm={() => void submitPackage("卸载")}>
      {error ? <p className="configuration-inline-error" role="alert">{error}</p> : null}
    </ConfirmDialog> : null}
    {guard.dialog}
  </>;
}

/** 长路径保留在详情，列表只显示可定位的文件名。 */
function pathName(path: string): string { return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path; }
