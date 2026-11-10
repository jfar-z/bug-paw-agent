import { workflowLoopInputBindings } from "./workflow-field-guards";
import { workflowHasPath, withWorkflowNode } from "./workflow-graph";
export { workflowHasPath, withWorkflowNode } from "./workflow-graph";
import { workflowClientId } from "./workflow-id";
import {
  copyWorkflowSelection,
  pasteWorkflowSelection,
  type WorkflowSelection,
} from "./workflow-copy";
import { useWorkflowConfirm } from "./workflow-confirm";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { WorkflowAlignmentControls } from "./workflow-alignment-controls";
import { WORKFLOW_GRID, gridPlacement, snapWorkflowNodes, alignWorkflowNodes, type AlignmentGuide, type AlignmentAction } from "./workflow-alignment";
import {
  ReactFlow,
  ViewportPortal,
  Background,
  Controls,
  Handle,
  Position,
  applyNodeChanges,
  type NodeProps,
  type Node,
  type Connection,
  type ReactFlowInstance,
  type OnConnectEnd,
  type XYPosition,
} from "@xyflow/react";
import {
  Plus,
  Repeat,
  Copy,
  ClipboardPaste,
  Workflow,
  Code,
  GitBranch,
  Bot,
  Sparkles,
  ArrowRightLeft,
  LogIn,
  LogOut,
} from "lucide-react";
import {
  WORKFLOW_NODE_NAMES,
  workflowEditorSettings,
  type WorkflowEditorSettings,
  newWorkflowNode,
  workflowLoopOutputs,
  type WorkflowDraft,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowCatalog,
} from "../../../shared/workflow-contracts";
import { WorkflowNodeEditor } from "./workflow-node-editor";
import type { WorkflowInputToolsProps } from "./workflow-input-tools";
import {
  appendWorkflowInputFields,
  importOuterWorkflowInputs,
} from "./workflow-input-parameters";
import { useApiTask } from "../../api-task-provider";
import "@xyflow/react/dist/style.css";

