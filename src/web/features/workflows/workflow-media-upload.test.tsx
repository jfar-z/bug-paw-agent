import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiClientError } from "../../api";
import { ApiTaskProvider } from "../../api-task-provider";
import { ErrorToastProvider } from "../../error-toast-provider";
import { WorkflowsPage } from "../../pages/workflows-page";
import { WorkflowValue } from "./workflow-fields";
import {
  emptyWorkflow,
  type WorkflowInputField,
} from "../../../shared/workflow-contracts";

vi.mock("./workflow-canvas", () => ({ WorkflowCanvas: () => null }));
afterEach(() => vi.restoreAllMocks());

/** 同时覆盖运行表单与编辑器固定值，使用真实组件状态和任务错误弹窗。 */
async function fixture(surface: "run" | "editor", field: WorkflowInputField) {
  const changed = vi.fn();
  const run = vi
    .spyOn(api, "runWorkflowBatch")
    .mockImplementation(() => new Promise(() => {}));
  const upload = vi
    .spyOn(api, "uploadWorkflowFile")
    .mockImplementation(async (file) => ({
      assetId: file.name,
      name: file.name,
      mediaType: file.type,
      size: file.size,
    }));
  const definition = {
    ...emptyWorkflow(),
    id: "media-run",
    revision: 1,
    createdAt: "",
    updatedAt: "",
  };
  definition.nodes[0].outputs = [field];
  vi.spyOn(api, "getWorkflow").mockResolvedValue(definition);
  vi.spyOn(api, "listWorkflows").mockResolvedValue({ workflows: [{ id: definition.id, name: definition.name, description: definition.description, published: definition.published, revision: definition.revision, createdAt: definition.createdAt, updatedAt: definition.updatedAt, nodeCount: definition.nodes.length }] });
  function Editor() {
    const [value, setValue] = useState<unknown>(field.defaultValue);
    return (
      <WorkflowValue
        field={field}
        value={value}
        onChange={(next) => {
          changed(next);
          setValue(next);
        }}
      />
    );
  }
  render(
    <ErrorToastProvider>
      <ApiTaskProvider onAuthenticationRequired={() => {}}>
        {surface === "run" ? (
          <WorkflowsPage
            route={{ page: "workflow-run", workflowId: definition.id }}
          />
        ) : (
          <Editor />
        )}
      </ApiTaskProvider>
    </ErrorToastProvider>,
  );
  const uploadButton = await screen.findByRole("button", { name: "上传 media" });
  const input = uploadButton.nextElementSibling as HTMLInputElement;
  expect(input).toHaveAttribute("type", "file");
  // 运行表单在定义加载后通过 effect 填入默认值，等待其显示再模拟用户上传。
  if (Array.isArray(field.defaultValue) && field.defaultValue.length)
    await screen.findByText(field.defaultValue[0].name);
  return {
    input,
    run,
    upload,
    names() {
      const list = screen.queryByRole("list", { name: "已选择的文件 media" });
      return list ? within(list).getAllByRole("listitem").map((item) => within(item).getByRole("button", { name: /^移除 / }).getAttribute("aria-label")!.slice(3)) : [];
    },
    async select(files: File[]) {
      fireEvent.change(input, { target: { files } });
      await waitFor(() => expect(input).toBeEnabled());
    },
    async value() {
      if (surface === "editor")
        return changed.mock.calls.length
          ? changed.mock.lastCall![0]
          : field.defaultValue;
      fireEvent.click(screen.getByRole("button", { name: "运行工作流" }));
      await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      return run.mock.calls[0][1].inputs.media;
    },
  };
}

