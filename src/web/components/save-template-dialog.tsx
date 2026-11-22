import { useState } from "react";
import type { RunTemplateDomain, RunTemplateSummary } from "../../shared/run-template-contracts";
import { api } from "../api";
import { useApiTask } from "../api-task-provider";
import { TextField } from "../ui/controls";
import { ConfirmDialog } from "../ui/dialog";
import { SearchSelect } from "../ui/search-select";
import { SegmentedControl } from "../ui/segmented-control";

/** 打开时才加载覆盖选择器与确认弹层的样式。 */
export default function SaveTemplateDialog({domain, targetId, inputs, candidates, disabled, onSaved, onClose}: {
  domain: RunTemplateDomain; targetId: string; inputs: Record<string, unknown>; candidates: RunTemplateSummary[];
  disabled: boolean; onSaved: (name: string) => void; onClose: () => void;
}) {
  const {runApiTask} = useApiTask();
  const [items, setItems] = useState(candidates);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"create" | "overwrite">("create");
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const selected = items.find(item => item.id === id);
  async function save() {
    if (mode === "overwrite" && !selected) return;
    setBusy(true);
    const result = await runApiTask(() => api.saveRunTemplate(domain,
      {targetId, inputs, ...(mode === "create" ? {name: name.trim()} : {})}, mode === "overwrite" ? id : undefined),
      {operation: "保存运行模板"});
    setBusy(false);
    if (result.status === "success") {
      onSaved(result.data.name);
    } else if (mode === "overwrite") {
      const list = await runApiTask(() => api.listRunTemplates(domain), {operation: "刷新覆盖候选模板"});
      if (list.status === "success") setItems(list.data.templates.filter(item => item.targetId === targetId));
    }
  }
  return <ConfirmDialog title="保存为模板" confirmLabel={mode === "overwrite" && selected ? "确认覆盖“" + selected.name + "”" : "保存模板"}
      busy={busy} destructive={mode === "overwrite"} confirmDisabled={disabled || (mode === "create" ? !name.trim() : !selected)}
      onCancel={onClose} onConfirm={() => void save()}>
      <SegmentedControl label="保存方式" value={mode} onChange={setMode} disabled={busy}
        options={[{id:"create",label:"新建模板"},{id:"overwrite",label:"覆盖已有模板"}]} />
      {mode === "create" ? <label>模板名称<TextField disabled={busy} value={name} onChange={event => setName(event.target.value)} /></label>
        : <SearchSelect ariaLabel="要覆盖的模板" value={id || undefined} onChange={setId} disabled={busy || !items.length}
          placeholder={items.length ? "选择要覆盖的模板" : "当前对象还没有模板"} options={items.map(item => ({value:item.id,label:item.name}))} />}
    </ConfirmDialog>;
}
