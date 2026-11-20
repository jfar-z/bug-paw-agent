import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { configurationGroups } from "../configuration-navigation";
import { CapabilitiesPage } from "../pages/capabilities-page";
import { ConfigurationSidebar } from "./configuration-sidebar";

/** 入口元数据共享后仍保留路由、选中态和移动端关闭合同。 */
describe("配置导航共享入口", () => {
  it("概览和全部业务入口名称稳定，选择后导航并关闭抽屉", () => {
    const go = vi.fn(), close = vi.fn();
    render(<ConfigurationSidebar route={{ page: "browser-automation" }} open onClose={close} onNavigate={go} />);
    const nav = within(screen.getByRole("navigation", { name: "配置中心导航" }));
    expect(nav.getByRole("button", { name: "浏览器执行" })).toHaveAttribute("aria-current", "page");
    expect(nav.getByRole("button", { name: "概览" })).not.toHaveAttribute("aria-current");
    for (const entry of configurationGroups.flatMap((group) => group.entries)) {
      fireEvent.click(nav.getByRole("button", { name: entry.title }));
      expect(go).toHaveBeenLastCalledWith(entry.route);
    }
    expect(close).toHaveBeenCalledTimes(12);
  });
  it("能力聚合页与配置目录顺序相同，AIGC 入口打开既有页面", () => {
    const go = vi.fn();
    render(<CapabilitiesPage onNavigate={go} />);
    const capabilities = configurationGroups.find((group) => group.title === "能力扩展")!;
    const section = within(screen.getByRole("region", { name: "已接入能力" }));
    const entries = section.getAllByRole("button");
    expect(entries.map((entry) => entry.querySelector("strong")?.textContent)).toEqual(capabilities.entries.map((entry) => entry.title));
    fireEvent.click(section.getByRole("button", { name: /^AIGC 渠道/ }));
    expect(go).toHaveBeenCalledWith({ page: "aigc-channels" });
  });
  it("Agent 详情仍归属 Agents 入口", () => {
    render(<ConfigurationSidebar route={{ page: "agent-detail", agentId: "example" }} open={false} onClose={() => undefined} onNavigate={() => undefined} />);
    expect(screen.getByRole("button", { name: "Agents" })).toHaveAttribute("aria-current", "page");
  });
});
