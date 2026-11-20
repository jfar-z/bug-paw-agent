import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  emptyWorkflow,
  newWorkflowNode,
  type WorkflowField,
  type WorkflowNode,
} from "../../../shared/workflow-contracts";
import { validateWorkflow } from "../../../server/workflows/workflow-validation";
import { ApiTaskProvider } from "../../api-task-provider";
import { ErrorToastProvider } from "../../error-toast-provider";
import { WorkflowInputTools } from "./workflow-input-tools";
import { appendWorkflowInputFields, importOuterWorkflowInputs } from "./workflow-input-parameters";

/** 同时覆盖原始 JSON 默认值、媒体数组及枚举来源，防止跨作用域时类型或引用丢失。 */
function fields(): WorkflowField[] {
  return [
    { name: "count", type: "integer", defaultValue: 0, required: true, description: "次数" },
    { name: "enabled", type: "boolean", defaultValue: false },
    { name: "text", type: "string", defaultValue: "" },
    { name: "images", type: "image", multiple: true, defaultValue: [] },
    { name: "options", type: "object", defaultValue: { value: { kind: "reference", nodeId: "literal", field: "kept" } } },
    { name: "quality", type: "string", enumValues: ["low", "high"], defaultValue: "low", enumSource: { nodeId: "external", field: "quality", interfaceId: "api" } },
  ];
}

