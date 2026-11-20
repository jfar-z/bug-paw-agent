import { chooseOption } from "../test-select";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProfileDocument } from "../../shared/agent-contracts";
import type { AigcSettingsDocument } from "../../shared/aigc-contracts";
import { api, ApiClientError } from "../api";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { ConfigurationEffectNotice, recordConfigurationSave, confirmConfigurationRefresh, configurationRefreshGeneration } from "../components/configuration/configuration-effect-notice";
import { navigateTo } from "../router";
import { TtsPage } from "./tts-page";
import { ProvidersPage } from "./providers-page";
import { PiSettingsPage } from "./pi-settings-page";
import { AigcChannelsPage } from "./aigc-channels-page";
import { ResourcesPage } from "./resources-page";

const authRequired = vi.fn();
/** 测试只使用虚构配置与内存 API，不读取任何生产数据。 */
function show(children: ReactNode) {
  return render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={authRequired}>{children}</ApiTaskProvider></ErrorToastProvider>);
}
const voice = { id: "speech-a", name: "语音 A", baseUrl: "https://example.test/v1", model: "speech", voice: "alloy", responseFormat: "mp3" as const, customParameters: {}, hasApiKey: true };
const voiceB = { ...voice, id: "speech-b", name: "语音 B" };
const providerA = { name: "Provider A", baseUrl: "https://a.example.test/v1", api: "openai-completions", models: [] };
const providerB = { ...providerA, name: "Provider B" };
const providerDocument = { revision: "r1", credentialRevision: "c1", credentials: [], diagnostics: [], value: { providers: { a: providerA, b: providerB } } };

