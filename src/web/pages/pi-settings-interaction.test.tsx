import { chooseOption } from "../test-select";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentProfileDocument } from "../../shared/agent-contracts";
import type { ScopedConfigDocument, WebPiSettings } from "../../shared/configuration-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiClientError } from "../api";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { PiSettingsPage } from "./pi-settings-page";

/** 虚构作用域文档用于验证表单、来源与保存边界，不读取生产配置。 */
const global: ScopedConfigDocument<WebPiSettings> = {
  revision: "g1", own: { defaultProvider: "demo", defaultModel: "model", defaultThinkingLevel: "medium", retry: { maxRetries: 3 }, httpProxy: "http://proxy.example.test", packages: [{ source: "demo-package", extensions: ["entry.ts"] }], thinkingBudgets: { high: 2048 } },
  effective: {}, diagnostics: [],
};
global.effective = structuredClone(global.own);
const agent: ScopedConfigDocument<WebPiSettings> = {
  revision: "a1", own: { defaultThinkingLevel: "high", retry: { maxRetries: 7 }, httpProxy: "http://legacy.example.test" }, inherited: global.own,
  effective: { ...global.effective, defaultThinkingLevel: "high", retry: { maxRetries: 7 } }, diagnostics: [],
};
/** 使用应用原有错误入口验证配置请求，不隔离掉错误通知行为。 */
function show() { return render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={() => undefined}><PiSettingsPage /></ApiTaskProvider></ErrorToastProvider>); }
/** 当前页签保留草稿，辅助操作按用户实际入口执行。 */
function tab(name: string) { fireEvent.click(screen.getByRole("tab", { name: new RegExp(name) })); }

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(api, "getGlobalSettings").mockResolvedValue(structuredClone(global));
  vi.spyOn(api, "getAgentSettings").mockResolvedValue(structuredClone(agent));
  vi.spyOn(api, "listAgents").mockResolvedValue({ agents: [{ profile: { id: "a", name: "示例助手" } } as AgentProfileDocument] });
  vi.spyOn(api, "listModels").mockResolvedValue({ models: [] });
});
afterEach(() => vi.restoreAllMocks());

