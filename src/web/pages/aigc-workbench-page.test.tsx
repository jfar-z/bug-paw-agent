import { chooseOption } from "../test-select";
import { readFile } from "node:fs/promises";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AIGC_TASK_BULK_DELETE_LIMIT } from "../../shared/aigc-contracts";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { AigcProviderControl, AigcWorkbenchPage } from "./aigc-workbench-page";

function renderAigcPage(route: Parameters<typeof AigcWorkbenchPage>[0]["route"] = { page: "aigc-run" }) {
  return render(
    <ErrorToastProvider>
      <ApiTaskProvider onAuthenticationRequired={vi.fn()}>
        <AigcWorkbenchPage route={route} />
      </ApiTaskProvider>
    </ErrorToastProvider>,
  );
}

describe("AigcWorkbenchPage 创作台", () => {
  it("任务详情保留完整请求并以纯文本展示截断回参，复制来自实际快照", async () => {
    const prompt = "长提示词".repeat(2000);
    const body = { model: "image-model", prompt, quality: "high" };
    const response = '<script>alert("不可执行")</script>';
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "diagnostic", interfaceName: "OpenAI", status: "failed", inputs: { prompt: "用户输入" }, assets: [],
      createdAt: "2026-11-17T00:00:00Z", updatedAt: "2026-11-17T00:00:00Z",
      error: { code: "AIGC_UPSTREAM_FAILED", message: "OpenAI 返回 400" },
      diagnostics: { request: { method: "POST", endpoint: "images/generations", body }, response: { status: 400, endpoint: "images/generations", body: response, truncated: true } },
    }))));
    renderAigcPage({ page: "aigc-task-detail", taskId: "diagnostic" });
    expect((await screen.findByLabelText("完整请求入参")).textContent).toBe(JSON.stringify(body, null, 2));
    expect(screen.getByLabelText("接口响应正文").textContent).toBe(response);
    expect(screen.getByLabelText("接口响应正文").querySelector("script")).toBeNull();
    expect(screen.getByText(/响应正文已截断/)).toBeInTheDocument();
    expect(screen.getByText("HTTP 400 · images/generations")).toBeInTheDocument();
    expect(await screen.findByText("AIGC 任务生成失败")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制完整请求入参" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(JSON.stringify(body, null, 2)));
    fireEvent.click(screen.getByRole("button", { name: "复制接口响应正文" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(response));
  });

  it("历史任务不伪造请求和回参，剪贴板不可用明确报告", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "old", interfaceName: "Grok", status: "failed", inputs: { prompt: "原始输入" }, assets: [],
      createdAt: "2026-11-17T00:00:00Z", updatedAt: "2026-11-17T00:00:00Z",
    }))));
    renderAigcPage({ page: "aigc-task-detail", taskId: "old" });
    expect(await screen.findByText(/没有实际请求快照/)).toBeInTheDocument();
    expect(screen.getByText(/没有已记录的接口回参/)).toBeInTheDocument();
    expect(screen.queryByLabelText("完整请求入参")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制用户输入" }));
    expect((await screen.findAllByText(/浏览器不支持剪贴板写入/)).length).toBeGreaterThan(0);
    // 局域网 HTTP 路径使用兼容复制，成功后移除临时文本框并恢复焦点。
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    try {
      const button = screen.getByRole("button", { name: "复制用户输入" });
      button.focus();
      fireEvent.click(button);
      await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
      expect(await screen.findByText("已复制")).toBeInTheDocument();
      expect(document.activeElement).toBe(button);
      expect(document.querySelector("textarea")).toBeNull();
    } finally {
      Reflect.deleteProperty(document, "execCommand");
    }
  });

  it("multipart 按顺序保留重复字段与文件元数据，成功任务不显示失败回参", async () => {
    const body = [{ name: "image", value: { name: "a.png", mediaType: "image/png", size: 12 } }, { name: "image", value: { name: "b.png", mediaType: "image/png", size: 24 } }];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "multipart", interfaceName: "OpenAI", status: "succeeded", inputs: {}, assets: [],
      createdAt: "2026-11-17T00:00:00Z", updatedAt: "2026-11-17T00:00:00Z",
      diagnostics: { request: { method: "POST", endpoint: "images/edits", body } },
    }))));
    renderAigcPage({ page: "aigc-task-detail", taskId: "multipart" });
    expect((await screen.findByLabelText("完整请求入参")).textContent).toBe(JSON.stringify(body, null, 2));
    expect(screen.queryByText("最近接口回参")).not.toBeInTheDocument();
  });

  it("待运行任务显示真实状态并进入需处理筛选，取消后不出现隐式重试", async () => {
    let status = "prepared";
    const task = () => ({ id: "prepared-task", interfaceId: "interface", interfaceName: "待运行创作", channelId: "channel", status,
      assetCount: 0, requiresNewTask: true, createdAt: "2026-11-03T00:00:00Z", updatedAt: "2026-11-03T00:00:00Z" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/cancel") && init?.method === "POST") { status = "cancelled"; return new Response(JSON.stringify(task())); }
      if (url.endsWith("/aigc/tasks")) return new Response(JSON.stringify({ tasks: [task()] }));
      return new Response("{}");
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAigcPage({ page: "aigc-tasks" });
    expect(await screen.findByText("待运行")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "需处理" }));
    expect(screen.getByText("待运行创作")).toBeInTheDocument();
    expect(screen.getByText("参数已校验，等待 Agent 显式运行")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(await screen.findByText("已取消")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
  });

  it("配置映射按子图名称和字段别名展示", async () => {
    const workflow = {
      id: "workflow-subgraph", name: "Krea-2", fileName: "krea-2.json", originalHash: "hash",
      nodes: [{
        id: "30", type: "subgraph-krea-2", title: "Text to Image (Krea-2 Turbo)",
        fields: [{ name: "inputs.value", label: "prompt", kind: "input", valueType: "string" }],
      }],
      edges: [], inputMappings: [], outputMappings: [],
      createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/aigc/workflows/workflow-subgraph")) return new Response(JSON.stringify({ revision: "r1", workflow }));
      if (url.endsWith("/capabilities/aigc/channels")) return new Response(JSON.stringify({ channels: [] }));
      return new Response("{}");
    }));
    renderAigcPage({ page: "aigc-workflow-detail", workflowId: workflow.id });

    fireEvent.click(await screen.findByRole("button", { name: "新增入参" }));
    const nodeButton = await screen.findByRole("button", { name: "浏览节点 Text to Image (Krea-2 Turbo)" });
    expect(nodeButton).toHaveTextContent("Text to Image (Krea-2 Turbo)");
    fireEvent.click(nodeButton);
    fireEvent.click(screen.getByRole("button", { name: "选为映射节点" }));

    expect(screen.getByText("prompt")).toHaveAttribute("title", "inputs.value");
    expect(screen.getByLabelText("入参名称")).toHaveValue("prompt");
  });

  it("确认后替换原始工作流并保留当前映射", async () => {
    const workflow = {
      id: "workflow-1", name: "文生图", fileName: "old.json", originalHash: "old-hash",
      nodes: [{ id: "1", type: "KSampler", fields: [{ name: "inputs.steps", kind: "input", valueType: "int" }] }], edges: [],
      inputMappings: [{ id: "steps", name: "steps", nodeId: "1", field: "inputs.steps", type: "int", required: true }],
      outputMappings: [], createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/aigc/workflows/workflow-1/replace-preview")) {
        return new Response(JSON.stringify({ revision: "r1", confirmationToken: "checked-compatible", removedMappings: [] }));
      }
      if (url.endsWith("/aigc/workflows/workflow-1/replace") && init?.method === "POST") {
        return new Response(JSON.stringify({ revision: "r2", workflow: { ...workflow, fileName: "new.json", originalHash: "new-hash" } }));
      }
      if (url.endsWith("/aigc/workflows/workflow-1")) return new Response(JSON.stringify({ revision: "r1", workflow }));
      if (url.endsWith("/capabilities/aigc/channels")) return new Response(JSON.stringify({ channels: [] }));
      return new Response("{}");
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAigcPage({ page: "aigc-workflow-detail", workflowId: "workflow-1" });

    const replaceButton = await screen.findByRole("button", { name: "替换原始工作流" });
    expect(screen.getAllByText("old.json")).not.toHaveLength(0);
    const file = {
      name: "new.json",
      text: vi.fn(async () => JSON.stringify({ "1": { class_type: "KSampler", inputs: { steps: 30 } } })),
    } as unknown as File;
    fireEvent.change(screen.getByLabelText("替换原始工作流文件"), { target: { files: [file] } });

    expect(await screen.findByRole("heading", { name: "替换为“new.json”？" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/replace"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "确认替换" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/replace"))).toBe(true));
    const request = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/replace"));
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ revision: "r1", fileName: "new.json", confirmationToken: "checked-compatible" });
    expect(await screen.findByText("已替换原始工作流，现有映射和接口配置保持不变")).toBeInTheDocument();
    expect(screen.getAllByText("new.json").length).toBeGreaterThan(0);
    expect(replaceButton).toBeInTheDocument();
  });

  it("替换前列出所有缺失映射，取消不写入，再次检查并确认才替换", async () => {
    const workflow = {
      id: "workflow-loss", name: "文生图", fileName: "old.json", originalHash: "old-hash",
      nodes: [{ id: "1", type: "KSampler", fields: [{ name: "inputs.steps", kind: "input", valueType: "int" }] }], edges: [],
      inputMappings: [{ id: "steps", name: "步数", nodeId: "1", field: "inputs.steps", type: "int", required: true }],
      outputMappings: [], createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z",
    };
    const removedMappings = [
      { kind: "input", id: "steps", name: "步数", nodeId: "1", field: "inputs.steps", reason: "映射字段不存在" },
      { kind: "output", id: "image", name: "成品图", nodeId: "9", field: "outputs.images", reason: "映射节点不存在" },
      { kind: "input-group", id: "refs", name: "参考素材", nodeId: "8", field: "inputs.references", reason: "参数组汇总节点不存在" },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/replace-preview")) return new Response(JSON.stringify({ revision: "r1", confirmationToken: "checked-loss", removedMappings }));
      if (url.endsWith("/replace")) return new Response(JSON.stringify({ revision: "r2", workflow: { ...workflow, fileName: "new.json", inputMappings: [] } }));
      if (url.endsWith("/workflows/workflow-loss")) return new Response(JSON.stringify({ revision: "r1", workflow }));
      if (url.endsWith("/capabilities/aigc/channels")) return new Response(JSON.stringify({ channels: [] }));
      return new Response("{}");
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAigcPage({ page: "aigc-workflow-detail", workflowId: workflow.id });
    await waitFor(() => expect(screen.getByRole("button", { name: "替换原始工作流" })).toBeEnabled());
    const file = { name: "new.json", text: async () => JSON.stringify({ "1": { class_type: "KSampler", inputs: { seed: 1 } } }) } as File;
    const chooseFile = () => fireEvent.change(screen.getByLabelText("替换原始工作流文件"), { target: { files: [file] } });
    chooseFile();
    expect(await screen.findByRole("list", { name: "无法保留的映射与参数组" })).toBeInTheDocument();
    for (const label of ["入参：步数", "出参：成品图", "参数组：参考素材", "节点 1 · inputs.steps", "映射字段不存在"]) expect(screen.getByText(label)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/replace"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getAllByText("old.json").length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/replace"))).toBe(false);
    chooseFile();
    fireEvent.click(await screen.findByRole("button", { name: "移除上述映射并替换" }));
    expect(await screen.findByText("已替换原始工作流；已移除不兼容映射：步数、成品图、参考素材")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/replace-preview"))).toHaveLength(2);
    const request = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/replace"));
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ revision: "r1", confirmationToken: "checked-loss" });
  });

  it.each(["检查失败", "版本冲突", "无效 JSON"])("替换%s通过全局错误展示且保留旧工作流", async (scenario) => {
    const workflow = {
      id: "workflow-error", name: "文生图", fileName: "old.json", originalHash: "hash", nodes: [], edges: [], inputMappings: [], outputMappings: [],
      createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/replace-preview")) return scenario === "检查失败"
        ? new Response(JSON.stringify({ error: { code: "VALIDATION_FAILED", message: "无法识别 ComfyUI 工作流格式", requestId: "req-preview" } }), { status: 400 })
        : new Response(JSON.stringify({ revision: "r1", confirmationToken: "checked", removedMappings: [] }));
      if (url.endsWith("/replace")) return new Response(JSON.stringify({ error: { code: "VERSION_CONFLICT", message: "工作流版本已变化，请重新加载后检查", requestId: "req-replace" } }), { status: 409 });
      if (url.endsWith("/workflows/workflow-error")) return new Response(JSON.stringify({ revision: "r1", workflow }));
      if (url.endsWith("/capabilities/aigc/channels")) return new Response(JSON.stringify({ channels: [] }));
      return new Response("{}");
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAigcPage({ page: "aigc-workflow-detail", workflowId: workflow.id });
    await waitFor(() => expect(screen.getByRole("button", { name: "替换原始工作流" })).toBeEnabled());
    const file = { name: "new.json", text: async () => scenario === "无效 JSON" ? "{" : "{}" } as File;
    fireEvent.change(screen.getByLabelText("替换原始工作流文件"), { target: { files: [file] } });
    if (scenario === "版本冲突") fireEvent.click(await screen.findByRole("button", { name: "确认替换" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(scenario === "检查失败" ? "无法识别 ComfyUI 工作流格式" : scenario === "版本冲突" ? "工作流版本已变化" : "JSON 格式无效");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getAllByText("old.json").length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByRole("button", { name: "替换原始工作流" })).toBeEnabled());
    if (scenario !== "版本冲突") expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/replace"))).toBe(false);
  });

  it("接口详情分别保存内部 Agent 与外部 MCP 发布开关", async () => {
    const item = {
      id: "interface-1", name: "测试接口", description: "", protocol: "openai", capability: "text-to-image",
      toolDescription: "Agent-only interface instructions",
      channelId: "channel-1", enabled: true, toolPublishEnabled: false, config: { model: "test" },
      createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/aigc/interfaces/interface-1") && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ ...item, ...body }));
      }
      if (url.endsWith("/aigc/interfaces")) return new Response(JSON.stringify({ revision: "r1", interfaces: [item] }));
      if (url.endsWith("/aigc/channels")) return new Response(JSON.stringify({ channels: [] }));
      if (url.endsWith("/aigc/workflows")) return new Response(JSON.stringify({ workflows: [] }));
      return new Response("{}");
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAigcPage({ page: "aigc-interface-detail", interfaceId: item.id });
    const toolDescription = await screen.findByLabelText(/^AIGC Agent/);
    expect(toolDescription).toHaveValue("Agent-only interface instructions");
    fireEvent.change(toolDescription, { target: { value: "Updated agent instructions" } });
    await waitFor(() => expect(screen.getByLabelText("AIGC 接口名称")).toHaveValue("测试接口"));
    const publish = screen.getByRole("checkbox", { name: "发布为 Agent 工具" });
    expect(publish).not.toBeChecked();
    fireEvent.click(publish);
    const mcpPublish = screen.getByRole("checkbox", { name: "开放给外部 MCP" });
    expect(mcpPublish).not.toBeChecked();
    fireEvent.click(mcpPublish);
    fireEvent.click(screen.getByRole("button", { name: "保存接口" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    const body = JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")?.[1]?.body));
    expect(body).toMatchObject({ toolPublishEnabled: true, mcpPublishEnabled: true, toolDescription: "Updated agent instructions", channelId: item.channelId, config: item.config });
    expect(await screen.findByText("已保存 AIGC 接口")).toBeInTheDocument();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("选择已启用接口后展示提示词表单并提交生成任务", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/aigc/interfaces") {
        return new Response(JSON.stringify({
          revision: "r1",
          interfaces: [{
            id: "interface-1",
            name: "OpenAI 文生图",
            description: "标准文生图",
            protocol: "openai",
            capability: "text-to-image",
            channelId: "channel-1",
            enabled: true,
            toolPublishEnabled: false,
            config: { model: "gpt-image-1" },
            createdAt: "2026-08-17T00:00:00.000Z",
            updatedAt: "2026-08-17T00:00:00.000Z",
          }],
        }));
      }
      if (String(input) === "/api/v1/aigc/runtime-channels") {
        return new Response(JSON.stringify({ revision: "c1", credentialRevision: "k1", channels: [{ id: "channel-1", name: "OpenAI", type: "openai", baseUrl: "https://api.openai.com/v1", enabled: true, timeoutMs: 30000, hasApiKey: true }], channelTemplates: [], credentials: [] }));
      }
      if (String(input) === "/api/v1/aigc/public-files") return new Response(JSON.stringify({ files: [] }));
      if (String(input) === "/api/v1/aigc/tasks" && init?.method === "POST") {
        return new Response(JSON.stringify({
          id: "task-1",
          interfaceId: "interface-1",
          interfaceName: "OpenAI 文生图",
          channelId: "channel-1",
          status: "queued",
          inputs: { prompt: "一只在太空中的猫" },
          assets: [],
          createdAt: "2026-08-17T00:00:00.000Z",
          updatedAt: "2026-08-17T00:00:00.000Z",
        }), { status: 202 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAigcPage();

    expect(await screen.findByLabelText("AIGC 接口")).toHaveAttribute("value", "interface-1");
    expect(await screen.findByLabelText("提示词")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "创作与运行" }).closest(".aigc-run-page")).not.toHaveClass("has-readiness");
    expect(screen.queryByText("生成结果")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));
    expect(await screen.findByText("请填写 提示词")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);

    fireEvent.change(screen.getByLabelText("提示词"), { target: { value: "一只在太空中的猫" } });
    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST" && String(init.body).includes("一只在太空中的猫"))).toBe(true));
    const detailLink = await screen.findByRole("link", { name: "查看任务详情" });
    expect(detailLink).toHaveAttribute("href", "/aigc/tasks/task-1");
    fireEvent.click(detailLink);
    expect(window.location.pathname).toBe("/aigc/tasks/task-1");
  });

  it.each([
    { protocol: "openai", name: "OpenAI 图片", inputName: "参考图片（可选）" },
    { protocol: "grok", name: "Grok 图片", inputName: "图片公网地址公共文件" },
  ] as const)("$protocol 接口不展示 ComfyUI input 来源", async ({ protocol, name, inputName }) => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/aigc/interfaces") return new Response(JSON.stringify({ revision: "r1", interfaces: [{
        id: `${protocol}-image`, name, description: "", protocol, capability: "image-edit", channelId: `${protocol}-channel`, enabled: true, toolPublishEnabled: false,
        config: { model: "image-model" }, createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z",
      }] }));
      if (url === "/api/v1/aigc/runtime-channels") return new Response(JSON.stringify({ channels: [{ id: `${protocol}-channel`, name, type: protocol, enabled: true, hasApiKey: true }] }));
      if (url === "/api/v1/aigc/public-files") return new Response(JSON.stringify({ files: [] }));
      return new Response(JSON.stringify({}), { status: 200 });
    }));

    renderAigcPage({ page: "aigc-run", interfaceId: `${protocol}-image` });

    expect(await screen.findByLabelText(inputName)).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "ComfyUI input" })).not.toBeInTheDocument();
    expect(screen.queryByText("ComfyUI input")).not.toBeInTheDocument();
  });

  it("仅 ComfyUI 接口展示 ComfyUI input 来源", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/aigc/interfaces") return new Response(JSON.stringify({ revision: "r1", interfaces: [{
        id: "comfy-image", name: "ComfyUI 图片", description: "", protocol: "comfyui", capability: "image-edit", channelId: "comfy-channel", enabled: true, toolPublishEnabled: false,
        config: { workflowId: "workflow-image" }, createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z",
      }] }));
      if (url === "/api/v1/aigc/runtime-channels") return new Response(JSON.stringify({ channels: [{ id: "comfy-channel", name: "本机 ComfyUI", type: "comfyui", enabled: true, hasApiKey: false }] }));
      if (url === "/api/v1/aigc/public-files") return new Response(JSON.stringify({ files: [] }));
      if (url === "/api/v1/aigc/workflows/workflow-image") return new Response(JSON.stringify({ revision: "w1", workflow: {
        id: "workflow-image", name: "图片工作流", fileName: "image.json", originalHash: "hash",
        nodes: [{ id: "1", type: "LoadImage", title: "载入图片", fields: [] }], edges: [],
        inputMappings: [{ id: "image", name: "image", nodeId: "1", field: "inputs.image", type: "image", required: true, description: "参考图" }],
        outputMappings: [], createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z",
      } }));
      return new Response(JSON.stringify({}), { status: 200 });
    }));

    renderAigcPage({ page: "aigc-run", interfaceId: "comfy-image" });

    expect(await screen.findByRole("tab", { name: "ComfyUI input" })).toBeInTheDocument();
  });

  it("按创建时间排序、选择并批量删除任务", async () => {
    let deleted = false;
    const tasks = [
      { id: "task-old", interfaceId: "interface-1", interfaceName: "旧任务", channelId: "channel-1", status: "succeeded", assetCount: 1, createdAt: "2026-09-08T08:00:00.000Z", updatedAt: "2026-09-08T08:01:00.000Z" },
      { id: "task-new", interfaceId: "interface-1", interfaceName: "新任务", channelId: "channel-1", status: "succeeded", assetCount: 2, createdAt: "2026-09-09T08:00:00.000Z", updatedAt: "2026-09-09T08:01:00.000Z" },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/aigc/tasks" && init?.method === "DELETE") {
        deleted = true;
        return new Response(JSON.stringify({ removedIds: ["task-old", "task-new"] }));
      }
      if (url === "/api/v1/aigc/tasks") return new Response(JSON.stringify({ tasks: deleted ? [] : tasks }));
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAigcPage({ page: "aigc-tasks" });

    await screen.findByText("新任务");
    expect(screen.getAllByRole("checkbox").map((checkbox) => checkbox.getAttribute("aria-label"))).toEqual([
      "选择任务 task-new",
      "选择任务 task-old",
    ]);
    chooseOption("任务创建时间排序", "asc");
    expect(screen.getAllByRole("checkbox").map((checkbox) => checkbox.getAttribute("aria-label"))).toEqual([
      "选择任务 task-old",
      "选择任务 task-new",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    fireEvent.click(screen.getByRole("button", { name: "删除选中（2）" }));
    expect(screen.getByText(/Agent 工作目录的附件会保留/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除选中" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true));
    const request = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE");
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ ids: ["task-old", "task-new"] });
    expect(await screen.findByText(/已删除 2 个任务/)).toBeInTheDocument();
  });

  it("全选超过单次上限时自动分批删除", async () => {
    let tasks = Array.from({ length: AIGC_TASK_BULK_DELETE_LIMIT + 1 }, (_, index) => ({
      id: `task-${index}`,
      interfaceId: "interface-1",
      interfaceName: `任务 ${index}`,
      channelId: "channel-1",
      status: "succeeded",
      assetCount: 0,
      createdAt: "2026-09-17T08:00:00.000Z",
      updatedAt: "2026-09-17T08:01:00.000Z",
    }));
    const deletedBatches: string[][] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/aigc/tasks" && init?.method === "DELETE") {
        const ids = (JSON.parse(String(init.body)) as { ids: string[] }).ids;
        deletedBatches.push(ids);
        const removed = new Set(ids);
        tasks = tasks.filter((task) => !removed.has(task.id));
        return new Response(JSON.stringify({ removedIds: ids }));
      }
      if (url === "/api/v1/aigc/tasks") return new Response(JSON.stringify({ tasks }));
      return new Response(JSON.stringify({}), { status: 200 });
    }));
    renderAigcPage({ page: "aigc-tasks" });

    await screen.findByText("任务 0");
    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    fireEvent.click(screen.getByRole("button", { name: `删除选中（${AIGC_TASK_BULK_DELETE_LIMIT + 1}）` }));
    // 在确认框内查询，避免对 501 张任务卡片逐个计算可访问名称。
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "删除选中" }));

    await waitFor(() => expect(deletedBatches).toHaveLength(2));
    expect(deletedBatches.map((batch) => batch.length)).toEqual([AIGC_TASK_BULK_DELETE_LIMIT, 1]);
    expect(await screen.findByText(`已删除 ${AIGC_TASK_BULK_DELETE_LIMIT + 1} 个任务及其 AIGC 产物，Agent 工作目录附件已保留`)).toBeInTheDocument();
  });

  it("批量删除失败时通过全局错误弹窗展示服务端错误", async () => {
    const tasks = [{
      id: "task-1",
      interfaceId: "interface-1",
      interfaceName: "失败任务",
      channelId: "channel-1",
      status: "succeeded",
      assetCount: 0,
      createdAt: "2026-09-17T08:00:00.000Z",
      updatedAt: "2026-09-17T08:01:00.000Z",
    }];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/aigc/tasks" && init?.method === "DELETE") {
        return new Response(JSON.stringify({
          error: {
            code: "VALIDATION_FAILED",
            message: `AIGC 批量删除任务参数无效，单次最多删除 ${AIGC_TASK_BULK_DELETE_LIMIT} 个任务`,
            requestId: "request-bulk-delete",
          },
        }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/v1/aigc/tasks") return new Response(JSON.stringify({ tasks }));
      return new Response(JSON.stringify({}), { status: 200 });
    }));
    renderAigcPage({ page: "aigc-tasks" });

    await screen.findByText("失败任务");
    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    fireEvent.click(screen.getByRole("button", { name: "删除选中（1）" }));
    fireEvent.click(screen.getByRole("button", { name: "删除选中" }));

    expect(await screen.findByText("删除选中的 AIGC 任务失败")).toBeInTheDocument();
    expect(screen.getByText(`AIGC 批量删除任务参数无效，单次最多删除 ${AIGC_TASK_BULK_DELETE_LIMIT} 个任务`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看错误详情" }));
    expect(screen.getByText("request-bulk-delete")).toBeInTheDocument();
  });

});
