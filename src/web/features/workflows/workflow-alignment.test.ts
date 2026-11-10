import { describe, expect, it } from "vitest";
import { emptyWorkflow, workflowEditorSettings } from "../../../shared/workflow-contracts";
import { duplicateWorkflow } from "./workflow-copy";
import { alignWorkflowNodes, gridPlacement, snapWorkflowNodes, type AlignmentAction } from "./workflow-alignment";

/** 用不同尺寸和非网格坐标覆盖真实画布的几何边界。 */
const node = (id: string, x: number, y: number, width = 100, height = 60) => ({
  id, position: { x, y }, measured: { width, height },
});
const grid = { snapToGrid: true, snapToNodes: false };
const both = { snapToGrid: true, snapToNodes: true };

describe("工作流网格与节点对齐", () => {
  it("新工作流开启，旧工作流关闭，整份复制独立继承设置", () => {
    const draft = emptyWorkflow();
    expect(workflowEditorSettings(draft)).toEqual(both);
    delete draft.editorSettings;
    const before = JSON.stringify(draft);
    expect(workflowEditorSettings(draft)).toEqual({ snapToGrid: false, snapToNodes: false });
    expect(JSON.stringify(draft)).toBe(before);
    draft.editorSettings = { ...grid };
    const copy = duplicateWorkflow(draft, "副本");
    copy.editorSettings!.snapToGrid = false;
    expect(draft.editorSettings).toEqual(grid);
  });
  it("负坐标及半格按一致规则落点，整组只平移，不改变节点间距", () => {
    const nodes = [node("a", -12, 13), node("b", 29, 87)];
    const placed = gridPlacement(nodes, true);
    expect(placed.map((n) => n.position)).toEqual([{ x: -24, y: 24 }, { x: 17, y: 98 }]);
    expect(nodes[0].position).toEqual({ x: -12, y: 13 });
    expect(gridPlacement(nodes, false)).toBe(nodes);
  });
  it.each([0.2, 1, 1.5])("缩放 %s 下节点阈值保持屏幕像素，命中轴优先对齐其他轴落网格", (zoom) => {
    const target = node("target", 101, 300);
    const moving = node("moving", 101 - 5 / zoom, 13);
    const result = snapWorkflowNodes([moving], [target], both, zoom);
    expect(result.nodes[0].position).toEqual({ x: 101, y: 24 });
    expect(result.guides[0]).toMatchObject({ axis: "x", value: 101 });
  });
  it("已命中辅助线在 10 像素内保持，超过后释放且不被更近的新线抢夺", () => {
    const target = node("target", 101, 300);
    const first = snapWorkflowNodes([node("moving", 97, 0)], [target], both, 1);
    const held = snapWorkflowNodes([node("moving", 109, 0)], [target, node("other", 110, 400)], both, 1, first.guides);
    expect(held.nodes[0].position.x).toBe(101);
    const released = snapWorkflowNodes([node("moving", 112, 0)], [target], both, 1, first.guides);
    expect(released.nodes[0].position.x).toBe(120);
    expect(released.guides).toEqual([]);
  });
  it("多选排除自身并使用统一位移，Alt 跳过两种吸附", () => {
    const nodes = [node("a", 98, 13), node("b", 131, 88)];
    const result = snapWorkflowNodes(nodes, [...nodes, node("target", 101, 400)], both, 1);
    expect(result.nodes.map((n) => n.position)).toEqual([{ x: 101, y: 24 }, { x: 134, y: 99 }]);
    expect(snapWorkflowNodes(nodes, nodes, grid, 1).guides).toEqual([]);
    expect(snapWorkflowNodes(nodes, [], both, 1, result.guides, true)).toEqual({ nodes, guides: [] });
  });
  it("尺寸未测量时只做网格放置，不猜测边缘；单节点手动对齐不改变位置", () => {
    const item = { id: "a", position: { x: 98, y: 13 } };
    expect(snapWorkflowNodes([item], [node("target", 101, 400)], both, 1).guides).toEqual([]);
    expect(alignWorkflowNodes([item, node("target", 101, 400)], "right")[0]).toBe(item);
    expect(alignWorkflowNodes([node("only", 13, 25)], "left")[0].position.x).toBe(13);
  });
  it.each([
    ["left", "x", [13, 13]], ["centerX", "x", [63, 38]], ["right", "x", [113, 63]],
    ["top", "y", [25, 25]], ["centerY", "y", [105, 75]], ["bottom", "y", [185, 125]],
  ] as [AlignmentAction, "x" | "y", number[]][])("%s 使用实际尺寸与选区边界", (action, axis, expected) => {
    const items = [node("input", 13, 25), node("output", 63, 125, 150, 120)];
    const aligned = alignWorkflowNodes(items, action);
    expect(aligned.map((n) => n.position[axis])).toEqual(expected);
    const other = axis === "x" ? "y" : "x";
    expect(aligned.map((n) => n.position[other])).toEqual(items.map((n) => n.position[other]));
  });
});
