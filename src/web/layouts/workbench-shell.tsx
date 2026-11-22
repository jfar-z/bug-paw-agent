import { WorkflowSidebar } from "./workflow-sidebar";
import { Workflow, CalendarClock, ChevronDown, Film, FolderOpen, GitFork, LibraryBig, LogOut, Menu, MessageSquare, Settings2, WandSparkles, X } from "lucide-react";
import { createContext, type ReactNode, useContext, useCallback, useEffect, useRef, useState } from "react";
import { ProductMark } from "../components/product-mark";
import { ThemeSwitcher } from "../components/theme-switcher";
import { WORKBENCH_NAVIGATION_TOGGLE_EVENT, type AppRoute } from "../router";
import { IconButton } from "../ui/controls";
import type { ThemePreference } from "../theme";
import { AIGC_NAVIGATION_TOGGLE_EVENT, AigcWorkbenchSidebar } from "./aigc-workbench-sidebar";
import { ConfigurationSidebar } from "./configuration-sidebar";

type NavigationDrawer = "primary" | "secondary" | null;
const NavigationContext = createContext<{
  drawer: NavigationDrawer;
  close: () => void;
  openSecondary: () => void;
} | null>(null);

/** 业务页共用移动导航状态，保留各自的目录与条目操作。 */
export function useWorkbenchNavigation() {
  return useContext(NavigationContext);
}

export function useMediaNavigation() {
  const navigation = useWorkbenchNavigation();
  return { open: navigation?.drawer === "secondary", close: navigation?.close ?? (() => {}) };
}

interface WorkbenchShellProps {
  route: AppRoute;
  theme: ThemePreference;
  children: ReactNode;
  onThemeChange: (theme: ThemePreference) => void;
  onNavigate: (route: AppRoute) => boolean | void;
  onLogout: () => void;
}

/**
 * 组合工作台主导航、配置目录与当前业务页面。
 */
