import { chooseOption } from "../test-select";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiClientError } from "../api";
import { NAVIGATION_BEFORE_EVENT } from "../router";
import { ErrorToastProvider } from "../error-toast-provider";
import { ApiTaskProvider } from "../api-task-provider";
import { KnowledgeRetrievalPage } from "./knowledge-retrieval-page";
import { ConfigurationOperationsPage } from "./configuration-operations-page";
import { ConfigurationOverviewPage } from "./configuration-overview-page";
import { BrowserAutomationPage } from "./browser-automation-page";
import { DEFAULT_BROWSER_AUTOMATION_CONFIG } from "../../shared/browser-automation-contracts";
import type { ReactNode } from "react";

/** 所有 API 均以虚构数据模拟，不执行真实索引或历史恢复。 */
function show(child: ReactNode) { return render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={() => undefined}>{child}</ApiTaskProvider></ErrorToastProvider>); }
const embedding = () => ({ revision: "r1", config: { baseUrl: "https://embedding.example/v1", model: "example", batchSize: 32, enabled: true, isManaged: false, hasApiKey: true }, managed: { available: true, baseUrl: "http://embedding.internal/v1", model: "managed-model", maxBatchSize: 4 } });
const browser = () => ({ revision: "r1", config: structuredClone(DEFAULT_BROWSER_AUTOMATION_CONFIG), deployment: { available: true, workerAvailable: true, chromiumReady: true, activeContexts: 1, queuedRequests: 2 } });
const entry = { id: "h1", summary: "更新全局设置", createdAt: "2026-10-09T00:00:00Z", scope: "global" as const, outcome: "success" as const, restorable: true };
beforeEach(() => { localStorage.clear(); Object.defineProperty(navigator, "onLine", { value: true, configurable: true }); });
afterEach(() => { vi.restoreAllMocks(); });

