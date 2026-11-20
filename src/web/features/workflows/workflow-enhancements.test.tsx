import { chooseOption, openOptions } from "../../test-select";
import { WorkflowsPage } from "../../pages/workflows-page";
import { useState } from "react";
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
  WorkflowBindingEditor,
  WorkflowFieldList,
  WorkflowValue,
} from "./workflow-fields";
import { WorkflowNodeEditor } from "./workflow-node-editor";
import {
  WorkflowScriptAssist,
  scriptInputDefinitions,
} from "./workflow-script-assist";
import { WorkflowValueView } from "./workflow-value-view";
import { ApiTaskProvider } from "../../api-task-provider";
import { ErrorToastProvider } from "../../error-toast-provider";
import { api, ApiClientError } from "../../api";
import {
  emptyWorkflow,
  newWorkflowNode,
  type WorkflowBinding,
  type WorkflowCatalog,
  type WorkflowNode,
} from "../../../shared/workflow-contracts";
import { validateWorkflow } from "../../../server/workflows/workflow-validation";
import { workflowDraftFieldError } from "./workflow-field-guards";

/** 使用真实任务提供器验证错误可见，模型请求仅使用假响应。 */
function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ErrorToastProvider>
      <ApiTaskProvider onAuthenticationRequired={() => {}}>
        {children}
      </ApiTaskProvider>
    </ErrorToastProvider>
  );
}
vi.mock("./workflow-canvas", () => ({ WorkflowCanvas: () => null }));