describe("运行设置分区与继承", () => {
  it("应用任务回调变化不重读设置或丢失草稿", async () => {
    const view = show(); await screen.findByLabelText("默认思考等级");
    chooseOption("默认思考等级", "high");
    view.rerender(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={() => Promise.resolve()}><PiSettingsPage /></ApiTaskProvider></ErrorToastProvider>);
    await act(async () => undefined);
    expect(screen.getByLabelText("默认思考等级")).toHaveAttribute("value", "high");
    expect(api.getGlobalSettings).toHaveBeenCalledTimes(1);
    expect(api.listAgents).toHaveBeenCalledTimes(1);
  });

  it("Agent 目录延迟完成不触发全局重载或清空已输入草稿", async () => {
    let resolveDirectory!: (value: Awaited<ReturnType<typeof api.listAgents>>) => void;
    vi.mocked(api.listAgents).mockReturnValue(new Promise((resolve) => { resolveDirectory = resolve; }));
    show(); await screen.findByLabelText("默认思考等级");
    chooseOption("默认思考等级", "high");
    await act(async () => resolveDirectory({ agents: [{ profile: { id: "a", name: "示例助手" } } as AgentProfileDocument] }));
    expect(screen.getByLabelText("默认思考等级")).toHaveAttribute("value", "high");
    expect(api.getGlobalSettings).toHaveBeenCalledTimes(1);
  });

  it("跨分区保存同一草稿并保留未展示字段与结构化资源", async () => {
    const save = vi.spyOn(api, "updateGlobalSettings").mockResolvedValue({ ...global, revision: "g2", runtimeRefreshRequired: true });
    show(); await screen.findByLabelText("默认思考等级");
    chooseOption("默认思考等级", "low");
    tab("执行策略"); fireEvent.change(screen.getByLabelText("最大重试次数"), { target: { value: "4" } });
    tab("高级设置"); expect(screen.getByLabelText("Packages JSON")).toHaveValue(JSON.stringify(global.own.packages, null, 2));
    tab("常用设置"); expect(screen.getByLabelText("默认思考等级")).toHaveAttribute("value", "low");
    fireEvent.click(screen.getByRole("button", { name: "保存全局设置" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("g1", expect.objectContaining({ defaultThinkingLevel: "low", retry: { maxRetries: 4 }, packages: global.own.packages, thinkingBudgets: { high: 2048 } }), []));
    expect(screen.getByText("配置已保存，等待应用")).toBeInTheDocument();
  });

  it("恢复继承立即显示全局声明并显式删除覆盖，重新覆盖不会复制旧值", async () => {
    const save = vi.spyOn(api, "updateAgentSettings").mockResolvedValue({ ...agent, own: {}, runtimeRefreshRequired: false });
    show(); await screen.findByLabelText("默认思考等级");
    fireEvent.click(screen.getByRole("button", { name: "Agent 覆盖" }));
    await waitFor(() => expect(screen.getByLabelText("默认思考等级")).toHaveAttribute("value", "high"));
    fireEvent.click(screen.getByLabelText("默认思考等级继承全局设置"));
    expect(screen.getByLabelText("默认思考等级")).toHaveAttribute("value", "medium");
    expect(screen.getByLabelText("默认思考等级")).toBeDisabled();
    fireEvent.click(screen.getByLabelText("默认思考等级继承全局设置"));
    expect(screen.getByLabelText("默认思考等级")).toHaveAttribute("value", "medium");
    fireEvent.click(screen.getByLabelText("默认思考等级继承全局设置"));
    fireEvent.click(screen.getByRole("button", { name: "保存 Agent 覆盖" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("a", "a1", { retry: { maxRetries: 7 } }, ["defaultThinkingLevel"]));
    expect(screen.getByText("本次已保存配置已应用")).toBeInTheDocument();
  });

  it("缺省布尔值不冒充关闭，Agent 新覆盖必须选择明确值", async () => {
    const save = vi.spyOn(api, "updateAgentSettings");
    show(); await screen.findByLabelText("隐藏思考块");
    expect(screen.getByLabelText("隐藏思考块")).toHaveAttribute("value", "");
    fireEvent.click(screen.getByRole("button", { name: "Agent 覆盖" }));
    await screen.findByLabelText("隐藏思考块继承全局设置");
    fireEvent.click(screen.getByLabelText("隐藏思考块继承全局设置"));
    expect(screen.getByLabelText("隐藏思考块")).toHaveAttribute("value", "");
    fireEvent.click(screen.getByRole("button", { name: "保存 Agent 覆盖" }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getAllByText(/隐藏思考块尚未选择覆盖值/).length).toBeGreaterThan(0);
    expect(document.querySelector(".error-toast-viewport")).toBeInTheDocument();
  });

  it("清空数字不会写成零，恢复原数字取消脏状态", async () => {
    const save = vi.spyOn(api, "updateGlobalSettings");
    show(); await screen.findByLabelText("默认思考等级"); tab("执行策略");
    fireEvent.change(screen.getByLabelText("最大重试次数"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存全局设置" }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByLabelText("最大重试次数")).toHaveDisplayValue("");
    fireEvent.change(screen.getByLabelText("最大重试次数"), { target: { value: "3" } });
    expect(screen.getByRole("button", { name: "保存全局设置" })).toBeDisabled();
  });

  it("高级 JSON 无效时保存并切换保留输入，修正后提交结构化对象", async () => {
    const save = vi.spyOn(api, "updateGlobalSettings").mockResolvedValue({ ...global, revision: "g2" });
    show(); await screen.findByLabelText("默认思考等级"); tab("高级设置");
    fireEvent.change(screen.getByLabelText("Packages JSON"), { target: { value: '[{"source":' } });
    fireEvent.click(screen.getByRole("button", { name: "Agent 覆盖" }));
    fireEvent.click(screen.getByRole("button", { name: "保存并切换" }));
    await screen.findByText(/尚未完成保存/);
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Packages JSON")).toHaveValue('[{"source":');
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    fireEvent.change(screen.getByLabelText("Packages JSON"), { target: { value: '[{"source":"demo-new","extensions":["test.ts"]}]' } });
    fireEvent.click(screen.getByRole("button", { name: "保存全局设置" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("g1", expect.objectContaining({ packages: [{ source: "demo-new", extensions: ["test.ts"] }] }), []));
  });

  it("全局默认模型恢复核心缺省时成对删除 Provider 与模型", async () => {
    const save = vi.spyOn(api, "updateGlobalSettings").mockResolvedValue(global);
    show(); await screen.findByLabelText("默认模型");
    chooseOption("默认模型", "");
    fireEvent.click(screen.getByRole("button", { name: "保存全局设置" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("g1", expect.not.objectContaining({ defaultProvider: expect.anything(), defaultModel: expect.anything() }), ["defaultProvider", "defaultModel"]));
  });

  it("保存失败保留当前作用域与草稿，通知显示具体服务错误", async () => {
    vi.spyOn(api, "updateGlobalSettings").mockRejectedValue(new ApiClientError("INTERNAL_ERROR", "运行设置持久化时存储不可用", 500));
    show(); await screen.findByLabelText("默认思考等级");
    chooseOption("默认思考等级", "high");
    fireEvent.click(screen.getByRole("button", { name: "Agent 覆盖" }));
    fireEvent.click(screen.getByRole("button", { name: "保存并切换" }));
    await screen.findByText(/尚未完成保存/);
    expect(screen.getByLabelText("默认思考等级")).toHaveAttribute("value", "high");
    expect(screen.getByRole("button", { name: "全局设置" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByText("运行设置持久化时存储不可用").length).toBeGreaterThan(0);
  });

  it("冲突重新应用再次冲突时更新 revision，保留数值原始输入", async () => {
    const save = vi.spyOn(api, "updateGlobalSettings").mockRejectedValueOnce(new ApiClientError("VERSION_CONFLICT", "配置版本变化", 409)).mockRejectedValueOnce(new ApiClientError("VERSION_CONFLICT", "再次变化", 409)).mockResolvedValueOnce({ ...global, revision: "g4" });
    vi.mocked(api.getGlobalSettings).mockResolvedValueOnce(global).mockResolvedValueOnce({ ...global, revision: "g2" }).mockResolvedValueOnce({ ...global, revision: "g3" });
    show(); await screen.findByLabelText("默认思考等级"); tab("执行策略");
    fireEvent.change(screen.getByLabelText("最大重试次数"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "保存全局设置" }));
    const dialog = await screen.findByRole("dialog", { name: "配置已在磁盘上发生变化" });
    fireEvent.click(within(dialog).getByRole("button", { name: "在新版本上重新应用" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("g2", expect.objectContaining({ retry: { maxRetries: 5 } }), []));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "在新版本上重新应用" })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "在新版本上重新应用" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("g3", expect.objectContaining({ retry: { maxRetries: 5 } }), []));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("读取失败有重试，目录为空不会永远显示加载中", async () => {
    vi.mocked(api.getGlobalSettings).mockRejectedValueOnce(new ApiClientError("INTERNAL_ERROR", "读取全局配置时连接中断", 500)).mockResolvedValueOnce(global);
    vi.mocked(api.listAgents).mockResolvedValue({ agents: [] });
    show(); fireEvent.click(await screen.findByRole("button", { name: "重新加载运行设置" }));
    await screen.findByLabelText("默认思考等级");
    fireEvent.click(screen.getByRole("button", { name: "Agent 覆盖" }));
    expect(await screen.findByText("还没有 Agent")).toBeInTheDocument();
    expect(screen.queryByText("正在加载设置…")).not.toBeInTheDocument();
  });

  it("Agent 目录错误不能伪装为空态，模型目录错误保留未发现的当前模型", async () => {
    vi.mocked(api.listAgents).mockRejectedValue(new ApiClientError("INTERNAL_ERROR", "读取 Agent 目录时存储不可用", 500));
    vi.mocked(api.listModels).mockRejectedValue(new ApiClientError("INTERNAL_ERROR", "读取模型目录时服务不可用", 500));
    show(); await screen.findByRole("button", { name: "重新加载 Agent 目录" });
    expect(screen.queryByText("还没有 Agent")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "重新加载模型目录" })).toBeInTheDocument();
    expect(screen.getByLabelText("默认模型")).toHaveAttribute("value", JSON.stringify(["demo", "model"]));
  });
});
