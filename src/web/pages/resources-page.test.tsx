import { chooseOption } from "../test-select";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiClientError, type ResourceCatalog } from "../api";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { ResourcesPage } from "./resources-page";

/** 可控任务源只发虚构事件，验证断流与重订阅不会重提包操作。 */
class ResourceStream {
  static streams: ResourceStream[] = [];
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  close = vi.fn();
  constructor(readonly url: string) { ResourceStream.streams.push(this); }
  send(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
}
const doc = (): ResourceCatalog => ({ resources: [{ id:"skill:/demo/one", name:"Research", description:"研究笔记", type:"skill", path:"/demo/one", source:"npm:example", scope:"global", origin:"package", enabled:true, inherited:false, mode:"default" }], tools:[{name:"demo_tool", description:"文件检索",extensionPath:"/demo/extension.ts",highRisk:true}], packages:[{source:"npm:example",scope:"user",filtered:false}], diagnostics:[] });
const show = () => render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}><ResourcesPage /></ApiTaskProvider></ErrorToastProvider>);
const tick = async () => act(async () => { await Promise.resolve(); });
beforeEach(() => {
  ResourceStream.streams=[];vi.stubGlobal("EventSource",ResourceStream);
  vi.spyOn(api,"listAgents").mockResolvedValue({agents:[{profile:{id:"a",name:"写作助手"}},{profile:{id:"b",name:"代码助手"}}] as never});
  vi.spyOn(api,"listResources").mockResolvedValue(doc());
  vi.spyOn(api,"getResourceTask").mockResolvedValue({status:"completed"});
});
afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();});