describe("输入参数复用与作用域映射", () => {
  it("按选择顺序追加并深拷贝完整定义，跨作用域保留枚举选项和原始默认值", () => {
    const draft = emptyWorkflow(), source = fields();
    const original = structuredClone(draft);
    const next = appendWorkflowInputFields(draft, source, source.map((f) => f.name));
    expect(draft).toEqual(original);
    const appended = next.nodes[0].outputs.slice(1);
    expect(appended.slice(0, 5)).toEqual(source.slice(0, 5));
    expect(appended[5]).toEqual({ ...source[5], enumSource: undefined });
    expect(appended[3].defaultValue).not.toBe(source[3].defaultValue);
    expect(appended[4].defaultValue).not.toBe(source[4].defaultValue);
    expect(source[5].enumSource?.nodeId).toBe("external");
    expect(() => validateWorkflow(next)).not.toThrow();
    const same = appendWorkflowInputFields(draft, source, ["quality"], [], true);
    expect(same.nodes[0].outputs.at(-1)?.enumSource).toEqual(source[5].enumSource);
  });

  it("同名、重复选择、内置参数和容量冲突整体拒绝，原图不变", () => {
    const draft = emptyWorkflow(), original = structuredClone(draft);
    expect(() => appendWorkflowInputFields(draft, fields(), ["count", "prompt"])).toThrow("prompt 已存在");
    expect(() => appendWorkflowInputFields(draft, fields(), ["count", "count"])).toThrow("count 已存在");
    expect(() => appendWorkflowInputFields(draft, [{ name: "index", type: "integer" }], ["index"], ["index", "item"])).toThrow("循环内置");
    expect(() => appendWorkflowInputFields(draft, fields(), ["deleted"])).toThrow("已删除或重名");
    expect(draft).toEqual(original);
    draft.nodes[0].outputs = Array.from({ length: 100 }, (_, i) => ({ name: `field_${i}`, type: "string" }));
    expect(() => appendWorkflowInputFields(draft, fields(), ["count"])).toThrow("100 项");
    expect(draft.nodes[0].outputs).toHaveLength(100);
  });

  it.each(["__proto__", "constructor", "prototype", "bad-name", "a".repeat(81)])("非法参数名 %s 不能写入绑定对象", (name) => {
    expect(() => appendWorkflowInputFields(emptyWorkflow(), [{ name, type: "string" }], [name])).toThrow("名称不合法");
  });

  it("导入同时创建循环内部字段、外部映射和控制边，可通过运行前结构校验", () => {
    const draft = emptyWorkflow(), loop = newWorkflowNode("loop", "loop");
    draft.nodes.push(loop);
    draft.edges.push({ id: "loop-output", source: "loop", target: "output" });
    const original = structuredClone(draft);
    const next = importOuterWorkflowInputs(draft, ["loop"], ["prompt"]);
    const imported = next.nodes.at(-1)!;
    expect(imported.inputs.prompt).toEqual({ kind: "reference", nodeId: "input", field: "prompt" });
    expect(imported.config.loop!.body.nodes[0].outputs).toContainEqual(draft.nodes[0].outputs[0]);
    expect(next.edges.filter((e) => e.source === "input" && e.target === "loop")).toHaveLength(1);
    expect(() => validateWorkflow(next, true)).not.toThrow();
    expect(draft).toEqual(original);
    expect(() => importOuterWorkflowInputs(next, ["loop"], ["prompt"])).toThrow("不能覆盖");
    expect(next.nodes.at(-1)!.config.loop!.body.nodes[0].outputs).toHaveLength(2);
  });

  it("嵌套导入只引用直接外层输入，并保留现有分支路径而不添加旁路", () => {
    const draft = emptyWorkflow(), outer = newWorkflowNode("loop", "outer"), inner = newWorkflowNode("loop", "inner");
    draft.nodes.push(outer);
    outer.config.loop!.body.nodes[0].id = "parent_input";
    outer.config.loop!.body.nodes[0].outputs.push({ name: "local", type: "string" });
    outer.config.loop!.body.nodes.push(inner);
    const branch = newWorkflowNode("condition", "branch");
    outer.config.loop!.body.nodes.push(branch);
    outer.config.loop!.body.edges = [
      { id: "upstream", source: "parent_input", target: "branch" },
      { id: "true", source: "branch", target: "inner", branch: "true" },
    ];
    const next = importOuterWorkflowInputs(draft, ["outer", "inner"], ["local"]);
    const body = next.nodes.at(-1)!.config.loop!.body;
    expect(body.nodes.find((n) => n.id === "inner")!.inputs.local).toEqual({ kind: "reference", nodeId: "parent_input", field: "local" });
    expect(body.edges).toEqual(outer.config.loop!.body.edges);
    expect(next.nodes.at(-1)!.inputs).toEqual({});
  });

  it("路径失效或控制边超限时不应用任何部分改动", () => {
    const draft = emptyWorkflow(), loop = newWorkflowNode("loop", "loop");
    draft.nodes.push(loop);
    draft.edges = Array.from({ length: 400 }, (_, i) => ({ id: `edge_${i}`, source: "input", target: "output" }));
    const before = structuredClone(draft);
    expect(() => importOuterWorkflowInputs(draft, ["missing"], ["prompt"])).toThrow("循环路径已变更");
    expect(() => importOuterWorkflowInputs(draft, ["loop"], ["prompt"])).toThrow("400 条");
    expect(draft).toEqual(before);
  });

  it("内部字段删除后遗留的绑定和变量设置也不被重新导入覆盖", () => {
    const draft = emptyWorkflow(), loop = newWorkflowNode("loop", "loop");
    draft.nodes.push(loop);
    loop.inputs.prompt = { kind: "literal", value: "原有绑定" };
    expect(() => importOuterWorkflowInputs(draft, ["loop"], ["prompt"])).toThrow("已有绑定或变量设置");
    expect(loop.inputs.prompt).toEqual({ kind: "literal", value: "原有绑定" });
    delete loop.inputs.prompt;
    loop.config.loop!.state.prompt = { initial: { kind: "literal", value: "原有变量" }, output: "result" };
    expect(() => importOuterWorkflowInputs(draft, ["loop"], ["prompt"])).toThrow("已有绑定或变量设置");
    expect(loop.config.loop!.body.nodes[0].outputs).toHaveLength(1);
  });
});

