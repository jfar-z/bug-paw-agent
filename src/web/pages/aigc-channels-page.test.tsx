import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AigcSettingsDocument } from "../../shared/aigc-contracts";
import { api, ApiClientError } from "../api";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { AigcChannelsPage } from "./aigc-channels-page";

const channel = { id: "channel-a", name: "渠道 A", type: "openai" as const, baseUrl: "https://a.example.test/v1", enabled: true, timeoutMs: 30000, hasApiKey: true };
const other = { ...channel, id: "channel-b", name: "渠道 B" };
const document: AigcSettingsDocument = {
  revision: "r1", credentialRevision: "c1", channels: [channel, other], credentials: [],
  channelTemplates: [
    { id: "openai", type: "openai", name: "OpenAI", defaultBaseUrl: "https://images.example.test/v1", credentialOptional: false },
    { id: "grok", type: "grok", name: "Grok", defaultBaseUrl: "https://video.example.test/v1", credentialOptional: false },
    { id: "comfyui", type: "comfyui", name: "ComfyUI", defaultBaseUrl: "https://workflow.example.test", credentialOptional: true },
  ],
};

/** 虚构配置与内存 API 隔离生产数据，并保留真正的错误分发器。 */
function show() {
  return render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}><AigcChannelsPage /></ApiTaskProvider></ErrorToastProvider>);
}

/** 等待初始读取结束再显式进入编辑，避免把加载态当成可操作态。 */
async function edit() {
  const button = await screen.findByRole("button", { name: "编辑渠道 A" });
  await waitFor(() => expect(button).toBeEnabled());
  button.focus(); fireEvent.click(button);
}

beforeEach(() => { window.localStorage.clear(); window.history.replaceState({}, "", "/settings/capabilities/aigc"); });
afterEach(() => { vi.restoreAllMocks(); });

