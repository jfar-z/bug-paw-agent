import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseRoute, routePath } from "../../router";
import { WorkbenchShell } from "../../layouts/workbench-shell";
import { WorkflowValue, WorkflowJson } from "./workflow-fields";
import {
  withWorkflowNode,
  syncCanvasNodes,
  appendWorkflowNode,
} from "./workflow-canvas";
import { applyNodeChanges } from "@xyflow/react";
import {
  emptyWorkflow,
  workflowRunNodesInOrder,
  type WorkflowRun,
  newWorkflowNode,
} from "../../../shared/workflow-contracts";
/** 导航与参数类型都是用户能观察到的契约，图形库实现本身不复制测试。 */
describe("工作流浏览器契约", () => {
  it("独立路由可恢复编辑和运行任务，保留 ComfyUI 旧路由", () => {
    const routes = [
      { page: "workflows" },
      { page: "workflow-editor", workflowId: "abc" },
      { page: "workflow-run", workflowId: "abc", runId: "run" },
      { page: "workflow-history" },
      { page: "workflow-templates" },
      { page: "workflow-run", workflowId: "abc", templateId: "草稿" },
      { page: "aigc-templates" },
      { page: "aigc-run", templateId: "草稿" },
    ] as const;
    for (const route of routes) {
      const url = new URL(routePath(route), "http://localhost");
      expect(parseRoute(url.pathname, url.search)).toEqual(route);
    }
    expect(parseRoute("/aigc/workflows")).toEqual({ page: "aigc-workflows" });
  });
  it("一级和二级菜单复用导航样式，移动端可以打开工作流导航", () => {
    const go = vi.fn();
    render(
      <WorkbenchShell
        route={{ page: "workflow-run" }}
        theme="light"
        onThemeChange={() => {}}
        onNavigate={go}
        onLogout={() => {}}
      >
        <div>页面内容</div>
      </WorkbenchShell>,
    );
    expect(screen.getByRole("button", { name: "工作流" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "运行工作流" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    fireEvent.click(screen.getByRole("button", { name: "运行模板" }));
    expect(go).toHaveBeenCalledWith({ page: "workflow-templates" });
    fireEvent.click(screen.getByRole("button", { name: "运行记录" }));
    expect(go).toHaveBeenCalledWith({ page: "workflow-history" });
    fireEvent.click(screen.getByRole("button", { name: "打开工作流导航" }));
    expect(
      screen.getAllByRole("button", { name: "关闭工作流导航" })[0],
    ).toHaveAttribute("aria-expanded", "true");
  });
  it("引用自动连线且阻止环路，不旁路覆盖已有分支", () => {
    const d = emptyWorkflow(),
      n = newWorkflowNode("javascript", "js");
    d.nodes.push(n);
    n.inputs.value = { kind: "reference", nodeId: "input", field: "prompt" };
    const next = withWorkflowNode(d, n);
    expect(
      next.edges.some((e) => e.source === "input" && e.target === "js"),
    ).toBe(true);
    const input = {
      ...next.nodes[0],
      inputs: {
        value: { kind: "reference" as const, nodeId: "js", field: "result" },
      },
    };
    expect(() => withWorkflowNode(next, input)).toThrow("循环");
  });
  it("数值保持 0、布尔保持 false，非法 JSON 不能确认", () => {
    const change = vi.fn(),
      valid = vi.fn();
    const { rerender } = render(
      <WorkflowValue
        field={{ name: "number", type: "integer" }}
        value={1}
        onChange={change}
      />,
    );
    fireEvent.change(screen.getByRole("spinbutton"), {
      target: { value: "0" },
    });
    expect(change).toHaveBeenLastCalledWith(0);
    rerender(
      <WorkflowValue
        field={{ name: "enabled", type: "boolean" }}
        value={true}
        onChange={change}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(change).toHaveBeenLastCalledWith(false);
    rerender(<WorkflowJson value={{}} onChange={change} onValidity={valid} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "{" } });
    expect(valid).toHaveBeenLastCalledWith(false);
    expect(screen.getByText("请输入有效 JSON。")).toBeVisible();
  });
});

/** 回归拖动丢失尺寸导致闪烁，以及拖线创建时的落点和分支语义。 */
describe("工作流画布状态", () => {
  it("拖动仅更新对应节点，并保留尺寸、选择和其他节点对象", () => {
    const draft = emptyWorkflow();
    const original = syncCanvasNodes([], draft.nodes);
    const measured = applyNodeChanges(
      [
        {
          id: "input",
          type: "dimensions",
          dimensions: { width: 220, height: 130 },
        },
        { id: "input", type: "select", selected: true },
        {
          id: "input",
          type: "position",
          position: { x: 400, y: 200 },
          dragging: true,
        },
      ],
      original,
    );
    const changed = draft.nodes.map((node) =>
      node.id === "input" ? { ...node, position: { x: 400, y: 200 } } : node,
    );
    const next = syncCanvasNodes(measured, changed);
    expect(next[0]).toMatchObject({
      measured: { width: 220, height: 130 },
      selected: true,
      dragging: true,
      position: { x: 400, y: 200 },
    });
    expect(next[1]).toBe(measured[1]);
    expect(syncCanvasNodes(next, changed)[0]).toBe(next[0]);
    expect(next.every((node) => !node.deletable)).toBe(true);
  });
  it.each(["true", "false"])(
    "从判断节点 %s 端口创建节点保留分支和原始松手坐标",
    (branch) => {
      const draft = emptyWorkflow();
      draft.nodes.push(newWorkflowNode("condition", "condition"));
      const position = { x: 723.5, y: -18.25 };
      const next = appendWorkflowNode(draft, "javascript", position, {
        nodeId: "condition",
        type: "source",
        handleId: branch,
        position,
      });
      const added = next.nodes.at(-1)!;
      expect(added.position).toEqual(position);
      expect(next.edges.at(-1)).toMatchObject({
        source: "condition",
        target: added.id,
        branch,
      });
      expect(syncCanvasNodes([], [added])[0].deletable).toBe(true);
      expect(draft.nodes).toHaveLength(3);
    },
  );
  it("从输入端口反向拖线创建上游节点，普通添加不自动连线", () => {
    const draft = emptyWorkflow();
    const position = { x: 80, y: 40 };
    const next = appendWorkflowNode(draft, "agent", position, {
      nodeId: "output",
      type: "target",
      position,
    });
    expect(next.edges.at(-1)).toMatchObject({
      source: next.nodes.at(-1)!.id,
      target: "output",
    });
    expect(appendWorkflowNode(draft, "llm", position).edges).toEqual(
      draft.edges,
    );
  });
});

/** 展示使用运行快照的拓扑关系，保持并行节点顺序并兼容旧运行数组。 */
describe("工作流运行节点排序", () => {
  it("串行流程按依赖排序，创建较早的输出节点移到最后且不修改原数组", () => {
    const draft = emptyWorkflow();
    const script = newWorkflowNode("javascript", "script");
    draft.nodes.push(script);
    draft.edges = [
      { id: "a", source: "input", target: "script" },
      { id: "b", source: "script", target: "output" },
    ];
    const run = {
      definition: draft,
      nodes: draft.nodes.map((n) => ({
        nodeId: n.id,
        status: "succeeded",
        events: [],
      })),
    } as unknown as WorkflowRun;
    const original = [...run.nodes];
    expect(workflowRunNodesInOrder(run).map((n) => n.nodeId)).toEqual([
      "input",
      "script",
      "output",
    ]);
    expect(run.nodes).toEqual(original);
  });
  it("分支先于汇合，同层按定义顺序，跳过与失败状态不改变展示位置", () => {
    const nodes = [
      newWorkflowNode("output", "output"),
      newWorkflowNode("javascript", "right"),
      newWorkflowNode("input", "input"),
      newWorkflowNode("select", "join"),
      newWorkflowNode("javascript", "left"),
      newWorkflowNode("condition", "condition"),
    ];
    const edges = [
      { id: "1", source: "input", target: "condition" },
      { id: "2", source: "condition", target: "left", branch: "true" },
      { id: "3", source: "condition", target: "right", branch: "false" },
      { id: "4", source: "left", target: "join" },
      { id: "5", source: "right", target: "join" },
      { id: "6", source: "join", target: "output" },
    ];
    const run = {
      definition: { nodes, edges },
      nodes: [...nodes]
        .reverse()
        .map((n) => ({ nodeId: n.id, status: "queued", events: [] })),
    } as unknown as WorkflowRun;
    const expected = ["input", "condition", "right", "left", "join", "output"];
    expect(workflowRunNodesInOrder(run).map((n) => n.nodeId)).toEqual(expected);
    run.nodes.find((n) => n.nodeId === "right")!.status = "skipped";
    run.nodes.find((n) => n.nodeId === "left")!.status = "failed";
    expect(workflowRunNodesInOrder(run).map((n) => n.nodeId)).toEqual(expected);
  });
});
