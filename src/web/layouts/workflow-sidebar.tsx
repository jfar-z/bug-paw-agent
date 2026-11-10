import { Workflow, Play, History, FolderOpen, SlidersHorizontal, X } from "lucide-react";
import { SecondarySidebarHeader } from "../components/secondary-sidebar-header";
import type { AppRoute } from "../router";

/** 复用现有二级导航容器，保证三主题、宽度和移动抽屉行为一致。 */
export function WorkflowSidebar({
  route,
  open,
  onClose,
  onNavigate,
}: {
  route: AppRoute;
  open: boolean;
  onClose: () => void;
  onNavigate: (route: AppRoute) => void;
}) {
  const items = [
    {
      page: "workflows" as const,
      label: "工作流列表",
      icon: Workflow,
      active: route.page === "workflows" || route.page === "workflow-editor",
    },
    {
      page: "workflow-run" as const,
      label: "运行工作流",
      icon: Play,
      active: route.page === "workflow-run",
    },
    {
      page: "workflow-history" as const,
      label: "运行记录",
      icon: History,
      active: route.page === "workflow-history",
    },
    {page: "workflow-semaphores" as const, label: "信号量管理", icon: SlidersHorizontal, active: route.page === "workflow-semaphores"},
    {page: "workflow-files" as const, label: "工作流文件管理", icon: FolderOpen, active: route.page === "workflow-files"},
  ];
  return (
    <aside className={`aigc-workbench-sidebar${open ? " is-open" : ""}`}>
      <SecondarySidebarHeader
        eyebrow="WORKFLOWS"
        title="工作流"
        actions={
          <button
            type="button"
            className="icon-button aigc-workbench-sidebar__close"
            aria-label="关闭工作流导航"
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        }
      />
      <nav className="aigc-workbench-nav" aria-label="工作流导航">
        <p>编排与执行</p>
        {items.map(({ page, label, icon: Icon, active }) => (
          <button
            type="button"
            key={page}
            className={active ? "is-active" : undefined}
            aria-current={active ? "page" : undefined}
            onClick={() => {
              onNavigate({ page });
              onClose();
            }}
          >
            <Icon size={17} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