const icons = {
  input: LogIn,
  output: LogOut,
  llm: Sparkles,
  agent: Bot,
  aigc: Workflow,
  condition: GitBranch,
  select: ArrowRightLeft,
  javascript: Code,
  semaphore_acquire: LogIn,
  semaphore_release: LogOut,
  loop: Repeat,
  workflow: Workflow,
};
export type CanvasNode = Node<{ node: WorkflowNode }, "workflow">;
type PendingConnection = {
  nodeId: string;
  type: "source" | "target";
  handleId?: string | null;
  position: XYPosition;
};
/** 保留测量尺寸、选择与拖动状态，避免更新业务定义时让所有节点重新测量。 */
export function syncCanvasNodes(
  previous: CanvasNode[],
  nodes: WorkflowNode[],
): CanvasNode[] {
  const lookup = new Map(previous.map((node) => [node.id, node]));
  return nodes.map((node) => {
    const old = lookup.get(node.id);
    if (old?.data.node === node) return old;
    return {
      ...old,
      id: node.id,
      type: "workflow",
      position: node.position,
      data: { node },
      deletable: !["input", "output"].includes(node.kind),
    };
  });
}
/** 松手坐标与菜单显示位置分开保存，菜单避让边缘不会改变节点落点。 */
export function appendWorkflowNode(
  draft: WorkflowDraft,
  kind: WorkflowNodeKind,
  position: XYPosition,
  pending?: PendingConnection,
): WorkflowDraft {
  const item = newWorkflowNode(
    kind,
    `node_${workflowClientId().replaceAll("-", "")}`,
    position,
  );
  const origin =
    pending && draft.nodes.find((node) => node.id === pending.nodeId);
  const branch =
    pending?.type === "source"
      ? pending.handleId === "true" || pending.handleId === "false"
        ? pending.handleId
        : undefined
      : kind === "condition"
        ? "true"
        : undefined;
  return {
    ...draft,
    nodes: [...draft.nodes, item],
    edges: origin
      ? [
          ...draft.edges,
          {
            id: workflowClientId(),
            source: pending.type === "source" ? origin.id : item.id,
            target: pending.type === "source" ? item.id : origin.id,
            branch,
          },
        ]
      : draft.edges,
  };
}
/** 节点只显示类型和参数摘要，完整配置由右侧面板承担。 */
const NodeCard = memo(function NodeCard({
  data,
  selected,
}: NodeProps<CanvasNode>) {
  const node = data.node,
    Icon = icons[node.kind];
  return (
    <div className={`wf-node${selected ? " is-selected" : ""}`}>
      {node.kind !== "input" && (
        <Handle type="target" position={Position.Left} aria-label="输入连接" />
      )}
      <div className="wf-node-heading">
        <span className="wf-node-icon">
          <Icon size={18} />
        </span>
        <div>
          <small>{WORKFLOW_NODE_NAMES[node.kind]}</small>
          <strong>{node.name}</strong>
        </div>
      </div>
      <div className="wf-node-ports">
        {node.outputs.length ? (
          node.outputs.slice(0, 3).map((f) => (
            <div key={f.name}>
              <code>{f.name}</code>
              <span>
                {f.type}
                {f.multiple ? "[]" : ""}
              </span>
            </div>
          ))
        ) : (
          <span>配置输出参数</span>
        )}
      </div>
      {node.kind === "condition" ? (
        <>
          <span className="wf-branch wf-branch-true">IF</span>
          <Handle
            id="true"
            type="source"
            position={Position.Right}
            style={{ top: "42%" }}
            aria-label="条件满足"
          />
          <span className="wf-branch wf-branch-false">ELSE</span>
          <Handle
            id="false"
            type="source"
            position={Position.Right}
            style={{ top: "80%" }}
            aria-label="条件不满足"
          />
        </>
      ) : (
        node.kind !== "output" && (
          <Handle
            type="source"
            position={Position.Right}
            aria-label="输出连接"
          />
        )
      )}
    </div>
  );
});
const nodeTypes = { workflow: NodeCard };
/** 可拖动、连线和键盘操作的 DAG 编辑画布。 */
function WorkflowCanvasScope({
  draft,
  catalog,
  onChange,
  onValidity,
  onEditLoop,
  workflowId,
  inputTools,
  settings,
  onSettingsChange,
}: {
  settings: WorkflowEditorSettings;
  onSettingsChange: (settings: WorkflowEditorSettings) => void;
  inputTools: WorkflowInputToolsProps;
  onEditLoop: (nodeId: string) => void;
  workflowId?: string;
  draft: WorkflowDraft;
  catalog: WorkflowCatalog;
  onChange: (draft: WorkflowDraft) => void;
  onValidity: (key: string, valid: boolean) => void;
}) {
  const confirm = useWorkflowConfirm();
  const [selected, setSelected] = useState<string>();
  const [palette, setPalette] = useState<{
    left: number;
    top: number;
    pending?: PendingConnection;
  }>();
  const { runApiTask } = useApiTask();
  const [selectedEdges, setSelectedEdges] = useState<string[]>([]);
  const [nodes, setNodes] = useState(() => syncCanvasNodes([], draft.nodes));
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const [guides, setGuides] = useState<AlignmentGuide[]>([]);
  const guideRef = useRef<AlignmentGuide[]>([]);
  const bypassSnap = useRef(false);
  const dragging = useRef(false);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      bypassSnap.current = event.altKey;
      if (event.altKey) {
        guideRef.current = [];
        setGuides([]);
      }
    };
    const blur = () => {
      bypassSnap.current = false;
      guideRef.current = [];
      setGuides([]);
    };
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", key);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", key);
      window.removeEventListener("blur", blur);
    };
  }, []);
  const [clipboard, setClipboard] = useState<WorkflowSelection>();
  const [notice, setNotice] = useState("");
  const pasteCount = useRef(0);
  const flow = useRef<ReactFlowInstance<CanvasNode> | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const deleting = useRef(false);
  const latest = useRef({ draft, onChange });
  latest.current = { draft, onChange };
  useLayoutEffect(() => {
    setNodes((old) => syncCanvasNodes(old, draft.nodes));
  }, [draft.nodes]);
  useLayoutEffect(() => {
    const container = canvas.current;
    const popup = menu.current;
    if (!palette || !container || !popup) return;
    // 按限高后的真实尺寸避让四边；画布缩放时重新定位，不改变节点松手落点。
    const positionMenu = () => {
      popup.style.left = `${Math.max(
        8,
        Math.min(palette.left, container.clientWidth - popup.offsetWidth - 8),
      )}px`;
      popup.style.top = `${Math.max(
        8,
        Math.min(palette.top, container.clientHeight - popup.offsetHeight - 8),
      )}px`;
    };
    positionMenu();
    const observer = new ResizeObserver(positionMenu);
    observer.observe(container);
    observer.observe(popup);
    popup.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    const close = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as HTMLElement))
        setPalette(undefined);
    };
    document.addEventListener("pointerdown", close);
    return () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", close);
    };
  }, [palette]);
  const node = draft.nodes.find((n) => n.id === selected);
  const selectedIds = nodes
    .filter((item) => item.selected && item.deletable)
    .map((item) => item.id);
  const alignmentSelection = nodes.filter((item) => item.selected);
  const alignSelection = (action: AlignmentAction) => {
    const aligned = alignWorkflowNodes(alignmentSelection, action);
    const positions = new Map(aligned.map((item) => [item.id, item.position]));
    const current = latest.current;
    current.onChange({ ...current.draft, nodes: current.draft.nodes.map((item) =>
      positions.has(item.id) ? { ...item, position: positions.get(item.id)! } : item,
    ) });
    setNotice(`已对齐 ${aligned.length} 个节点`);
    canvas.current?.focus();
  };
  const copySelection = () => {
    if (!selectedIds.length) return;
    const snapshot = copyWorkflowSelection(draft, selectedIds);
    setClipboard(snapshot);
    pasteCount.current = 0;
    setNotice(`已复制 ${snapshot.nodes.length} 个节点`);
    canvas.current?.focus();
  };
  const applyPaste = (snapshot: WorkflowSelection, offset: number) => {
    const current = latest.current;
    const pasted = pasteWorkflowSelection(current.draft, snapshot, offset);
    const next = { ...pasted, nodes: [
      ...pasted.nodes.slice(0, current.draft.nodes.length),
      ...gridPlacement(pasted.nodes.slice(current.draft.nodes.length), settings.snapToGrid && !bypassSnap.current),
    ] };
    const added = new Set(
      next.nodes.slice(current.draft.nodes.length).map((item) => item.id),
    );
    current.onChange(next);
    setNodes((old) =>
      syncCanvasNodes(old, next.nodes).map((item) => ({
        ...item,
        selected: added.has(item.id),
      })),
    );
    setSelectedEdges([]);
    setSelected(undefined);
    setNotice(`已粘贴 ${added.size} 个节点`);
    canvas.current?.focus();
  };
  const pasteSelection = () => {
    if (!clipboard) return;
    void runApiTask(
      async () => {
        applyPaste(clipboard, (pasteCount.current + 1) * 48);
        pasteCount.current += 1;
      },
      { operation: "粘贴工作流节点" },
    );
  };
  const changeNode = (next: WorkflowNode) =>
    void runApiTask(async () => onChange(withWorkflowNode(draft, next)), {
      operation: "更新节点依赖",
    });
  const remove = (ids: string[], edgeIds: string[] = []) =>
    flow.current?.deleteElements({
      nodes: ids.map((id) => ({ id })),
      edges: edgeIds.map((id) => ({ id })),
    });
  const finishConnection: OnConnectEnd = (event, state) => {
    // 只有拖到画布空白处才创建节点；错误端口或已有节点仍沿用普通连线校验。
    if (state.isValid || !state.fromNode) return;
    const pointer = "changedTouches" in event ? event.changedTouches[0] : event;
    const bounds = canvas.current?.getBoundingClientRect();
    if (!pointer || !bounds || !flow.current) return;
    // TouchEvent.target 保留起始端口，松手目标必须按最终屏幕坐标重新定位。
    const target = document.elementFromPoint(pointer.clientX, pointer.clientY);
    if (
      !target?.closest(".react-flow__pane") ||
      !canvas.current?.contains(target)
    )
      return;
    setPalette({
      left: pointer.clientX - bounds.left,
      top: pointer.clientY - bounds.top,
      pending: {
        nodeId: state.fromNode.id,
        type: state.fromHandle.type,
        handleId: state.fromHandle.id,
        position: flow.current.screenToFlowPosition({
          x: pointer.clientX,
          y: pointer.clientY,
        }),
      },
    });
  };
  const connect = (connection: Connection) =>
    void runApiTask(
      async () => {
        const { source, target, sourceHandle } = connection;
        if (workflowHasPath(draft, target, source))
          throw new Error("DAG 不能包含循环连线。");
        if (
          draft.nodes.find((n) => n.id === target)?.kind === "input" ||
          draft.nodes.find((n) => n.id === source)?.kind === "output"
        )
          throw new Error("输入节点只可作为起点，输出节点只可作为终点。");
        const branch =
          sourceHandle === "true" || sourceHandle === "false"
            ? sourceHandle
            : undefined;
        if (
          draft.edges.some(
            (e) =>
              e.source === source && e.target === target && e.branch === branch,
          )
        )
          return;
        onChange({
          ...draft,
          edges: [
            ...draft.edges,
            { id: workflowClientId(), source, target, branch },
          ],
        });
      },
      { operation: "连接工作流节点" },
    );
  return (
    <div
      className="wf-editor-body"
      onKeyDownCapture={(event) => {
        // 网格模式由画布统一处理方向键，避免图库默认的 5px 步长被吸附抵消。
        if (!settings.snapToGrid || event.altKey || event.ctrlKey || event.metaKey ||
          !(event.target instanceof Element) || !event.target.classList.contains("react-flow__node") ||
          !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const step = WORKFLOW_GRID * (event.shiftKey ? 4 : 1);
        const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
        const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
        const moved = gridPlacement(alignmentSelection.map((item) => ({ ...item,
          position: { x: item.position.x + dx, y: item.position.y + dy },
        })), true);
        const positions = new Map(moved.map((item) => [item.id, item.position]));
        const current = latest.current;
        current.onChange({ ...current.draft, nodes: current.draft.nodes.map((item) =>
          positions.has(item.id) ? { ...item, position: positions.get(item.id)! } : item,
        ) });
      }}
      onKeyDown={(event) => {
        // 只处理画布内快捷键，表单和脚本编辑仍使用浏览器的文本复制粘贴。
        if (
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          !event.shiftKey &&
          !event.repeat &&
          !palette &&
          event.target instanceof Element &&
          canvas.current?.contains(event.target) &&
          !event.target.closest(
            "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
          )
        ) {
          const key = event.key.toLowerCase();
          if (
            (key === "c" && selectedIds.length) ||
            (key === "v" && clipboard)
          ) {
            event.preventDefault();
            event.stopPropagation();
            if (key === "c") copySelection();
            else pasteSelection();
            return;
          }
        }
        if (event.key === "Escape" && palette) {
          event.preventDefault();
          setPalette(undefined);
          canvas.current?.focus();
          return;
        }
        if (
          event.repeat ||
          palette ||
          !["Delete", "Backspace"].includes(event.key)
        )
          return;
        if (
          event.target instanceof Element &&
          event.target.closest(
            "input, textarea, select, button, [contenteditable]:not([contenteditable='false'])",
          )
        )
          return;
        const ids = nodes
          .filter((node) => node.selected && node.deletable)
          .map((node) => node.id);
        if (!ids.length && !selectedEdges.length) return;
        event.preventDefault();
        void remove(ids, selectedEdges);
      }}
    >
      <div
        className="wf-canvas"
        ref={canvas}
        tabIndex={0}
        aria-label="工作流画布操作区"
      >
        <div className="wf-canvas-toolbar">
          <button
            className="wf-button"
            aria-expanded={!!palette}
            onClick={() =>
              setPalette(palette ? undefined : { left: 16, top: 62 })
            }
          >
            <Plus size={16} />
            添加节点
          </button>
          <button
            className="wf-button"
            disabled={!selectedIds.length}
            onClick={copySelection}
            title="复制所选节点（Ctrl/Cmd+C），输入和输出节点除外"
          >
            <Copy size={16} />
            复制所选
          </button>
          <button
            className="wf-button"
            disabled={!clipboard}
            onClick={pasteSelection}
            title="粘贴节点（Ctrl/Cmd+V）"
          >
            <ClipboardPaste size={16} />
            粘贴
          </button>
          <WorkflowAlignmentControls settings={settings} onChange={onSettingsChange}
            canAlign={alignmentSelection.length >= 2 && alignmentSelection.every((n) => !!n.measured?.width && !!n.measured?.height)}
            onAlign={alignSelection} />
          <span>Shift 拖动框选 · Ctrl/Cmd 点击多选 · Alt 自由拖动 · Delete 删除</span>
          {selectedEdges.length > 0 && (
            <button
              className="wf-button"
              onClick={() => void remove([], selectedEdges)}
            >
              删除连线
            </button>
          )}
        </div>
        {palette && (
          <div
            className="wf-palette"
            ref={menu}
            role="menu"
            aria-label="可用节点"
            style={{ left: palette.left, top: palette.top }}
            onKeyDown={(event) => {
              const buttons = [
                ...(menu.current?.querySelectorAll<HTMLButtonElement>(
                  "button",
                ) ?? []),
              ];
              const index = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? buttons.length - 1
                      : (index +
                          (event.key === "ArrowDown" ? 1 : -1) +
                          buttons.length) %
                        buttons.length;
                buttons[next]?.focus();
              }
            }}
          >
            {(Object.keys(WORKFLOW_NODE_NAMES) as WorkflowNodeKind[])
              .filter((k) => !["input", "output"].includes(k))
              .map((kind) => {
                const Icon = icons[kind];
                return (
                  <button
                    key={kind}
                    role="menuitem"
                    onClick={() => {
                      const bounds = canvas.current?.getBoundingClientRect();
                      const position =
                        palette.pending?.position ??
                        (bounds && flow.current
                          ? flow.current.screenToFlowPosition({
                              x: bounds.left + bounds.width / 2,
                              y: bounds.top + bounds.height / 2,
                            })
                          : { x: 80, y: 140 });
                      const next = appendWorkflowNode(
                        draft,
                        kind,
                        gridPlacement([{ id: "new", position }], settings.snapToGrid && !bypassSnap.current)[0].position,
                        palette.pending,
                      );
                      const item = next.nodes.at(-1)!;
                      onChange(next);
                      setNodes((old) =>
                        syncCanvasNodes(old, next.nodes).map((node) => ({
                          ...node,
                          selected: node.id === item.id,
                        })),
                      );
                      setSelectedEdges([]);
                      // 保持侧栏开闭状态，避免画布宽度变化挪动松手落点。
                      setSelected(
                        palette.pending && !selected ? undefined : item.id,
                      );
                      setPalette(undefined);
                      canvas.current?.focus();
                    }}
                  >
                    <Icon size={18} />
                    {WORKFLOW_NODE_NAMES[kind]}
                    {palette.pending?.type === "target" && kind === "condition"
                      ? " · IF"
                      : ""}
                  </button>
                );
              })}
          </div>
        )}
        <ReactFlow<CanvasNode>
          onInit={(instance) => {
            flow.current = instance;
          }}
          nodes={nodes}
          edges={draft.edges.map((e) => ({
            ...e,
            sourceHandle: e.branch,
            selected: selectedEdges.includes(e.id),
            label:
              e.branch === "true"
                ? "IF"
                : e.branch === "false"
                  ? "ELSE"
                  : undefined,
          }))}
          nodeTypes={nodeTypes}
          onNodeClick={(event, n) => {
            if (event.ctrlKey || event.metaKey || event.shiftKey) return;
            setSelected(n.id);
            setSelectedEdges([]);
          }}
          onSelectionChange={({ nodes: selection }) => {
            if (selection.length > 1) setSelected(undefined);
          }}
          onPaneClick={() => {
            setSelected(undefined);
            setPalette(undefined);
            canvas.current?.focus();
          }}
          onNodesChange={(changes) => {
            const old = nodesRef.current;
            let next = applyNodeChanges(changes, old);
            const positionChanges = changes.filter((change) => change.type === "position").filter((change) => change.position);
            if (!positionChanges.length) {
              nodesRef.current = next;
              setNodes(next);
              return;
            }
            const ids = new Set(positionChanges.map((change) => change.id));
            const moving = next.filter((item) => ids.has(item.id));
            const finishing = dragging.current && positionChanges.every((change) => change.dragging === false);
            // 松手保留上一帧最终位置，避免把辅助线落点再次网格取整。
            const result = finishing
              ? { nodes: old.filter((item) => ids.has(item.id)), guides: [] }
              : snapWorkflowNodes(moving, next, settings, flow.current?.getZoom() ?? 1, guideRef.current, bypassSnap.current || !positionChanges.some((change) => change.dragging === true));
            dragging.current = positionChanges.some((change) => change.dragging === true);
            guideRef.current = dragging.current ? result.guides : [];
            setGuides(guideRef.current);
            const positions = new Map(result.nodes.map((item) => [item.id, item.position]));
            next = next.map((item) => positions.has(item.id) ? { ...item, position: positions.get(item.id)! } : item);
            nodesRef.current = next;
            setNodes(next);
            const current = latest.current;
            current.onChange({
              ...current.draft,
              nodes: current.draft.nodes.map((node) => positions.has(node.id)
                ? { ...node, position: positions.get(node.id)! } : node),
            });
          }}
          onEdgesChange={(changes) =>
            setSelectedEdges((old) => {
              let next = [...old];
              for (const change of changes)
                if (change.type === "select") {
                  next = next.filter((id) => id !== change.id);
                  if (change.selected) next.push(change.id);
                }
              return next;
            })
          }
          onBeforeDelete={async ({ nodes }) => {
            if (deleting.current) return false;
            if (!nodes.length) return true;
            deleting.current = true;
            try {
              return await confirm(
                `删除 ${nodes.length} 个节点及关联连线？引用这些节点的参数需要重新配置。`,
              );
            } finally {
              deleting.current = false;
            }
          }}
          onDelete={({ nodes: removed, edges }) => {
            const current = latest.current;
            const ids = new Set(removed.map((node) => node.id));
            const edgeIds = new Set(edges.map((edge) => edge.id));
            current.onChange({
              ...current.draft,
              nodes: current.draft.nodes.filter((node) => !ids.has(node.id)),
              edges: current.draft.edges.filter(
                (edge) =>
                  !edgeIds.has(edge.id) &&
                  !ids.has(edge.source) &&
                  !ids.has(edge.target),
              ),
            });
            if (selected && ids.has(selected)) setSelected(undefined);
            setSelectedEdges((old) => old.filter((id) => !edgeIds.has(id)));
          }}
          onConnectStart={() => {
            setPalette(undefined);
          }}
          onConnectEnd={finishConnection}
          onConnect={connect}
          fitView
          minZoom={0.2}
          maxZoom={1.5}
          deleteKeyCode={null}
          multiSelectionKeyCode={["Control", "Meta"]}
          selectionKeyCode="Shift"
          aria-label="工作流 DAG 画布"
        >
          <Background color="var(--border-strong)" gap={WORKFLOW_GRID} />
          <ViewportPortal>
            <svg className="wf-alignment-guides" aria-hidden="true">
              {guides.map((guide) => <line key={guide.axis}
                x1={guide.axis === "x" ? guide.value : guide.start - 16}
                x2={guide.axis === "x" ? guide.value : guide.end + 16}
                y1={guide.axis === "y" ? guide.value : guide.start - 16}
                y2={guide.axis === "y" ? guide.value : guide.end + 16}
                vectorEffect="non-scaling-stroke" />)}
            </svg>
          </ViewportPortal>
          <Controls showInteractive={false} />
        </ReactFlow>
        <div className="wf-canvas-caption" role="status" aria-live="polite">
          {draft.nodes.length} 个节点 · {draft.edges.length} 条连线
          {selectedIds.length > 0 && ` · 已选 ${selectedIds.length} 个`}
          {notice && ` · ${notice}`}
        </div>
      </div>
      {node && (
        <WorkflowNodeEditor
          key={node.id}
          workflowId={workflowId}
          inputTools={inputTools}
          onEditLoop={() => onEditLoop(node.id)}
          node={node}
          nodes={draft.nodes}
          edges={draft.edges}
          catalog={catalog}
          onChange={changeNode}
          onClose={() => setSelected(undefined)}
          onDelete={() => void remove([node.id])}
          onCopy={() => {
            void runApiTask(
              async () =>
                applyPaste(copyWorkflowSelection(draft, [node.id]), 48),
              { operation: "复制工作流节点" },
            );
          }}
          onValidity={onValidity}
        />
      )}
    </div>
  );
}