describe("配置维护页面交互", () => {
  it("查看密钥不生成草稿，模式与批次修改阻止旧配置重建，跨分区保留", async () => {
    vi.spyOn(api, "getKnowledgeRetrieval").mockResolvedValue(embedding());
    vi.spyOn(api, "getKnowledgeRetrievalCredential").mockResolvedValue({ apiKey: "example-test-value" });
    show(<KnowledgeRetrievalPage />); await screen.findByLabelText("服务模式");
    fireEvent.click(screen.getByRole("button", { name: "显示Embedding API Key" })); await waitFor(() => expect(screen.getByLabelText("Embedding API Key")).toHaveValue("example-test-value"));
    expect(screen.getByRole("button", { name: "保存连接配置" })).toBeDisabled();
    chooseOption("服务模式", "managed");
    expect(screen.getByLabelText("每批切片数")).toHaveValue(4);
    fireEvent.click(screen.getByRole("tab", { name: "索引维护" })); expect(screen.getByRole("button", { name: "手动重建索引" })).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: "连接配置" })); expect(screen.getByLabelText("服务模式")).toHaveAttribute("value", "managed");
  });
  it("语义配置冲突保留草稿，重新读取必须先明确放弃", async () => {
    vi.spyOn(api, "getKnowledgeRetrieval").mockResolvedValue(embedding());
    vi.spyOn(api, "updateKnowledgeRetrieval").mockRejectedValue(new ApiClientError("VERSION_CONFLICT", "版本已变化", 409));
    show(<KnowledgeRetrievalPage />); await screen.findByLabelText("Embedding 模型");
    fireEvent.change(screen.getByLabelText("Embedding 模型"), { target: { value: "changed" } }); fireEvent.click(screen.getByRole("button", { name: "保存连接配置" }));
    await screen.findByText(/版本已变化/); expect(screen.getByLabelText("Embedding 模型")).toHaveValue("changed");
    fireEvent.click(screen.getByRole("button", { name: "重新读取配置" })); expect(screen.getByRole("dialog", { name: "还有未保存的修改" })).toBeInTheDocument();
  });
  it("部分重建失败保留具体对象和全局错误，不宣称所有索引最新", async () => {
    vi.spyOn(api, "getKnowledgeRetrieval").mockResolvedValue(embedding());
    vi.spyOn(api, "rebuildKnowledgeRetrieval").mockResolvedValue({ totalBases: 2, rebuiltBases: 1, failedBases: ["b2"], failures: [{ baseId: "b2", message: "Embedding 上游 HTTP 503" }] });
    show(<KnowledgeRetrievalPage />); await screen.findByLabelText("服务模式"); fireEvent.click(screen.getByRole("tab", { name: "索引维护" })); fireEvent.click(screen.getByRole("button", { name: "手动重建索引" })); fireEvent.click(screen.getByRole("button", { name: "开始重建" }));
    await screen.findByText("已重建 1 / 2 个知识库。"); expect(screen.getAllByText(/Embedding 上游 HTTP 503/).length).toBeGreaterThan(0); expect(screen.getByRole("button", { name: "查看错误详情" })).toBeInTheDocument();
  });
  it("导入输入改变后旧预览失效，失败保留输入且禁止重放旧预览", async () => {
    vi.spyOn(api, "listConfigurationHistory").mockResolvedValue({ entries: [] });
    vi.spyOn(api, "previewConfigurationImport").mockResolvedValue({ previewId: "p1", added: [], changed: ["models"], conflicts: [], invalid: [] });
    const apply = vi.spyOn(api, "applyConfigurationImport").mockRejectedValue(new ApiClientError("IMPORT_PREVIEW_EXPIRED", "预览已过期", 409));
    show(<ConfigurationOperationsPage />); fireEvent.change(screen.getByLabelText("配置 JSON 内容"), { target: { value: '{"providers":{}}' } });
    fireEvent.click(screen.getByRole("button", { name: "生成预览" })); await screen.findByRole("button", { name: "确认并应用" });
    fireEvent.change(screen.getByLabelText("配置 JSON 内容"), { target: { value: '{"providers":{},"version":1}' } }); expect(screen.queryByRole("button", { name: "确认并应用" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "生成预览" })); fireEvent.click(await screen.findByRole("button", { name: "确认并应用" })); fireEvent.click(screen.getByRole("button", { name: "确认执行" })); await screen.findByText("预览已过期");
    expect(screen.getByLabelText("配置 JSON 内容")).toHaveValue('{"providers":{},"version":1}'); expect(screen.queryByRole("button", { name: "确认并应用" })).not.toBeInTheDocument(); expect(apply).toHaveBeenCalledTimes(1);
  });
  it("恢复绑定审阅版本，不重新读取最新版本绕过并发修改", async () => {
    vi.spyOn(api, "listConfigurationHistory").mockResolvedValue({ entries: [entry] });
    vi.spyOn(api, "previewConfigurationRestore").mockResolvedValue({ id: "h1", scope: "global", revision: "reviewed-r1", differences: [{ field: "defaultThinkingLevel", current: "medium", restored: "high" }] });
    const restore = vi.spyOn(api, "restoreConfigurationHistory").mockRejectedValue(new ApiClientError("VERSION_CONFLICT", "审阅后配置已变", 409));
    const latest = vi.spyOn(api, "getGlobalSettings");
    show(<ConfigurationOperationsPage />); fireEvent.click(screen.getByRole("tab", { name: "变更历史" })); fireEvent.click(await screen.findByRole("button", { name: "查看恢复差异" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认恢复该目标设置" })); fireEvent.click(screen.getByRole("button", { name: "确认执行" })); await waitFor(() => expect(restore).toHaveBeenCalledWith("h1", "reviewed-r1"));
    expect(latest).not.toHaveBeenCalled(); await screen.findByRole("button", { name: "重新读取差异" });
  });
  it("概览局部读取失败显示具体错误，其他计数保留且入口完整", async () => {
    vi.spyOn(api, "getConfigurationOverview").mockResolvedValue({ readAt: "2026-10-09T00:00:00Z", entries: [{ key: "providers", summary: "2 个 Provider" }, { key: "tts", error: { message: "语音配置 HTTP 503", requestId: "overview" } }] });
    const go = vi.fn(); show(<ConfigurationOverviewPage onNavigate={go} />); await screen.findByText("2 个 Provider");
    for (const name of ["浏览器执行", "语义检索", "导入与变更", "AIGC 渠道"]) expect(screen.getByRole("button", { name: new RegExp(name) })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /浏览器执行/ })); expect(go).toHaveBeenCalledWith({ page: "browser-automation" });
    expect(screen.getByRole("button", { name: "重试语音合成摘要" })).toBeInTheDocument(); expect(screen.getByRole("button", { name: "查看错误详情" })).toBeInTheDocument();
  });
  it("运行状态刷新不覆盖浏览草稿，保存后维护错误不重试写入", async () => {
    vi.spyOn(api, "getBrowserAutomation").mockResolvedValue(browser());
    const save = vi.spyOn(api, "updateBrowserAutomation").mockImplementation(async (_, config) => ({ ...browser(), revision: "r2", config, runtimeRefreshRequired: true, postCommitError: { message: "Runtime HTTP 503，配置已保存", requestId: "browser" } }));
    show(<BrowserAutomationPage />); await screen.findByLabelText("导航超时（秒）"); fireEvent.change(screen.getByLabelText("导航超时（秒）"), { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: "刷新状态" })); await waitFor(() => expect(screen.getByRole("button", { name: "保存浏览器设置" })).toBeEnabled()); expect(screen.getByLabelText("导航超时（秒）")).toHaveValue(40);
    fireEvent.click(screen.getByRole("button", { name: "保存浏览器设置" })); await screen.findAllByText("Runtime HTTP 503，配置已保存"); expect(screen.getByRole("button", { name: "保存浏览器设置" })).toBeDisabled(); expect(save).toHaveBeenCalledTimes(1);
  });
  it("未加入草稿的 Origin 输入也保护站内导航，关闭只丢弃该输入", async () => {
    vi.spyOn(api, "getBrowserAutomation").mockResolvedValue(browser());
    show(<BrowserAutomationPage />); await screen.findByLabelText("导航超时（秒）");
    fireEvent.change(screen.getByLabelText("导航超时（秒）"), { target: { value: "40" } });
    fireEvent.click(screen.getByRole("tab", { name: "交互权限" })); fireEvent.click(screen.getByRole("button", { name: "添加 Origin" }));
    fireEvent.change(screen.getByRole("textbox", { name: "新增受信任 Origin" }), { target: { value: "https://draft.example" } });
    const navigation = new CustomEvent(NAVIGATION_BEFORE_EVENT, { cancelable: true, detail: { page: "configuration-overview" } });
    act(() => window.dispatchEvent(navigation)); expect(navigation.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" })); expect(screen.getByRole("textbox", { name: "新增受信任 Origin" })).toHaveValue("https://draft.example");
    fireEvent.click(screen.getByRole("button", { name: "关闭 Origin 编辑" })); fireEvent.click(screen.getByRole("button", { name: "放弃 Origin 输入" }));
    fireEvent.click(screen.getByRole("tab", { name: "浏览范围" })); expect(screen.getByLabelText("导航超时（秒）")).toHaveValue(40);
  });
  it("离线浏览器缓存不制造运行状态，保存禁用", async () => {
    const value = browser(); localStorage.setItem("bugpaw:browser-automation:offline:v1", JSON.stringify({ revision: value.revision, config: value.config }));
    vi.spyOn(api, "getBrowserAutomation").mockRejectedValue(new ApiClientError("INTERNAL_ERROR", "读取浏览器服务 HTTP 503", 503));
    show(<BrowserAutomationPage />); await screen.findByText(/配置快照不包含实时服务状态/);
    expect(screen.getAllByText("未知", { exact: true })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "保存浏览器设置" })).toBeDisabled(); expect(screen.getByRole("button", { name: "查看错误详情" })).toBeInTheDocument();
  });

});