beforeEach(() => { window.localStorage.clear(); window.history.replaceState({}, "", "/settings/capabilities/tts"); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("配置快速交互改进", () => {
  it("语音新增与编辑有独立标题和提交动作，空列表不会自动新建", async () => {
    vi.spyOn(api, "getTtsProfiles").mockResolvedValue({ revision: "r1", profiles: [] });
    show(<TtsPage />);
    expect(await screen.findByText("尚未配置语音模型")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "创建语音配置" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "新增语音配置" }));
    expect(screen.getByRole("heading", { name: "新增语音配置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建语音配置" })).toBeInTheDocument();
  });

  it("语音关闭前保存失败保留字段、凭证与高级 JSON，重试成功才关闭", async () => {
    vi.spyOn(api, "getTtsProfiles").mockResolvedValue({ revision: "r1", profiles: [voice, voiceB] });
    const save = vi.spyOn(api, "updateTtsProfile").mockRejectedValueOnce(new ApiClientError("VALIDATION_FAILED", "语音模型配置校验未通过", 400))
      .mockResolvedValueOnce({ revision: "r2", profile: { ...voice, voice: "nova", customParameters: { speed: 1.2 } } });
    show(<TtsPage />);
    const edit = await screen.findByRole("button", { name: "编辑语音 A" });
    edit.focus(); fireEvent.click(edit);
    fireEvent.change(screen.getByLabelText("音色"), { target: { value: "nova" } });
    fireEvent.change(screen.getByLabelText("TTS API Key"), { target: { value: "fictional-test-key" } });
    fireEvent.change(screen.getByLabelText("TTS 自定义请求参数"), { target: { value: '{"speed":1.2}' } });
    fireEvent.click(screen.getByRole("button", { name: "关闭语音配置编辑" }));
    const dialog = screen.getByRole("dialog", { name: "还有未保存的修改" });
    expect(within(dialog).getByRole("button", { name: "继续编辑" })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "保存并切换" }));
    await screen.findByText(/尚未完成保存/);
    expect(screen.getByLabelText("音色")).toHaveValue("nova");
    expect(screen.getByLabelText("TTS API Key")).toHaveValue("fictional-test-key");
    fireEvent.click(within(dialog).getByRole("button", { name: "保存并切换" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(save).toHaveBeenLastCalledWith("speech-a", "r1", expect.objectContaining({ voice: "nova", apiKey: "fictional-test-key", customParameters: { speed: 1.2 } }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("显示已保存密钥不产生脏草稿，离开页面的放弃与继续操作明确", async () => {
    vi.spyOn(api, "getTtsProfiles").mockResolvedValue({ revision: "r1", profiles: [voice, voiceB] });
    vi.spyOn(api, "getTtsProfileCredential").mockResolvedValue({ apiKey: "fictional-existing-key" });
    show(<TtsPage />);
    const edit = await screen.findByRole("button", { name: "编辑语音 A" });
    edit.focus(); fireEvent.click(edit);
    fireEvent.click(screen.getByRole("button", { name: "显示TTS API Key" }));
    await waitFor(() => expect(screen.getByLabelText("TTS API Key")).toHaveValue("fictional-existing-key"));
    fireEvent.click(screen.getByRole("button", { name: "关闭语音配置编辑" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑语音 B" }));
    fireEvent.change(screen.getByLabelText("音色"), { target: { value: "nova" } });
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    act(() => navigateTo({ page: "diagnostics" }));
    expect(window.location.pathname).toBe("/settings/capabilities/tts");
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(screen.getByLabelText("音色")).toHaveValue("nova");
    act(() => navigateTo({ page: "diagnostics" }));
    fireEvent.click(screen.getByRole("button", { name: "放弃并切换" }));
    expect(window.location.pathname).toBe("/settings/diagnostics");
  });

  it("新建语音使用保存响应中的对象，不重新读取列表或误选末项", async () => {
    const list = vi.spyOn(api, "getTtsProfiles").mockResolvedValue({ revision: "r1", profiles: [voice] });
    vi.spyOn(api, "createTtsProfile").mockResolvedValue({ revision: "r2", profile: voiceB });
    show(<TtsPage />);
    await screen.findByRole("button", { name: "编辑语音 A" });
    fireEvent.click(screen.getByRole("button", { name: "新增语音配置" }));
    fireEvent.change(screen.getByLabelText("配置名称"), { target: { value: voiceB.name } });
    fireEvent.click(screen.getByRole("button", { name: "创建语音配置" }));
    await screen.findByRole("button", { name: "编辑语音 B" });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("Provider 切换前保存配置和凭证，凭证失败不会回滚配置 revision 或丢失密钥", async () => {
    vi.spyOn(api, "listProviders").mockResolvedValue(providerDocument);
    const config = vi.spyOn(api, "saveProvider").mockResolvedValue({ revision: "r2", diagnostics: [], value: { providers: { a: { ...providerA, name: "新名称" }, b: providerB } } });
    const credential = vi.spyOn(api, "saveProviderCredential").mockRejectedValueOnce(new ApiClientError("INVALID_CREDENTIAL", "凭证格式校验未通过", 400))
      .mockResolvedValueOnce({ credentialRevision: "c2", status: { providerId: "a", type: "api_key", configured: true } });
    show(<ProvidersPage />);
    fireEvent.click(await screen.findByRole("button", { name: "管理 Provider Provider A" }));
    await screen.findByDisplayValue("Provider A");
    fireEvent.change(screen.getByDisplayValue("Provider A"), { target: { value: "新名称" } });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "fictional-new-key" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭 Provider 管理" }));
    fireEvent.click(screen.getByRole("button", { name: "保存并切换" }));
    await screen.findByText(/尚未完成保存/);
    expect(screen.getByDisplayValue("新名称")).toBeInTheDocument();
    expect(screen.getByLabelText("API Key")).toHaveValue("fictional-new-key");
    fireEvent.click(screen.getByRole("button", { name: "保存并切换" }));
    fireEvent.click(await screen.findByRole("button", { name: "管理 Provider Provider B" }));
    await screen.findByDisplayValue("Provider B");
    expect(config).toHaveBeenCalledTimes(1);
    expect(credential).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "关闭 Provider 管理" }));
    fireEvent.click(screen.getByRole("button", { name: "管理 Provider 新名称" }));
    fireEvent.change(screen.getByDisplayValue("新名称"), { target: { value: "再改名称" } });
    fireEvent.click(screen.getByRole("button", { name: "保存连接与模型" }));
    await waitFor(() => expect(config).toHaveBeenLastCalledWith("a", "r2", expect.anything()));
  });

  it("Provider 高级 JSON 无效时禁止保存并切换，修正内容可以继续保存", async () => {
    vi.spyOn(api, "listProviders").mockResolvedValue(providerDocument);
    const save = vi.spyOn(api, "saveProvider").mockResolvedValue({ revision: "r2", diagnostics: [], value: providerDocument.value });
    show(<ProvidersPage />);
    fireEvent.click(await screen.findByRole("button", { name: "管理 Provider Provider A" }));
    await screen.findByDisplayValue("Provider A");
    fireEvent.change(screen.getByLabelText("Provider 高级 JSON"), { target: { value: '{"models":' } });
    fireEvent.click(screen.getByRole("button", { name: "关闭 Provider 管理" }));
    fireEvent.click(screen.getByRole("button", { name: "保存并切换" }));
    await screen.findByText(/尚未完成保存/);
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Provider 高级 JSON")).toHaveValue('{"models":');
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    fireEvent.change(screen.getByLabelText("Provider 高级 JSON"), { target: { value: JSON.stringify({ ...providerA, name: "JSON 新名称" }) } });
    fireEvent.click(screen.getByRole("button", { name: "保存连接与模型" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("a", "r1", expect.objectContaining({ name: "JSON 新名称" })));
  });

  it("运行设置作用域切换先保存，版本冲突时保留原作用域和草稿", async () => {
    const global = { revision: "r1", own: { defaultThinkingLevel: "medium" as const }, effective: { defaultThinkingLevel: "medium" as const }, diagnostics: [] };
    vi.spyOn(api, "getGlobalSettings").mockResolvedValue(global);
    vi.spyOn(api, "listAgents").mockResolvedValue({ agents: [{ profile: { id: "agent-a", name: "研究助手" } } as AgentProfileDocument] });
    vi.spyOn(api, "listModels").mockResolvedValue({ models: [] });
    const agentRead = vi.spyOn(api, "getAgentSettings").mockResolvedValue({ ...global, own: {} });
    vi.spyOn(api, "updateGlobalSettings").mockRejectedValue(new ApiClientError("VERSION_CONFLICT", "运行设置版本发生变化", 409));
    show(<PiSettingsPage />);
    await screen.findByLabelText("默认思考等级");
    chooseOption("默认思考等级", "high");
    fireEvent.click(screen.getByRole("button", { name: "Agent 覆盖" }));
    fireEvent.click(screen.getByRole("button", { name: "保存并切换" }));
    await screen.findByText(/尚未完成保存/);
    expect(screen.getByRole("button", { name: "全局设置" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("默认思考等级")).toHaveAttribute("value", "high");
    expect(agentRead).not.toHaveBeenCalled();
  });

  it("AIGC 渠道关闭保护凭证且使用更新响应直接完成保存", async () => {
    const channel = { id: "channel-a", name: "渠道 A", type: "openai" as const, baseUrl: "https://a.example.test", enabled: true, timeoutMs: 30000, hasApiKey: true };
    const other = { ...channel, id: "channel-b", name: "渠道 B" };
    const doc: AigcSettingsDocument = { revision: "r1", credentialRevision: "c1", channels: [channel, other], channelTemplates: [], credentials: [] };
    const list = vi.spyOn(api, "getAigcChannels").mockResolvedValue(doc);
    const update = vi.spyOn(api, "updateAigcChannel").mockResolvedValue({ ...doc, revision: "r2" });
    show(<AigcChannelsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑渠道 A" }));
    fireEvent.change(screen.getByLabelText("AIGC API Key"), { target: { value: "fictional-channel-key" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭渠道编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "保存并切换" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "编辑渠道 B" }));
    expect(screen.getByLabelText("AIGC 渠道名称")).toHaveValue("渠道 B");
    expect(update).toHaveBeenCalledWith("channel-a", expect.objectContaining({ credential: { action: "replace", apiKey: "fictional-channel-key" } }));
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("资源目录初次读取不冒充配置保存或待应用状态", async () => {
    vi.spyOn(api, "listAgents").mockResolvedValue({ agents: [] });
    vi.spyOn(api, "listResources").mockResolvedValue({ resources: [], tools: [], packages: [], diagnostics: [] });
    show(<ResourcesPage />);
    await screen.findByText("当前没有资源");
    expect(screen.getByText("配置生效方式")).toBeInTheDocument();
    expect(screen.queryByText("配置已保存，等待应用")).not.toBeInTheDocument();
  });

  it("仅成功刷新请求开始前的保存变为已应用，并发保存仍待刷新", () => {
    recordConfigurationSave("test-early");
    const generation = configurationRefreshGeneration();
    recordConfigurationSave("test-late");
    confirmConfigurationRefresh(generation);
    const view = show(<ConfigurationEffectNotice configKey="test-early" />);
    expect(screen.getByText("本次已保存配置已应用")).toBeInTheDocument();
    view.rerender(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={authRequired}><ConfigurationEffectNotice configKey="test-late" /></ApiTaskProvider></ErrorToastProvider>);
    expect(screen.getByText("配置已保存，等待应用")).toBeInTheDocument();
  });
});


describe("语音配置列表与抽屉", () => {
  it("默认展示摘要而不自动编辑，高级参数按需展开", async () => {
    vi.spyOn(api, "getTtsProfiles").mockResolvedValue({ revision: "r1", profiles: [{ ...voice, customParameters: { speed: 1.2 } }] });
    show(<TtsPage />);
    const edit = await screen.findByRole("button", { name: "编辑语音 A" });
    edit.focus(); fireEvent.click(edit);
    expect(screen.getByText("已设置 1 项参数")).toBeInTheDocument();
    expect(screen.getByText("高级请求参数").closest("details")).not.toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "关闭语音配置编辑" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("密钥已配置")).toBeInTheDocument();
    expect(screen.getByText("MP3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑语音 A" })).toHaveFocus();
  });

  it("无效高级参数阻止保存并展开原草稿，Esc 和遮罩关闭经过保护", async () => {
    vi.spyOn(api, "getTtsProfiles").mockResolvedValue({ revision: "r1", profiles: [voice] });
    const save = vi.spyOn(api, "updateTtsProfile");
    show(<TtsPage />);
    const edit = await screen.findByRole("button", { name: "编辑语音 A" });
    edit.focus(); fireEvent.click(edit);
    fireEvent.change(screen.getByLabelText("TTS 自定义请求参数"), { target: { value: '{"speed":' } });
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));
    await waitFor(() => expect(screen.getByText("高级请求参数").closest("details")).toHaveAttribute("open"));
    expect(save).not.toHaveBeenCalled();
    const drawer = screen.getByRole("dialog", { name: /编辑语音配置/ });
    fireEvent.keyDown(drawer, { key: "Escape" });
    const confirmation = screen.getByRole("dialog", { name: "还有未保存的修改" });
    fireEvent(confirmation, new Event("cancel", { cancelable: true }));
    expect(screen.getByLabelText("TTS 自定义请求参数")).toHaveValue('{"speed":');
    fireEvent.click(drawer, { clientX: -1 });
    fireEvent.click(screen.getByRole("button", { name: "放弃并切换" }));
    await waitFor(() => expect(document.body.style.overflow).not.toBe("hidden"));
  });

  it("删除先确认对象与脏草稿，取消不提交也不丢失修改", async () => {
    vi.spyOn(api, "getTtsProfiles").mockResolvedValue({ revision: "r1", profiles: [voice] });
    const remove = vi.spyOn(api, "deleteTtsProfile");
    show(<TtsPage />);
    const edit = await screen.findByRole("button", { name: "编辑语音 A" });
    edit.focus(); fireEvent.click(edit);
    fireEvent.change(screen.getByLabelText("音色"), { target: { value: "nova" } });
    screen.getByRole("button", { name: "删除配置" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "删除配置" }));
    const dialog = screen.getByRole("dialog", { name: "删除语音配置？" });
    expect(within(dialog).getByText(/当前未保存的修改也会丢弃/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus();
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.getByLabelText("音色")).toHaveValue("nova");
    expect(screen.getByRole("button", { name: "删除配置" })).toHaveFocus();
  });

  it("被引用的配置或版本冲突删除失败时保留配置、版本与草稿", async () => {
    vi.spyOn(api, "getTtsProfiles").mockResolvedValue({ revision: "r1", profiles: [voice] });
    const remove = vi.spyOn(api, "deleteTtsProfile")
      .mockRejectedValueOnce(new ApiClientError("MODEL_IN_USE", "语音配置正被 Agent 使用", 409))
      .mockRejectedValueOnce(new ApiClientError("VERSION_CONFLICT", "语音配置版本发生变化", 409));
    show(<TtsPage />);
    const edit = await screen.findByRole("button", { name: "编辑语音 A" });
    edit.focus(); fireEvent.click(edit);
    fireEvent.change(screen.getByLabelText("音色"), { target: { value: "nova" } });
    screen.getByRole("button", { name: "删除配置" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "删除配置" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    const confirmation = within(screen.getByRole("dialog", { name: "删除语音配置？" }));
    await confirmation.findByText("语音配置正被 Agent 使用", { selector: "p.configuration-inline-error" });
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await confirmation.findByText("语音配置版本发生变化", { selector: "p.configuration-inline-error" });
    expect(remove).toHaveBeenLastCalledWith("speech-a", "r1");
    fireEvent.click(within(screen.getByRole("dialog", { name: "删除语音配置？" })).getByRole("button", { name: "取消" }));
    expect(screen.getByLabelText("音色")).toHaveValue("nova");
  });

  it("删除成功后列表刷新失败不重复删除，重新加载恢复最新写入版本", async () => {
    const list = vi.spyOn(api, "getTtsProfiles").mockResolvedValueOnce({ revision: "r1", profiles: [voice, voiceB] })
      .mockRejectedValueOnce(new ApiClientError("INTERNAL_ERROR", "读取语音列表时存储不可用", 500))
      .mockResolvedValueOnce({ revision: "r2", profiles: [voiceB] });
    const remove = vi.spyOn(api, "deleteTtsProfile").mockResolvedValue();
    show(<TtsPage />);
    const edit = await screen.findByRole("button", { name: "编辑语音 A" });
    edit.focus(); fireEvent.click(edit);
    screen.getByRole("button", { name: "删除配置" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "删除配置" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await screen.findByText(/语音配置已删除，但列表尚未更新/);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "编辑语音 A" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑语音 B" })).toBeDisabled();
    expect(window.localStorage.getItem("pi-agent:tts-cache")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重新加载语音配置" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "编辑语音 B" })).toBeEnabled());
    expect(list).toHaveBeenCalledTimes(3);
    expect(remove).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.body.style.overflow).not.toBe("hidden"));
  });

  it("保存返回列表，API Key 仅在服务端提交而不进入缓存", async () => {
    vi.spyOn(api, "getTtsProfiles").mockResolvedValue({ revision: "r1", profiles: [voice] });
    const save = vi.spyOn(api, "updateTtsProfile").mockResolvedValue({ revision: "r2", profile: { ...voice, voice: "nova" } });
    show(<TtsPage />);
    const edit = await screen.findByRole("button", { name: "编辑语音 A" });
    edit.focus(); fireEvent.click(edit);
    fireEvent.change(screen.getByLabelText("音色"), { target: { value: "nova" } });
    fireEvent.change(screen.getByLabelText("TTS API Key"), { target: { value: "fictional-replacement-key" } });
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));
    await screen.findByText("语音配置修改已保存");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(save).toHaveBeenCalledWith("speech-a", "r1", expect.objectContaining({ apiKey: "fictional-replacement-key" }));
    expect(window.localStorage.getItem("pi-agent:tts-cache")).not.toContain("fictional-replacement-key");
  });

  it("离线缓存允许查看编辑但禁用保存、新建和删除", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    window.localStorage.setItem("pi-agent:tts-cache", JSON.stringify({ revision: "r1", profiles: [voice] }));
    vi.spyOn(api, "getTtsProfiles").mockRejectedValue(new ApiClientError("INTERNAL_ERROR", "读取语音配置时连接中断", 500));
    show(<TtsPage />);
    const edit = await screen.findByRole("button", { name: "编辑语音 A" });
    await waitFor(() => expect(edit).toBeEnabled());
    expect(screen.getByRole("button", { name: "新增语音配置" })).toBeDisabled();
    fireEvent.click(edit);
    expect(screen.getByRole("button", { name: "保存更改" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "删除配置" })).toBeDisabled();
  });
});
