import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FileField, type FileSource } from "./file-field";
import { SelectableList } from "./selectable-list";

// 回归评审中涉及文件丢失、来源变化和跨行误选的交互。
describe("文件与列表选择", () => {
  const source = (id: string): FileSource<string> => ({
    id, label: id,
    render: ({ add }) => <button onClick={() => add([{id:"x",name:"文本.txt",type:"text/plain",ref:"x"}])}>选择文件</button>
  });

  it("被拒绝的文件给出具体原因，已选引用保留", () => {
    const change = vi.fn();
    render(<FileField sources={[source("设备")]} accept="image/*" multiple={false}
      value={[{source:"设备",id:"old",ref:"old",name:"封面.webp"}]} onChange={change}/>);
    fireEvent.click(screen.getByText("选择文件"));
    expect(screen.getByRole("alert")).toHaveTextContent("文本.txt：允许的类型为 image/*");
    expect(screen.getByText("封面.webp")).toBeVisible();
    expect(change).not.toHaveBeenCalled();
  });

  it("来源消失时，新的面板和按钮保持一致", () => {
    const first=source("设备"), second=source("媒体库");
    const model={value:[],onChange:vi.fn()};
    const view=render(<FileField sources={[first,second]} {...model}/>);
    fireEvent.click(screen.getByRole("button",{name:"媒体库"}));
    view.rerender(<FileField sources={[first]} {...model}/>);
    expect(screen.getByRole("button",{name:"设备"})).toHaveAttribute("aria-pressed","true");
    fireEvent.click(screen.getByText("选择文件"));
    expect(model.onChange.mock.calls[0][0][0].source).toBe("设备");
  });

  it("范围选择跳过行内操作，并可清空选择", () => {
    function Sample(){
      const [keys, setKeys]=useState<string[]>([]);
      return <SelectableList rows={["甲","乙","丙"]} selected={keys} onChange={setKeys} keyOf={s=>s} labelOf={s=>s}
        renderRow={s=><><strong>{s}</strong><button>行内操作</button></>}/>;
    }
    render(<Sample/>);
    fireEvent.click(screen.getByText("甲"));
    fireEvent.click(screen.getByText("丙"),{shiftKey:true});
    fireEvent.click(screen.getAllByText("行内操作")[1]);
    expect(screen.getByText("已选 3")).toBeVisible();
    fireEvent.click(screen.getByText("清除选择"));
    expect(screen.getByText("已选 0")).toBeVisible();
  });
});
