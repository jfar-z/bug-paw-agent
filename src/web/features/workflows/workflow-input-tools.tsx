import { Button } from "../../ui/controls";
import { Checkbox } from "../../ui/choice";
import { useRef, useState } from "react";
import type {
  WorkflowField,
  WorkflowNode,
} from "../../../shared/workflow-contracts";
import { ConfigurationEditorDialog } from "../../components/configuration/configuration-editor-dialog";
import { useApiTask } from "../../api-task-provider";

/** 参数剪贴板由根画布持有，切换循环体不会丢失；不写系统剪贴板和浏览器存储。 */
export interface WorkflowInputToolsProps {
  clipboard?: WorkflowField[];
  reserved?: string[];
  systemFields?: string[];
  outerInput?: WorkflowNode;
  onCopy: (fields: WorkflowField[]) => void;
  onPaste: (names: string[]) => void;
  onImport?: (names: string[]) => void;
}

/** 复用既有参数行和确认弹窗，选择性追加参数并明确显示同名及内置字段限制。 */
export function WorkflowInputTools({
  node,
  clipboard,
  reserved = [],
  outerInput,
  onCopy,
  onPaste,
  onImport,
}: WorkflowInputToolsProps & { node: WorkflowNode }) {
  const [mode, setMode] = useState<"paste" | "outer">();
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const { runApiTask } = useApiTask();
  const source = mode === "outer" ? outerInput?.outputs ?? [] : clipboard ?? [];
  const conflict = (field: WorkflowField) =>
    reserved.includes(field.name)
      ? "循环内置参数"
      : node.outputs.some((item) => item.name === field.name)
        ? "同名参数已存在"
        : "";
  const open = (next: "paste" | "outer") => {
    const fields = next === "outer" ? outerInput?.outputs ?? [] : clipboard ?? [];
    setSelected(
      fields.filter((field) => !conflict(field)).map((field) => field.name),
    );
    setMode(next);
  };
  const available = node.outputs.filter(
    (field) => !reserved.includes(field.name),
  );
  const submit = async () => {
    if (pending.current || !selected.length) return;
    pending.current = true;
    setBusy(true);
    const result = await runApiTask(
      async () => {
        if (mode === "outer") onImport?.(selected);
        else onPaste(selected);
      },
      { operation: mode === "outer" ? "导入外层输入参数" : "粘贴输入参数" },
    );
    pending.current = false;
    setBusy(false);
    if (result.status === "success") {
      setNotice(
        `已${mode === "outer" ? "导入并映射" : "粘贴"} ${selected.length} 项参数，保存工作流后生效。`,
      );
      setMode(undefined);
    }
  };
  return (
    <>
      <div className="wf-parameter-heading" aria-label="输入参数复用">
        <Button
          type="button"
          className="wf-button"
          disabled={!available.length}
          onClick={() => {
            onCopy(available);
            setNotice(
              `已复制 ${available.length} 项参数，可在当前编辑页的外层与循环体之间粘贴。`,
            );
          }}
        >
          复制参数
        </Button>
        <Button
          type="button"
          className="wf-button"
          disabled={!clipboard?.length}
          onClick={() => open("paste")}
        >
          粘贴参数
        </Button>
        {outerInput && onImport && (
          <Button
            type="button"
            className="wf-button"
            disabled={!outerInput.outputs.length}
            onClick={() => open("outer")}
          >
            从外层输入导入
          </Button>
        )}
      </div>
      {notice && (
        <p className="wf-hint" role="status">{notice}</p>
      )}
      {mode && (
        <ConfigurationEditorDialog
          variant="confirmation"
          title={mode === "outer" ? "从外层输入导入" : "粘贴输入参数"}
          description={
            mode === "outer"
              ? `从直接外层的“${outerInput?.name}”选择参数，自动创建内部参数并配置循环入参映射。`
              : "选择要追加到当前输入节点的参数，仅复制定义，不自动配置数据映射。"
          }
          busy={busy}
          onClose={() => setMode(undefined)}
          footer={
            <>
              <Button
                type="button"
                className="configuration-secondary-action"
                disabled={busy}
                onClick={() => setMode(undefined)}
              >
                取消
              </Button>
              <Button variant="primary"
                type="button"
                className="configuration-primary-action"
                disabled={busy || !selected.length}
                onClick={() => void submit()}
              >
                {mode === "outer" ? "导入并映射" : "追加参数"} · {selected.length} 项
              </Button>
            </>
          }
        >
          <p className="wf-hint">
            保留类型、数组标记、必填、说明、默认值及枚举选项。已有同名参数和循环内置参数不可覆盖；跨作用域不复制枚举来源节点。
          </p>
          <div className="wf-fields wf-import-fields">
            {source.map((field, index) => {
              const reason = conflict(field);
              return (
                <section className="wf-field-item" key={index}>
                  <label className="wf-check wf-boolean-value">
                    <Checkbox

                      aria-label={`选择参数 ${field.name}`}
                      disabled={busy || !!reason}
                      checked={!reason && selected.includes(field.name)}
                      onChange={(event) =>
                        setSelected(event.target.checked
                          ? [...selected, field.name]
                          : selected.filter((name) => name !== field.name))
                      }
                    />
                    <span>
                      {field.name} · {field.type}{field.multiple ? "[]" : ""}
                      {field.required ? " · 必填" : ""}
                      {reason && ` · ${reason}`}
                    </span>
                  </label>
                  {field.description && (
                    <small className="wf-hint">{field.description}</small>
                  )}
                </section>
              );
            })}
          </div>
        </ConfigurationEditorDialog>
      )}
    </>
  );
}
