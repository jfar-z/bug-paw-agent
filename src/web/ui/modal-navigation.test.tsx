import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog, Dialog } from "./dialog";
import { WorkspaceLayout } from "./workspace-layout";

describe("模态窗口和导航", () => {
  it("准确输入确认内容才可以执行，忙碌时锁定关闭入口", () => {
    const confirm = vi.fn(),
      cancel = vi.fn();
    const props = {
      title: "移除示例",
      confirmLabel: "移除",
      requireText: "名称",
      onCancel: cancel,
      onConfirm: confirm,
    };
    const view = render(<ConfirmDialog {...props} />);
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "移除" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "名称" },
    });
    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    expect(confirm).toHaveBeenCalledOnce();
    view.rerender(<ConfirmDialog {...props} busy />);
    fireEvent(
      screen.getByRole("dialog"),
      new Event("cancel", { cancelable: true }),
    );
    expect(cancel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "关闭" })).toBeDisabled();
  });
  it("分层抽屉消费 Escape，同一次长按只返回一层", () => {
    const back = vi.fn(), close = vi.fn();
    render(<Dialog title="文件" onEscape={back} onClose={close}>
      <button type="button">文件预览</button>
    </Dialog>);
    const preview = screen.getByRole("button", { name: "文件预览" });
    expect(fireEvent.keyDown(preview, { key: "Escape" })).toBe(false);
    expect(fireEvent.keyDown(preview, { key: "Escape", repeat: true })).toBe(false);
    expect(back).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(back).toHaveBeenCalledTimes(2);
  });

  it("关闭后恢复到开启前获得焦点的节点", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const view = render(
      <ConfirmDialog title="保存" onCancel={() => {}} onConfirm={() => {}} />,
    );
    view.unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
  it("保留修饰键打开链接，断点变化关闭当前抽屉", () => {
    let onChange = () => {};
    const screenSize = {
      matches: true,
      addEventListener: (_: string, listener: () => void) => {
        onChange = listener;
      },
      removeEventListener: () => {},
    };
    const media = vi
      .spyOn(window, "matchMedia")
      .mockReturnValue(screenSize as unknown as MediaQueryList);
    try {
      const go = vi.fn();
      render(
        <WorkspaceLayout
          groups={[
            {
              id: "g",
              label: "资源",
              eyebrow: "FILES",
              items: [{ id: "i", label: "文件" }],
            },
          ]}
          groupId="g"
          itemId="i"
          onNavigate={go}
          hrefFor={() => "#g/i"}
        >
          文件内容
        </WorkspaceLayout>,
      );
      const target = screen.getByRole("link", { name: "文件" });
      fireEvent.click(target, { ctrlKey: true });
      expect(go).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "打开二级导航" }));
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "关闭",
        }),
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "打开一级导航" }));
      screenSize.matches = false;
      act(onChange);
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      media.mockRestore();
    }
  });
});
