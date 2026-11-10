import { useEffect, useState } from "react";

export type AppRoute =
  | { page: "chat" }
  | { page: "workflows" }
  | { page: "workflow-editor"; workflowId: string }
  | { page: "workflow-run"; workflowId?: string; runId?: string }
  | { page: "workflow-history" }
  | { page: "workflow-files" }
  | { page: "workflow-semaphores" }
  | { page: "aigc-overview" }
  | { page: "aigc-run"; interfaceId?: string }
  | { page: "aigc-interfaces" }
  | { page: "aigc-tasks" }
  | { page: "aigc-outputs" }
  | { page: "aigc-media-editor" }
  | { page: "aigc-public-directory" }
  | { page: "aigc-workflows" }
  | { page: "aigc-interface-detail"; interfaceId: string }
  | { page: "aigc-task-detail"; taskId: string }
  | { page: "aigc-workflow-detail"; workflowId: string }
  | { page: "workspace-resources" }
  | { page: "knowledge-base" }
  | { page: "scheduled-tasks" }
  | { page: "configuration-overview" }
  | { page: "capabilities" }
  | { page: "web-research" }
  | { page: "browser-automation" }
  | { page: "tts" }
  | { page: "knowledge-retrieval" }
  | { page: "aigc-channels" }
  | { page: "agents"; onboarding?: "create" }
  | { page: "providers" }
  | { page: "pi-settings" }
  | { page: "resources" }
  | { page: "configuration-operations" }
  | { page: "security" }
  | { page: "diagnostics" }
  | { page: "agent-detail"; agentId: string };

/** 导航守卫可恢复原始导航意图，包括浏览器返回与 replace 导航。 */
export type NavigationBeforeEvent = CustomEvent<AppRoute> & { resume?: () => void };
const HISTORY_INDEX = "pi-agent-route-index";

/** 保留移动端已有 History 元数据，仅补充站内位置。 */
function historyState(index: number): Record<string, unknown> {
  return { ...(typeof window.history.state === "object" && window.history.state !== null ? window.history.state : {}), [HISTORY_INDEX]: index };
}

const NAVIGATION_EVENT = "pi-agent:navigate";
export const NAVIGATION_BEFORE_EVENT = "pi-agent:before-navigate";
export const WORKBENCH_NAVIGATION_TOGGLE_EVENT = "pi-agent:toggle-workbench-navigation";
export const KNOWLEDGE_BASE_NAVIGATION_TOGGLE_EVENT = "pi-agent:toggle-knowledge-base-navigation";

/**
 * 将浏览器路径解析为工作台路由，未知地址安全回退到对话页。
 */