/** 使用真实错误弹窗和参数追加逻辑验证选择、取消、失败后重试及焦点返回。 */
function Tools({
  initial = newWorkflowNode("input", "input"),
  outer,
  paste = () => {},
  imported = () => {},
}: {
  initial?: WorkflowNode;
  outer?: WorkflowNode;
  paste?: (names: string[]) => void;
  imported?: (names: string[]) => void;
}) {
  const [node, setNode] = useState(initial);
  const [clipboard, setClipboard] = useState<WorkflowField[]>();
  return (
    <ErrorToastProvider>
      <ApiTaskProvider onAuthenticationRequired={() => {}}>
        <WorkflowInputTools
          node={node}
          clipboard={clipboard}
          reserved={outer ? ["index", "item"] : []}
          outerInput={outer}
          onCopy={(value) => setClipboard(structuredClone(value))}
          onPaste={(names) => {
            paste(names);
            setNode(appendWorkflowInputFields({ ...emptyWorkflow(), nodes: [node] }, clipboard!, names).nodes[0]);
          }}
          onImport={outer ? (names) => imported(names) : undefined}
        />
        <button onClick={() => setNode({ ...node, outputs: [] })}>清空目标参数</button>
      </ApiTaskProvider>
    </ErrorToastProvider>
  );
}

describe("输入参数复用交互", () => {
  it("剪贴板初始不可粘贴，复制后禁止覆盖同名参数，清空目标后可选择性粘贴", async () => {
    const input = newWorkflowNode("input", "input");
    input.outputs = fields();
    const paste = vi.fn();
    render(<Tools initial={input} paste={paste} />);
    expect(screen.getByRole("button", { name: "粘贴参数" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "复制参数" }));
    fireEvent.click(screen.getByRole("button", { name: "粘贴参数" }));
    expect(screen.getByLabelText("选择参数 count")).toBeDisabled();
    expect(screen.getByRole("button", { name: /追加参数/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "清空目标参数" }));
    fireEvent.click(screen.getByRole("button", { name: "粘贴参数" }));
    fireEvent.click(screen.getByLabelText("选择参数 enabled"));
    fireEvent.click(screen.getByRole("button", { name: /追加参数/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(paste).toHaveBeenCalledWith(["count", "text", "images", "options", "quality"]);
    expect(screen.getByRole("status")).toHaveTextContent("已粘贴 5 项参数");
  });

  it("从外层导入可取消，禁用同名和内置字段，提交仅含勾选参数且焦点返回", async () => {
    const outer = newWorkflowNode("input", "outer");
    outer.outputs = [{ name: "index", type: "integer" }, { name: "item", type: "string" }, ...fields()];
    const initial = newWorkflowNode("input", "inner");
    initial.outputs = [{ name: "count", type: "integer" }];
    const imported = vi.fn();
    render(<Tools initial={initial} outer={outer} imported={imported} />);
    const trigger = screen.getByRole("button", { name: "从外层输入导入" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    for (const name of ["index", "item", "count"])
      expect(within(dialog).getByLabelText(`选择参数 ${name}`)).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(imported).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByLabelText("选择参数 images"));
    fireEvent.click(screen.getByRole("button", { name: /导入并映射 ·/ }));
    // 焦点还原在弹层卸载阶段完成，等待提交与关闭都完成。
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });
    expect(imported).toHaveBeenCalledExactlyOnceWith(["enabled", "text", "options", "quality"]);
  });

  it("导入失败保留选择并通过全局弹窗展示明确原因，重试成功后才关闭", async () => {
    const outer = newWorkflowNode("input", "outer");
    const imported = vi.fn().mockImplementationOnce(() => { throw new Error("导入后输入参数超过 100 项，请减少选择数量。"); });
    render(<Tools initial={{ ...outer, id: "inner", outputs: [] }} outer={outer} imported={imported} />);
    fireEvent.click(screen.getByRole("button", { name: "从外层输入导入" }));
    fireEvent.click(screen.getByRole("button", { name: /导入并映射 ·/ }));
    await screen.findAllByText(/导入后输入参数超过 100 项/);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("选择参数 prompt")).toBeChecked();
    await waitFor(() => expect(screen.getByRole("button", { name: /导入并映射 ·/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /导入并映射 ·/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(imported).toHaveBeenCalledTimes(2);
  });
});
