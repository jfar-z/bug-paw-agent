import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button, IconButton } from "./controls";
import { Menu, Tooltip } from "./menu";
import { Tabs } from "./tabs";

// 覆盖图谱视觉评审涉及的键盘交互与无障碍状态。
describe("公共控件交互", () => {
  it("忙碌按钮保留操作名称并阻止重复触发", () => {
    const click = vi.fn();
    render(<Button loading onClick={click}>保存</Button>);
    const button = screen.getByRole("button", {name:"保存"});
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(click).not.toHaveBeenCalled();
  });
  it("图标菜单允许用方向键选择并将焦点还给入口", () => {
    const choose = vi.fn();
    render(<Menu icon={<span/>} label="更多" items={[{key:"first",label:"打开",onSelect:vi.fn()},{key:"last",label:"归档",onSelect:choose}]}/>);
    const trigger = screen.getByRole("button",{name:"更多"});
    fireEvent.keyDown(trigger,{key:"ArrowDown"});
    const first=screen.getByRole("menuitem",{name:"打开"});
    expect(first).toHaveFocus();
    fireEvent.keyDown(first,{key:"End"});
    const last=screen.getByRole("menuitem",{name:"归档"});
    expect(last).toHaveFocus();
    fireEvent.click(last);
    expect(choose).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveFocus();
  });
  it("焦点提示作为说明关联到按钮", () => {
    render(<Tooltip label="保存到设备"><IconButton label="下载"><span/></IconButton></Tooltip>);
    const button=screen.getByRole("button",{name:"下载"});
    fireEvent.focus(button);
    expect(button).toHaveAccessibleDescription("保存到设备");
    fireEvent.keyDown(button,{key:"Escape"});
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
  it("标签页根据 End 键通知调用方并移动焦点", () => {
    const change=vi.fn();
    render(<Tabs label="示例" value="a" onChange={change} items={[{id:"a",label:"概要",panel:"甲"},{id:"b",label:"明细",panel:"乙"}]}/>);
    fireEvent.keyDown(screen.getByRole("tab",{name:"概要"}),{key:"End"});
    expect(change).toHaveBeenCalledWith("b");
    expect(screen.getByRole("tab",{name:"明细"})).toHaveFocus();
  });
});