export function WorkbenchShell({
  route,
  theme,
  children,
  onThemeChange,
  onNavigate,
  onLogout,
}: WorkbenchShellProps) {
  const [drawer, setDrawer] = useState<NavigationDrawer>(null);
  const shell = useRef<HTMLElement>(null);
  const close = useCallback(() => setDrawer(null), []);
  const openSecondary = useCallback(() => setDrawer("secondary"), []);
  const mainNavigationOpen = drawer === "primary";
  const secondaryOpen = drawer === "secondary";
  const configurationRoute = isConfigurationRoute(route);
  const workflowRoute = route.page === "workflows" || route.page.startsWith("workflow-");
  const aigcRoute = isAigcRoute(route) || workflowRoute;
  const mediaLibraryRoute = route.page === "media-library";
  const knowledgeBaseRoute = route.page === "knowledge-base";
  const agentNavigationRoute = route.page === "workspace-resources" || route.page === "scheduled-tasks";
  const hasSecondary = configurationRoute || aigcRoute || mediaLibraryRoute || knowledgeBaseRoute || agentNavigationRoute;
  const secondaryLabel = configurationRoute ? "配置导航" : workflowRoute ? "工作流导航" : aigcRoute ? "AIGC 导航" :
    mediaLibraryRoute ? "媒体库列表" : knowledgeBaseRoute ? "知识库列表" : "Agent 列表";
  const context = { drawer, close, openSecondary };
  const togglePrimary = useCallback(() => setDrawer((current) => current === "primary" ? null : "primary"), []);
  const toggleSecondary = useCallback(() => setDrawer((current) => current === "secondary" ? null : "secondary"), []);
  const primaryNavigation = [
    { label: "会话", route: { page: "chat" } as AppRoute, icon: MessageSquare, active: route.page === "chat" },
    { label: "AIGC 工作台", route: { page: "aigc-overview" } as AppRoute, icon: WandSparkles, active: aigcRoute && !workflowRoute },
    { label: "工作流", route: { page: "workflows" } as AppRoute, icon: Workflow, active: workflowRoute },
    { label: "资源管理", route: { page: "workspace-resources" } as AppRoute, icon: FolderOpen, active: route.page === "workspace-resources" },
    { label: "知识库", route: { page: "knowledge-base" } as AppRoute, icon: LibraryBig, active: route.page === "knowledge-base" },
    { label: "媒体库", route: { page: "media-library" } as AppRoute, icon: Film, active: mediaLibraryRoute },
    { label: "定时任务", route: { page: "scheduled-tasks" } as AppRoute, icon: CalendarClock, active: route.page === "scheduled-tasks" },
    { label: "配置中心", route: { page: "configuration-overview" } as AppRoute, icon: Settings2, active: configurationRoute },
  ];

  // 等路由真正提交后收起导航，保留尚待处理的离开确认。
  useEffect(close, [route, close]);
  useEffect(() => {
    const mobile = window.matchMedia?.("(max-width: 760px)");
    const resetDesktop = () => { if (!mobile?.matches) close(); };
    mobile?.addEventListener("change", resetDesktop);
    window.addEventListener(WORKBENCH_NAVIGATION_TOGGLE_EVENT, togglePrimary);
    window.addEventListener(AIGC_NAVIGATION_TOGGLE_EVENT, toggleSecondary);
    return () => {
      mobile?.removeEventListener("change", resetDesktop);
      window.removeEventListener(WORKBENCH_NAVIGATION_TOGGLE_EVENT, togglePrimary);
      window.removeEventListener(AIGC_NAVIGATION_TOGGLE_EVENT, toggleSecondary);
    };
  }, [close, togglePrimary, toggleSecondary]);

  useEffect(() => {
    if (!drawer) return;
    const panel = shell.current?.querySelector<HTMLElement>(drawer === "primary" ? ".workbench-rail" :
      ".configuration-sidebar.is-open, .aigc-workbench-sidebar.is-open, .knowledge-base-navigation.is-mobile-open, .workspace-agent-navigation.is-mobile-open, .chat-sidebar.is-open");
    if (!panel) { close(); return; }
    const trigger = shell.current?.querySelector<HTMLElement>(drawer === "primary"
      ? '.chat-workbench-switcher[aria-expanded="true"]'
      : '.workbench-secondary-menu[aria-expanded="true"], .live-chat-header .mobile-menu');
    const focusable = () => [...panel.querySelectorAll<HTMLElement>("button, a[href], input, [tabindex]")]
      .filter((element) => !element.matches(":disabled") && element.tabIndex >= 0 && element.getClientRects().length > 0);
    (panel.querySelector<HTMLElement>('[aria-current="page"]') ?? focusable()[0])?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('[aria-modal="true"]:not([aria-hidden="true"])')) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if (event.key === "Tab") {
        const controls = focusable();
        const index = controls.indexOf(document.activeElement as HTMLElement);
        if (index < 0 || (event.shiftKey ? index === 0 : index === controls.length - 1)) {
          event.preventDefault();
          (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      if (!panel.contains(document.activeElement) && document.activeElement !== document.body) return;
      // 路由切换后，原入口可能由新页面的顶部栏替换。
      const usable = (element: HTMLElement | null | undefined) =>
        element?.isConnected && element.getClientRects().length > 0 && !element.matches(":disabled");
      const fallback = [...(shell.current?.querySelectorAll<HTMLElement>(".chat-workbench-switcher") ?? [])].find(usable);
      (usable(trigger) ? trigger : fallback)?.focus();
    };
  }, [close, drawer]);

  const shellMode = configurationRoute ? "is-configuration" : aigcRoute ? "is-aigc" : (agentNavigationRoute || mediaLibraryRoute || knowledgeBaseRoute) ? "is-workspace-resources" : "is-chat";

  return (
    <NavigationContext.Provider value={context}>
    <main ref={shell} className={`workbench-shell ${shellMode}`} style={{ height: "var(--app-viewport-height, 100dvh)" }}>
      <header className="workbench-mobile-header">
        <IconButton
          className="icon-button workbench-secondary-menu"
          label={hasSecondary ? `${secondaryOpen ? "关闭" : "打开"}${secondaryLabel}` : "当前工作台没有二级导航"}
          aria-expanded={hasSecondary ? secondaryOpen : undefined}
          disabled={!hasSecondary}
          onClick={toggleSecondary}
        >
          <Menu size={19} />
        </IconButton>
        <button
          type="button"
          className="chat-workbench-switcher"
          aria-label={mainNavigationOpen ? "关闭工作台导航" : "打开工作台导航"}
          aria-expanded={mainNavigationOpen}
          onClick={togglePrimary}
        >
          <span>工作台</span><ChevronDown size={14} aria-hidden="true" />
        </button>
        <ProductMark />
      </header>

      {(mainNavigationOpen || (secondaryOpen && (configurationRoute || aigcRoute))) && (
        <button type="button" className="workbench-scrim" aria-label="关闭导航" tabIndex={-1} onClick={close} />
      )}

      <aside className={mainNavigationOpen ? "workbench-rail is-open" : "workbench-rail"}>
        <div className="workbench-rail__brand">
          <ProductMark compact />
          <IconButton className="workbench-rail__close" label="关闭工作台导航" onClick={close}><X /></IconButton>
        </div>
        <nav className="workbench-main-nav" aria-label="工作台主导航">
          {primaryNavigation.map(({ label, route: nextRoute, icon: Icon, active }) => (
            <button
              key={label}
              type="button"
              className={active ? "is-active" : undefined}
              aria-current={active ? "page" : undefined}
              aria-label={label}
              title={label}
              onClick={() => onNavigate(nextRoute)}
            >
              <Icon size={20} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="workbench-rail__actions">
          <ThemeSwitcher value={theme} onChange={onThemeChange} compact />
          <a className="icon-button" href="https://github.com/jfar-z/bug-paw-agent" target="_blank" rel="noreferrer" aria-label="打开 BugPaw GitHub 仓库" title="GitHub">
            <GitFork size={18} aria-hidden="true" />
          </a>
          <button type="button" className="icon-button" aria-label="退出登录" title="退出登录" onClick={onLogout}>
            <LogOut size={18} aria-hidden="true" />
          </button>
        </div>
      </aside>

      <div className="workbench-content">
        {configurationRoute ? (
          <div className="configuration-shell">
            <ConfigurationSidebar
              route={route}
              open={secondaryOpen}
              onClose={close}
              onNavigate={onNavigate}
            />
            <section className="configuration-content">
              {children}
            </section>
          </div>
        ) : aigcRoute ? (
          <div className="aigc-workbench-shell">
            {workflowRoute ? <WorkflowSidebar route={route} open={secondaryOpen} onClose={close} onNavigate={onNavigate} /> : <AigcWorkbenchSidebar
              route={route}
              open={secondaryOpen}
              onClose={close}
              onNavigate={onNavigate}
            />}
            <section className="aigc-workbench-content">
              {children}
            </section>
          </div>
        ) : children}
      </div>
    </main>
    </NavigationContext.Provider>
  );
}

/**
 * 判断路由是否属于 AIGC 工作台。
 *
 * @param route 当前工作台路由
 */
function isAigcRoute(route: AppRoute): boolean {
  return [
    "aigc-overview",
    "aigc-run",
    "aigc-interfaces",
    "aigc-templates",
    "aigc-tasks",
    "aigc-outputs",
    "aigc-media-editor",
    "aigc-public-directory",
    "aigc-workflows",
    "aigc-interface-detail",
    "aigc-task-detail",
    "aigc-workflow-detail",
  ].includes(route.page);
}

/**
 * 判断路由是否属于配置中心，一级工作台预留页不展示配置二级目录。
 *
 * @param route 当前工作台路由
 */
function isConfigurationRoute(route: AppRoute): boolean {
  return [
    "configuration-overview",
    "agents",
    "providers",
    "pi-settings",
    "resources",
    "capabilities",
    "web-research",
    "browser-automation",
    "tts",
    "knowledge-retrieval",
    "aigc-channels",
    "configuration-operations",
    "security",
    "diagnostics",
    "agent-detail",
  ].includes(route.page);
}
