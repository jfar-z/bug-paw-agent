import { Checkbox } from "../ui/choice";
import { SearchField, Button } from "../ui/controls";
import { ConfirmDialog } from "../ui/dialog";
import { ArrowUpRight, Boxes, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { AigcChannelSummary, AigcInterfaceInput, AigcInterfaceProtocol, AigcInterfaceCapability, AigcInterfaceRecord, AigcOpenAiInterfaceConfig } from "../../shared/aigc-contracts";
import { createDefaultOpenAiParameters } from "../../shared/aigc-openai-parameters";
import { api } from "../api";
import { useApiTask } from "../api-task-provider";
import { AigcConfigDrawer } from "../components/aigc-config-drawer";
import { AigcMcpClientManager } from "../components/aigc-mcp-client-manager";
import { SearchSelect } from "../ui/search-select";
import { useOnlineStatus } from "../use-online-status";
import { OpenAiParameterEditor, useAigcUnsavedNavigation, emptyInterface, defaultCapability, capabilityOptions, capabilityLabel, interfaceProtocolName, interfaceProtocolDescription, aigcExpected } from "./aigc-workbench-page";
import "../configuration.css";
import "../aigc.css";
import "../aigc-interface-config.css";

/** 接口列表与编辑。 */
export function AigcInterfacesPage() {
  const { runApiTask } = useApiTask();
  const online = useOnlineStatus();
  const [document, setDocument] = useState<{ revision: string; interfaces: AigcInterfaceRecord[] }>();
  const [channels, setChannels] = useState<AigcChannelSummary[]>([]);
  const [workflows, setWorkflows] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState<AigcInterfaceRecord>();
  const [draft, setDraft] = useState<AigcInterfaceInput>(emptyInterface);
  const [savedDraft, setSavedDraft] = useState<AigcInterfaceInput>(emptyInterface);
  const [message, setMessage] = useState("");
  const [pendingAction, setPendingAction] = useState<(() => void) | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<AigcInterfaceRecord>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [tab, setTab] = useState<"interfaces" | "mcp">("interfaces");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [mcpCount, setMcpCount] = useState(0);
  const [mcpCreateRequest, setMcpCreateRequest] = useState(0);
  const [busy, setBusy] = useState(false);
  const isDirty = editorOpen && JSON.stringify(draft) !== JSON.stringify(savedDraft);
  const visibleInterfaces = (document?.interfaces ?? []).filter((item) => {
    const channel = channels.find((candidate) => candidate.id === item.channelId);
    const target = "model" in item.config ? item.config.model : workflows.find((workflow) => workflow.id === (item.config as { workflowId: string }).workflowId)?.name ?? "";
    return `${item.name} ${channel?.name ?? ""} ${target}`.toLowerCase().includes(search.toLowerCase())
      && (filter === "all" || filter === "mcp" && item.mcpPublishEnabled || filter === "enabled" && item.enabled || filter === "disabled" && !item.enabled);
  });
  const navigationGuard = useAigcUnsavedNavigation(isDirty);

  async function refresh() {
    const [next, channelDocument, workflowDocument] = await Promise.all([
      api.getAigcInterfaces(),
      api.getAigcChannels(),
      api.getAigcWorkflows(),
    ]);
    setDocument(next);
    setChannels(channelDocument.channels);
    setWorkflows(workflowDocument.workflows.map((workflow) => ({ id: workflow.id, name: workflow.name })));
    return next;
  }

  useEffect(() => {
    void runApiTask(refresh, { operation: "加载 AIGC 接口" });
  }, [runApiTask]);

  function select(item: AigcInterfaceRecord) {
    if (isDirty) {
      setPendingAction(() => () => selectImmediately(item));
      return;
    }
    selectImmediately(item);
  }

  function selectImmediately(item: AigcInterfaceRecord) {
    const nextDraft: AigcInterfaceInput = {
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
    setSelected(item);
    setDraft(nextDraft);
    setSavedDraft(nextDraft);
    setEditorOpen(true);
  }

  function createDraft() {
    if (isDirty) {
      setPendingAction(() => createImmediately);
      return;
    }
    createImmediately();
  }

  function createImmediately() {
    const nextDraft = { ...emptyInterface, channelId: channels.find((channel) => channel.enabled && channel.type === emptyInterface.protocol)?.id ?? "" };
    setSelected(undefined);
    setDraft(nextDraft);
    setSavedDraft(nextDraft);
    setEditorOpen(true);
  }

  function changeProtocol(protocol: AigcInterfaceProtocol) {
    setDraft((current) => ({
      ...current,
      protocol,
      capability: defaultCapability(protocol),
      channelId: channels.find((channel) => channel.type === protocol && channel.enabled)?.id ?? "",
      config: protocol === "comfyui"
        ? { workflowId: "" }
        : protocol === "openai"
          ? { model: "", parameters: createDefaultOpenAiParameters() }
          : { model: "" },
    }));
  }

  async function save() {
    if (!online || busy) return;
    setMessage("");
    setBusy(true);
    try {
      const result = selected
        ? await runApiTask(() => api.updateAigcInterface(selected.id, document?.revision ?? "", draft), { operation: "保存 AIGC 接口", expected: aigcExpected(setMessage) })
        : await runApiTask(() => api.createAigcInterface(draft), { operation: "保存 AIGC 接口", expected: aigcExpected(setMessage) });
      if (result.status !== "success") return;
      // 使用响应中的确切 ID，避免刷新后误选列表的最后一项。
      setDocument((current) => current ? { ...current, interfaces: selected
        ? current.interfaces.map((item) => item.id === selected.id ? result.data : item)
        : [...current.interfaces, result.data] } : current);
      setEditorOpen(false);
      setMessage(selected ? "接口修改已保存" : "接口已创建");
      await runApiTask(refresh, { operation: "刷新已保存的 AIGC 接口" });
    } finally { setBusy(false); }
  }

  /** 关闭与切换视图前保留未保存表单，避免意外覆盖。 */
  function closeEditor() {
    if (busy) return;
    if (isDirty) { setPendingAction(() => () => setEditorOpen(false)); return; }
    setEditorOpen(false);
  }


  async function remove() {
    if (!deleteTarget || !document || !online) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await runApiTask(() => api.deleteAigcInterface(deleteTarget.id, document.revision), { operation: "删除 AIGC 接口", expected: aigcExpected(setMessage) });
      if (result.status !== "success") return;
      setEditorOpen(false);
      setSelected(undefined);
      setDraft(emptyInterface);
      setSavedDraft(emptyInterface);
      setDeleteTarget(undefined);
      setMessage("已删除 AIGC 接口");
      await runApiTask(refresh, { operation: "刷新已删除接口的 AIGC 列表" });
    } finally { setBusy(false); }
  }

  return (
    <div className="aigc-workbench-page aigc-interface-config-page">
      <header className="aigc-config-heading"><div><small className="aigc-config-eyebrow">CONNECTIONS &amp; ACCESS</small><h1>接口配置</h1><p>管理生成接口，以及外部 MCP 客户端的访问权限。</p></div><Button variant="primary" type="button" className="configuration-primary-action" disabled={!online || !document} onClick={() => tab === "interfaces" ? createDraft() : setMcpCreateRequest((current) => current + 1)}><Plus size={16} />{tab === "interfaces" ? "新增接口" : "签发新 Key"}</Button></header>
      {message ? <p className="configuration-help" role="status">{message}</p> : null}
      {!online ? <p className="aigc-config-info">当前离线，配置与授权暂不可保存。</p> : null}
      <div className="aigc-config-tabs" role="tablist" aria-label="配置视图" onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); const next = tab === "interfaces" ? "mcp" : "interfaces"; setTab(next); window.document.getElementById(`aigc-${next}-tab`)?.focus(); } }}>
        <button type="button" id="aigc-interfaces-tab" role="tab" tabIndex={tab === "interfaces" ? 0 : -1} aria-selected={tab === "interfaces"} aria-controls="aigc-interfaces-panel" onClick={() => setTab("interfaces")}>接口配置 <span>{document?.interfaces.length ?? "—"}</span></button>
        <button type="button" id="aigc-mcp-tab" role="tab" tabIndex={tab === "mcp" ? 0 : -1} aria-selected={tab === "mcp"} aria-controls="aigc-mcp-panel" onClick={() => setTab("mcp")}>MCP 接入与授权 <span>{mcpCount}</span></button>
        <small>{document?.interfaces.filter((item) => item.mcpPublishEnabled).length ?? 0} 个接口已开放 MCP</small>
      </div>
      <section hidden={tab !== "interfaces"} id="aigc-interfaces-panel" role="tabpanel" aria-labelledby="aigc-interfaces-tab">
        <div className="aigc-config-toolbar"><SearchField className="aigc-config-search" label="搜索接口" placeholder="搜索接口名称、模型或渠道" value={search} onChange={setSearch} /><SearchSelect
          ariaLabel="筛选接口"
          value={filter}
          onChange={(next) => setFilter(next)}
          options={[
            { value: "all", label: "全部接口" },
            { value: "mcp", label: "已开放 MCP" },
            { value: "enabled", label: "已启用" },
            { value: "disabled", label: "已停用" },
          ]}
        /><small>{document ? `${visibleInterfaces.length} 个接口` : "正在加载…"}</small></div>
        <div className="aigc-config-table-wrap"><table className="aigc-config-table"><thead><tr><th>接口 / 执行目标</th><th>渠道与能力</th><th>状态</th><th>开放方式</th><th><span className="visually-hidden">操作</span></th></tr></thead><tbody>
          {visibleInterfaces.map((item) => <tr key={item.id}><td><div className="aigc-config-identity"><span className="aigc-config-mark">{interfaceProtocolName(item.protocol).slice(0, 1)}</span><div><strong>{item.name}</strong><small>{"model" in item.config ? item.config.model : workflows.find((workflow) => workflow.id === (item.config as { workflowId: string }).workflowId)?.name ?? "工作流已不存在"}</small></div></div></td><td><span>{channels.find((channel) => channel.id === item.channelId)?.name ?? "渠道已不存在"}</span><small>{capabilityLabel(item.protocol, item.capability)}</small></td><td><span className={item.enabled ? "aigc-access-badge is-enabled" : "aigc-access-badge"}>{item.enabled ? "● 已启用" : "○ 已停用"}</span></td><td><div className="aigc-config-badges">{item.mcpPublishEnabled ? <span className="aigc-access-badge is-mcp">MCP</span> : null}{item.toolPublishEnabled ? <span className="aigc-access-badge">Agent</span> : null}{!item.mcpPublishEnabled && !item.toolPublishEnabled ? <small>仅工作台</small> : null}</div></td><td><button type="button" className="aigc-config-text-action" aria-label={`编辑接口 ${item.name}`} onClick={() => select(item)}>编辑 <ArrowUpRight size={13} /></button></td></tr>)}
        </tbody></table>{document && !visibleInterfaces.length ? <div className="aigc-config-empty"><Boxes size={26} /><h3>{document.interfaces.length ? "没有符合条件的接口" : "尚未创建接口"}</h3><p>{document.interfaces.length ? "试试其他关键词或筛选条件。" : "创建接口，连接渠道、模型或 ComfyUI 工作流。"}</p></div> : null}<footer><span>接口决定调用什么，MCP 授权决定谁能调用。</span><button type="button" className="aigc-config-text-action" onClick={() => setTab("mcp")}>管理 MCP 授权 →</button></footer></div>
        <div className="aigc-config-connect"><ArrowUpRight size={24} /><div><strong>把生成能力连接到你的客户端</strong><p>开放接口后，前往「MCP 接入与授权」签发 Key，并指定可访问的接口。</p></div><Button type="button" className="configuration-secondary-action" onClick={() => setTab("mcp")}>配置 MCP →</Button></div>
      </section>
      <AigcMcpClientManager interfaces={document?.interfaces ?? []} channels={channels} visible={tab === "mcp"} createRequest={mcpCreateRequest} onCountChange={setMcpCount} />
      {editorOpen ? <AigcConfigDrawer title={selected ? `编辑 · ${selected.name}` : "新增接口"} eyebrow={selected ? "EDIT INTERFACE" : "NEW INTERFACE"} description={selected ? "修改配置将更新此接口。" : "选择协议、配置执行目标，再决定开放方式。"} busy={busy} onClose={closeEditor} footer={<><small>{selected ? "正在编辑现有接口" : "尚未创建"}</small><div>{selected ? <Button variant="danger" type="button" className="configuration-secondary-action configuration-secondary-action--danger" disabled={busy || !online} onClick={() => setDeleteTarget(selected)}><Trash2 size={15} />删除</Button> : null}<Button type="button" className="configuration-secondary-action" disabled={busy} onClick={closeEditor}>取消</Button><Button variant="primary" type="button" className="configuration-primary-action" disabled={busy || !online || !draft.name.trim() || !draft.channelId || !isDirty} onClick={() => void save()}><Save size={15} />{busy ? "正在保存…" : selected ? "保存修改" : "创建接口"}</Button></div></>}>
        <fieldset className="aigc-config-fields" disabled={busy}>
        <h3 className="aigc-config-form-heading"><small>01</small>基本信息</h3>
        <div className="aigc-form-stack">
          <label><span>接口名称</span><input aria-label="AIGC 接口名称" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          <label><span>描述</span><textarea aria-label="AIGC 接口描述" rows={2} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
          <label><span>接口说明（Agent）</span><textarea aria-label="AIGC Agent 接口说明" rows={4} value={draft.toolDescription ?? ""} onChange={(event) => setDraft({ ...draft, toolDescription: event.target.value })} /><small>说明适用场景、调用约束和结果含义，Agent 查询接口明细时会读取此内容。</small></label>
        </div>

        <h3 className="aigc-config-form-heading"><small>02</small>执行配置</h3>
        <div className="aigc-fieldset">
          <div className="aigc-fieldset__heading"><strong>协议</strong><small>选择接口使用的第三方协议，能力会随协议变化</small></div>
          <div className="aigc-protocol-grid aigc-protocol-grid--compact">
            {(["openai", "grok", "comfyui"] as const).map((protocol) => (
              <button
                type="button"
                key={protocol}
                className={draft.protocol === protocol ? "aigc-overview-card aigc-protocol-card is-selected" : "aigc-overview-card aigc-protocol-card"}
                onClick={() => changeProtocol(protocol)}
              >
                <span className="aigc-protocol-card__name">{interfaceProtocolName(protocol)}</span>
                <span className="aigc-protocol-card__type">{protocol}</span>
                <small>{interfaceProtocolDescription(protocol)}</small>
              </button>
            ))}
          </div>
        </div>

        <div className="aigc-fieldset">
          <div className="aigc-fieldset__heading"><strong>执行目标</strong><small>能力、渠道及模型或工作流共同决定最终调用方式</small></div>
          <div className="configuration-field-row">
            <label><span>能力</span><SearchSelect
              ariaLabel="AIGC 接口能力"
              value={draft.capability}
              onChange={(next) => setDraft({ ...draft, capability: next as AigcInterfaceCapability })}
              options={capabilityOptions(draft.protocol).map((option) => ({ value: option.value, label: option.label }))}
            /></label>
            <div className="aigc-config-field"><span>渠道</span><SearchSelect
              ariaLabel="AIGC 渠道"
              options={channels.filter((channel) => channel.type === draft.protocol).map((channel) => ({ value: channel.id, label: channel.name, description: channel.enabled ? "已启用" : "已停用" }))}
              value={draft.channelId || undefined}
              placeholder="请选择渠道"
              onChange={(channelId) => setDraft({ ...draft, channelId })}
            /></div>
          </div>
          {!channels.some((channel) => channel.type === draft.protocol) ? <p className="configuration-help">当前协议还没有可用渠道，请先到配置中心创建 {interfaceProtocolName(draft.protocol)} 渠道。</p> : null}
          <label><span>{draft.protocol === "comfyui" ? "工作流" : "模型"}</span>
            {draft.protocol === "comfyui" ? (
              <SearchSelect
                ariaLabel="ComfyUI 工作流"
                value={(draft.config as { workflowId?: string }).workflowId ?? ""}
                onChange={(next) => setDraft({ ...draft, config: { workflowId: next } })}
                options={[
                  { value: "", label: "请选择工作流" },
                  ...workflows.map((workflow) => ({ value: workflow.id, label: workflow.name })),
                ]}
              />
            ) : (
              <input aria-label="AIGC 模型" value={(draft.config as { model?: string }).model ?? ""} onChange={(event) => setDraft({ ...draft, config: { ...draft.config, model: event.target.value } })} />
            )}
          </label>
        </div>

        {draft.protocol === "openai" ? (
          <details className="aigc-config-parameters"><summary>请求参数 · 按需配置</summary><OpenAiParameterEditor
            config={draft.config as AigcOpenAiInterfaceConfig}
            onChange={(config) => setDraft({ ...draft, config })}
          /></details>
        ) : null}

        {draft.protocol === "grok" ? (
          <div className="aigc-fieldset">
            <div className="aigc-fieldset__heading"><strong>协议参数</strong><small>按需补充生成默认值；留空时由调用方传入</small></div>
            <div className="configuration-field-row">
              <label><span>默认尺寸</span><input aria-label="Grok 默认尺寸" placeholder="1024x1024" value={(draft.config as { size?: string }).size ?? ""} onChange={(event) => setDraft({ ...draft, config: { ...draft.config, size: event.target.value } })} /></label>
              <label><span>默认时长（秒）</span><input type="number" min={1} max={300} aria-label="Grok 默认时长" value={(draft.config as { duration?: number }).duration ?? ""} onChange={(event) => setDraft({ ...draft, config: { ...draft.config, duration: Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : undefined } })} /></label>
            </div>
          </div>
        ) : null}

        <h3 className="aigc-config-form-heading"><small>03</small>开放设置</h3>
        <div className="aigc-config-settings">
          <label><span><strong>启用接口</strong><small>关闭后停止接受新的生成调用。</small></span><Checkbox aria-label="启用接口" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /></label>
          <label><span><strong>发布为 Agent 工具</strong><small>允许工作台内的 Agent 发现并调用。</small></span><Checkbox aria-label="发布为 Agent 工具" checked={draft.toolPublishEnabled} onChange={(event) => setDraft({ ...draft, toolPublishEnabled: event.target.checked })} /></label>
          <label><span><strong>开放给外部 MCP</strong><small>开放后仍需为客户端 Key 单独分配此接口。</small></span><Checkbox aria-label="开放给外部 MCP" checked={draft.mcpPublishEnabled} onChange={(event) => setDraft({ ...draft, mcpPublishEnabled: event.target.checked })} /></label>
        </div>
        </fieldset>
      </AigcConfigDrawer> : null}
      {pendingAction ? <ConfirmDialog title="放弃未保存修改？" description="当前接口表单还有未保存内容。继续后，这些修改将丢失。" confirmLabel="放弃修改" destructive={false} onCancel={() => setPendingAction(undefined)} onConfirm={() => { const action = pendingAction; setPendingAction(undefined); action(); }} /> : null}
      {navigationGuard.pendingRoute ? <ConfirmDialog title="离开并放弃修改？" description="当前接口表单还有未保存内容。离开页面后，这些修改将丢失。" confirmLabel="离开页面" destructive={false} onCancel={navigationGuard.cancel} onConfirm={navigationGuard.confirm} /> : null}
      {deleteTarget ? <ConfirmDialog title={`删除接口“${deleteTarget.name}”？`} description="删除后无法恢复，引用该接口的创作入口将立即失效，历史任务仍会保留。" confirmLabel="删除接口" busy={busy} onCancel={() => setDeleteTarget(undefined)} onConfirm={() => void remove()} /> : null}
    </div>
  );
}