export function parseRoute(pathname: string, search = ""): AppRoute {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (normalized === "/workflows") return { page: "workflows" };
  if (normalized === "/workflows/run") { const params = new URLSearchParams(search); return { page: "workflow-run", workflowId: params.get("workflow") ?? undefined, runId: params.get("run") ?? undefined }; }
  if (normalized === "/workflows/semaphores") return { page: "workflow-semaphores" };
  if (normalized === "/workflows/files") return { page: "workflow-files" };
  if (normalized === "/workflows/history") return { page: "workflow-history" };
  const workflowMatch = normalized.match(/^\/workflows\/([^/]+)\/edit$/);
  if (workflowMatch) { try { return { page: "workflow-editor", workflowId: decodeURIComponent(workflowMatch[1]) }; } catch { return { page: "workflows" }; } }
  if (normalized === "/aigc") return { page: "aigc-overview" };
  if (normalized === "/aigc/run") {
    const interfaceId = new URLSearchParams(search).get("interface")?.trim();
    return interfaceId ? { page: "aigc-run", interfaceId } : { page: "aigc-run" };
  }
  if (normalized === "/aigc/interfaces") return { page: "aigc-interfaces" };
  if (normalized === "/aigc/tasks") return { page: "aigc-tasks" };
  if (normalized === "/aigc/outputs") return { page: "aigc-outputs" };
  if (normalized === "/aigc/editor") return { page: "aigc-media-editor" };
  if (normalized === "/aigc/public-directory") return { page: "aigc-public-directory" };
  if (normalized === "/aigc/workflows") return { page: "aigc-workflows" };
  const aigcInterfaceMatch = normalized.match(/^\/aigc\/interfaces\/([^/]+)$/);
  if (aigcInterfaceMatch) {
    try {
      return { page: "aigc-interface-detail", interfaceId: decodeURIComponent(aigcInterfaceMatch[1]) };
    } catch {
      return { page: "chat" };
    }
  }
  const aigcTaskMatch = normalized.match(/^\/aigc\/tasks\/([^/]+)$/);
  if (aigcTaskMatch) {
    try {
      return { page: "aigc-task-detail", taskId: decodeURIComponent(aigcTaskMatch[1]) };
    } catch {
      return { page: "chat" };
    }
  }
  const aigcWorkflowMatch = normalized.match(/^\/aigc\/workflows\/([^/]+)$/);
  if (aigcWorkflowMatch) {
    try {
      return { page: "aigc-workflow-detail", workflowId: decodeURIComponent(aigcWorkflowMatch[1]) };
    } catch {
      return { page: "chat" };
    }
  }
  if (normalized === "/resources") return { page: "workspace-resources" };
  if (normalized === "/knowledge-base") return { page: "knowledge-base" };
  if (normalized === "/scheduled-tasks") return { page: "scheduled-tasks" };
  if (normalized === "/settings") {
    return { page: "configuration-overview" };
  }
  if (normalized === "/settings/capabilities") return { page: "capabilities" };
  if (normalized === "/settings/capabilities/web-research") return { page: "web-research" };
  if (normalized === "/settings/capabilities/browser") return { page: "browser-automation" };
  if (normalized === "/settings/capabilities/tts") return { page: "tts" };
  if (normalized === "/settings/capabilities/knowledge-retrieval") return { page: "knowledge-retrieval" };
  if (normalized === "/settings/capabilities/aigc-channels") return { page: "aigc-channels" };
  if (normalized === "/settings/agents") {
    return new URLSearchParams(search).get("onboarding") === "create"
      ? { page: "agents", onboarding: "create" }
      : { page: "agents" };
  }
  if (normalized === "/settings/providers") {
    return { page: "providers" };
  }
  if (normalized === "/settings/pi") {
    return { page: "pi-settings" };
  }
  if (normalized === "/settings/resources") {
    return { page: "resources" };
  }
  if (normalized === "/settings/operations") return { page: "configuration-operations" };
  if (normalized === "/settings/security") return { page: "security" };
  if (normalized === "/settings/diagnostics") return { page: "diagnostics" };
  const match = normalized.match(/^\/settings\/agents\/([^/]+)$/);
  if (match) {
    try {
      return { page: "agent-detail", agentId: decodeURIComponent(match[1]) };
    } catch {
      return { page: "chat" };
    }
  }
  return { page: "chat" };
}

/**
 * 生成工作台路由对应的稳定路径。
 */
export function routePath(route: AppRoute): string {
  switch (route.page) {
    case "workflows": return "/workflows";
    case "workflow-editor": return `/workflows/${encodeURIComponent(route.workflowId)}/edit`;
    case "workflow-semaphores": return "/workflows/semaphores";
    case "workflow-files": return "/workflows/files";
    case "workflow-history": return "/workflows/history";
    case "workflow-run": { const params = new URLSearchParams(); if (route.workflowId) params.set("workflow", route.workflowId); if (route.runId) params.set("run", route.runId); return `/workflows/run${params.size ? `?${params}` : ""}`; }

    case "aigc-overview":
      return "/aigc";
    case "aigc-run":
      return route.interfaceId ? `/aigc/run?interface=${encodeURIComponent(route.interfaceId)}` : "/aigc/run";
    case "aigc-interfaces":
      return "/aigc/interfaces";
    case "aigc-tasks":
      return "/aigc/tasks";
    case "aigc-outputs":
      return "/aigc/outputs";
    case "aigc-media-editor":
      return "/aigc/editor";
    case "aigc-public-directory":
      return "/aigc/public-directory";
    case "aigc-workflows":
      return "/aigc/workflows";
    case "aigc-interface-detail":
      return `/aigc/interfaces/${encodeURIComponent(route.interfaceId)}`;
    case "aigc-task-detail":
      return `/aigc/tasks/${encodeURIComponent(route.taskId)}`;
    case "aigc-workflow-detail":
      return `/aigc/workflows/${encodeURIComponent(route.workflowId)}`;
    case "workspace-resources":
      return "/resources";
    case "knowledge-base":
      return "/knowledge-base";
    case "scheduled-tasks":
      return "/scheduled-tasks";
    case "configuration-overview":
      return "/settings";
    case "capabilities":
      return "/settings/capabilities";
    case "web-research":
      return "/settings/capabilities/web-research";
    case "browser-automation":
      return "/settings/capabilities/browser";
    case "tts":
      return "/settings/capabilities/tts";
    case "knowledge-retrieval":
      return "/settings/capabilities/knowledge-retrieval";
    case "aigc-channels":
      return "/settings/capabilities/aigc-channels";
    case "agents":
      return route.onboarding === "create" ? "/settings/agents?onboarding=create" : "/settings/agents";
    case "providers":
      return "/settings/providers";
    case "pi-settings":
      return "/settings/pi";
    case "resources":
      return "/settings/resources";
    case "configuration-operations":
      return "/settings/operations";
    case "security":
      return "/settings/security";
    case "diagnostics":
      return "/settings/diagnostics";
    case "agent-detail":
      return `/settings/agents/${encodeURIComponent(route.agentId)}`;
    default:
      return "/chat";
  }
}

