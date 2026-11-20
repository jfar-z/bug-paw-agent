import { Button } from "../../ui/controls";
import { useEffect, useRef, useState } from "react";
import type {
  WorkflowDefinition,
  WorkflowSummary,
} from "../../../shared/workflow-contracts";
import { api } from "../../api";
import { useApiTask } from "../../api-task-provider";
import { useOnlineStatus } from "../../use-online-status";
import { ConfigurationEditorDialog } from "../../components/configuration/configuration-editor-dialog";
import { duplicateWorkflow } from "./workflow-copy";

/** 输入名称即可复制最新已保存定义，失败保留输入并通过全局错误弹窗报告。 */
export function WorkflowCopyDialog({
  workflow,
  onClose,
  onCreated,
}: {
  workflow: WorkflowSummary;
  onClose: () => void;
  onCreated: (workflow: WorkflowDefinition) => void;
}) {
  const [name, setName] = useState(`${workflow.name.slice(0, 97)} 副本`);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const online = useOnlineStatus();
  const { runApiTask } = useApiTask();
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const submit = async () => {
    if (pending.current || !online || !name.trim() || name.length > 100) return;
    pending.current = true;
    setBusy(true);
    const result = await runApiTask(
      async () => {
        const source = await api.getWorkflow(workflow.id);
        return api.saveWorkflow(duplicateWorkflow(source, name));
      },
      { operation: "复制工作流" },
    );
    pending.current = false;
    setBusy(false);
    if (result.status === "success") onCreated(result.data);
  };
  return (
    <ConfigurationEditorDialog
      variant="confirmation"
      title="复制工作流"
      description={`复制“${workflow.name}”的完整配置及 Agent 开放设置，运行历史不复制。`}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button
            className="configuration-secondary-action"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </Button>
          <Button variant="primary"
            className="configuration-primary-action"
            disabled={busy || !online || !name.trim()}
            onClick={() => void submit()}
          >
            {busy ? "正在复制…" : "创建副本"}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="wf-copy-name">
          新工作流名称
          <input
            ref={input}
            required
            maxLength={100}
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
      </form>
    </ConfigurationEditorDialog>
  );
}
