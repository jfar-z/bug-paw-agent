import type {
  WorkflowBinding,
  WorkflowDraft,
  WorkflowEdge,
  WorkflowNode,
} from "../../../shared/workflow-contracts";
import { workflowClientId } from "./workflow-id";
import { withWorkflowNode } from "./workflow-graph";

/** 当前编辑页内的独立快照；不写系统剪贴板或持久化存储。 */
export interface WorkflowSelection {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/** 只遍历契约声明的绑定，常量 JSON、脚本和自定义参数保持原样。 */
function remapNode(node: WorkflowNode, resolve: (id: string) => string): void {
  const binding = (value: WorkflowBinding) => {
    if (value.kind === "reference") value.nodeId = resolve(value.nodeId);
  };
  Object.values(node.inputs).forEach(binding);
  Object.values(node.config.referenceGroups ?? {}).forEach((group) => {
    if (group.binding) binding(group.binding);
  });
  for (const condition of [
    ...(node.config.conditions ?? []),
    ...(node.config.selectCondition ? [node.config.selectCondition] : []),
  ]) {
    binding(condition.left);
    binding(condition.right);
  }
  node.config.candidates?.forEach(binding);
  if (node.kind === "loop" && node.config.loop) {
    const loop = node.config.loop;
    binding(loop.count);
    binding(loop.items);
    for (const state of Object.values(loop.state)) binding(state.initial);
    const original = loop.body;
    const body = duplicateWorkflow(original, original.name);
    const ids = new Map(
      original.nodes.map((child, index) => [child.id, body.nodes[index].id]),
    );
    for (const value of [loop.condition.left, loop.condition.right])
      if (value.kind === "reference")
        value.nodeId = ids.get(value.nodeId) ?? value.nodeId;
    loop.body = body;
  }
  for (const field of node.outputs) {
    if (field.enumSource)
      field.enumSource.nodeId = resolve(field.enumSource.nodeId);
  }
}

/** 整份复制仅返回新建所需定义，历史版本、时间和运行记录由服务端独立维护。 */
export function duplicateWorkflow(
  draft: WorkflowDraft,
  name: string,
): WorkflowDraft {
  const { description, published, nodes, edges, editorSettings } = structuredClone(draft);
  const ids = new Map(
    nodes.map((node) => [
      node.id,
      `node_${workflowClientId().replaceAll("-", "")}`,
    ]),
  );
  const resolve = (id: string) => ids.get(id) ?? id;
  for (const node of nodes) {
    node.id = resolve(node.id);
    remapNode(node, resolve);
  }
  return {
    editorSettings,
    name: name.trim(),
    description,
    published,
    nodes,
    edges: edges.map((edge) => ({
      ...edge,
      id: workflowClientId(),
      source: resolve(edge.source),
      target: resolve(edge.target),
    })),
  };
}

/** 保留内部边和外部入边，防止复制后丢失分支控制；不向原有下游新增连接。 */
export function copyWorkflowSelection(
  draft: WorkflowDraft,
  selectedIds: string[],
): WorkflowSelection {
  const selected = new Set(selectedIds);
  const nodes = draft.nodes.filter(
    (node) => selected.has(node.id) && !["input", "output"].includes(node.kind),
  );
  const ids = new Set(nodes.map((node) => node.id));
  return structuredClone({
    nodes,
    edges: draft.edges.filter((edge) => ids.has(edge.target)),
  });
}

/** 先完整构造并检查副本，再一次性应用，重复粘贴不共享对象或标识。 */
export function pasteWorkflowSelection(
  draft: WorkflowDraft,
  selection: WorkflowSelection,
  offset: number,
): WorkflowDraft {
  if (!selection.nodes.length)
    throw new Error("请先复制普通节点；输入和输出节点不能重复创建。");
  if (draft.nodes.length + selection.nodes.length > 100)
    throw new Error("粘贴后节点将超过 100 个，请减少复制的节点数量。");
  const { nodes, edges } = structuredClone(selection);
  const ids = new Map(
    nodes.map((node) => [
      node.id,
      `node_${workflowClientId().replaceAll("-", "")}`,
    ]),
  );
  const existing = new Set(draft.nodes.map((node) => node.id));
  const resolve = (id: string) => {
    if (ids.has(id)) return ids.get(id)!;
    if (existing.has(id)) return id;
    throw new Error(
      `复制内容依赖的上游或枚举来源节点 ${id} 已删除，请重新选择并复制。`,
    );
  };
  for (const node of nodes) {
    node.id = resolve(node.id);
    node.name = `${node.name.slice(0, 97)} 副本`;
    node.position = {
      x: node.position.x + offset,
      y: node.position.y + offset,
    };
    remapNode(node, resolve);
  }
  let next: WorkflowDraft = {
    ...draft,
    nodes: [...draft.nodes, ...nodes],
    edges: [
      ...draft.edges,
      ...edges.map((edge) => ({
        ...edge,
        id: workflowClientId(),
        source: resolve(edge.source),
        target: resolve(edge.target),
      })),
    ],
  };
  // 选区外路径可能穿过未复制节点，按副本绑定补齐依赖并继续执行环路检查。
  for (const node of nodes) next = withWorkflowNode(next, node);
  if (next.edges.length > 400)
    throw new Error("粘贴后连线将超过 400 条，请减少复制的节点数量。");
  return next;
}
