import { chooseOption, openOptions } from "../../test-select";
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyWorkflow,
  newWorkflowNode,
  type WorkflowCatalog,
  type WorkflowNode,
} from "../../../shared/workflow-contracts";
import { ApiTaskProvider } from "../../api-task-provider";
import { ErrorToastProvider } from "../../error-toast-provider";
import { api, ApiClientError } from "../../api";
import {
  WorkflowCallEditor,
  WorkflowLoopEditor,
} from "./workflow-composition-editor";
import {
  duplicateWorkflow,
  copyWorkflowSelection,
  pasteWorkflowSelection,
} from "./workflow-copy";
import { withWorkflowNode } from "./workflow-graph";

const catalog: WorkflowCatalog = {
  models: [],
  agents: [],
  interfaces: [],
  workflows: [
    { id: "self", name: "当前流程", dependencies: [] },
    { id: "cycle", name: "间接环路", dependencies: ["self"] },
    { id: "target", name: "可调用流程", dependencies: [] },
  ],
};
afterEach(() => vi.restoreAllMocks());
/** 使用真实 API 任务与错误提供器覆盖参数选择和错误提示。 */
function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ErrorToastProvider>
      <ApiTaskProvider onAuthenticationRequired={() => {}}>
        {children}
      </ApiTaskProvider>
    </ErrorToastProvider>
  );
}
function Editor({
  initial,
  changed = () => {},
  edit = () => {},
}: {
  initial: WorkflowNode;
  changed?: (node: WorkflowNode) => void;
  edit?: () => void;
}) {
  const [node, setNode] = useState(initial);
  const props = {
    node,
    nodes: emptyWorkflow().nodes,
    onValidity: () => {},
    onChange: (next: WorkflowNode) => {
      setNode(next);
      changed(next);
    },
  };
  return (
    <Wrapper>
      {node.kind === "loop" ? (
        <WorkflowLoopEditor {...props} onEditLoop={edit} />
      ) : (
        <WorkflowCallEditor {...props} catalog={catalog} workflowId="self" />
      )}
    </Wrapper>
  );
}

