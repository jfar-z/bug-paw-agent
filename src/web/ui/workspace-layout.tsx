import { useEffect, useState, type ReactNode, type MouseEvent } from "react";
import { Layers, Menu, PanelLeftOpen } from "lucide-react";
import { SecondarySidebarHeader } from "./sidebar-header";
import { Dialog } from "./dialog";
import { IconButton } from "./controls";
import "./workspace-layout.css";

export interface NavigationGroup {
  id: string;
  label: string;
  icon?: ReactNode;
  eyebrow?: string;
  items: readonly { id: string; label: string }[];
}

/** 显式链接保留中键与新标签行为，移动端只挂载当前打开的抽屉。 */
export function WorkspaceLayout({
  groups,
  groupId,
  itemId,
  onNavigate,
  hrefFor,
  children,
}: {
  groups: readonly NavigationGroup[];
  groupId: string;
  itemId: string;
  onNavigate: (group: string, item: string) => void;
  hrefFor: (group: string, item: string) => string;
  children: ReactNode;
}) {
  const group = groups.find((g) => g.id === groupId);
  const [drawer, setDrawer] = useState<"main" | "sub" | null>(null);
  useEffect(() => {
    const screen = matchMedia("(max-width:760px)");
    const sync = () => {
      if (!screen.matches) setDrawer(null);
    };
    screen.addEventListener("change", sync);
    return () => screen.removeEventListener("change", sync);
  }, []);
  function go(e: MouseEvent<HTMLAnchorElement>, g: string, i: string) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    e.preventDefault();
    onNavigate(g, i);
    setDrawer(null);
  }
  const primary = (
    <nav
      className="bp-workspace__primary"
      aria-label="一级导航"
    >
      {groups.map((g) => {
        const i = g.id === groupId ? itemId : (g.items[0]?.id ?? "");
        return (
          <a
            key={g.id}
            className="bp-workspace__link"
            href={hrefFor(g.id, i)}
            title={g.label}
            aria-label={g.label}
            aria-current={g.id === groupId ? "true" : undefined}
            onClick={(e) => go(e, g.id, i)}
          >
            {g.icon ?? <Layers size={20} aria-hidden />}
            <span className="bp-workspace__label">{g.label}</span>
          </a>
        );
      })}
    </nav>
  );
  const secondary = (
    <div className="bp-workspace__secondary">
      <SecondarySidebarHeader
        eyebrow={group?.eyebrow && <span className="bp-workspace__eyebrow">{group.eyebrow}</span>}
        title={group?.label}
      />
      <nav className="bp-workspace__items" aria-label="二级导航">
        {group?.items.map((i) => (
          <a
            key={i.id}
            className="bp-workspace__item"
            href={hrefFor(groupId, i.id)}
            aria-current={i.id === itemId ? "page" : undefined}
            onClick={(e) => go(e, groupId, i.id)}
          >
            {i.label}
          </a>
        ))}
      </nav>
    </div>
  );
  return (
    <div className="bp-workspace">
      <div className="bp-workspace__top">
        <IconButton
          label="打开一级导航"
          aria-expanded={drawer === "main"}
          onClick={() => setDrawer("main")}
        >
          <Menu />
        </IconButton>
        <IconButton
          label="打开二级导航"
          aria-expanded={drawer === "sub"}
          disabled={!group?.items.length}
          onClick={() => setDrawer("sub")}
        >
          <PanelLeftOpen />
        </IconButton>
        <strong className="bp-workspace__title">{group?.items.find(item => item.id === itemId)?.label ?? group?.label}</strong>
      </div>
      <div className="bp-workspace__desktop">
        {primary}
        {secondary}
      </div>
      <div className="bp-workspace__pane">{children}</div>
      {drawer && (
        <Dialog
          drawer
          className="bp-workspace__drawer"
          title={drawer === "main" ? "一级导航" : "二级导航"}
          onClose={() => setDrawer(null)}
        >
          {drawer === "main" ? primary : secondary}
        </Dialog>
      )}
    </div>
  );
}
