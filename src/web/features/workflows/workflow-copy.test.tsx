import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyWorkflow,
  newWorkflowNode,
  type WorkflowDefinition,
  type WorkflowSummary,
} from "../../../shared/workflow-contracts";
import {
  copyWorkflowSelection,
  duplicateWorkflow,
  pasteWorkflowSelection,
} from "./workflow-copy";
import { workflowHasPath } from "./workflow-graph";
import { WorkflowsPage } from "../../pages/workflows-page";
import { ApiTaskProvider } from "../../api-task-provider";
import { ErrorToastProvider } from "../../error-toast-provider";
import { api, ApiClientError } from "../../api";
import { navigateTo } from "../../router";

vi.mock("./workflow-canvas", () => ({ WorkflowCanvas: () => null }));
vi.mock("../../router", async (original) => ({
  ...(await original<object>()),
  navigateTo: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

/** 构造覆盖分支、媒体数组、选择条件和枚举来源的独立定义。 */
function definition(): WorkflowDefinition {
  const draft = emptyWorkflow();
  const source = newWorkflowNode("aigc", "source", { x: 100, y: 200 });
  const branch = newWorkflowNode("condition", "branch", { x: 400, y: 200 });
  const target = newWorkflowNode("select", "target", { x: 700, y: 200 });
  const ref = () => ({
    kind: "reference" as const,
    nodeId: "source",
    field: "files",
  });
  branch.config.conditions = [
    {
      left: ref(),
      operator: "not_empty",
      right: { kind: "literal", value: false },
    },
  ];
  target.inputs.value = ref();
  target.config.referenceGroups = { images: { mode: "array", binding: ref() } };
  target.config.candidates = [ref(), { kind: "literal", value: 0 }];
  target.config.selectCondition = {
    left: ref(),
    operator: "eq",
    right: { kind: "literal", value: false },
  };
  target.outputs[0].enumSource = {
    nodeId: "source",
    field: "quality",
    interfaceId: "test",
  };
  target.outputs[0].enumValues = ["0", "false"];
  // 形似引用的用户 JSON 不属于绑定，不得被递归改写或产生控制边。
  target.inputs.json = { kind: "literal", value: { nested: ref() } };
  target.config.customParameters = { nested: ref() };
  draft.nodes.push(source, branch, target);
  draft.edges = [
    { id: "e1", source: "input", target: "source" },
    { id: "e2", source: "source", target: "branch" },
    { id: "e3", source: "branch", target: "target", branch: "false" },
    { id: "e4", source: "target", target: "output" },
  ];
  return {
    ...draft,
    id: "original",
    name: "原工作流",
    description: "完整说明",
    published: true,
    revision: 9,
    createdAt: "old",
    updatedAt: "old",
  };
}

describe("工作流复制数据契约", () => {
  it("复制子工作流枚举只重映射当前画布节点标识，保留真实目标工作流 ID", () => {
    const draft = emptyWorkflow(), call = newWorkflowNode("workflow", "call");
    call.config.workflowId = "target";
    draft.nodes.push(call);
    draft.nodes[0].outputs[0].enumValues = ["16:9", "9:16"];
    draft.nodes[0].outputs[0].enumSource = { nodeId: "call", field: "ratio", workflowId: "target" };
    const copied = duplicateWorkflow(draft, "副本");
    expect(copied.nodes[0].outputs[0].enumSource).toEqual({ nodeId: copied.nodes[2].id, field: "ratio", workflowId: "target" });
    expect(copied.nodes[2].config.workflowId).toBe("target");
    expect(draft.nodes[0].outputs[0].enumSource?.nodeId).toBe("call");
  });
  it("整份复制重建全部标识并保留配置，剔除版本和时间等元数据", () => {
    const original = definition();
    const before = structuredClone(original);
    const copy = duplicateWorkflow(original, " 新工作流 ");
    expect(Object.keys(copy).sort()).toEqual([
      "description",
      "edges",
      "editorSettings",
      "name",
      "nodes",
      "published",
    ]);
    expect(copy).toMatchObject({
      name: "新工作流",
      description: original.description,
      published: true,
      editorSettings: original.editorSettings,
    });
    expect(copy.nodes).toHaveLength(original.nodes.length);
    expect(copy.edges).toHaveLength(original.edges.length);
    const source = copy.nodes.find((node) => node.kind === "aigc")!;
    const target = copy.nodes.find((node) => node.kind === "select")!;
    expect(target.inputs.value).toMatchObject({ nodeId: source.id });
    expect(target.config.referenceGroups?.images.binding).toMatchObject({
      nodeId: source.id,
    });
    expect(target.config.candidates?.[0]).toMatchObject({ nodeId: source.id });
    expect(target.config.candidates?.[1]).toEqual({
      kind: "literal",
      value: 0,
    });
    expect(target.config.selectCondition?.left).toMatchObject({
      nodeId: source.id,
    });
    expect(target.outputs[0].enumSource?.nodeId).toBe(source.id);
    expect(
      copy.nodes.find((node) => node.kind === "condition")?.config
        .conditions?.[0].left,
    ).toMatchObject({ nodeId: source.id });
    expect(target.inputs.json).toEqual(original.nodes.at(-1)!.inputs.json);
    expect(target.config.customParameters).toEqual(
      original.nodes.at(-1)!.config.customParameters,
    );
    const oldIds = new Set(
      [...original.nodes, ...original.edges].map((item) => item.id),
    );
    expect(
      [...copy.nodes, ...copy.edges].every((item) => !oldIds.has(item.id)),
    ).toBe(true);
    expect(original).toEqual(before);
    target.outputs[0].enumValues!.push("new");
    expect(original).toEqual(before);
  });

  it("批量副本保留分支路径和相对位置，连续粘贴标识独立且不连接原下游", () => {
    const original = definition();
    const selection = copyWorkflowSelection(
      original,
      original.nodes.map((node) => node.id),
    );
    expect(selection.nodes.map((node) => node.kind)).toEqual([
      "aigc",
      "condition",
      "select",
    ]);
    const next = pasteWorkflowSelection(original, selection, 48);
    const [source, branch, target] = next.nodes.slice(original.nodes.length);
    expect(target.position.x - source.position.x).toBe(600);
    expect(source.position).toEqual({ x: 148, y: 248 });
    expect(next.edges.find((edge) => edge.source === branch.id)).toMatchObject({
      target: target.id,
      branch: "false",
    });
    expect(workflowHasPath(next, "input", target.id)).toBe(true);
    expect(
      next.edges.some(
        (edge) => edge.source === source.id && edge.target === target.id,
      ),
    ).toBe(false);
    expect(
      next.edges.some(
        (edge) => edge.source === target.id && edge.target === "output",
      ),
    ).toBe(false);
    expect(target.inputs.value).toMatchObject({ nodeId: source.id });
    const twice = pasteWorkflowSelection(next, selection, 96);
    expect(new Set(twice.nodes.map((node) => node.id)).size).toBe(
      twice.nodes.length,
    );
    expect(new Set(twice.edges.map((edge) => edge.id)).size).toBe(
      twice.edges.length,
    );
    expect(twice.nodes.at(-3)!.position).toEqual({ x: 196, y: 296 });
    expect(twice.nodes.filter((node) => node.kind === "input")).toHaveLength(1);
    expect(twice.nodes.filter((node) => node.kind === "output")).toHaveLength(
      1,
    );
  });

  it("仅复制下游保留外部引用和 ELSE 控制，常量 JSON 不产生新依赖", () => {
    const original = definition();
    const next = pasteWorkflowSelection(
      original,
      copyWorkflowSelection(original, ["target"]),
      48,
    );
    const copied = next.nodes.at(-1)!;
    expect(copied.inputs.value).toMatchObject({ nodeId: "source" });
    expect(next.edges.slice(original.edges.length)).toEqual([
      {
        id: expect.any(String),
        source: "branch",
        target: copied.id,
        branch: "false",
      },
    ]);
    const plain = newWorkflowNode("javascript", "plain");
    plain.inputs.json = {
      kind: "literal",
      value: { kind: "reference", nodeId: "missing", field: "result" },
    };
    original.nodes.push(plain);
    const literal = pasteWorkflowSelection(
      original,
      copyWorkflowSelection(original, ["plain"]),
      48,
    );
    expect(literal.edges).toEqual(original.edges);
  });

  it("复制快照不受后续编辑影响，删除原选区后仍可粘贴，缺失外部依赖则原子拒绝", () => {
    const original = definition();
    const selection = copyWorkflowSelection(original, [
      "source",
      "branch",
      "target",
    ]);
    original.nodes.at(-1)!.name = "后来修改";
    expect(selection.nodes.at(-1)!.name).not.toBe("后来修改");
    original.nodes = original.nodes.filter((node) =>
      ["input", "output"].includes(node.kind),
    );
    original.edges = [];
    expect(pasteWorkflowSelection(original, selection, 48).nodes).toHaveLength(
      5,
    );
    const before = structuredClone(original);
    original.nodes = original.nodes.filter((node) => node.kind !== "input");
    expect(() => pasteWorkflowSelection(original, selection, 48)).toThrow(
      "input 已删除",
    );
    expect(original.edges).toEqual(before.edges);
    expect(original.nodes).toHaveLength(1);
  });

  it("空选区、节点上限和连线上限均在应用前拒绝", () => {
    const original = definition();
    expect(() =>
      pasteWorkflowSelection(
        original,
        copyWorkflowSelection(original, ["input", "output"]),
        48,
      ),
    ).toThrow("输入和输出节点");
    const selection = copyWorkflowSelection(original, ["target"]);
    const large = {
      ...original,
      nodes: Array.from({ length: 100 }, (_, i) =>
        newWorkflowNode("javascript", `n${i}`),
      ),
    };
    expect(() => pasteWorkflowSelection(large, selection, 48)).toThrow(
      "100 个",
    );
    const dense = {
      ...original,
      edges: [
        ...original.edges,
        ...Array.from({ length: 400 }, (_, i) => ({
          id: `extra${i}`,
          source: "input",
          target: "source",
        })),
      ],
    };
    expect(() => pasteWorkflowSelection(dense, selection, 48)).toThrow(
      "400 条",
    );
    expect(dense.nodes).toHaveLength(5);
  });
});

/** 列表入口测试使用真实弹窗、任务提供器与错误提示，仅替换远端 API。 */
function renderList() {
  const source = definition();
  const { nodes, edges: _edges, ...summary } = source;
  vi.spyOn(api, "listWorkflows").mockResolvedValue({
    workflows: [
      { ...summary, nodeCount: nodes.length } satisfies WorkflowSummary,
    ],
  });
  vi.spyOn(api, "getWorkflow").mockResolvedValue(source);
  render(
    <ErrorToastProvider>
      <ApiTaskProvider onAuthenticationRequired={() => {}}>
        <WorkflowsPage route={{ page: "workflows" }} />
      </ApiTaskProvider>
    </ErrorToastProvider>,
  );
  return source;
}

describe("工作流复制弹窗", () => {
  it("只填新名称即可创建并进入副本，空白名称不可提交且防重复点击", async () => {
    const source = renderList();
    let finish!: (value: WorkflowDefinition) => void;
    const save = vi.spyOn(api, "saveWorkflow").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "复制 原工作流" }),
    );
    const field = screen.getByLabelText("新工作流名称");
    expect(field).toHaveFocus();
    expect(field).toHaveValue("原工作流 副本");
    fireEvent.change(field, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "创建副本" })).toBeDisabled();
    fireEvent.change(field, { target: { value: "新流程" } });
    fireEvent.submit(field.closest("form")!);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    fireEvent.submit(field.closest("form")!);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]).toHaveLength(1);
    expect(save.mock.calls[0][0]).toMatchObject({
      name: "新流程",
      published: true,
      description: source.description,
    });
    expect(save.mock.calls[0][0]).not.toHaveProperty("id");
    await act(async () =>
      finish({
        ...save.mock.calls[0][0],
        id: "copy",
        revision: 1,
        createdAt: "now",
        updatedAt: "now",
      }),
    );
    expect(navigateTo).toHaveBeenCalledWith({
      page: "workflow-editor",
      workflowId: "copy",
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(source.revision).toBe(9);
  });

  it("取消不创建；保存失败保留名称并显示具体错误，重试成功", async () => {
    renderList();
    const save = vi
      .spyOn(api, "saveWorkflow")
      .mockRejectedValue(
        new ApiClientError(
          "CONFLICT",
          "复制时定义存储不可写",
          409,
          "copy-trace",
        ),
      );
    const trigger = await screen.findByRole("button", {
      name: "复制 原工作流",
    });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(save).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.change(screen.getByLabelText("新工作流名称"), {
      target: { value: "保留名称" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建副本" }));
    await waitFor(() =>
      expect(
        screen.getAllByText(/复制时定义存储不可写/).length,
      ).toBeGreaterThan(0),
    );
    expect(
      within(screen.getByRole("dialog")).getByLabelText("新工作流名称"),
    ).toHaveValue("保留名称");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "创建副本" })).toBeEnabled(),
    );
    save.mockImplementation(async (draft) => ({
      ...draft,
      id: "retry-copy",
      revision: 1,
      createdAt: "now",
      updatedAt: "now",
    }));
    fireEvent.click(screen.getByRole("button", { name: "创建副本" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(navigateTo).toHaveBeenCalledWith({
      page: "workflow-editor",
      workflowId: "retry-copy",
    });
  });
});
