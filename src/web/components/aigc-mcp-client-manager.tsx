import { Button, SearchField, TextField } from "../ui/controls";
import { Checkbox } from "../ui/choice";
import { FormField } from "../ui/form-field";
import { ConfirmDialog } from "../ui/dialog";
import { Copy, KeyRound, Plus, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AigcChannelSummary, AigcInterfaceRecord, AigcMcpClient, AigcMcpOperation } from "../../shared/aigc-contracts";
import { api } from "../api";
import { useApiTask } from "../api-task-provider";
import { navigateTo, NAVIGATION_BEFORE_EVENT, type AppRoute } from "../router";
import { useOnlineStatus } from "../use-online-status";
import { AigcConfigDrawer } from "./aigc-config-drawer";

/** 允许操作使用业务名称展示，协议值仅用于请求。 */
const OPERATION_LABELS: Record<AigcMcpOperation, string> = {
  list: "发现接口", run: "提交任务", get: "查询任务", cancel: "取消任务", upload: "上传输入", download: "下载产物",
};
const ALL_OPERATIONS = Object.keys(OPERATION_LABELS) as AigcMcpOperation[];

/** 外部 MCP 管理视图：接入地址、客户端授权及一次性令牌展示。 */
export function AigcMcpClientManager({ interfaces, channels, createRequest, onCountChange }: {
  interfaces: AigcInterfaceRecord[];
  channels: AigcChannelSummary[];
  createRequest: number;
  onCountChange: (count: number) => void;
}) {
  const { runApiTask } = useApiTask();
  const online = useOnlineStatus();
  const [clients, setClients] = useState<AigcMcpClient[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<AigcMcpClient>();
  const [name, setName] = useState("");
  const [interfaceIds, setInterfaceIds] = useState<string[]>([]);
  const [operations, setOperations] = useState<AigcMcpOperation[]>(ALL_OPERATIONS);
  const [baseline, setBaseline] = useState("");
  const [query, setQuery] = useState("");
  const [issuedToken, setIssuedToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [discard, setDiscard] = useState(false);
  const [pendingRoute, setPendingRoute] = useState<AppRoute>();
  const allowNavigation = useRef(false);
  const [revokeTarget, setRevokeTarget] = useState<AigcMcpClient>();
  const dirty = JSON.stringify([name, interfaceIds, operations]) !== baseline;
  const endpoint = `${window.location.origin}/api/v1/aigc/mcp`;
  const activeCount = clients.filter((client) => !client.revokedAt).length;

  useEffect(() => {
    let active = true;
    void runApiTask(api.getAigcMcpClients, { operation: "加载 MCP 客户端" }).then((result) => {
      if (active && result.status === "success") { setClients(result.data.clients); setLoaded(true); }
    });
    return () => { active = false; };
  }, [runApiTask]);
  useEffect(() => { onCountChange(activeCount); }, [activeCount, onCountChange]);
  useEffect(() => { if (createRequest) start(); }, [createRequest]);
  useEffect(() => {
    if (!open || !dirty) return;
    function beforeUnload(event: BeforeUnloadEvent) { event.preventDefault(); event.returnValue = ""; }
    function beforeNavigation(event: Event) {
      if (allowNavigation.current) return;
      event.preventDefault();
      setPendingRoute((event as CustomEvent<AppRoute>).detail);
    }
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener(NAVIGATION_BEFORE_EVENT, beforeNavigation);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener(NAVIGATION_BEFORE_EVENT, beforeNavigation);
    };
  }, [open, dirty]);

  /** 编辑回填历史授权，未开放或已删除接口仍显示，方便明确移除。 */
  function start(client?: AigcMcpClient) {
    setSelected(client);
    setName(client?.name ?? "");
    setInterfaceIds(client?.interfaceIds ?? []);
    setOperations(client?.operations ?? ALL_OPERATIONS);
    setBaseline(JSON.stringify([client?.name ?? "", client?.interfaceIds ?? [], client?.operations ?? ALL_OPERATIONS]));
    setQuery(""); setIssuedToken(""); setMessage(""); setOpen(true);
  }

  function close() { if (busy) return; if (dirty) setDiscard(true); else setOpen(false); }

  async function save() {
    if (busy || !online) return;
    setBusy(true); setMessage("");
    const input = { name: name.trim(), interfaceIds, operations };
    try {
      if (selected) {
        const result = await runApiTask(() => api.updateAigcMcpClient(selected.id, input), { operation: "更新 MCP 客户端授权" });
        if (result.status !== "success") return;
        setClients((current) => current.map((client) => client.id === selected.id ? result.data.client : client));
        setMessage("授权已更新，原 Key 继续使用");
      } else {
        const result = await runApiTask(() => api.createAigcMcpClient(input), { operation: "签发 MCP Key" });
        if (result.status !== "success") return;
        setClients((current) => [result.data.client, ...current]);
        setIssuedToken(result.data.token);
        setMessage("MCP Key 已签发，请复制并保存");
      }
      setOpen(false);
    } finally { setBusy(false); }
  }

  async function revoke() {
    if (!revokeTarget || busy || !online) return;
    setBusy(true);
    try {
      const result = await runApiTask(() => api.revokeAigcMcpClient(revokeTarget.id), { operation: "撤销 MCP 客户端" });
      if (result.status !== "success") return;
      setClients((current) => current.map((client) => client.id === revokeTarget.id ? { ...client, revokedAt: new Date().toISOString() } : client));
      setRevokeTarget(undefined); setMessage("MCP Key 已撤销");
    } finally { setBusy(false); }
  }

  const choices = [...interfaces, ...interfaceIds.filter((id) => !interfaces.some((item) => item.id === id)).map((id) => ({ id, name: `已删除接口（${id}）`, enabled: false, mcpPublishEnabled: false } as AigcInterfaceRecord))];
  const invalidSelected = choices.some((item) => interfaceIds.includes(item.id) && !item.mcpPublishEnabled);

  return <section aria-label="MCP 接入与授权">
    <div className="aigc-mcp-endpoint"><small className="aigc-config-eyebrow">STREAMABLE HTTP</small><h2>MCP 接入地址</h2><p>客户端使用 Bearer Key 访问已授权的生成接口。</p><div><code>{endpoint}</code><Button type="button" className="configuration-secondary-action" onClick={() => void runApiTask(() => navigator.clipboard.writeText(endpoint), { operation: "复制 MCP 接入地址" })}><Copy size={14} />复制地址</Button></div><small>Authorization: Bearer &lt;MCP Key&gt;</small></div>
    {message ? <p role="status" className="configuration-help">{message}</p> : null}
    {issuedToken ? <div className="aigc-mcp-issued" role="status"><strong>新 Key 仅显示一次</strong><p>复制后请保存到客户端，关闭或离开页面后将无法再次查看。</p><div><code>{issuedToken}</code><Button type="button" className="configuration-secondary-action" onClick={() => void runApiTask(() => navigator.clipboard.writeText(issuedToken), { operation: "复制 MCP Key" })}><Copy size={14} />复制 Key</Button><Button type="button" className="configuration-secondary-action" onClick={() => setIssuedToken("")}>已保存，隐藏</Button></div></div> : null}
    <header className="aigc-mcp-list-heading"><div><h2>客户端与 Key</h2><p>每个客户端独立授权，修改接口范围后原 Key 继续使用。</p></div><span>{loaded ? `${activeCount} 个有效 Key` : "正在加载…"}</span></header>
    <div className="aigc-mcp-clients">{clients.map((client) => <article key={client.id} className="aigc-mcp-client"><span className="aigc-config-mark"><KeyRound size={18} /></span><div><div className="aigc-mcp-client__title"><h3>{client.name}</h3><span className={client.revokedAt ? "aigc-access-badge" : "aigc-access-badge is-enabled"}>{client.revokedAt ? "已撤销" : "有效"}</span></div><p className="aigc-config-meta">签发于 {new Date(client.createdAt).toLocaleDateString("zh-CN")} · Key 明文不再展示</p><div className="aigc-mcp-grants">{client.interfaceIds.map((id) => { const item = interfaces.find((candidate) => candidate.id === id); const channel = channels.find((candidate) => candidate.id === item?.channelId); const unavailable = !item?.enabled || !item.mcpPublishEnabled || !channel?.enabled || channel.type !== item.protocol; return <span key={id}>{item?.name ?? "已删除接口"}{unavailable ? " · 当前不可用" : ""}</span>; })}</div><p className="aigc-config-meta">{client.operations.map((operation) => OPERATION_LABELS[operation]).join(" · ")}</p></div><div className="aigc-mcp-client__actions"><Button type="button" className="configuration-secondary-action" disabled={!!client.revokedAt || !online} onClick={() => start(client)}>编辑授权</Button><button type="button" className="aigc-config-text-action is-danger" disabled={!!client.revokedAt || !online} onClick={() => setRevokeTarget(client)}>撤销</button></div></article>)}{loaded && !clients.length ? <div className="aigc-config-empty"><KeyRound size={26} /><h3>尚未签发 MCP Key</h3><p>先开放一个接口，再为你的客户端创建授权。</p><Button variant="primary" type="button" className="configuration-primary-action" disabled={!online} onClick={() => start()}><Plus size={15} />签发新 Key</Button></div> : null}</div>
    <p className="aigc-mcp-security"><ShieldCheck size={16} />Key 明文仅在签发时显示一次。已签发 Key 可修改授权，撤销后无法继续调用。</p>
    {open ? <AigcConfigDrawer title={selected ? `编辑授权 · ${selected.name}` : "签发 MCP Key"} description="指定此客户端可访问的接口，以及允许执行的操作。" busy={busy} onClose={close} footer={<><small>{selected ? "原 Key 继续使用" : "Key 仅显示一次"}</small><div><Button type="button" className="configuration-secondary-action" disabled={busy} onClick={close}>取消</Button><Button variant="primary" type="button" className="configuration-primary-action" disabled={busy || !online || !name.trim() || !interfaceIds.length || !operations.length || invalidSelected || !!selected && !dirty} onClick={() => void save()}>{busy ? "正在保存…" : selected ? "保存授权" : "签发 Key"}</Button></div></>}>
      {selected ? <p className="aigc-config-info">保存后原 Key 将使用新的授权范围，无需重新签发。</p> : null}
      <FormField label="客户端名称">{(props) => <TextField {...props} aria-label="MCP 客户端名称" maxLength={80} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />}</FormField>
      <section className="aigc-config-form-section"><h3>可访问接口 <small>已选择 {interfaceIds.length} 个</small></h3><SearchField label="搜索授权接口" className="aigc-config-search" placeholder="搜索接口名称" value={query} onChange={setQuery} /><div className="aigc-mcp-choices">{choices.filter((item) => item.name.toLowerCase().includes(query.toLowerCase())).map((item) => { const selectedId = interfaceIds.includes(item.id); const channel = channels.find((candidate) => candidate.id === item.channelId); return <label key={item.id}><Checkbox aria-label={`授权 ${item.name}`} disabled={busy || !item.mcpPublishEnabled && !selectedId} checked={selectedId} onChange={(event) => setInterfaceIds((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /><div><strong>{item.name}</strong><small>{channel?.name ?? "无可用渠道"}{!item.enabled || !channel?.enabled ? " · 当前不可调用" : ""}</small></div><span className={item.mcpPublishEnabled ? "aigc-access-badge is-mcp" : "aigc-access-badge"}>{item.mcpPublishEnabled ? "已开放" : "未开放 MCP"}</span></label>; })}</div><p className="configuration-help">未开放 MCP 的接口需先在接口配置中开启；历史授权可取消勾选并移除。</p></section>
      <section className="aigc-config-form-section"><h3>允许操作</h3><div className="aigc-mcp-operations">{ALL_OPERATIONS.map((operation) => <label key={operation}><Checkbox checked={operations.includes(operation)} disabled={busy} onChange={(event) => setOperations((current) => event.target.checked ? [...current, operation] : current.filter((item) => item !== operation))} /><span>{OPERATION_LABELS[operation]}<small>{operation}</small></span></label>)}</div></section>
    </AigcConfigDrawer> : null}
    {discard ? <ConfirmDialog title="放弃未保存授权？" description="当前 MCP 授权修改尚未保存。" confirmLabel="放弃修改" destructive={false} onCancel={() => setDiscard(false)} onConfirm={() => { setDiscard(false); setOpen(false); }} /> : null}
    {pendingRoute ? <ConfirmDialog title="离开并放弃授权修改？" description="当前 MCP 授权修改尚未保存。" confirmLabel="离开页面" destructive={false} onCancel={() => setPendingRoute(undefined)} onConfirm={() => { allowNavigation.current = true; navigateTo(pendingRoute); setPendingRoute(undefined); window.queueMicrotask(() => { allowNavigation.current = false; }); }} /> : null}
    {revokeTarget ? <ConfirmDialog title={`撤销“${revokeTarget.name}”？`} description="撤销后该客户端无法继续调用 MCP 或下载产物。" confirmLabel="撤销 Key" busy={busy} onCancel={() => setRevokeTarget(undefined)} onConfirm={() => void revoke()} /> : null}
  </section>;
}