/** 页面行为回归覆盖来源事实、写入失败与任务目标，不镜像组件实现。 */
describe("Skills 与扩展交互",()=>{
  it("默认不打开详情，搜索分区独立，工具不是运行中授权",async()=>{
    show();await screen.findByRole("button",{name:"查看资源 Research"});expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox",{name:"搜索资源目录"}),{target:{value:"no-match"}});expect(screen.getByText("没有匹配的条目")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab",{name:"注册工具"}));fireEvent.click(screen.getByRole("button",{name:"查看工具 demo_tool"}));
    expect(screen.getByRole("dialog",{name:"工具详情 · demo_tool"})).toHaveTextContent("不代表运行中授权");fireEvent.click(screen.getByRole("button",{name:"关闭工具详情"}));
    fireEvent.click(screen.getByRole("tab",{name:"资源目录"}));expect(screen.getByRole("searchbox")).toHaveValue("no-match");
  });
  it("安装输入关闭与导航只提供继续或放弃，来源变化重置风险确认",async()=>{
    const install=vi.spyOn(api,"installResource");show();await screen.findByRole("button",{name:"查看资源 Research"});
    fireEvent.click(screen.getByRole("button",{name:"安装扩展包"}));fireEvent.change(screen.getByLabelText("扩展包来源"),{target:{value:"npm:example"}});
    fireEvent.click(screen.getByRole("checkbox"));expect(screen.getByRole("button",{name:"开始安装"})).toBeEnabled();
    fireEvent.change(screen.getByLabelText("扩展包来源"),{target:{value:"npm:changed"}});expect(screen.getByRole("checkbox")).not.toBeChecked();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "安装扩展包" }), { key: "Escape" });const guard=screen.getByRole("dialog",{name:"还有未提交的安装输入"});expect(within(guard).queryByRole("button",{name:"保存并切换"})).not.toBeInTheDocument();
    fireEvent.click(within(guard).getByRole("button",{name:"继续编辑"}));expect(screen.getByLabelText("扩展包来源")).toHaveValue("npm:changed");
    fireEvent.keyDown(screen.getByRole("dialog", { name: "安装扩展包" }), { key: "Escape" });fireEvent.click(screen.getByRole("button",{name:"放弃并切换"}));expect(screen.queryByRole("dialog")).not.toBeInTheDocument();expect(install).not.toHaveBeenCalled();
  });
  it("启停失败保留原状态和对象，内容失败有重试与全局错误",async()=>{
    vi.spyOn(api,"setResourceMode").mockRejectedValue(new ApiClientError("INTERNAL_ERROR","保存资源模式时存储不可用",500));
    const content=vi.spyOn(api,"getResourceContent").mockRejectedValueOnce(new ApiClientError("INTERNAL_ERROR","读取资源 UTF-8 内容失败",500)).mockResolvedValueOnce({content:"虚构内容"});
    show();fireEvent.click(await screen.findByRole("button",{name:"查看资源 Research"}));chooseOption("当前资源模式", "disabled");
    await screen.findAllByText("保存资源模式时存储不可用");expect(screen.getByLabelText("当前资源模式")).toHaveAttribute("value", "default");
    fireEvent.click(screen.getByRole("button",{name:"查看资源内容"}));fireEvent.click(await screen.findByRole("button",{name:"重新读取资源内容"}));await screen.findByText("虚构内容");expect(content).toHaveBeenCalledTimes(2);expect(screen.getAllByRole("button",{name:"查看错误详情"}).length).toBeGreaterThan(0);
  });
  it("断流不重提安装，切换 Agent 后完成事件仍属于全局任务",async()=>{
    const install=vi.spyOn(api,"installResource").mockResolvedValue({taskId:"demo-task"});show();await screen.findByRole("button",{name:"查看资源 Research"});
    fireEvent.click(screen.getByRole("button",{name:"安装扩展包"}));fireEvent.change(screen.getByLabelText("扩展包来源"),{target:{value:"npm:example"}});fireEvent.click(screen.getByRole("checkbox"));fireEvent.click(screen.getByRole("button",{name:"开始安装"}));
    await screen.findByText("进行中");expect(install).toHaveBeenCalledWith("npm:example","global",undefined);expect(screen.getByRole("button",{name:"安装扩展包"})).toBeDisabled();
    fireEvent.click(screen.getByRole("button",{name:"Agent 资源"}));await waitFor(()=>expect(api.listResources).toHaveBeenCalledWith("a"));
    act(()=>ResourceStream.streams[0].onerror?.());await screen.findByText("结果未确认");
    expect(screen.getByRole("button",{name:"安装扩展包"})).toBeDisabled();fireEvent.click(screen.getByRole("button",{name:"重新订阅原任务"}));
    await waitFor(()=>expect(ResourceStream.streams).toHaveLength(2));act(()=>ResourceStream.streams[1].send({type:"completed"}));await screen.findByText("已完成");
    await waitFor(()=>expect(screen.getByRole("button",{name:"安装扩展包"})).toBeEnabled());expect(install).toHaveBeenCalledTimes(1);expect(screen.queryByText("配置已保存，等待应用")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:"全局资源"}));await screen.findByText("配置已保存，等待应用");
  });
  it("完成后目录重读失败保留完成事实，明确重试目录",async()=>{
    vi.spyOn(api,"installResource").mockResolvedValue({taskId:"demo-refresh"});vi.mocked(api.listResources).mockResolvedValueOnce(doc()).mockRejectedValueOnce(new ApiClientError("INTERNAL_ERROR","完成后读取目录时存储不可用",500)).mockResolvedValue(doc());
    show();await screen.findByRole("button",{name:"查看资源 Research"});fireEvent.click(screen.getByRole("button",{name:"安装扩展包"}));fireEvent.change(screen.getByLabelText("扩展包来源"),{target:{value:"npm:example"}});fireEvent.click(screen.getByRole("checkbox"));fireEvent.click(screen.getByRole("button",{name:"开始安装"}));await screen.findByText("进行中");
    // 任务状态先渲染，订阅在后续 Effect 中创建；等待订阅后再模拟完成事件。
    await waitFor(()=>expect(ResourceStream.streams).toHaveLength(1));
    act(()=>ResourceStream.streams[0].send({type:"completed"}));
    await screen.findByText("任务已完成，目录更新失败。请重新加载目录；不要重复提交包操作。");expect(screen.getByText("已完成")).toBeInTheDocument();fireEvent.click(screen.getByRole("button",{name:"重新加载目录"}));await screen.findByRole("button",{name:"查看资源 Research"});
  });
  it("从 Agent 卸载全局包明确全局影响，引用拒绝保留确认对象",async()=>{
    const remove=vi.spyOn(api,"removeResourcePackage").mockRejectedValue(new ApiClientError("PACKAGE_IN_USE","扩展包仍被写作助手引用",409));show();await screen.findByRole("button",{name:"查看资源 Research"});fireEvent.click(screen.getByRole("button",{name:"Agent 资源"}));await tick();fireEvent.click(screen.getByRole("tab",{name:"扩展包"}));fireEvent.click(screen.getByRole("button",{name:"卸载 npm:example"}));
    const confirm = within(screen.getByRole("dialog", { name: "确认卸载扩展包" }));
    expect(confirm.getByText(/即使从 Agent 视图操作也影响全局/)).toBeInTheDocument();
    fireEvent.click(confirm.getByRole("button", { name: "确认卸载" }));
    const impact = await confirm.findByRole("region", { name: "操作影响清单" });
    await within(impact).findByText("扩展包仍被写作助手引用");
    const notice = await confirm.findByRole("group", { name: "卸载扩展包失败" });
    expect(notice).toHaveTextContent("扩展包仍被写作助手引用");
    fireEvent.click(within(notice).getByRole("button", { name: "查看错误详情" }));
    expect(within(notice).getByText("PACKAGE_IN_USE")).toBeInTheDocument();
    expect(remove).toHaveBeenCalledWith("npm:example", "global", undefined);
  });
  it("Agent 目录失败不冒充空态，迟到目录不能覆盖新目标",async()=>{
    let resolveA: (value: ResourceCatalog)=>void = ()=>undefined;
    vi.mocked(api.listResources).mockImplementation(async(id)=>id==="a"?new Promise<ResourceCatalog>(resolve=>{resolveA=resolve;}):{...doc(),resources:doc().resources.map(r=>({...r,name:id==="b"?"Code":"Research"}))});
    show();await screen.findByRole("button",{name:"查看资源 Research"});fireEvent.click(screen.getByRole("button",{name:"Agent 资源"}));await waitFor(()=>expect(api.listResources).toHaveBeenCalledWith("a"));chooseOption("资源 Agent", "b");await screen.findByRole("button",{name:"查看资源 Code"});await act(async()=>resolveA(doc()));expect(screen.queryByRole("button",{name:"查看资源 Research"})).not.toBeInTheDocument();
  });
});