describe("AIGC 渠道列表与编辑抽屉", () => {
  it("默认只展示真实摘要，协议选择只出现在新增流程", async () => {
    vi.spyOn(api, "getAigcChannels").mockResolvedValue({ ...document, channels: [{ ...channel, type: "comfyui", hasApiKey: false, timeoutMs: undefined }] });
    show();
    await screen.findByText("密钥未配置（可选）");
    expect(screen.getByText("不限制")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新建 OpenAI 渠道" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "新增渠道" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "新增渠道" }));
    expect(screen.getByRole("button", { name: "新建 OpenAI 渠道" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "新建 ComfyUI 渠道" }));
    expect(screen.getByLabelText("AIGC 渠道协议")).toHaveValue("comfyui");
    expect(screen.getByLabelText("AIGC 请求超时")).toHaveValue(null);
    expect(screen.getByText("留空表示不限制")).toBeInTheDocument();
  });

  it("新增协议不可直接修改，重选经草稿保护；保存使用新标识和双版本", async () => {
    const list = vi.spyOn(api, "getAigcChannels").mockResolvedValue({ ...document, channels: [] });
    const create = vi.spyOn(api, "createAigcChannel").mockImplementation(async (input) => ({ ...document, revision: "r2", credentialRevision: "c2", channels: [{ ...input.channel, hasApiKey: false }] }));
    show();
    await screen.findByText("尚未配置 AIGC 渠道");
    fireEvent.click(screen.getByRole("button", { name: "新增渠道" }));
    fireEvent.click(screen.getByRole("button", { name: "新建 Grok 渠道" }));
    expect(screen.getByLabelText("AIGC 渠道协议")).toHaveAttribute("readonly");
    fireEvent.change(screen.getByLabelText("AIGC 渠道名称"), { target: { value: "新渠道" } });
    fireEvent.click(screen.getByRole("button", { name: "重新选协议" }));
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(screen.getByLabelText("AIGC 渠道名称")).toHaveValue("新渠道");
    fireEvent.click(screen.getByRole("button", { name: "重新选协议" }));
    fireEvent.click(screen.getByRole("button", { name: "放弃并切换" }));
    fireEvent.click(screen.getByRole("button", { name: "新建 ComfyUI 渠道" }));
    fireEvent.change(screen.getByLabelText("AIGC 渠道名称"), { target: { value: "工作流渠道" } });
    fireEvent.click(screen.getByRole("button", { name: "创建渠道" }));
    await screen.findByRole("button", { name: "编辑工作流渠道" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ configRevision: "r1", credentialRevision: "c1", channel: expect.objectContaining({ id: expect.any(String), type: "comfyui", timeoutMs: undefined }) }));
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("查看密钥不产生修改，编辑后测试禁用，留空保留凭证且只缓存摘要", async () => {
    vi.spyOn(api, "getAigcChannels").mockResolvedValue(document);
    vi.spyOn(api, "getAigcChannelCredential").mockResolvedValue({ apiKey: "fictional-view-key" });
    const test = vi.spyOn(api, "testAigcChannel").mockResolvedValue({ ok: true, message: "渠道连接正常" });
    const update = vi.spyOn(api, "updateAigcChannel").mockResolvedValue({ ...document, revision: "r2" });
    show(); await edit();
    fireEvent.click(screen.getByRole("button", { name: "显示AIGC API Key" }));
    await waitFor(() => expect(screen.getByLabelText("AIGC API Key")).toHaveValue("fictional-view-key"));
    expect(screen.getByText("当前没有未保存的修改")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "测试已保存配置" }));
    await screen.findByText(/已保存配置连接正常/);
    expect(test).toHaveBeenCalledWith("channel-a");
    fireEvent.change(screen.getByLabelText("AIGC 渠道名称"), { target: { value: "新名字" } });
    expect(screen.getByRole("button", { name: "测试已保存配置" })).toBeDisabled();
    expect(screen.queryByText(/已保存配置连接正常/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("AIGC API Key"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(update).toHaveBeenCalledWith("channel-a", expect.objectContaining({ credential: { action: "keep" } }));
    expect(window.localStorage.getItem("pi-agent:aigc-channels-cache")).not.toContain("fictional-view-key");
  });

  it("保存失败与版本冲突保留参数和凭证，重试保存成功才关闭保护", async () => {
    vi.spyOn(api, "getAigcChannels").mockResolvedValue(document);
    const update = vi.spyOn(api, "updateAigcChannel")
      .mockRejectedValueOnce(new ApiClientError("VERSION_CONFLICT", "AIGC 渠道版本已变化", 409))
      .mockResolvedValueOnce({ ...document, revision: "r2" });
    show(); await edit();
    fireEvent.change(screen.getByLabelText("AIGC Base URL"), { target: { value: "https://changed.example.test" } });
    fireEvent.change(screen.getByLabelText("AIGC API Key"), { target: { value: "fictional-new-key" } });
    fireEvent.keyDown(screen.getByLabelText("AIGC API Key"), { key: "Escape" });
    const guard = screen.getByRole("dialog", { name: "还有未保存的修改" });
    expect(within(guard).getByRole("button", { name: "继续编辑" })).toHaveFocus();
    fireEvent.click(within(guard).getByRole("button", { name: "保存并切换" }));
    await screen.findByText(/尚未完成保存/);
    expect(screen.getByLabelText("AIGC Base URL")).toHaveValue("https://changed.example.test");
    expect(screen.getByLabelText("AIGC API Key")).toHaveValue("fictional-new-key");
    fireEvent.click(within(guard).getByRole("button", { name: "保存并切换" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(update).toHaveBeenLastCalledWith("channel-a", expect.objectContaining({ configRevision: "r1", credential: { action: "replace", apiKey: "fictional-new-key" } }));
  });

  it("删除明确对象、引用限制和草稿影响；失败保留对象与双版本", async () => {
    vi.spyOn(api, "getAigcChannels").mockResolvedValue(document);
    const remove = vi.spyOn(api, "deleteAigcChannel").mockRejectedValue(new ApiClientError("VALIDATION_FAILED", "该渠道仍被 AIGC 接口引用", 409));
    show(); await edit();
    fireEvent.change(screen.getByLabelText("AIGC 渠道名称"), { target: { value: "草稿名" } });
    const removeButton = screen.getByRole("button", { name: "删除渠道" });
    removeButton.focus(); fireEvent.click(removeButton);
    const confirmation = screen.getByRole("dialog", { name: "删除渠道“渠道 A”？" });
    expect(within(confirmation).getByText(/当前未保存的修改也会丢弃/)).toBeInTheDocument();
    expect(within(confirmation).getByRole("button", { name: "取消" })).toHaveFocus();
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", { name: "确认删除" }));
    await within(confirmation).findByText("该渠道仍被 AIGC 接口引用");
    expect(remove).toHaveBeenCalledWith("channel-a", "r1", "c1");
    fireEvent.click(within(confirmation).getByRole("button", { name: "取消" }));
    expect(screen.getByLabelText("AIGC 渠道名称")).toHaveValue("草稿名");
    expect(removeButton).toHaveFocus();
  });

  it("删除后列表失败禁止旧版本写入，显示全局错误并重载恢复", async () => {
    const list = vi.spyOn(api, "getAigcChannels").mockResolvedValueOnce(document)
      .mockRejectedValueOnce(new ApiClientError("INTERNAL_ERROR", "读取渠道列表时存储不可用", 500, "test-reload"))
      .mockResolvedValueOnce({ ...document, revision: "r2", credentialRevision: "c2", channels: [other] });
    const remove = vi.spyOn(api, "deleteAigcChannel").mockResolvedValue();
    const update = vi.spyOn(api, "updateAigcChannel").mockResolvedValue({ ...document, revision: "r3", channels: [other] });
    show(); await edit();
    fireEvent.click(screen.getByRole("button", { name: "删除渠道" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await screen.findByText(/渠道已删除，但列表尚未更新/);
    expect(screen.queryByRole("button", { name: "编辑渠道 A" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑渠道 B" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "新增渠道" })).toBeDisabled();
    expect(window.localStorage.getItem("pi-agent:aigc-channels-cache")).toBeNull();
    expect(screen.getByText("读取渠道列表时存储不可用")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新加载渠道" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "编辑渠道 B" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "编辑渠道 B" }));
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("channel-b", expect.objectContaining({ configRevision: "r2", credentialRevision: "c2" })));
    expect(list).toHaveBeenCalledTimes(3); expect(remove).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(window.document.body.style.overflow).not.toBe("hidden"));
  });

  it("离线摘要允许查看，但禁用创建、保存、测试与删除", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    window.localStorage.setItem("pi-agent:aigc-channels-cache", JSON.stringify(document));
    vi.spyOn(api, "getAigcChannels").mockRejectedValue(new ApiClientError("INTERNAL_ERROR", "读取渠道配置时连接中断", 500));
    show(); await edit();
    expect(screen.getByRole("button", { name: "保存更改" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "测试已保存配置" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "删除渠道" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "关闭渠道编辑" }));
    expect(screen.getByRole("button", { name: "新增渠道" })).toBeDisabled();
  });
});
