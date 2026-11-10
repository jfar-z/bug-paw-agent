import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowSemaphoresPage } from "./workflow-semaphores-page";
import { api, ApiClientError } from "../api";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { parseRoute, routePath } from "../router";
import { WorkflowSidebar } from "../layouts/workflow-sidebar";
afterEach(() => vi.restoreAllMocks());
const item = { code: "gpu", name: "共享 GPU", limit: 2, revision: 1, used: 0, available: 2, holders: [], waiting: [] };
/** 页面沿用统一错误出口，测试完整保存和冲突行为。 */
function mount() { return render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={() => {}}><WorkflowSemaphoresPage /></ApiTaskProvider></ErrorToastProvider>); }
it("新建校验 code 和额度，编辑时保留 code 与版本", async () => {
  const list = vi.spyOn(api, "listWorkflowSemaphores").mockResolvedValue({ semaphores: [item] });
  const save = vi.spyOn(api, "saveWorkflowSemaphore").mockResolvedValue(item);
  mount(); await screen.findByText("共享 GPU");
  fireEvent.click(screen.getByRole("button", { name: "新建信号量" }));
  expect(screen.getByRole("button", { name: "保存信号量" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/信号量 code/), { target: { value: "pool" } });
  fireEvent.change(screen.getByLabelText("信号量名称"), { target: { value: "资源池" } });
  fireEvent.change(screen.getByLabelText("额度上限"), { target: { value: "3" } });
  fireEvent.click(screen.getByRole("button", { name: "保存信号量" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ code: "pool", name: "资源池", limit: 3 }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "编辑 共享 GPU" }));
  expect(screen.getByLabelText(/信号量 code/)).toBeDisabled();
  fireEvent.change(screen.getByLabelText("额度上限"), { target: { value: "4" } });
  fireEvent.click(screen.getByRole("button", { name: "保存信号量" }));
  await waitFor(() => expect(save).toHaveBeenLastCalledWith({ code: "gpu", name: "共享 GPU", limit: 4, revision: 1 }));
  expect(list).toHaveBeenCalledTimes(3);
});
it("删除先确认，引用冲突进入全局错误弹窗且保留资源", async () => {
  vi.spyOn(api, "listWorkflowSemaphores").mockResolvedValue({ semaphores: [item] });
  const remove = vi.spyOn(api, "deleteWorkflowSemaphore").mockRejectedValue(new ApiClientError("CONFLICT", "信号量仍被工作流引用", 409, "semaphore-in-use"));
  mount(); await screen.findByText("共享 GPU");
  fireEvent.click(screen.getByRole("button", { name: "删除 共享 GPU" })); expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  await screen.findAllByText("信号量仍被工作流引用");
  fireEvent.click(screen.getByRole("button", { name: "查看错误详情" }));
  expect(await screen.findByText("semaphore-in-use")).toBeInTheDocument();
});
it("信号量深链、选中态和移动端导航关闭合同", () => {
  expect(parseRoute("/workflows/semaphores")).toEqual({ page: "workflow-semaphores" });
  expect(routePath({ page: "workflow-semaphores" })).toBe("/workflows/semaphores");
  const close = vi.fn(), navigate = vi.fn();
  render(<WorkflowSidebar route={{ page: "workflow-semaphores" }} open onClose={close} onNavigate={navigate} />);
  const button = screen.getByRole("button", { name: "信号量管理" });
  expect(button).toHaveAttribute("aria-current", "page"); fireEvent.click(button);
  expect(navigate).toHaveBeenCalledWith({ page: "workflow-semaphores" }); expect(close).toHaveBeenCalled();
});