const catalog: WorkflowCatalog = {
  models: [
    {
      provider: "test",
      id: "script",
      name: "测试模型",
      reasoning: false,
      images: false,
    },
  ],
  agents: [],
  interfaces: [],
};
afterEach(() => vi.restoreAllMocks());
describe("工作流编辑增强", () => {
  /** 使用实际属性面板检查出参声明与提交结构，不以显示隐藏代替数据清理。 */
  function OutputEditor({ initial }: { initial: WorkflowNode }) {
    const [node, setNode] = useState(initial);
    return (
      <>
        <WorkflowNodeEditor
          node={node}
          nodes={[emptyWorkflow().nodes[0], node]}
          edges={emptyWorkflow().edges}
          catalog={catalog}
          onChange={setNode}
          onClose={() => {}}
          onDelete={() => {}}
          onCopy={() => {}}
          onValidity={() => {}}
        />
        <output data-testid="output-node">{JSON.stringify(node)}</output>
      </>
    );
  }

  it("删除、逐次改名与排序出参时只保留仍声明的绑定", () => {
    const node = emptyWorkflow().nodes[1];
    node.outputs.push({ name: "keep", type: "boolean" });
    node.inputs.keep = { kind: "literal", value: false };
    render(<Wrapper><OutputEditor initial={node} /></Wrapper>);
    const current = () => JSON.parse(screen.getByTestId("output-node").textContent!) as WorkflowNode;
    fireEvent.click(screen.getByRole("button", { name: "上移参数 keep" }));
    expect(current().outputs.map((field) => field.name)).toEqual(["keep", "result"]);
    expect(current().inputs).toEqual(node.inputs);
    fireEvent.change(screen.getByLabelText("参数 2 名称"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("参数 2 名称"), { target: { value: "story" } });
    expect(current().inputs).toEqual({ keep: { kind: "literal", value: false } });
    fireEvent.click(screen.getByRole("button", { name: "删除参数 keep" }));
    expect(current().inputs).toEqual({});
    const draft = { ...emptyWorkflow(), nodes: [emptyWorkflow().nodes[0], current()] };
    expect(workflowDraftFieldError(draft)).toBe("");
    expect(() => validateWorkflow(draft, true)).toThrow("story 尚未绑定");
  });

  it("旧工作流显示隐藏的残留绑定，显式清理后保留正常出参并可执行校验", () => {
    const node = emptyWorkflow().nodes[1];
    node.outputs = [{ name: "story", type: "string", required: true }];
    node.inputs.story = { kind: "reference", nodeId: "input", field: "prompt" };
    render(<Wrapper><OutputEditor initial={node} /></Wrapper>);
    expect(screen.getByText(/未声明的输出绑定：result/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "清理未声明的输出绑定" }));
    const cleaned = JSON.parse(screen.getByTestId("output-node").textContent!) as WorkflowNode;
    expect(cleaned.inputs).toEqual({ story: node.inputs.story });
    expect(screen.queryByText(/未声明的输出绑定/)).not.toBeInTheDocument();
    expect(() => validateWorkflow({ ...emptyWorkflow(), nodes: [emptyWorkflow().nodes[0], cleaned] }, true)).not.toThrow();
    expect(node.inputs.result).toBeDefined();
  });

  it("已有残留映射即使未打开属性面板也阻止校验、保存和运行", async () => {
    const definition = {
      ...emptyWorkflow(), id: "stale-output", revision: 1, createdAt: "", updatedAt: "",
    };
    definition.nodes[1].outputs = [{ name: "story", type: "string" }];
    vi.spyOn(api, "getWorkflowCatalog").mockResolvedValue(catalog);
    vi.spyOn(api, "getWorkflow").mockResolvedValue(definition);
    const save = vi.spyOn(api, "saveWorkflow");
    render(<Wrapper><WorkflowsPage route={{ page: "workflow-editor", workflowId: definition.id }} /></Wrapper>);
    await screen.findByLabelText("工作流名称");
    expect(screen.getByText(/输出绑定 result 未声明/)).toBeVisible();
    for (const name of ["校验", "保存", "保存并运行"])
      expect(screen.getByRole("button", { name })).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
    const loop = newWorkflowNode("loop", "loop");
    loop.config.loop!.body = definition;
    expect(workflowDraftFieldError({ ...emptyWorkflow(), nodes: [...emptyWorkflow().nodes, loop] })).toContain("输出绑定 result 未声明");
  });

  it("嵌套循环的参数名错误在未打开属性面板时仍阻止校验、保存和运行", async () => {
    const loop = newWorkflowNode("loop", "loop");
    const inner = newWorkflowNode("loop", "inner");
    inner.config.loop!.body.nodes[0].outputs.push({
      name: "index",
      type: "string",
    });
    loop.config.loop!.body.nodes.push(inner);
    const definition = {
      ...emptyWorkflow(),
      id: "invalid",
      revision: 1,
      createdAt: "",
      updatedAt: "",
    };
    definition.nodes.push(loop);
    vi.spyOn(api, "getWorkflowCatalog").mockResolvedValue(catalog);
    vi.spyOn(api, "getWorkflow").mockResolvedValue(definition);
    const save = vi.spyOn(api, "saveWorkflow");
    render(
      <Wrapper>
        <WorkflowsPage
          route={{ page: "workflow-editor", workflowId: definition.id }}
        />
      </Wrapper>,
    );
    await screen.findByLabelText("工作流名称");
    expect(screen.getByText(/参数名 index 已存在/)).toHaveTextContent("index");
    for (const name of ["校验", "保存", "保存并运行"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(save).not.toHaveBeenCalled();
  });

  it("运行详情按历史快照拓扑显示，使用快照名称而非当前定义", async () => {
    const definition = {
      ...emptyWorkflow(),
      id: "ordered",
      revision: 1,
      createdAt: "",
      updatedAt: "",
    };
    const script = newWorkflowNode("javascript", "script");
    script.name = "快照脚本";
    definition.nodes.push(script);
    definition.edges = [
      { id: "a", source: "input", target: "script" },
      { id: "b", source: "script", target: "output" },
    ];
    const run = {
      id: "history",
      workflowId: definition.id,
      definition: structuredClone(definition),
      status: "succeeded",
      inputs: {},
      outputs: {},
      nodes: definition.nodes.map((n) => ({
        nodeId: n.id,
        status: "succeeded",
        events: [],
      })),
      createdAt: "",
    };
    script.name = "当前脚本";
    vi.spyOn(api, "getWorkflow").mockResolvedValue(definition);
    vi.spyOn(api, "listWorkflows").mockResolvedValue({
      workflows: [{ id: definition.id, name: definition.name, description: definition.description, published: definition.published, revision: definition.revision, createdAt: definition.createdAt, updatedAt: definition.updatedAt, nodeCount: definition.nodes.length }],
    });
    vi.spyOn(api, "getWorkflowRun").mockResolvedValue(run as never);
    const { container } = render(
      <Wrapper>
        <WorkflowsPage
          route={{
            page: "workflow-run",
            workflowId: definition.id,
            runId: run.id,
          }}
        />
      </Wrapper>,
    );
    await screen.findByText("快照脚本");
    expect(
      Array.from(
        container.querySelectorAll(".wf-trace-title strong"),
        (el) => el.textContent,
      ),
    ).toEqual(["输入", "快照脚本", "输出"]);
    expect(run.nodes.map((n) => n.nodeId)).toEqual([
      "input",
      "output",
      "script",
    ]);
  });
  it("应用层回调变化不重新加载运行表单并清空已填写参数", async () => {
    const definition = {
      ...emptyWorkflow(),
      id: "runner",
      revision: 1,
      createdAt: "",
      updatedAt: "",
    };
    vi.spyOn(api, "getWorkflow").mockResolvedValue(definition);
    const list = vi
      .spyOn(api, "listWorkflows")
      .mockImplementation(async () => ({
        workflows: [{ id: definition.id, name: definition.name, description: definition.description, published: definition.published, revision: definition.revision, createdAt: definition.createdAt, updatedAt: definition.updatedAt, nodeCount: definition.nodes.length }],
      }));
    const { rerender } = render(
      <Wrapper>
        <WorkflowsPage route={{ page: "workflow-run", workflowId: "runner" }} />
      </Wrapper>,
    );
    // 异步定义加载后的初始化完成后，再模拟填写和回调重渲染，避免提前输入被初始值覆盖。
    await screen.findByLabelText("prompt");
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("prompt"), {
      target: { value: "应保留的运行参数" },
    });
    await act(async () =>
      rerender(
        <Wrapper>
          <WorkflowsPage
            route={{ page: "workflow-run", workflowId: "runner" }}
          />
        </Wrapper>,
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("prompt")).toHaveValue("应保留的运行参数"),
    );
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("应用层回调变化不重新加载编辑器并覆盖未保存的名称说明", async () => {
    const definition = {
      ...emptyWorkflow(),
      id: "test",
      name: "原名称",
      revision: 1,
      createdAt: "",
      updatedAt: "",
    };
    vi.spyOn(api, "getWorkflowCatalog").mockResolvedValue(catalog);
    const get = vi.spyOn(api, "getWorkflow").mockResolvedValue(definition);
    const { rerender } = render(
      <Wrapper>
        <WorkflowsPage
          route={{ page: "workflow-editor", workflowId: "test" }}
        />
      </Wrapper>,
    );
    await screen.findByLabelText("工作流名称");
    fireEvent.change(screen.getByLabelText("工作流名称"), {
      target: { value: "新名称" },
    });
    fireEvent.change(screen.getByLabelText("工作流说明"), {
      target: { value: "新说明" },
    });
    await act(async () =>
      rerender(
        <Wrapper>
          <WorkflowsPage
            route={{ page: "workflow-editor", workflowId: "test" }}
          />
        </Wrapper>,
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("工作流名称")).toHaveValue("新名称"),
    );
    expect(get).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("工作流名称")).toHaveValue("新名称");
    expect(screen.getByLabelText("工作流说明")).toHaveValue("新说明");
  });
  it("枚举固定值保留数字和布尔类型，失效选项明确标错，引用不显示类型选择", () => {
    const change = vi.fn();
    const validity = vi.fn();
    const props = {
      label: "质量",
      nodes: emptyWorkflow().nodes,
      nodeId: "aigc",
      onChange: change,
      onValidity: validity,
      field: {
        name: "quality",
        type: "float" as const,
        enumValues: [10, 20, false],
        defaultValue: 20,
      },
    };
    const { rerender } = render(<WorkflowBindingEditor {...props} />);
    chooseOption("质量 值来源", "literal");
    expect(change).toHaveBeenLastCalledWith({ kind: "literal", value: 20 });
    rerender(
      <WorkflowBindingEditor
        {...props}
        binding={{ kind: "literal", value: 20 }}
      />,
    );
    expect(screen.queryByLabelText("质量 常量类型")).not.toBeInTheDocument();
    chooseOption("quality", "2");
    expect(change).toHaveBeenLastCalledWith({ kind: "literal", value: false });
    rerender(
      <WorkflowBindingEditor
        {...props}
        binding={{ kind: "literal", value: "20" }}
      />,
    );
    expect(screen.getByLabelText("quality")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(validity).toHaveBeenLastCalledWith(false);
    rerender(
      <WorkflowBindingEditor
        {...props}
        binding={{ kind: "reference", nodeId: "input", field: "prompt" }}
      />,
    );
    expect(screen.getByText(/上游值按字符串/)).toBeVisible();
    expect(screen.queryByLabelText("quality")).not.toBeInTheDocument();
  });
  it("AIGC 整数和枚举使用完整定义，参数分组可独立定位", () => {
    const initial = newWorkflowNode("aigc", "aigc");
    initial.config.interfaceId = "a";
    function Editor() {
      const [node, setNode] = useState(initial);
      return (
        <WorkflowNodeEditor
          node={node}
          nodes={emptyWorkflow().nodes}
          catalog={{
            ...catalog,
            interfaces: [
              {
                id: "a",
                name: "测试接口",
                fields: [
                  { name: "steps", type: "integer", min: 1, max: 50 },
                  {
                    name: "quality",
                    type: "string",
                    enumValues: ["low", "high"],
                  },
                ],
                outputs: [],
              },
            ],
          }}
          onChange={setNode}
          onValidity={() => {}}
          onClose={() => {}}
          onCopy={() => {}}
          onDelete={() => {}}
        />
      );
    }
    render(
      <Wrapper>
        <Editor />
      </Wrapper>,
    );
    chooseOption("steps 值来源", "literal");
    const step = within(screen.getByRole("region", { name: "steps 参数配置" }));
    expect(step.getByLabelText("steps")).toHaveAttribute("step", "1");
    expect(step.getByLabelText("steps")).toHaveAttribute("min", "1");
    expect(step.getByLabelText("steps")).toHaveAttribute("max", "50");
    expect(step.queryByLabelText(/常量类型/)).not.toBeInTheDocument();
  });
  it("脚本输入推导保留上游类型、数组和固定 0/false", () => {
    const node = newWorkflowNode("javascript", "js");
    node.inputs = {
      value: { kind: "literal", value: 0 },
      flag: { kind: "literal", value: false },
      names: { kind: "literal", value: ["a", "b"] },
      ref: { kind: "reference", nodeId: "input", field: "prompt" },
    };
    expect(scriptInputDefinitions(node, emptyWorkflow().nodes)).toMatchObject([
      { name: "value", type: "integer" },
      { name: "flag", type: "boolean" },
      { name: "names", type: "string", multiple: true },
      { name: "ref", type: "string" },
    ]);
  });
  it("生成候选不会改脚本，显式应用只接受未变化上下文", async () => {
    const assist = vi
      .spyOn(api, "assistWorkflowScript")
      .mockResolvedValue({ script: 'return { result: "generated" };' });
    const apply = vi.fn();
    const node = newWorkflowNode("javascript", "js");
    const props = {
      node,
      nodes: emptyWorkflow().nodes,
      catalog,
      onApply: apply,
    };
    const { rerender } = render(
      <Wrapper>
        <WorkflowScriptAssist {...props} />
      </Wrapper>,
    );
    fireEvent.click(screen.getByRole("button", { name: "AI 辅助" }));
    chooseOption("脚本辅助模型", "test\tscript");
    fireEvent.change(screen.getByLabelText("脚本生成需求"), {
      target: { value: "生成脚本" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成脚本" }));
    await screen.findByLabelText("候选脚本");
    expect(apply).not.toHaveBeenCalled();
    expect(assist.mock.calls[0][0]).toMatchObject({
      script: node.config.script,
      outputs: node.outputs,
      inputs: [{ name: "value", type: "string" }],
    });
    rerender(
      <Wrapper>
        <WorkflowScriptAssist
          {...props}
          node={{
            ...node,
            config: { ...node.config, script: 'return { result: "manual" };' },
          }}
        />
      </Wrapper>,
    );
    expect(screen.getByRole("button", { name: "应用到脚本" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "应用到脚本" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "应用到脚本" }));
    expect(apply).toHaveBeenCalledWith('return { result: "generated" };');
  });
  it("关闭辅助取消请求；生成异常进入错误弹窗", async () => {
    const assist = vi
      .spyOn(api, "assistWorkflowScript")
      .mockImplementation(() => new Promise(() => {}));
    const node = newWorkflowNode("javascript", "js");
    render(
      <Wrapper>
        <WorkflowScriptAssist
          node={node}
          nodes={[]}
          catalog={catalog}
          onApply={() => {}}
        />
      </Wrapper>,
    );
    fireEvent.click(screen.getByRole("button", { name: "AI 辅助" }));
    chooseOption("脚本辅助模型", "test\tscript");
    fireEvent.change(screen.getByLabelText("脚本生成需求"), {
      target: { value: "需求" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成脚本" }));
    fireEvent.click(screen.getByRole("button", { name: "取消生成并关闭" }));
    expect(assist.mock.calls[0][1]?.aborted).toBe(true);
    assist.mockRejectedValue(
      new ApiClientError(
        "REQUEST_FAILED",
        "测试模型输出被截断",
        502,
        "trace-test",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "AI 辅助" }));
    fireEvent.click(screen.getByRole("button", { name: "生成脚本" }));
    await waitFor(() =>
      expect(screen.getAllByText(/测试模型输出被截断/).length).toBeGreaterThan(
        0,
      ),
    );
    expect(screen.getByRole("button", { name: "应用到脚本" })).toBeDisabled();
  });
  it("模型右侧选择支持的思考强度，生成期间预览思考和正文，取消后保留内容", async () => {
    let progress: Parameters<typeof api.assistWorkflowScript>[2];
    const assist = vi.spyOn(api, "assistWorkflowScript").mockImplementation((_input, _signal, onProgress) => {
      progress = onProgress;
      return new Promise(() => {});
    });
    const reasoningCatalog: WorkflowCatalog = { ...catalog, models: [
      { ...catalog.models[0], reasoning: true, thinkingLevels: ["low", "high"] },
      { ...catalog.models[0], id: "plain", name: "普通模型" },
    ] };
    render(<Wrapper><WorkflowScriptAssist node={newWorkflowNode("javascript", "js")} nodes={[]} catalog={reasoningCatalog} onApply={() => {}} /></Wrapper>);
    fireEvent.click(screen.getByRole("button", { name: "AI 辅助" }));
    chooseOption("脚本辅助模型", "test\tscript");
    fireEvent.click(screen.getByRole("button", { name: "思考强度：模型默认" }));
    expect(screen.queryByRole("menuitemradio", { name: "最大" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitemradio", { name: "关闭" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "高" }));
    fireEvent.change(screen.getByLabelText("脚本生成需求"), { target: { value: "生成脚本" } });
    fireEvent.click(screen.getByRole("button", { name: "生成脚本" }));
    expect(assist.mock.calls[0][0]).toMatchObject({ thinkingLevel: "high" });
    act(() => {
      progress?.({ type: "thinking_delta", delta: "分析输入类型" });
      progress?.({ type: "text_delta", delta: "return {" });
    });
    expect(screen.getByLabelText("思考内容")).toHaveValue("分析输入类型");
    expect(screen.getByLabelText("正文输出")).toHaveValue("return {");
    expect(screen.getByRole("button", { name: "应用到脚本" })).toBeDisabled();
    const oldProgress = progress;
    fireEvent.click(screen.getByRole("button", { name: "取消生成" }));
    expect(assist.mock.calls[0][1]?.aborted).toBe(true);
    act(() => oldProgress?.({ type: "text_delta", delta: "旧流残留" }));
    expect(screen.getByLabelText("正文输出")).toHaveValue("return {");
    expect(screen.getByRole("status")).toHaveTextContent("已取消");
    chooseOption("脚本辅助模型", "test\tplain");
    expect(screen.getByRole("button", { name: /思考强度：模型默认/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "生成脚本" }));
    expect(assist.mock.calls[1][0]).not.toHaveProperty("thinkingLevel");
    expect(screen.queryByLabelText("思考内容")).not.toBeInTheDocument();
    act(() => oldProgress?.({ type: "text_delta", delta: "旧输出" }));
    expect(screen.getByLabelText("正文输出")).toHaveValue("");
  });
  it("流内失败后保留预览且错误消息和请求标识进入全局弹窗", async () => {
    vi.spyOn(api, "assistWorkflowScript").mockImplementation(async (_input, _signal, progress) => {
      progress?.({ type: "thinking_delta", delta: "已检查输入" });
      progress?.({ type: "text_delta", delta: "残缺代码" });
      throw new ApiClientError("REQUEST_FAILED", "模型连接在正文生成期间中断", 200, "stream-failure-trace");
    });
    render(<Wrapper><WorkflowScriptAssist node={newWorkflowNode("javascript", "js")} nodes={[]} catalog={catalog} onApply={() => {}} /></Wrapper>);
    fireEvent.click(screen.getByRole("button", { name: "AI 辅助" }));
    chooseOption("脚本辅助模型", "test\tscript");
    fireEvent.change(screen.getByLabelText("脚本生成需求"), { target: { value: "需求" } });
    fireEvent.click(screen.getByRole("button", { name: "生成脚本" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("生成未完成"));
    expect(screen.getByLabelText("正文输出")).toHaveValue("残缺代码");
    expect(screen.getByLabelText("思考内容")).toHaveValue("已检查输入");
    expect(screen.getAllByText(/模型连接在正文生成期间中断/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "应用到脚本" })).toBeDisabled();
  });
  it("嵌套产物按字段展示图片、音视频和下载，并显示加载异常", async () => {
    const image = {
      assetId: "image",
      name: "图片.png",
      mediaType: "image/png",
      size: 8,
    };
    render(
      <Wrapper>
        <WorkflowValueView
          value={{
            files: [image],
            nested: {
              copies: [image],
              video: {
                ...image,
                assetId: "video",
                name: "视频.mp4",
                mediaType: "video/mp4",
              },
              audio: {
                ...image,
                assetId: "audio",
                name: "音频.wav",
                mediaType: "audio/wav",
              },
            },
          }}
        />
      </Wrapper>,
    );
    expect(screen.getAllByRole("img")).toHaveLength(2);
    expect(screen.getByLabelText("视频.mp4")).toHaveAttribute("controls");
    expect(screen.getByLabelText("音频.wav")).toHaveAttribute(
      "src",
      "/api/v1/workflow-files/audio?preview=1",
    );
    expect(screen.getAllByRole("link", { name: "下载" })).toHaveLength(4);
    fireEvent.click(screen.getAllByRole("button", { name: "查看大图 图片.png" })[0]);
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "关闭图片预览" }));
    fireEvent.error(screen.getAllByRole("img")[0]);
    await waitFor(() =>
      expect(screen.getAllByText(/加载或解码失败/).length).toBeGreaterThan(0),
    );
  });
});

/** 使用真实表单验证枚举来源、双模式参考组与参数重排的编辑语义。 */
describe("工作流参数组合", () => {
  it("参数移动携带类型、默认值和说明，首尾移动按钮禁用", () => {
    function Fields() {
      const [fields, setFields] = useState([
        {
          name: "first",
          type: "string" as const,
          description: "第一个",
          defaultValue: "a",
        },
        {
          name: "second",
          type: "string" as const,
          description: "第二个",
          defaultValue: "b",
        },
      ]);
      return (
        <WorkflowFieldList
          defaults
          fields={fields}
          onChange={setFields as never}
        />
      );
    }
    render(<Fields />);
    expect(screen.getByLabelText("上移参数 first")).toBeDisabled();
    expect(screen.getByLabelText("下移参数 second")).toBeDisabled();
    fireEvent.click(screen.getByLabelText("下移参数 first"));
    expect(screen.getByLabelText("参数 1 名称")).toHaveValue("second");
    expect(screen.getByLabelText("参数 2 名称")).toHaveValue("first");
    expect(screen.getByLabelText("first 说明")).toHaveValue("第一个");
    fireEvent.click(screen.getByLabelText("上移参数 first"));
    expect(screen.getByLabelText("参数 1 名称")).toHaveValue("first");
  });
  it("开始节点选择下游枚举时保存字符串约束，运行表单选择输出字符串", () => {
    const source = newWorkflowNode("aigc", "aigc");
    source.config.interfaceId = "enum";
    const change = vi.fn();
    function Editor() {
      const [node, setNode] = useState(newWorkflowNode("input", "input"));
      return (
        <WorkflowNodeEditor
          node={node}
          nodes={[node, source]}
          edges={[{ id: "a", source: "input", target: "aigc" }]}
          catalog={{
            ...catalog,
            interfaces: [
              {
                id: "enum",
                name: "枚举测试",
                fields: [
                  { name: "quality", type: "float", enumValues: [0, 20] },
                ],
                outputs: [],
              },
            ],
          }}
          onChange={(next) => {
            change(next);
            setNode(next);
          }}
          onValidity={() => {}}
          onClose={() => {}}
          onCopy={() => {}}
          onDelete={() => {}}
        />
      );
    }
    const rendered = render(
      <Wrapper>
        <Editor />
      </Wrapper>,
    );
    chooseOption("prompt 类型", "enum");
    fireEvent.click(openOptions("prompt 枚举来源").getByRole("option", { name: /\/ quality$/ }));
    const field = change.mock.calls.at(-1)![0].outputs[0];
    expect(field).toMatchObject({
      type: "string",
      enumValues: ["0", "20"],
      enumSource: { nodeId: "aigc", field: "quality", interfaceId: "enum" },
    });
    rendered.unmount();
    const value = vi.fn();
    render(<WorkflowValue field={field} value="0" onChange={value} />);
    chooseOption("prompt", "1");
    expect(value).toHaveBeenCalledWith("20");
  });
  it("循环输入可从已连接工作流的枚举入参复制选项，隔离未连接和不可用目标", () => {
    const changed = vi.fn();
    const input = newWorkflowNode("input", "input");
    input.outputs = [{ name: "index", type: "integer", required: true }, { name: "ratio", type: "string" }];
    const call = newWorkflowNode("workflow", "call");
    call.name = "MiniMax-H3-Ref2VA";
    call.config.workflowId = "target";
    const disconnected = { ...call, id: "disconnected", name: "未连接节点" };
    const unavailable = { ...call, id: "unavailable", config: { workflowId: "unavailable" } };
    function Editor() {
      const [node, setNode] = useState(input);
      return <WorkflowNodeEditor
        node={node}
        nodes={[node, call, disconnected, unavailable]}
        edges={[{ id: "linked", source: "input", target: "call" }, { id: "disabled", source: "call", target: "unavailable" }]}
        catalog={{ ...catalog, workflows: [
          { id: "target", name: call.name, dependencies: [], enumFields: [{ name: "ratio", values: ["16:9", "9:16"] }] },
          { id: "unavailable", name: "不可用目标", dependencies: [], unavailable: "定义失效", enumFields: [{ name: "bad", values: ["x"] }] },
        ] }}
        onChange={(next) => { setNode(next); changed(next); }}
        onValidity={() => {}} onClose={() => {}} onCopy={() => {}} onDelete={() => {}}
      />;
    }
    render(<Wrapper><Editor /></Wrapper>);
    chooseOption("ratio 类型", "enum");
    const choices = openOptions("ratio 枚举来源");
    expect(choices.getAllByRole("option")).toHaveLength(2);
    expect(choices.queryByRole("option", { name: /未连接节点|bad/ })).not.toBeInTheDocument();
    fireEvent.click(choices.getByRole("option", { name: "MiniMax-H3-Ref2VA / ratio" }));
    expect(changed.mock.lastCall?.[0].outputs[1]).toEqual({
      name: "ratio", type: "string", enumValues: ["16:9", "9:16"],
      enumSource: { nodeId: "call", field: "ratio", workflowId: "target" }, defaultValue: undefined,
    });
    expect(screen.getByText("16:9 / 9:16")).toBeInTheDocument();
  });

  it("刷新子工作流枚举不丢当前草稿，读取失败显示原因，成功后显式更新选项", async () => {
    const directory: WorkflowCatalog = { ...catalog, workflows: [{ id: "target", name: "目标", dependencies: [], enumFields: [{ name: "ratio", values: ["16:9", "9:16"] }] }] };
    const read = vi.spyOn(api, "getWorkflowCatalog")
      .mockRejectedValueOnce(new ApiClientError("REQUEST_FAILED", "读取枚举目录时存储不可用", 503, "enum-refresh"))
      .mockResolvedValue({ ...directory, workflows: [{ id: "target", name: "目标", dependencies: [], enumFields: [{ name: "ratio", values: ["1:1", "3:2"] }] }] });
    const changed = vi.fn();
    function Editor() {
      const [node, setNode] = useState({ ...newWorkflowNode("input", "input"), outputs: [{ name: "ratio", type: "string" as const, enumValues: ["16:9", "9:16"], enumSource: { nodeId: "call", field: "ratio", workflowId: "target" } }] });
      const call = newWorkflowNode("workflow", "call");
      call.config.workflowId = "target";
      return <WorkflowNodeEditor node={node} nodes={[node, call]} edges={[{ id: "a", source: "input", target: "call" }]} catalog={directory}
        onChange={(next) => { setNode(next as typeof node); changed(next); }} onValidity={() => {}} onClose={() => {}} onCopy={() => {}} onDelete={() => {}} />;
    }
    render(<Wrapper><Editor /></Wrapper>);
    fireEvent.click(screen.getByRole("button", { name: "ratio 刷新枚举来源" }));
    await screen.findAllByText(/读取枚举目录时存储不可用/);
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByText("16:9 / 9:16")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "ratio 刷新枚举来源" }));
    fireEvent.click(await screen.findByRole("button", { name: "更新枚举选项" }));
    expect(changed.mock.lastCall?.[0].outputs[0].enumValues).toEqual(["1:1", "3:2"]);
    expect(changed.mock.lastCall?.[0].outputs[0].enumSource.workflowId).toBe("target");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("参考组默认逐项输入，数组模式只列同类型数组，切回后清除数组绑定", () => {
    const upstream = newWorkflowNode("input", "input");
    upstream.outputs = [
      { name: "pictures", type: "image", multiple: true },
      { name: "single", type: "image" },
      { name: "sounds", type: "audio", multiple: true },
    ];
    const initial = newWorkflowNode("aigc", "aigc");
    initial.config.interfaceId = "group";
    initial.inputs.first = {
      kind: "literal",
      value: { assetId: "old", mediaType: "image/png" },
    };
    const changed = vi.fn();
    function Editor() {
      const [node, setNode] = useState(initial);
      return (
        <WorkflowNodeEditor
          node={node}
          nodes={[upstream, node]}
          edges={[{ id: "a", source: "input", target: "aigc" }]}
          catalog={{
            ...catalog,
            interfaces: [
              {
                id: "group",
                name: "参考图",
                fields: [
                  { name: "first", type: "image" },
                  { name: "second", type: "image" },
                ],
                outputs: [],
                referenceGroups: [
                  {
                    id: "refs",
                    label: "参考图片",
                    type: "image",
                    fields: ["first", "second"],
                  },
                ],
              },
            ],
          }}
          onChange={(next) => {
            changed(next);
            setNode(next);
          }}
          onValidity={() => {}}
          onClose={() => {}}
          onCopy={() => {}}
          onDelete={() => {}}
        />
      );
    }
    render(
      <Wrapper>
        <Editor />
      </Wrapper>,
    );
    expect(screen.getByLabelText("first 值来源")).toBeInTheDocument();
    chooseOption("参考图片 输入方式", "array");
    expect(screen.queryByLabelText("first 值来源")).not.toBeInTheDocument();
    const values = openOptions("参考图片 数组 值来源");
    expect(values.getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual(["unset", "input:pictures"]);
    fireEvent.click(values.getByRole("option", { name: /pictures/ }));
    expect(changed.mock.calls.at(-1)![0]).toMatchObject({
      inputs: {},
      config: {
        referenceGroups: {
          refs: {
            mode: "array",
            binding: { kind: "reference", nodeId: "input", field: "pictures" },
          },
        },
      },
    });
    chooseOption("参考图片 输入方式", "split");
    expect(changed.mock.calls.at(-1)![0].config.referenceGroups).toEqual({});
  });
});

it("外层输入可以选择已连接循环节点的枚举入参，修改循环选项后显式同步", () => {
  const loop = newWorkflowNode("loop", "loop");loop.name = "画幅循环";
  loop.config.loop!.body.nodes[0].outputs.push({name:"ratio",type:"string",enumValues:["16:9","9:16"]});
  const input = newWorkflowNode("input","input");input.outputs = [{name:"ratio",type:"string"}];
  const changed = vi.fn();
  function Editor() {
    const [node,setNode] = useState(input);
    return <WorkflowNodeEditor node={node} nodes={[node,loop]} edges={[{id:"a",source:"input",target:"loop"}]} catalog={catalog} onChange={(next) => {setNode(next);changed(next);}} onValidity={() => {}} onClose={() => {}} onCopy={() => {}} onDelete={() => {}}/>;
  }
  const view = render(<Wrapper><Editor/></Wrapper>);
  chooseOption("ratio 类型", "enum");
  fireEvent.click(openOptions("ratio 枚举来源").getByRole("option", { name: "画幅循环 / ratio" }));
  expect(changed.mock.lastCall?.[0].outputs[0].enumSource).toEqual({nodeId:"loop",field:"ratio",loop:true});
  loop.config.loop!.body.nodes[0].outputs[1].enumValues = ["1:1"];
  view.rerender(<Wrapper><Editor/></Wrapper>);
  fireEvent.click(screen.getByRole("button",{name:"更新枚举选项"}));
  expect(changed.mock.lastCall?.[0].outputs[0].enumValues).toEqual(["1:1"]);
});

it("编辑器固定文件上传到常量目录，也可选择已有文件，运行表单上传保持运行目录", async () => {
  const file = {assetId:"constant",name:"reference.png",mediaType:"image/png",size:5};
  const upload = vi.spyOn(api,"uploadWorkflowFile").mockResolvedValue(file);
  vi.spyOn(api,"listWorkflowFiles").mockResolvedValue({files:[{...file,directory:"constants",createdAt:"",usages:[]}],total:1,page:1,workflows:[]});
  const changed = vi.fn();
  render(<Wrapper><WorkflowBindingEditor label="image" field={{name:"image",type:"image"}} binding={{kind:"literal",value:null}} nodes={[]} nodeId="node" onChange={changed}/></Wrapper>);
  const data = new File(["image"],"reference.png",{type:"image/png"});
  const picker = screen.getByRole("button", { name: "上传 image" });
  fireEvent.change(picker.nextElementSibling!, { target: { files: [data] } });
  await waitFor(() => expect(upload).toHaveBeenCalledWith(data,"constants"));
  fireEvent.click(screen.getByRole("button",{name:"选择已有文件常量"}));
  fireEvent.click(await screen.findByRole("button",{name:"reference.png"}));
  await waitFor(() => expect(changed).toHaveBeenLastCalledWith({kind:"literal",value:file}));
});
