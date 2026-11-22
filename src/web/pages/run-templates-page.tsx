import { useEffect, useRef, useState } from "react";
import type { RunTemplateDomain, RunTemplateSummary } from "../../shared/run-template-contracts";
import { api } from "../api";
import { useApiTask } from "../api-task-provider";
import { navigateTo } from "../router";
import { Button, TextField } from "../ui/controls";
import { ConfirmDialog } from "../ui/dialog";
import { useOnlineStatus } from "../use-online-status";
import "./run-templates.css";

/** 两个独立入口共用管理表面，草稿读成功后才切换到对应运行页。 */
export default function RunTemplatesPage({ domain }: { domain: RunTemplateDomain }) {
  const { runApiTask } = useApiTask();
  const online = useOnlineStatus();
  const [items, setItems] = useState<RunTemplateSummary[]>();
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<{item: RunTemplateSummary; kind: "rename" | "delete"}>();
  const [name, setName] = useState("");
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    let current = true;
    setItems(undefined);
    setFailed(false);
    void runApiTask(() => api.listRunTemplates(domain), {operation: "读取运行模板"}).then(result => {
      if (!current) return;
      if (result.status === "success") setItems(result.data.templates);
      else setFailed(true);
    });
    return () => { current = false; };
  }, [domain, revision, runApiTask]);

  async function open(item: RunTemplateSummary) {
    setBusy(true);
    const result = await runApiTask(() => api.getTemplateDraft(domain, item.id), {operation: "打开模板“" + item.name + "”"});
    if (!mounted.current) return;
    setBusy(false);
    if (result.status !== "success") { setRevision(value => value + 1); return; }
    navigateTo(domain === "workflow"
      ? {page: "workflow-run", workflowId: result.data.targetId, templateId: item.id}
      : {page: "aigc-run", templateId: item.id});
  }

  async function confirm() {
    if (!action) return;
    setBusy(true);
    const { kind, item } = action;
    const result = await runApiTask(async () => {
      if (kind === "rename") await api.renameRunTemplate(domain, item.id, name.trim());
      else await api.deleteRunTemplate(domain, item.id);
    }, {operation: kind === "rename" ? "重命名运行模板" : "删除运行模板"});
    if (!mounted.current) return;
    setBusy(false);
    if (result.status === "success") {
      setItems(current => kind === "delete" ? current?.filter(row => row.id !== item.id)
        : current?.map(row => row.id === item.id ? {...row, name: name.trim()} : row));
      setAction(undefined);
    } else setRevision(value => value + 1);
  }
  useEffect(() => {
    if (items && action && !items.some(item => item.id === action.item.id)) setAction(undefined);
  }, [items, action]);
  return <main className="run-templates">
    <h1>运行模板</h1>
    {failed ? <Button onClick={() => setRevision(value => value + 1)}>重新加载模板</Button>
      : !items ? <p role="status">正在读取运行模板…</p>
      : !items.length ? <section><p>还没有运行模板。填写参数后，点击「保存为模板」即可在这里再次使用。</p>
        <Button onClick={() => navigateTo({page: domain === "workflow" ? "workflow-run" : "aigc-run"})}>{domain === "workflow" ? "运行工作流" : "创作与运行"}</Button></section>
      : <ul>{items.map(item => <li key={item.id}>
        <div><strong>{item.name}</strong><small>{item.targetName}</small></div>
        <div className="run-templates__actions">
          <Button disabled={!online || busy} onClick={() => void open(item)}>从模板运行</Button>
          <Button disabled={!online || busy} onClick={() => { setName(item.name); setAction({kind:"rename",item}); }}>重命名</Button>
          <Button variant="danger" disabled={!online || busy} onClick={() => setAction({kind:"delete",item})}>删除</Button>
        </div>
      </li>)}</ul>}
    {action && <ConfirmDialog title={action.kind === "rename" ? "重命名模板" : "删除模板“" + action.item.name + "”？"}
      confirmLabel={action.kind === "rename" ? "保存名称" : "确认删除"} busy={busy} destructive={action.kind === "delete"}
      confirmDisabled={!online || (action.kind === "rename" && !name.trim())} onCancel={() => setAction(undefined)} onConfirm={() => void confirm()}>
      {action.kind === "rename" && <label>模板名称<TextField value={name} onChange={event => setName(event.target.value)} /></label>}
    </ConfirmDialog>}
  </main>;
}
