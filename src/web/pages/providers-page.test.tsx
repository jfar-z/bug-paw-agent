import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiClientError } from "../api";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { ProvidersPage } from "./providers-page";

function renderProvidersPage() {
  return render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}><ProvidersPage /></ApiTaskProvider></ErrorToastProvider>);
}

describe("ProvidersPage", () => {
  afterEach(() => { vi.restoreAllMocks(); });


it("创建成功后自动选中新 Provider 并可立即保存 API Key", async () => {
    const example = { name: "Example", baseUrl: "https://api.example.com/v1", api: "openai-completions", models: [] };
    const created = { name: "Created", baseUrl: "https://created.example.test/v1", api: "openai-completions", authHeader: true, models: [] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/providers" && init?.method === "POST") {
        return new Response(JSON.stringify({ revision: "r2", diagnostics: [], value: { providers: { example, created } } }), { status: 200 });
      }
      if (url === "/api/v1/providers/created/credential" && init?.method === "PUT") {
        return new Response(JSON.stringify({ credentialRevision: "c2", status: { providerId: "created", type: "api_key", configured: true } }), { status: 200 });
      }
      return new Response(JSON.stringify({ revision: "r1", credentialRevision: "c1", credentials: [], diagnostics: [], value: { providers: { example } } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderProvidersPage();

    fireEvent.click(await screen.findByRole("button", { name: "新建 Provider" }));
    const dialog = screen.getByRole("dialog", { name: "新建 Provider" });
    fireEvent.change(within(dialog).getByLabelText("Provider ID"), { target: { value: "created" } });
    fireEvent.change(within(dialog).getByLabelText("显示名称"), { target: { value: "Created" } });
    fireEvent.change(within(dialog).getByLabelText("Base URL"), { target: { value: "https://created.example.test/v1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建 Provider" }));

    expect(await screen.findByText("Provider 已创建，请继续配置 API Key")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "新建 Provider" })).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Created")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "test-provider-key" } });
    fireEvent.click(screen.getByRole("button", { name: "保存凭证" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/providers/created/credential", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ revision: "c1", apiKey: "test-provider-key" }),
    })));
  });

  it("默认摘要列表不打开编辑器，搜索时不能保存局部顺序", async () => {
    vi.spyOn(api, "listProviders").mockResolvedValue(exampleDocument());
    renderProvidersPage();
    await screen.findByRole("button", { name: "管理 Provider Example" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("已配置")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索 Provider" }), { target: { value: "second" } });
    expect(screen.queryByRole("button", { name: "管理 Provider Example" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "向上移动 Provider Second" })).toBeDisabled();
  });

  it("页签切换保留模型与凭证草稿，连接保存不提交独立 Key", async () => {
    const doc = exampleDocument();
    vi.spyOn(api, "listProviders").mockResolvedValue(doc);
    const save = vi.spyOn(api, "saveProvider").mockImplementation(async (_id, _revision, provider) => ({ ...doc, revision: "r2", value: { providers: { ...doc.value.providers, example: provider } } }));
    const key = vi.spyOn(api, "saveProviderCredential");
    renderProvidersPage();
    fireEvent.click(await screen.findByRole("button", { name: "管理 Provider Example" }));
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "fictional-new-key" } });
    fireEvent.click(screen.getByRole("tab", { name: /模型管理/ }));
    expect(screen.queryByRole("textbox", { name: "模型 ID" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑模型 Model A" }));
    fireEvent.change(screen.getByRole("textbox", { name: "模型 ID" }), { target: { value: "demo/new-id" } });
    fireEvent.click(screen.getByRole("button", { name: "完成编辑" }));
    fireEvent.click(screen.getByRole("tab", { name: /连接与凭证/ }));
    expect(screen.getByLabelText("API Key")).toHaveValue("fictional-new-key");
    fireEvent.click(screen.getByRole("button", { name: "保存连接与模型" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("example", "r1", expect.objectContaining({ models: [expect.objectContaining({ id: "demo/new-id", customField: { keep: true } })] })));
    expect(key).not.toHaveBeenCalled();
    expect(screen.getByLabelText("API Key")).toHaveValue("fictional-new-key");
    expect(screen.getByRole("dialog", { name: "管理 Provider · Example" })).toBeInTheDocument();
  });

  it("按需查看旧 Key 不变脏，新 Key 与高级 JSON 修改阻止测试和发现", async () => {
    vi.spyOn(api, "listProviders").mockResolvedValue(exampleDocument());
    vi.spyOn(api, "getProviderCredential").mockResolvedValue({ apiKey: "fictional-existing-key" });
    renderProvidersPage();
    fireEvent.click(await screen.findByRole("button", { name: "管理 Provider Example" }));
    fireEvent.click(screen.getByRole("button", { name: "显示API Key" }));
    await waitFor(() => expect(screen.getByLabelText("API Key")).toHaveValue("fictional-existing-key"));
    expect(screen.getByRole("button", { name: "保存凭证" })).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: "连接测试" }));
    expect(screen.getByRole("button", { name: "测试所选模型" })).toBeEnabled();
    fireEvent.click(screen.getByRole("tab", { name: "连接与凭证" }));
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "fictional-changed-key" } });
    fireEvent.click(screen.getByRole("tab", { name: "连接测试" }));
    expect(screen.getByRole("button", { name: "测试全部模型" })).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: /模型管理/ }));
    expect(screen.getByRole("button", { name: "发现模型" })).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: /连接与凭证/ }));
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Provider 高级 JSON"), { target: { value: '{"models":' } });
    fireEvent.click(screen.getByRole("tab", { name: "连接测试" }));
    expect(screen.getByRole("button", { name: "测试全部模型" })).toBeDisabled();
  });

  it("删除 Provider 必须确认，引用拒绝保留对象并进入错误弹窗", async () => {
    const doc = exampleDocument();
    vi.spyOn(api, "listProviders").mockResolvedValue(doc);
    const remove = vi.spyOn(api, "removeProvider").mockRejectedValueOnce(new ApiClientError("PROVIDER_IN_USE", "Provider 正被 Agent 默认模型引用", 409))
      .mockResolvedValueOnce({ revision: "r2", diagnostics: [], value: { providers: { second: doc.value.providers.second } } });
    const removeKey = vi.spyOn(api, "removeProviderCredential");
    renderProvidersPage();
    fireEvent.click(await screen.findByRole("button", { name: "管理 Provider Example" }));
    fireEvent.click(screen.getByRole("button", { name: "删除 Provider" }));
    const confirm = screen.getByRole("dialog", { name: "删除 Provider？" });
    expect(within(confirm).getByText(/独立 API Key 保留/)).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "确认删除" }));
    await within(confirm).findByText("Provider 正被 Agent 默认模型引用", { selector: ".configuration-inline-error" });
    const notice = within(confirm).getByRole("group", { name: "配置 Provider · Example失败" });
    expect(within(notice).getByRole("button", { name: "查看错误详情" })).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole("button", { name: "确认删除" }));
    await screen.findByRole("button", { name: "管理 Provider Second" });
    expect(screen.queryByRole("dialog", { name: "删除 Provider？" })).not.toBeInTheDocument();
    expect(removeKey).not.toHaveBeenCalled();
  });

  it("已保存模型删除即时更新版本，新增模型删除仅移除草稿", async () => {
    const doc = exampleDocument();
    vi.spyOn(api, "listProviders").mockResolvedValue(doc);
    const remove = vi.spyOn(api, "removeProviderModel").mockResolvedValue({ revision: "r2", diagnostics: [], value: { providers: { ...doc.value.providers, example: { ...doc.value.providers.example, models: [] } } } });
    renderProvidersPage();
    fireEvent.click(await screen.findByRole("button", { name: "管理 Provider Example" }));
    fireEvent.click(screen.getByRole("tab", { name: "模型管理" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑模型 Model A" }));
    fireEvent.click(screen.getByRole("button", { name: "删除模型" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "删除模型？" })).getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("example", "model-a", "r1"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "删除模型？" })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "新增模型" }));
    expect(screen.getByRole("textbox", { name: "模型 ID" })).toHaveValue("new-model-1");
    fireEvent.click(screen.getByRole("button", { name: "删除模型" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "删除模型？" })).getByRole("button", { name: "确认删除" }));
    expect(remove).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "保存连接与模型" })).toBeDisabled();
  });

  it("结构无效的高级 JSON 不进入表单状态，失败的逐模型测试仍弹出错误", async () => {
    vi.spyOn(api, "listProviders").mockResolvedValue(exampleDocument());
    const save = vi.spyOn(api, "saveProvider");
    vi.spyOn(api, "testProvider").mockResolvedValue({ providerId: "example", results: [{ modelId: "model-a", modelName: "Model A", ok: false, durationMs: 5, message: "远端模型认证返回 HTTP 401", errorCode: "UPSTREAM_HTTP_ERROR" }] });
    renderProvidersPage();
    fireEvent.click(await screen.findByRole("button", { name: "管理 Provider Example" }));
    const json = screen.getByLabelText("Provider 高级 JSON");
    fireEvent.change(json, { target: { value: '{"models":{}}' } });
    fireEvent.blur(json);
    expect(screen.getByDisplayValue("Example")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存连接与模型" }));
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(json, { target: { value: JSON.stringify({ ...exampleDocument().value.providers.example, headers: {} }, null, 2) } });
    fireEvent.blur(json);
    fireEvent.click(screen.getByRole("tab", { name: "连接测试" }));
    fireEvent.click(screen.getByRole("button", { name: "测试所选模型" }));
    await screen.findByRole("button", { name: "查看错误详情" });
    expect(screen.getByRole("group", { name: "Provider 模型连接测试失败" })).toHaveTextContent("远端模型认证返回 HTTP 401");
  });

  it("改名后重读凭证版本失败时暂停写入，重新加载成功后使用新版本", async () => {
    const doc = exampleDocument();
    const renamed = { ...doc, revision: "r2", credentialRevision: "c2", credentials: [{ providerId: "renamed", type: "api_key" as const, configured: true as const }], value: { providers: { renamed: doc.value.providers.example, second: doc.value.providers.second } } };
    vi.spyOn(api, "listProviders").mockResolvedValueOnce(doc).mockRejectedValueOnce(new ApiClientError("INTERNAL_ERROR", "改名后读取存储不可用", 500)).mockResolvedValueOnce(renamed);
    vi.spyOn(api, "renameProvider").mockResolvedValue({ revision: "r2", diagnostics: [], value: renamed.value });
    const key = vi.spyOn(api, "saveProviderCredential").mockResolvedValue({ credentialRevision: "c3", status: { providerId: "renamed", type: "api_key", configured: true } });
    renderProvidersPage();
    fireEvent.click(await screen.findByRole("button", { name: "管理 Provider Example" }));
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    const rename = screen.getByRole("dialog", { name: "重命名 Provider" });
    fireEvent.change(within(rename).getByLabelText("新的 Provider ID"), { target: { value: "renamed" } });
    fireEvent.click(within(rename).getByRole("button", { name: "确认改名" }));
    const reload = await screen.findByRole("button", { name: "重新加载 Provider 与凭证版本" });
    expect(screen.getByRole("button", { name: "删除 Provider" })).toBeDisabled();
    fireEvent.click(reload);
    await waitFor(() => expect(screen.getByLabelText("API Key")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "fictional-renamed-key" } });
    fireEvent.click(screen.getByRole("button", { name: "保存凭证" }));
    await waitFor(() => expect(key).toHaveBeenCalledWith("renamed", "c2", "fictional-renamed-key"));
  });

  it("新建草稿取消需明确放弃，键盘关闭不能悄悄清除输入", async () => {
    vi.spyOn(api, "listProviders").mockResolvedValue(exampleDocument());
    renderProvidersPage();
    fireEvent.click(await screen.findByRole("button", { name: "新建 Provider" }));
    fireEvent.change(screen.getByLabelText("Provider ID"), { target: { value: "new-provider" } });
    fireEvent.keyDown(screen.getByLabelText("Provider ID"), { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "还有未保存的修改" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(screen.getByLabelText("Provider ID")).toHaveValue("new-provider");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "放弃并切换" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

});

/** 回归夹具只包含公开示例地址和虚构凭证摘要。 */
function exampleDocument() {
  const model = { id: "model-a", name: "Model A", reasoning: false, input: ["text" as const], contextWindow: 128000, maxTokens: 8192, customField: { keep: true } };
  const example = { name: "Example", baseUrl: "https://api.example.test/v1", api: "openai-completions", models: [model] };
  return { revision: "r1", credentialRevision: "c1", credentials: [{ providerId: "example", type: "api_key" as const, configured: true as const }], diagnostics: [], value: { providers: { example, second: { ...example, name: "Second", models: [] } } } };
}