/** 同页切换隔离作用域，整个草稿保留在父编辑器，保存和离开保护覆盖全部循环体。 */
export function WorkflowCanvas(props: {
  draft: WorkflowDraft;
  catalog: WorkflowCatalog;
  workflowId?: string;
  onChange: (draft: WorkflowDraft) => void;
  onValidity: (key: string, valid: boolean) => void;
}) {
  const [path, setPath] = useState<string[]>([]);
  const [parameterClipboard, setParameterClipboard] = useState<{
    fields: import("../../../shared/workflow-contracts").WorkflowField[];
    scope: string;
  }>();
  let scope = props.draft;
  let outerInput: WorkflowNode | undefined;
  let systemFields: string[] = [];
  const names = [props.draft.name];
  for (const id of path) {
    outerInput = scope.nodes.find((node) => node.kind === "input");
    const node = scope.nodes.find((item) => item.id === id)!;
    systemFields =
      node.config.loop!.mode === "array" ? ["index", "item"] : ["index"];
    scope = node.config.loop!.body;
    names.push(node.name);
  }
  const replace = (
    graph: WorkflowDraft,
    ids: string[],
    next: WorkflowDraft,
  ): WorkflowDraft => {
    if (!ids.length) return next;
    return {
      ...graph,
      nodes: graph.nodes.map((node) => {
        if (node.id !== ids[0]) return node;
        const body = replace(node.config.loop!.body, ids.slice(1), next);
        const outputs = Object.fromEntries(
          Object.entries(node.config.loop!.outputs)
            .filter(([, mapping]) =>
              body.nodes
                .find((n) => n.kind === "output")!
                .outputs.some((field) => field.name === mapping.field),
            )
            .map(([name, mapping]) => {
              const field = body.nodes
                .find((n) => n.kind === "output")!
                .outputs.find((f) => f.name === mapping.field)!;
              return [
                name,
                {
                  ...mapping,
                  mode:
                    mapping.mode === "last"
                      ? ("last" as const)
                      : field.multiple
                        ? ("flatten" as const)
                        : ("collect" as const),
                },
              ];
            }),
        );
        const bindings = workflowLoopInputBindings(node, body);
        const loop = {
          ...node.config.loop!,
          body,
          outputs,
          state: bindings.state,
        };
        return {
          ...node,
          inputs: bindings.inputs,
          config: { ...node.config, loop },
          outputs: workflowLoopOutputs(loop, node.outputs),
        };
      }),
    };
  };
  return (
    <>
      {path.length > 0 && (
        <nav className="wf-scope-path" aria-label="循环体路径">
          {names.map((name, index) => (
            <button
              key={index}
              type="button"
              className="wf-button"
              disabled={index === path.length}
              onClick={() => setPath(path.slice(0, index))}
            >
              {index > 0 ? "› " : ""}
              {name}
            </button>
          ))}
        </nav>
      )}
      <WorkflowCanvasScope
        key={path.join("/")}
        {...props}
        draft={scope}
        settings={workflowEditorSettings(props.draft)}
        onSettingsChange={(editorSettings) => props.onChange({ ...props.draft, editorSettings })}
        inputTools={{
          clipboard: parameterClipboard?.fields,
          reserved: path.length ? ["index", "item"] : [],
          systemFields,
          outerInput,
          onCopy: (fields) =>
            setParameterClipboard({
              fields: structuredClone(fields),
              scope: path.join("/"),
            }),
          onPaste: (names) => {
            const next = appendWorkflowInputFields(
              scope,
              parameterClipboard?.fields ?? [],
              names,
              path.length ? ["index", "item"] : [],
              parameterClipboard?.scope === path.join("/"),
            );
            props.onChange(replace(props.draft, path, next));
          },
          onImport: path.length
            ? (names) =>
                props.onChange(
                  importOuterWorkflowInputs(props.draft, path, names),
                )
            : undefined,
        }}
        onChange={(next) => props.onChange(replace(props.draft, path, next))}
        onValidity={(key, valid) =>
          props.onValidity(`${path.join("/")}:${key}`, valid)
        }
        onEditLoop={(nodeId) => setPath([...path, nodeId])}
      />
    </>
  );
}
