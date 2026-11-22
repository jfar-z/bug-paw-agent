import { lazy, Suspense, useState } from "react";
import type { RunTemplateDomain, RunTemplateSummary } from "../../shared/run-template-contracts";
import { api } from "../api";
import { useApiTask } from "../api-task-provider";
import { Button } from "../ui/controls";
const SaveTemplateDialog = lazy(() => import("./save-template-dialog"));

/** 在弹层开启时冻结参数，覆盖只允许选择同一对象下的模板。 */
export function SaveRunTemplate({domain, targetId, disabled, readInputs}: {
  domain: RunTemplateDomain; targetId: string; disabled: boolean; readInputs: () => Record<string, unknown>;
}) {
  const {runApiTask} = useApiTask();
  const [inputs, setInputs] = useState<Record<string, unknown>>();
  const [items, setItems] = useState<RunTemplateSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function open() {
    setBusy(true);
    setMessage("");
    const result = await runApiTask(async () => {
      const snapshot = readInputs();
      const list = await api.listRunTemplates(domain);
      return {snapshot, list};
    }, {operation: "准备保存运行模板"});
    setBusy(false);
    if (result.status !== "success") return;
    setItems(result.data.list.templates.filter(item => item.targetId === targetId));
    setInputs(result.data.snapshot);
  }
  return <>
    <Button type="button" disabled={disabled || busy} onClick={() => void open()}>保存为模板</Button>
    {message && <small role="status">{message}</small>}
    {inputs && <Suspense fallback={<span role="status">正在打开保存弹层…</span>}>
      <SaveTemplateDialog domain={domain} targetId={targetId} inputs={inputs} candidates={items} disabled={disabled}
        onClose={() => setInputs(undefined)} onSaved={name => { setMessage("已保存模板“" + name + "”"); setInputs(undefined); }} />
    </Suspense>}
  </>;
}
