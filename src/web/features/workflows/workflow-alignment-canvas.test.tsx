import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactFlowProps } from "@xyflow/react";
import { WorkflowCanvas, type CanvasNode } from "./workflow-canvas";
import { WorkflowConfirmProvider } from "./workflow-confirm";
import { ApiTaskProvider } from "../../api-task-provider";
import { ErrorToastProvider } from "../../error-toast-provider";
import { emptyWorkflow, newWorkflowNode, type WorkflowDraft } from "../../../shared/workflow-contracts";

// JSDOM 没有布局观察器；尺寸由图库事件桩显式提交。
beforeEach(() => vi.stubGlobal("ResizeObserver", class {
  observe() {}
  disconnect() {}
}));
afterEach(() => vi.unstubAllGlobals());
let flowProps: ReactFlowProps<CanvasNode>;
let current: WorkflowDraft;
vi.mock("@xyflow/react", async (original) => ({
  ...await original<object>(),
  ReactFlow: (props: ReactFlowProps<CanvasNode>) => { flowProps = props; return <div>{props.children}</div>; },
  Background: () => null,
  Controls: () => null,
  ViewportPortal: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("./workflow-node-editor", () => ({
  WorkflowNodeEditor: ({ onEditLoop }: { onEditLoop: () => void }) => <button onClick={onEditLoop}>进入循环体测试</button>,
}));

/** 仅替换图库事件源，真实草稿、作用域传递、开关和位置提交链路参与测试。 */
function Harness({ initial }: { initial: WorkflowDraft }) {
  const [draft, setDraft] = useState(initial);
  current = draft;
  return <ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={() => {}}><WorkflowConfirmProvider>
    <WorkflowCanvas draft={draft} onChange={setDraft} onValidity={() => {}}
      catalog={{ models: [], agents: [], interfaces: [] }} />
  </WorkflowConfirmProvider></ApiTaskProvider></ErrorToastProvider>;
}

describe("画布吸附事件与工作流作用域", () => {
  it("拖动与松手共享对齐位置，Alt 解除吸附且输入输出支持手动对齐", () => {
    const draft = emptyWorkflow();
    draft.nodes[1].position = { x: 101, y: 400 };
    render(<Harness initial={draft} />);
    act(() => flowProps.onNodesChange!([
      { type: "dimensions", id: "input", dimensions: { width: 100, height: 60 } },
      { type: "dimensions", id: "output", dimensions: { width: 100, height: 90 } },
    ]));
    act(() => flowProps.onNodesChange!([{ type: "position", id: "input", position: { x: 98, y: 13 }, dragging: true }]));
    expect(current.nodes[0].position).toEqual({ x: 101, y: 24 });
    act(() => flowProps.onNodesChange!([{ type: "position", id: "input", position: { x: 98, y: 13 }, dragging: false }]));
    expect(current.nodes[0].position).toEqual({ x: 101, y: 24 });
    fireEvent.keyDown(window, { key: "Alt", altKey: true });
    act(() => flowProps.onNodesChange!([{ type: "position", id: "input", position: { x: 99, y: 17 }, dragging: true }]));
    expect(current.nodes[0].position).toEqual({ x: 99, y: 17 });
    act(() => flowProps.onNodesChange!([{ type: "position", id: "input", position: { x: 99, y: 17 }, dragging: false }]));
    fireEvent.keyUp(window, { key: "Alt", altKey: false });
    act(() => flowProps.onNodesChange!([
      { type: "select", id: "input", selected: true }, { type: "select", id: "output", selected: true },
    ]));
    fireEvent.change(screen.getByLabelText("对齐所选节点"), { target: { value: "bottom" } });
    expect(current.nodes[0].position.y + 60).toBe(current.nodes[1].position.y + 90);
    expect(current.nodes[0].position.x).toBe(99);
  });
  it("循环体读取和修改根工作流设置，新增落点使用根设置且不移动原节点", () => {
    const draft = emptyWorkflow();
    const loop = newWorkflowNode("loop", "loop");
    draft.nodes.push(loop);
    draft.editorSettings = { snapToGrid: false, snapToNodes: false };
    render(<Harness initial={draft} />);
    act(() => flowProps.onNodeClick!({} as React.MouseEvent, flowProps.nodes!.find((n) => n.id === "loop")!));
    fireEvent.click(screen.getByText("进入循环体测试"));
    const before = structuredClone(current.nodes);
    expect(screen.getAllByRole("switch", { name: "网格吸附" })[0]).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getAllByRole("switch", { name: "网格吸附" })[0]);
    expect(current.editorSettings?.snapToGrid).toBe(true);
    expect(current.nodes).toEqual(before);
    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "JS 脚本" }));
    const body = current.nodes.find((n) => n.id === "loop")!.config.loop!.body;
    expect(body.nodes.at(-1)!.position).toEqual({ x: 72, y: 144 });
    expect(current.nodes).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "新工作流" }));
    expect(screen.getAllByRole("switch", { name: "网格吸附" })[0]).toHaveAttribute("aria-checked", "true");
  });
});