/** 分批上传必须保留历史引用和选择顺序，单文件字段仍遵循替换语义。 */
describe.each(["run", "editor"] as const)("%s 媒体上传", (surface) => {
  it.each(["image", "audio", "video", "file"] as const)(
    "%s 数组连续单选和多选追加，取消选择不清空",
    async (type) => {
      const f = await fixture(surface, { name: "media", type, multiple: true });
      const mediaType = type === "file" ? "application/pdf" : `${type}/test`;
      const files = ["first", "second", "third", "fourth"].map(
        (name) => new File([name], name, { type: mediaType }),
      );
      expect(f.input).toHaveAttribute("multiple");
      await f.select([files[0]]);
      await screen.findByText("first");
      await f.select([files[1]]);
      expect(f.names()).toEqual(["first", "second"]);
      await f.select(files.slice(2));
      expect(f.names()).toEqual(["first", "second", "third", "fourth"]);
      await f.select([]);
      expect(f.upload).toHaveBeenCalledTimes(4);
      expect(f.input).toHaveValue("");
      expect(await f.value()).toEqual(
        files.map((file) => ({
          assetId: file.name,
          name: file.name,
          mediaType,
          size: file.size,
        })),
      );
    },
  );

  it("单文件第二次上传替换第一次，不提交数组", async () => {
    const f = await fixture(surface, { name: "media", type: "image" });
    expect(f.input).not.toHaveAttribute("multiple");
    await f.select([new File(["a"], "first.png", { type: "image/png" })]);
    await f.select([new File(["b"], "second.png", { type: "image/png" })]);
    await screen.findByText("second.png");
    expect(screen.queryByText("first.png")).not.toBeInTheDocument();
    expect(await f.value()).toMatchObject({ assetId: "second.png" });
  });

  it("追加失败显示错误并保留旧数组，同一文件可重试追加", async () => {
    const f = await fixture(surface, {
      name: "media",
      type: "image",
      multiple: true,
    });
    const first = new File(["a"], "first.png", { type: "image/png" });
    const second = new File(["b"], "second.png", { type: "image/png" });
    await f.select([first]);
    f.upload.mockRejectedValueOnce(
      new ApiClientError(
        "REQUEST_FAILED",
        "媒体上传存储失败",
        500,
        "upload-test",
      ),
    );
    await f.select([second]);
    expect(screen.getAllByText(/媒体上传存储失败/).length).toBeGreaterThan(0);
    expect(screen.getByText("first.png")).toBeInTheDocument();
    await f.select([second]);
    expect(f.names()).toEqual(["first.png", "second.png"]);
    expect(await f.value()).toMatchObject([
      { assetId: "first.png" },
      { assetId: "second.png" },
    ]);
  });

  it("按累计数量限制上传，拒绝前不发送请求且不丢已有文件", async () => {
    const limit = surface === "run" ? 100 : 2;
    const existing = Array.from({ length: limit }, (_, index) => ({
      assetId: `old-${index}`,
      name: `old-${index}.png`,
      mediaType: "image/png",
      size: 1,
    }));
    const f = await fixture(surface, {
      name: "media",
      type: "image",
      multiple: true,
      maxItems: limit,
      defaultValue: existing,
    });
    await f.select([new File(["a"], "overflow.png", { type: "image/png" })]);
    expect(
      screen.getAllByText(new RegExp(`最多上传 ${limit} 个文件`)).length,
    ).toBeGreaterThan(0);
    expect(f.upload).not.toHaveBeenCalled();
    expect(f.names()).toEqual(existing.map((file) => file.name));
    expect(await f.value()).toEqual(existing);
  });

  it.each(["image", "audio", "video", "file"] as const)(
    "%s 数组移除中间文件后保留顺序，并允许重新上传同一文件",
    async (type) => {
      const f = await fixture(surface, { name: "media", type, multiple: true });
      const files = ["first", "second", "third"].map((name) =>
        new File([name], name, { type: type === "file" ? "application/pdf" : `${type}/test` }));
      await f.select(files);
      fireEvent.click(screen.getByRole("button", { name: "移除 second" }));
      expect(f.names()).toEqual(["first", "third"]);
      await f.select([files[1]]);
      expect(f.names()).toEqual(["first", "third", "second"]);
      expect(await f.value()).toMatchObject([
        { assetId: "first" }, { assetId: "third" }, { assetId: "second" },
      ]);
    },
  );

  it("清空单文件提交 null，避免服务端重新填入默认文件", async () => {
    const f = await fixture(surface, {
      name: "media", type: "image",
      defaultValue: { assetId: "default", name: "default.png", mediaType: "image/png", size: 1 },
    });
    fireEvent.click(await screen.findByRole("button", { name: "移除 default.png" }));
    expect(f.names()).toEqual([]);
    expect(await f.value()).toBeNull();
  });

  it("移除相同资产的一个引用不会同时移除其他项，全部移除提交空数组", async () => {
    const f = await fixture(surface, { name: "media", type: "image", multiple: true });
    const file = new File(["a"], "same.png", { type: "image/png" });
    await f.select([file, file]);
    fireEvent.click(screen.getAllByRole("button", { name: "移除 same.png" })[0]);
    expect(f.names()).toEqual(["same.png"]);
    fireEvent.click(screen.getByRole("button", { name: "移除 same.png" }));
    expect(f.names()).toEqual([]);
    expect(await f.value()).toEqual([]);
  });

  it("追加上传期间禁用移除，完成后恢复且不会丢失此前文件", async () => {
    const f = await fixture(surface, { name: "media", type: "image", multiple: true });
    await f.select([new File(["a"], "first.png", { type: "image/png" })]);
    let resolve!: (file: { assetId: string; name: string; mediaType: string; size: number }) => void;
    f.upload.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    fireEvent.change(f.input, { target: { files: [new File(["b"], "second.png", { type: "image/png" })] } });
    expect(screen.getByRole("button", { name: "移除 first.png" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "移除 first.png" }));
    resolve({ assetId: "second", name: "second.png", mediaType: "image/png", size: 1 });
    await waitFor(() => expect(f.input).toBeEnabled());
    expect(f.names()).toEqual(["first.png", "second.png"]);
    expect(screen.getByRole("button", { name: "移除 first.png" })).toBeEnabled();
  });
});

it("公网传输确认覆盖整批，取消保留草稿，确认沿用原批次请求键与上传顺序", async () => {
  const f = await fixture("run", { name: "media", type: "file", multiple: true });
  await f.select([new File(["a"], "one.txt"), new File(["b"], "two.txt")]);
  const quantity = screen.getByRole("textbox", { name: "运行次数" });
  fireEvent.change(quantity, { target: { value: "3" } });
  const error = new ApiClientError("VALIDATION_FAILED", "需要确认公网传输", 400, "test", { requiresPublicTransfer: true });
  f.run.mockRejectedValueOnce(error).mockRejectedValueOnce(error);
  const submit = screen.getByRole("button", { name: "运行工作流" });
  fireEvent.click(submit);
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(/本次将提交 3 次运行/)).toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(quantity).toHaveValue("3");
  fireEvent.click(submit);
  fireEvent.click(await screen.findByRole("button", { name: "确认并运行" }));
  const request = f.run.mock.calls[0][1];
  expect(request).toMatchObject({ count: 3, inputs: { media: [{ assetId: "one.txt" }, { assetId: "two.txt" }] } });
  expect(f.run.mock.calls[2][1]).toEqual({ ...request, confirmPublicTransfer: true });
});
