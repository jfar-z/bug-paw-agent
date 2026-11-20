import { chooseOption } from "../../test-select";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  emptyWorkflow,
  newWorkflowNode,
  type WorkflowField,
} from "../../../shared/workflow-contracts";
import { validateWorkflow } from "../../../server/workflows/workflow-validation";
import { WorkflowFieldList } from "./workflow-fields";
import {
  workflowDraftFieldError,
  workflowLoopInputBindings,
} from "./workflow-field-guards";

/** 真实受控表单覆盖逐次输入、恢复和增删，不依赖保存时的服务端校验。 */
function Fields({
  initial,
  systemFields = [],
}: {
  initial: WorkflowField[];
  systemFields?: string[];
}) {
  const [fields, setFields] = useState(initial);
  return (
    <WorkflowFieldList
      fields={fields}
      onChange={setFields}
      defaults
      systemFields={systemFields}
      reserved={systemFields.length ? ["index", "item"] : []}
    />
  );
}

describe("参数保护与即时校验", () => {
  it("系统名称和删除入口隐藏，index 完全只读，item 可改元素类型", () => {
    render(
      <Fields
        initial={[
          { name: "custom", type: "string" },
          { name: "index", type: "integer", required: true },
          { name: "item", type: "string", required: true },
        ]}
        systemFields={["index", "item"]}
      />,
    );
    expect(screen.getByText("系统参数 · index")).toBeVisible();
    for (const name of ["index", "item"]) {
      expect(
        screen.queryByRole("button", { name: `删除参数 ${name}` }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: `上移参数 ${name}` }),
      ).not.toBeInTheDocument();
      expect(screen.queryByDisplayValue(name)).not.toBeInTheDocument();
    }
    expect(screen.queryByLabelText("index 类型")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("index 默认值")).not.toBeInTheDocument();
    chooseOption("item 类型", "integer");
    expect(screen.getByLabelText("item 类型")).toHaveAttribute("value", "integer");
    fireEvent.change(screen.getByLabelText("参数 3 名称"), {
      target: { value: "item" },
    });
    expect(screen.getByLabelText("参数 3 名称")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    fireEvent.change(screen.getByLabelText("参数 3 名称"), {
      target: { value: "fixed" },
    });
    expect(screen.getByLabelText("参数 3 名称")).toHaveAttribute(
      "aria-invalid",
      "false",
    );
    expect(screen.getByLabelText("item 类型")).toHaveAttribute("value", "integer");
  });

  it("重名双方立即标错，修正即恢复；新增参数避开已占用序号", () => {
    render(
      <Fields
        initial={[
          { name: "first", type: "string" },
          { name: "param_3", type: "string" },
        ]}
      />,
    );
    const first = screen.getByLabelText("参数 1 名称"),
      second = screen.getByLabelText("参数 2 名称");
    fireEvent.change(first, { target: { value: "param_3" } });
    expect(first).toHaveAttribute("aria-invalid", "true");
    expect(second).toHaveAttribute("aria-invalid", "true");
    expect(first).toHaveAccessibleDescription(/已存在/);
    fireEvent.change(first, { target: { value: "fixed" } });
    expect(first).toHaveAttribute("aria-invalid", "false");
    expect(second).toHaveAttribute("aria-invalid", "false");
    fireEvent.click(screen.getByRole("button", { name: "添加参数" }));
    expect(screen.getByLabelText("参数 3 名称")).toHaveValue("param_4");
  });

  it.each([
    "",
    "bad-name",
    "1name",
    "constructor",
    "prototype",
    "__proto__",
    "a".repeat(81),
  ])("非法名称 %s 在输入时显示关联说明", (name) => {
    render(<Fields initial={[{ name: "valid", type: "string" }]} />);
    const input = screen.getByLabelText("参数 1 名称");
    fireEvent.change(input, { target: { value: name } });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription();
  });

  it("次数循环的普通参数不能占用尚未声明的 item", () => {
    render(
      <Fields
        initial={[
          { name: "index", type: "integer" },
          { name: "custom", type: "string" },
        ]}
        systemFields={["index"]}
      />,
    );
    const input = screen.getByLabelText("参数 2 名称");
    fireEvent.change(input, { target: { value: "item" } });
    expect(input).toHaveAccessibleDescription(/循环系统参数/);
    fireEvent.change(input, { target: { value: "fixed" } });
    expect(input).toHaveAttribute("aria-invalid", "false");
  });

  it("删除声明后清理旧入参和状态，保留有效绑定及原草稿", () => {
    const node = newWorkflowNode("loop", "loop"),
      loop = node.config.loop!;
    loop.body.nodes[0].outputs.push(
      { name: "keep", type: "boolean" },
      { name: "renamed", type: "integer" },
    );
    node.inputs = {
      keep: { kind: "literal", value: false },
      removed: { kind: "literal", value: 0 },
      index: { kind: "literal", value: 0 },
    };
    loop.state = {
      deleted: { initial: { kind: "literal", value: 0 }, output: "result" },
      renamed: { initial: { kind: "literal", value: 0 }, output: "result" },
    };
    const original = structuredClone(node);
    const cleaned = workflowLoopInputBindings(node, loop.body);
    expect(cleaned.inputs).toEqual({ keep: { kind: "literal", value: false } });
    expect(cleaned.state).toEqual({ renamed: loop.state.renamed });
    loop.body.nodes[1].outputs = [];
    expect(workflowLoopInputBindings(node, loop.body).state).toEqual({});
    expect(node.inputs).toEqual(original.inputs);
  });

  it("整个草稿递归检查参数名，正确的系统声明允许保存", () => {
    const draft = emptyWorkflow(),
      outer = newWorkflowNode("loop", "outer"),
      inner = newWorkflowNode("loop", "inner");
    draft.nodes.push(outer);
    outer.config.loop!.body.nodes.push(inner);
    expect(workflowDraftFieldError(draft)).toBe("");
    inner.config.loop!.body.nodes[0].outputs.push({
      name: "index",
      type: "string",
    });
    expect(workflowDraftFieldError(draft)).toContain("index");
    inner.config.loop!.body.nodes[0].outputs.pop();
    expect(workflowDraftFieldError(draft)).toBe("");
  });

  it.each(["index", "item", "deleted"])("后端准确指出无效映射 %s", (name) => {
    const draft = emptyWorkflow(),
      loop = newWorkflowNode("loop", "loop");
    loop.inputs = { [name]: { kind: "literal", value: 0 } };
    draft.nodes.push(loop);
    const error = vi.fn(() => validateWorkflow(draft));
    expect(error).toThrow(
      name === "deleted"
        ? "deleted 未在循环体输入中声明"
        : `${name} 由循环自动提供`,
    );
  });
});