/**
 * 使用 History API 导航，并通知当前页面内的路由订阅者。
 */
export function navigateTo(route: AppRoute, replace = false): void {
  const beforeEvent: NavigationBeforeEvent = new CustomEvent<AppRoute>(NAVIGATION_BEFORE_EVENT, { cancelable: true, detail: route });
  beforeEvent.resume = () => navigateTo(route, replace);
  if (!window.dispatchEvent(beforeEvent)) return;
  const method = replace ? "replaceState" : "pushState";
  const index = typeof window.history.state?.[HISTORY_INDEX] === "number" ? window.history.state[HISTORY_INDEX] : 0;
  window.history[method](historyState(index + (replace ? 0 : 1)), "", routePath(route));
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

/**
 * 订阅 History API 和应用内导航事件。
 */
export function useBrowserRoute(): AppRoute {
  const [route, setRoute] = useState<AppRoute>(() => parseRoute(window.location.pathname, window.location.search));

  useEffect(() => {
    let currentIndex: number = window.history.state?.[HISTORY_INDEX] ?? 0;
    let currentUrl = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState(historyState(currentIndex), "", window.location.href);
    let restoring = false;
    let replayRequested = false;
    let replayDelta = 0;
    let replaying = false;
    const refresh = () => {
      currentIndex = window.history.state?.[HISTORY_INDEX] ?? currentIndex;
      currentUrl = `${window.location.pathname}${window.location.search}`;
      setRoute(parseRoute(window.location.pathname, window.location.search));
    };
    const onPopState = (event: PopStateEvent) => {
      if (restoring) {
        // 恢复被取消的 History 位置时不发布路由，也不触发移动端退出逻辑。
        event.stopImmediatePropagation();
        restoring = false;
        if (replayRequested) { replaying = true; window.history.go(replayDelta); }
        return;
      }
      if (replaying) { replaying = false; replayRequested = false; refresh(); return; }
      const targetUrl = `${window.location.pathname}${window.location.search}`;
      if (targetUrl === currentUrl) { refresh(); return; }
      const target = parseRoute(window.location.pathname, window.location.search);
      const targetIndex = event.state?.[HISTORY_INDEX];
      const known = typeof targetIndex === "number" && targetIndex !== currentIndex;
      const delta = known ? currentIndex - targetIndex : 0;
      const before: NavigationBeforeEvent = new CustomEvent<AppRoute>(NAVIGATION_BEFORE_EVENT, { cancelable: true, detail: target });
      before.resume = () => {
        if (!known) { navigateTo(target, true); return; }
        replayRequested = true;
        replayDelta = -delta;
        if (!restoring) { replaying = true; window.history.go(replayDelta); }
      };
      if (!window.dispatchEvent(before)) {
        event.stopImmediatePropagation();
        if (known) { restoring = true; window.history.go(delta); }
        else {
          // 刷新前或外部创建的 History 条目无位置标识，保留草稿并恢复当前地址。
          window.history.pushState(historyState(currentIndex), "", currentUrl);
        }
        return;
      }
      refresh();
    };
    window.addEventListener("popstate", onPopState, true);
    window.addEventListener(NAVIGATION_EVENT, refresh);
    return () => {
      window.removeEventListener("popstate", onPopState, true);
      window.removeEventListener(NAVIGATION_EVENT, refresh);
    };
  }, []);

  return route;
}
