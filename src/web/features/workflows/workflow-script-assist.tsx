import { Button, Textarea } from "../../ui/controls";
import { SearchSelect } from "../../ui/search-select";
import { useEffect, useRef, useState } from "react";
import type { ThinkingLevel } from "../../../shared/configuration-contracts";
import { WorkflowThinkingControl } from "./workflow-thinking-control";
import { Sparkles } from "lucide-react";
import type {
  WorkflowCatalog,
  WorkflowNode,
  WorkflowScriptAssistRequest,
  WorkflowValueType,
} from "../../../shared/workflow-contracts";
import { api } from "../../api";
import { useApiTask } from "../../api-task-provider";
import { ConfigurationEditorDialog } from "../../components/configuration/configuration-editor-dialog";

/** 由引用节点定义或固定值提取脚本输入类型，不猜测缺失引用和混合数组类型。 */
export function scriptInputDefinitions(
  node: WorkflowNode,
  nodes: WorkflowNode[],
): WorkflowScriptAssistRequest["inputs"] {
  return Object.entries(node.inputs).map(([name, source]) => {
    if (source.kind === "reference") {
      const output = nodes
        .find((item) => item.id === source.nodeId)
        ?.outputs.find((field) => field.name === source.field);
      return {
        name,
        source,
        type: output?.type,
        multiple: output?.multiple,
        description: output?.description,
      };
    }
    const values = Array.isArray(source.value) ? source.value : [source.value];
    const types = values.map((value): WorkflowValueType | undefined => {
      if (typeof value === "string") return "string";
      if (typeof value === "boolean") return "boolean";
      if (typeof value === "number")
        return Number.isSafeInteger(value) ? "integer" : "float";
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if ("assetId" in value) return "file";
        return "object";
      }
      return undefined;
    });
    const type =
      types.length && types.every((item) => item === types[0])
        ? types[0]
        : undefined;
    return { name, source, type, multiple: Array.isArray(source.value) };
  });
}

