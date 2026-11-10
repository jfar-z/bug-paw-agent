import type { WorkflowEditorSettings } from "../../../shared/workflow-contracts";

/** 点阵与所有放置入口共用画布坐标，缩放不改变网格尺寸。 */
export const WORKFLOW_GRID = 24;
/** 几何计算只依赖位置和已测量尺寸，不携带业务节点配置。 */
export interface AlignmentNode {
  id: string;
  position: { x: number; y: number };
  measured?: { width?: number; height?: number };
}
/** 保留目标和锚点实现吸附滞回；辅助线只存在于本次拖动。 */
export interface AlignmentGuide {
  axis: "x" | "y";
  targetId: string;
  anchor: number;
  targetAnchor: number;
  value: number;
  start: number;
  end: number;
}
/** 单次手动对齐只修改一条轴，不叠加网格修正。 */
export type AlignmentAction = "left" | "centerX" | "right" | "top" | "centerY" | "bottom";

/** 缺少测量时仅能确定左上角，禁止猜测高度造成伪对齐。 */
function bounds(nodes: AlignmentNode[]) {
  const x = Math.min(...nodes.map((n) => n.position.x));
  const y = Math.min(...nodes.map((n) => n.position.y));
  return {
    x, y,
    width: Math.max(...nodes.map((n) => n.position.x + (n.measured?.width ?? 0))) - x,
    height: Math.max(...nodes.map((n) => n.position.y + (n.measured?.height ?? 0))) - y,
  };
}
/** 对称处理负坐标，避免负半格与正半格落点规则不一致。 */
export function gridCoordinate(value: number): number {
  return (Math.sign(value) * Math.round(Math.abs(value) / WORKFLOW_GRID) * WORKFLOW_GRID) || 0;
}
/** 新增和粘贴按整体左上角平移，保持内部布局和原始对象不变。 */
export function gridPlacement<T extends AlignmentNode>(nodes: T[], enabled: boolean): T[] {
  if (!enabled || !nodes.length) return nodes;
  const box = bounds(nodes);
  const delta = { x: gridCoordinate(box.x) - box.x, y: gridCoordinate(box.y) - box.y };
  return nodes.map((node) => ({ ...node, position: {
    x: node.position.x + delta.x, y: node.position.y + delta.y,
  } }));
}
/** 逐轴先选择节点辅助线，再补网格；整组始终使用同一个位移。 */
export function snapWorkflowNodes<T extends AlignmentNode>(
  moving: T[], targets: AlignmentNode[], settings: WorkflowEditorSettings,
  zoom: number, previous: AlignmentGuide[] = [], bypass = false,
): { nodes: T[]; guides: AlignmentGuide[] } {
  if (!moving.length || bypass) return { nodes: moving, guides: [] };
  const box = bounds(moving);
  const movingIds = new Set(moving.map((node) => node.id));
  const candidates = targets.filter((node) => !movingIds.has(node.id));
  const measured = moving.every((n) => n.measured?.width && n.measured?.height);
  const delta = { x: 0, y: 0 };
  const guides: AlignmentGuide[] = [];
  for (const axis of ["x", "y"] as const) {
    const size = axis === "x" ? "width" : "height";
    const cross = axis === "x" ? "y" : "x";
    const crossSize = axis === "x" ? "height" : "width";
    let best: { distance: number; guide: AlignmentGuide; retained: boolean } | undefined;
    if (settings.snapToNodes && measured) {
      for (const target of candidates) {
        if (!target.measured?.width || !target.measured?.height) continue;
        for (const anchor of [0, 0.5, 1]) for (const targetAnchor of [0, 0.5, 1]) {
          const value = target.position[axis] + target.measured[size]! * targetAnchor;
          const distance = value - (box[axis] + box[size] * anchor);
          const retained = previous.some((g) => g.axis === axis && g.targetId === target.id &&
            g.anchor === anchor && g.targetAnchor === targetAnchor);
          if (Math.abs(distance) * zoom > (retained ? 10 : 6)) continue;
          if (!best || (retained && !best.retained) || (retained === best.retained && Math.abs(distance) < Math.abs(best.distance) - 1e-7)) {
            best = { distance, retained, guide: { axis, targetId: target.id, anchor, targetAnchor, value,
              start: Math.min(box[cross], target.position[cross]),
              end: Math.max(box[cross] + box[crossSize], target.position[cross] + target.measured[crossSize]!),
            } };
          }
        }
      }
    }
    delta[axis] = best?.distance ?? (settings.snapToGrid ? gridCoordinate(box[axis]) - box[axis] : 0);
    if (best) guides.push(best.guide);
  }
  return { nodes: moving.map((node) => ({ ...node, position: {
    x: node.position.x + delta.x, y: node.position.y + delta.y,
  } })), guides };
}
/** 以选区包围盒为基准，输入与输出节点也可参与手动对齐。 */
export function alignWorkflowNodes<T extends AlignmentNode>(nodes: T[], action: AlignmentAction): T[] {
  if (nodes.length < 2 || nodes.some((n) => !n.measured?.width || !n.measured?.height)) return nodes;
  const box = bounds(nodes);
  const axis = ["left", "centerX", "right"].includes(action) ? "x" : "y";
  const size = axis === "x" ? "width" : "height";
  const anchor = ["left", "top"].includes(action) ? 0 : ["right", "bottom"].includes(action) ? 1 : 0.5;
  return nodes.map((node) => ({ ...node, position: {
    ...node.position, [axis]: box[axis] + box[size] * anchor - node.measured![size]! * anchor,
  } }));
}
