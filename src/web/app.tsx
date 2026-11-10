import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";
import { api, ApiClientError, type SetupRequest } from "./api";
import { toUnexpectedErrorNotice } from "./api-error-policy";
import { ApiTaskProvider } from "./api-task-provider";
import { useErrorToast } from "./error-toast-provider";
import { LoginPage } from "./pages/login-page";
import { SetupPage } from "./pages/setup-page";
import { WorkbenchShell } from "./layouts/workbench-shell";
import { navigateTo, useBrowserRoute, type AppRoute } from "./router";
import {
  applyTheme,
  readThemePreference,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "./theme";
import { usePressFeedback } from "./use-press-feedback";
import { useOnlineStatus } from "./use-online-status";
import { useMobileBackNavigation } from "./use-mobile-back-navigation";
import { clearAllQuestionDrafts } from "./question-draft-store";

type PreviewPage = "setup" | "login" | "chat";
type AppPage = "loading" | "setup" | "login" | "workbench" | "error";

const WorkflowSemaphoresPage = lazy(() => import("./pages/workflow-semaphores-page").then(module => ({ default: module.WorkflowSemaphoresPage })));
const WorkflowFilesPage = lazy(() => import("./pages/workflow-files-page").then(module => ({ default: module.WorkflowFilesPage })));
const WorkflowsPage = lazy(() => import("./pages/workflows-page").then(module => ({ default: module.WorkflowsPage })));
const ChatPage = lazy(() => import("./pages/chat-page").then((module) => ({ default: module.ChatPage })));
const AigcWorkbenchPage = lazy(() => import("./pages/aigc-workbench-page").then((module) => ({ default: module.AigcWorkbenchPage })));
const AigcChannelsPage = lazy(() => import("./pages/aigc-channels-page").then((module) => ({ default: module.AigcChannelsPage })));
const AigcOutputsPage = lazy(() => import("./pages/aigc-outputs-page").then((module) => ({ default: module.AigcOutputsPage })));
const AigcMediaEditorPage = lazy(() => import("./pages/aigc-media-editor-page").then((module) => ({ default: module.AigcMediaEditorPage })));
const AigcPublicDirectoryPage = lazy(() => import("./pages/aigc-public-directory-page").then((module) => ({ default: module.AigcPublicDirectoryPage })));
const AgentDetailPage = lazy(() => import("./pages/agent-detail-page").then((module) => ({ default: module.AgentDetailPage })));
const AgentsPage = lazy(() => import("./pages/agents-page").then((module) => ({ default: module.AgentsPage })));
const ConfigurationOverviewPage = lazy(() => import("./pages/configuration-overview-page").then((module) => ({ default: module.ConfigurationOverviewPage })));
const CapabilitiesPage = lazy(() => import("./pages/capabilities-page").then((module) => ({ default: module.CapabilitiesPage })));
const WebResearchPage = lazy(() => import("./pages/web-research-page").then((module) => ({ default: module.WebResearchPage })));
const BrowserAutomationPage = lazy(() => import("./pages/browser-automation-page").then((module) => ({ default: module.BrowserAutomationPage })));
const TtsPage = lazy(() => import("./pages/tts-page").then((module) => ({ default: module.TtsPage })));
const KnowledgeRetrievalPage = lazy(() => import("./pages/knowledge-retrieval-page").then((module) => ({ default: module.KnowledgeRetrievalPage })));
const ProvidersPage = lazy(() => import("./pages/providers-page").then((module) => ({ default: module.ProvidersPage })));
const PiSettingsPage = lazy(() => import("./pages/pi-settings-page").then((module) => ({ default: module.PiSettingsPage })));
const ResourcesPage = lazy(() => import("./pages/resources-page").then((module) => ({ default: module.ResourcesPage })));
const WorkspaceResourcesPage = lazy(() => import("./pages/workspace-resources-page").then((module) => ({ default: module.WorkspaceResourcesPage })));
const KnowledgeBasePage = lazy(() => import("./pages/knowledge-base-page").then((module) => ({ default: module.KnowledgeBasePage })));
const ConfigurationOperationsPage = lazy(() => import("./pages/configuration-operations-page").then((module) => ({ default: module.ConfigurationOperationsPage })));
const SecurityPage = lazy(() => import("./pages/security-page").then((module) => ({ default: module.SecurityPage })));
const DiagnosticsPage = lazy(() => import("./pages/diagnostics-page").then((module) => ({ default: module.DiagnosticsPage })));
const ScheduledTasksPage = lazy(() => import("./pages/scheduled-tasks-page").then((module) => ({ default: module.ScheduledTasksPage })));

function getPreviewPage(): PreviewPage | undefined {
  const page = new URLSearchParams(window.location.search).get("preview");
  if (page === "setup" || page === "login" || page === "chat") {
    return page;
  }

  return undefined;
}

/**
 * v0 使用查询参数切换三个关键页面，便于在接入后端前校准视觉方向。
 */
export function App() {
  usePressFeedback();
  const toast = useErrorToast();
  const online = useOnlineStatus();
  const [theme, setTheme] = useState<ThemePreference>(() => readThemePreference());
  const previewPage = useMemo(getPreviewPage, []);
  const route = useBrowserRoute();
  const [page, setPage] = useState<AppPage>(previewPage === "chat" ? "workbench" : previewPage ?? "loading");
  const [mobileEntryActivated, setMobileEntryActivated] = useState(false);
  const [requiresMobileEntry] = useState(isMobileEntryContext);
  const showMobileEntry = page === "workbench" && !previewPage && requiresMobileEntry && !mobileEntryActivated;
  const { showExitHint } = useMobileBackNavigation({ route, enabled: page === "workbench" && !previewPage && !showMobileEntry, onNavigate: navigateTo });

  useEffect(() => {
    if (previewPage) {
      return;
    }

    let active = true;
    api
      .getStatus()
      .then((status) => {
        if (active) {
          setPage(!status.initialized ? "setup" : status.authenticated ? "workbench" : "login");
        }
      })
      .catch((error) => {
        if (active) {
          setPage("error");
          toast.push(toUnexpectedErrorNotice(error, "加载应用状态"));
        }
      });
    return () => {
      active = false;
    };
  }, [previewPage, toast]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const changeTheme = (nextTheme: ThemePreference) => {
    window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    setTheme(nextTheme);
  };

  const completeSetup = async (input: SetupRequest) => {
    await api.setup(input);
    try {
      await api.login(input.password, true);
      navigateTo({ page: "agents", onboarding: "create" }, true);
      setPage("workbench");
    } catch (error) {
      const expectedAuthenticationFailure = error instanceof ApiClientError
        && ["INVALID_CREDENTIALS", "INVALID_LOGIN_REQUEST", "LOGIN_RATE_LIMITED"].includes(error.code);
      if (!expectedAuthenticationFailure) toast.push(toUnexpectedErrorNotice(error, "初始化后自动登录"));
      navigateTo({ page: "chat" }, true);
      setPage("login");
    }
  };

  const login = async (password: string, remember: boolean) => {
    const result = await api.login(password, remember);
    if (result?.authenticated === false) return result;
    navigateTo({ page: "chat" }, true);
    setPage("workbench");
  };

  const verifyTotp = async (code: string, recovery: boolean) => {
    await api.verifyLoginTotp(code, recovery);
    navigateTo({ page: "chat" }, true);
    setPage("workbench");
  };

  const logout = async () => {
    try {
      await api.logout();
      clearAllQuestionDrafts();
      navigateTo({ page: "chat" }, true);
      setPage("login");
    } catch (error) {
      toast.push(toUnexpectedErrorNotice(error, "退出登录"));
    }
  };

  const renderRoute = (activeRoute: AppRoute) => {
    switch (activeRoute.page) {
      case "workflow-semaphores": return <WorkflowSemaphoresPage />;
      case "workflow-files": return <WorkflowFilesPage />;
      case "workflows":
      case "workflow-editor":
      case "workflow-run":
      case "workflow-history":
        return <WorkflowsPage route={activeRoute} />;
      case "aigc-overview":
      case "aigc-run":
      case "aigc-interfaces":
      case "aigc-tasks":
      case "aigc-workflows":
      case "aigc-interface-detail":
      case "aigc-task-detail":
      case "aigc-workflow-detail":
        return <AigcWorkbenchPage route={activeRoute} />;
      case "aigc-outputs":
        return <AigcOutputsPage />;
      case "aigc-media-editor":
        return <AigcMediaEditorPage />;
      case "aigc-public-directory":
        return <AigcPublicDirectoryPage />;
      case "workspace-resources":
        return <WorkspaceResourcesPage />;
      case "knowledge-base":
        return <KnowledgeBasePage />;
      case "scheduled-tasks":
        return <ScheduledTasksPage />;
      case "configuration-overview":
        return <ConfigurationOverviewPage onNavigate={navigateTo} />;
      case "capabilities":
        return <CapabilitiesPage onNavigate={navigateTo} />;
    case "web-research":
      return <WebResearchPage />;
    case "browser-automation":
      return <BrowserAutomationPage />;
    case "tts":
      return <TtsPage />;
    case "knowledge-retrieval":
      return <KnowledgeRetrievalPage />;
    case "aigc-channels":
      return <AigcChannelsPage />;
      case "agents":
        return <AgentsPage onNavigate={navigateTo} openCreateOnEmpty={activeRoute.onboarding === "create"} />;
      case "agent-detail":
        return <AgentDetailPage agentId={activeRoute.agentId} onNavigate={navigateTo} />;
      case "providers":
        return <ProvidersPage />;
      case "pi-settings":
        return <PiSettingsPage />;
      case "resources":
        return <ResourcesPage />;
      case "configuration-operations":
        return <ConfigurationOperationsPage />;
      case "security":
        return <SecurityPage />;
      case "diagnostics":
        return <DiagnosticsPage />;
      default:
        return <ChatPage theme={theme} onThemeChange={changeTheme} live />;
    }
  };

  return (
    <ApiTaskProvider onAuthenticationRequired={() => {
      clearAllQuestionDrafts();
      navigateTo({ page: "chat" }, true);
      setPage("login");
    }}>
      <div className="app-page-transition" key={page}>
        {page === "loading" && <AppLoadingState />}
        {page === "error" && <main className="app-status-page">无法连接 Agent 服务，请检查容器状态。</main>}
        {page === "setup" && (
          <SetupPage theme={theme} onThemeChange={changeTheme} onComplete={previewPage ? undefined : completeSetup} />
        )}
        {page === "login" && (
          <LoginPage onLogin={previewPage ? undefined : login} onVerify={previewPage ? undefined : verifyTotp} />
        )}
        {page === "workbench" && (
          previewPage ? (
            <Suspense fallback={<AppLoadingState />}>
              <ChatPage theme={theme} onThemeChange={changeTheme} />
            </Suspense>
          ) : (
              <WorkbenchShell
                route={route}
                theme={theme}
                onThemeChange={changeTheme}
                onNavigate={navigateTo}
                onLogout={() => void logout()}
              >
                <Suspense fallback={<WorkbenchLoadingState />}>
                  {renderRoute(route)}
                </Suspense>
              </WorkbenchShell>
          )
        )}
      </div>
      {page === "workbench" && !online ? <div className="offline-banner" role="status">当前处于离线状态。可查看已缓存页面，配置保存和其他写操作已暂停。</div> : null}
      {showExitHint ? <div className="mobile-exit-hint" role="status">再按一次返回退出应用</div> : null}
      {showMobileEntry ? <MobileEntryGate onEnter={() => setMobileEntryActivated(true)} /> : null}

      {previewPage && (
        <nav className="preview-switcher" aria-label="v0 页面预览">
          <span>v0</span>
          <a href="?preview=setup" aria-current={page === "setup" ? "page" : undefined}>首启</a>
          <a href="?preview=login" aria-current={page === "login" ? "page" : undefined}>登录</a>
          <a href="?preview=chat" aria-current={page === "workbench" ? "page" : undefined}>对话</a>
        </nav>
      )}
    </ApiTaskProvider>
  );
}

/** 渲染应用启动与工作台模块加载共用的品牌化等待状态。 */
function AppLoadingState() {
  return (
    <main className="app-status-page app-status-page--loading" role="status" aria-label="正在准备 BugPaw">
      <img src="/brand/bugpaw/bugpaw-sleeping.png" alt="睡眠中的 BUG 猫咪像素吉祥物" />
      <p>正在准备你的工作台…</p>
    </main>
  );
}

/** 在工作台内仅占据当前内容区，避免覆盖已可用的导航。 */
function WorkbenchLoadingState() {
  return (
    <main className="app-status-page app-status-page--loading workbench-content-loading" role="status" aria-label="正在加载页面内容">
      <img src="/brand/bugpaw/bugpaw-sleeping.png" alt="睡眠中的 BUG 猫咪像素吉祥物" />
      <p>正在加载页面内容…</p>
    </main>
  );
}

/** 判断当前文档是否需要移动端首次点按，以获得后续系统返回所需的用户激活。 */
function isMobileEntryContext(): boolean {
  return window.matchMedia("(max-width: 760px)").matches
    || window.matchMedia("(pointer: coarse)").matches
    || window.matchMedia("(display-mode: standalone)").matches;
}

/** 展示移动端工作台的首次入场层，并保留当前页面内容作为背景。 */
function MobileEntryGate({ onEnter }: { onEnter: () => void }) {
  return (
    <section className="mobile-entry-gate" role="dialog" aria-modal="true" aria-labelledby="mobile-entry-gate-title">
      <div className="mobile-entry-gate__glow mobile-entry-gate__glow--top" aria-hidden="true" />
      <div className="mobile-entry-gate__glow mobile-entry-gate__glow--bottom" aria-hidden="true" />
      <div className="mobile-entry-gate__card">
        <div className="mobile-entry-gate__mark"><img src="/brand/bugpaw/bugpaw-mascot.png" alt="BUG 猫咪像素吉祥物" /></div>
        <p className="mobile-entry-gate__eyebrow">BUGPAW / WORKBENCH</p>
        <h1 id="mobile-entry-gate-title">从这里继续工作</h1>
        <p className="mobile-entry-gate__description">轻触进入工作台，继续当前会话与任务。</p>
        <button type="button" className="mobile-entry-gate__enter" onClick={onEnter} autoFocus>
          进入工作台
          <ArrowRight size={17} aria-hidden="true" />
        </button>
        <p className="mobile-entry-gate__note">已为顺畅的移动端返回体验做好准备</p>
      </div>
    </section>
  );
}