/** 候选脚本显式应用；请求和应用均绑定上下文快照，避免覆盖期间的编辑。 */
export function WorkflowScriptAssist({
  node,
  nodes,
  catalog,
  onApply,
}: {
  node: WorkflowNode;
  nodes: WorkflowNode[];
  catalog: WorkflowCatalog;
  onApply: (script: string) => void;
}) {
  const { runApiTask } = useApiTask();
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState("");
  const [requirement, setRequirement] = useState("");
  const [busy, setBusy] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>();
  const [thinking, setThinking] = useState("");
  const [text, setText] = useState("");
  const [phase, setPhase] = useState("");
  const [candidate, setCandidate] = useState<{
    script: string;
    snapshot: string;
  }>();
  const controller = useRef<AbortController | undefined>(undefined);
  const [provider, modelId] = model.split("\t");
  const selectedModel = catalog.models.find((item) => item.provider === provider && item.id === modelId);
  const request: WorkflowScriptAssistRequest = {
    provider,
    modelId,
    requirement,
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    script: node.config.script ?? "",
    inputs: scriptInputDefinitions(node, nodes),
    outputs: node.outputs,
    timeoutMs: node.config.timeoutMs ?? 1000,
  };
  const snapshot = JSON.stringify(request);
  const current = useRef(snapshot);
  current.current = snapshot;
  const stale = candidate && candidate.snapshot !== snapshot;
  const cancel = () => {
    controller.current?.abort();
    controller.current = undefined;
    setBusy(false);
    setPhase("已取消生成，已接收内容仅供预览。");
  };
  const close = () => {
    if (controller.current) cancel();
    setOpen(false);
  };
  useEffect(() => () => controller.current?.abort(), []);
  const generate = async () => {
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    setCandidate(undefined);
    setThinking("");
    setText("");
    setPhase("正在等待模型响应…");
    setBusy(true);
    const result = await runApiTask(
      () => api.assistWorkflowScript(request, active.signal, (event) => {
        // 取消或新一轮生成后丢弃旧流，不能覆盖当前预览。
        if (controller.current !== active || active.signal.aborted) return;
        if (event.type === "thinking_delta") {
          setThinking((current) => current + event.delta);
          setPhase("正在思考…");
        } else if (event.type === "text_delta") {
          setText((current) => current + event.delta);
          setPhase("正在生成正文…");
        } else if (event.type === "validating") setPhase("正在检查脚本语法…");
      }),
      { operation: "AI 辅助生成工作流脚本" },
    );
    if (controller.current !== active || active.signal.aborted) return;
    controller.current = undefined;
    if (result.status === "success") {
      setCandidate({ script: result.data.script, snapshot });
      setText(result.data.script);
      setPhase("生成完成，脚本语法检查通过。");
    } else setPhase(result.status === "cancelled" ? "已取消生成。" : "生成未完成，请查看错误提示；已接收内容仅供预览。");
    setBusy(false);
  };
  return (
    <>
      <Button type="button" className="wf-button" onClick={() => setOpen(true)}>
        <Sparkles size={15} />
        AI 辅助
      </Button>
      {open && (
        <ConfigurationEditorDialog
          variant="drawer"
          classPrefix="wf-assist"
          title="AI 辅助编写脚本"
          description="结合当前节点出入参和现有脚本生成候选内容，应用后保存工作流。"
          busy={false}
          closeLabel="关闭脚本辅助"
          onClose={close}
          footer={
            <>
              <Button type="button" className="wf-button" onClick={close}>
                {busy ? "取消生成并关闭" : "关闭"}
              </Button>
              {busy && <Button type="button" className="wf-button" onClick={cancel}>取消生成</Button>}
              <Button
                type="button"
                className="wf-button"
                disabled={
                  busy ||
                  !requirement.trim() ||
                  !catalog.models.some(
                    (item) => item.provider === provider && item.id === modelId,
                  ) ||
                  !node.outputs.length
                }
                onClick={() => void generate()}
              >
                {busy ? "正在生成…" : candidate ? "重新生成" : "生成脚本"}
              </Button>
              <Button variant="primary"
                type="button"
                className="wf-button wf-primary"
                disabled={busy || !candidate || !!stale}
                onClick={() => {
                  if (!candidate || candidate.snapshot !== current.current)
                    return;
                  onApply(candidate.script);
                  setCandidate(undefined);
                  close();
                }}
              >
                应用到脚本
              </Button>
            </>
          }
        >
          <div className="wf-page wf-assist-form" aria-busy={busy}>
            <div className="wf-assist-model-row">
              <label className="wf-field">
                生成模型
                <SearchSelect
                  ariaLabel="脚本辅助模型"
                  value={model}
                  disabled={busy}
                  onChange={(next) => {
                  setModel(next);
                  setThinkingLevel(undefined);
                }}
                  options={[
                    { value: "", label: "选择已配置模型" },
                    ...catalog.models.map((item) => ({ value: `${item.provider}\t${item.id}`, label: `${item.name} · ${item.provider}` })),
                  ]}
                />
              </label>
              <WorkflowThinkingControl levels={selectedModel?.thinkingLevels ?? []} value={thinkingLevel}
                disabled={busy || !selectedModel?.reasoning || !selectedModel.thinkingLevels?.length}
                onChange={setThinkingLevel} />
            </div>
            {!catalog.models.length && (
              <p className="wf-hint">请先在配置中心添加可用模型。</p>
            )}
            <label className="wf-field">
              需求
              <Textarea
                aria-label="脚本生成需求"
                rows={5}
                maxLength={8000}
                value={requirement}
                disabled={busy}
                placeholder="例如：将输入文本按行拆分，去除空行和重复项，返回输出定义中的 result。"
                onChange={(event) => setRequirement(event.target.value)}
              />
            </label>
            <details>
              <summary>将发送的节点上下文</summary>
              <pre className="wf-json-output">
                {JSON.stringify(
                  {
                    inputs: request.inputs,
                    outputs: request.outputs,
                    script: request.script,
                    timeoutMs: request.timeoutMs,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
            {!node.outputs.length && (
              <p className="wf-error">请先定义脚本输出参数。</p>
            )}
            {phase && <p role="status">{phase}</p>}
            {thinking && <details open>
              <summary>思考内容</summary>
              <StreamingPreview label="思考内容" value={thinking} />
            </details>}
            {(busy || text) && <label className="wf-field">
              {candidate ? "候选脚本" : "正文输出"}
              <StreamingPreview label={candidate ? "候选脚本" : "正文输出"} value={text} />
            </label>}
            {candidate && (
              <p className="wf-hint">
                已检查语法；实际数据和输出类型将在工作流运行时校验。
              </p>
            )}
            {stale && (
              <p role="status" className="wf-error">
                节点内容、模型或需求已变化，请重新生成后应用，避免覆盖新修改。
              </p>
            )}
          </div>
        </ConfigurationEditorDialog>
      )}
    </>
  );
}

/** 仅在用户停留底部时跟随新输出，向上查看历史时保持阅读位置。 */
function StreamingPreview({ label, value }: { label: string; value: string }) {
  const element = useRef<HTMLTextAreaElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    if (follow.current && element.current) element.current.scrollTop = element.current.scrollHeight;
  }, [value]);
  return <textarea ref={element} aria-label={label} className="wf-code wf-script" rows={8} value={value} readOnly spellCheck={false}
    onScroll={(event) => {
      const target = event.currentTarget;
      follow.current = target.scrollHeight - target.scrollTop - target.clientHeight < 32;
    }} />;
}