describe("循环与工作流节点编辑", () => {
  it("已有的无效映射明确列出参数名，主动清理保留有效的固定值", () => {
    const initial = newWorkflowNode("loop", "loop"),
      changed = vi.fn();
    initial.config.loop!.body.nodes[0].outputs.push({
      name: "count",
      type: "integer",
    });
    initial.inputs = {
      index: { kind: "literal", value: 0 },
      removed: { kind: "literal", value: false },
      count: { kind: "literal", value: 0 },
    };
    render(<Editor initial={initial} changed={changed} />);
    expect(screen.getByText(/无效的循环入参映射或变量/)).toHaveTextContent("index、removed");
    fireEvent.click(screen.getByRole("button", { name: "清理无效映射" }));
    expect(changed.mock.lastCall?.[0].inputs).toEqual({
      count: { kind: "literal", value: 0 },
    });
    expect(
      screen.queryByRole("button", { name: "清理无效映射" }),
    ).not.toBeInTheDocument();
  });

  it("切换数组模式声明 item，进入循环体按钮可操作", () => {
    const changed = vi.fn(),
      edit = vi.fn();
    render(
      <Editor
        initial={newWorkflowNode("loop", "loop")}
        changed={changed}
        edit={edit}
      />,
    );
    chooseOption("循环模式", "array");
    expect(
      changed.mock.lastCall?.[0].config.loop.body.nodes[0].outputs,
    ).toContainEqual({ name: "item", type: "string", required: true });
    expect(screen.getByText("迭代数组")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /编辑循环体/ }));
    expect(edit).toHaveBeenCalledOnce();
    chooseOption("循环模式", "while");
    expect(screen.getByLabelText("while 运算符")).toBeInTheDocument();
    expect(
      changed.mock.lastCall?.[0].config.loop.body.nodes[0].outputs.some(
        (field: { name: string }) => field.name === "item",
      ),
    ).toBe(false);
  });
  it("输出切换最后一轮并配置默认值，其他设置变化保留默认值", () => {
    const changed = vi.fn();
    render(
      <Editor initial={newWorkflowNode("loop", "loop")} changed={changed} />,
    );
    chooseOption("result 汇总方式", "last");
    expect(changed.mock.lastCall?.[0].outputs[0].multiple).toBeUndefined();
    fireEvent.click(screen.getByLabelText("零次执行使用默认值"));
    fireEvent.change(screen.getByLabelText("result", { selector: "input" }), {
      target: { value: "9" },
    });
    fireEvent.change(screen.getByLabelText("最大迭代次数"), {
      target: { value: "10" },
    });
    expect(changed.mock.lastCall?.[0].outputs[0].defaultValue).toBe(9);
  });
  it("变量启用后分别配置初始值与更新来源", () => {
    const initial = newWorkflowNode("loop", "loop");
    initial.config.loop!.body.nodes[0].outputs.push({
      name: "score",
      type: "integer",
      defaultValue: 0,
    });
    const changed = vi.fn();
    render(<Editor initial={initial} changed={changed} />);
    fireEvent.click(screen.getByLabelText("score 作为循环变量"));
    chooseOption("score 更新来源", "result");
    expect(changed.mock.lastCall?.[0].config.loop.state.score).toEqual({
      initial: { kind: "literal", value: 0 },
      output: "result",
    });
    expect(changed.mock.lastCall?.[0].inputs.score).toBeUndefined();
  });
  it("直接及间接环路在目标选择中禁用，选择成功加载真实出参", async () => {
    const definition = {
      ...emptyWorkflow(),
      id: "target",
      revision: 3,
      createdAt: "",
      updatedAt: "",
    };
    vi.spyOn(api, "getWorkflow").mockResolvedValue(definition);
    const changed = vi.fn();
    render(
      <Editor
        initial={newWorkflowNode("workflow", "call")}
        changed={changed}
      />,
    );
    const targets = openOptions("目标工作流");
    expect(targets.getByRole("option", { name: /当前流程/ })).toBeDisabled();
    expect(targets.getByRole("option", { name: /间接环路/ })).toBeDisabled();
    fireEvent.click(targets.getAllByRole("option").find((option) => option.getAttribute("value") === "target")!);
    await screen.findByRole("button", { name: /同步最新参数 · v3/ });
    expect(changed.mock.lastCall?.[0].outputs).toEqual(
      definition.nodes[1].outputs,
    );
    expect(changed.mock.lastCall?.[0].config.workflowId).toBe("target");
  });
  it("目标读取失败显示具体错误并保留原节点", async () => {
    vi.spyOn(api, "getWorkflow").mockRejectedValue(
      new ApiClientError("NOT_FOUND", "目标工作流已删除", 404, "trace-call"),
    );
    const changed = vi.fn();
    render(
      <Editor
        initial={newWorkflowNode("workflow", "call")}
        changed={changed}
      />,
    );
    chooseOption("目标工作流", "target");
    await screen.findByText("目标工作流已删除");
    expect(changed).not.toHaveBeenCalled();
  });
  it("复制循环独立重映射内部节点与 while 引用，外部初始值仍指向外部副本", () => {
    const draft = emptyWorkflow(),
      loop = newWorkflowNode("loop", "loop");
    loop.config.loop!.count = {
      kind: "reference",
      nodeId: "input",
      field: "prompt",
    };
    draft.nodes.splice(1, 0, loop);
    const copied = duplicateWorkflow(draft, "副本");
    const next = copied.nodes[1].config.loop!;
    expect(next.count).toMatchObject({ nodeId: copied.nodes[0].id });
    expect(next.body.nodes[0].id).not.toBe("input");
    expect(next.condition.left).toMatchObject({
      nodeId: next.body.nodes[0].id,
    });
    expect(next.body.nodes[1].inputs.result).toMatchObject({
      nodeId: next.body.nodes[0].id,
    });
    const pasted = pasteWorkflowSelection(
      draft,
      copyWorkflowSelection(draft, ["loop"]),
      48,
    );
    const pastedLoop = pasted.nodes.at(-1)!;
    expect(pastedLoop.config.loop!.count).toMatchObject({ nodeId: "input" });
    expect(pastedLoop.config.loop!.body.nodes[0].id).not.toBe(
      next.body.nodes[0].id,
    );
  });
  it("循环外层依赖只收集显式外部映射，不将内部 input ID 错连外层", () => {
    const draft = emptyWorkflow(),
      source = newWorkflowNode("javascript", "source"),
      loop = newWorkflowNode("loop", "loop");
    draft.nodes.splice(1, 0, source, loop);
    loop.config.loop!.count = {
      kind: "reference",
      nodeId: "source",
      field: "result",
    };
    const next = withWorkflowNode(draft, loop);
    expect(
      next.edges.some(
        (edge) => edge.source === "source" && edge.target === "loop",
      ),
    ).toBe(true);
    expect(
      next.edges.some(
        (edge) => edge.source === "input" && edge.target === "loop",
      ),
    ).toBe(false);
  });
});
