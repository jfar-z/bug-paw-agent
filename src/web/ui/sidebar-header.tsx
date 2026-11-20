import type { HTMLAttributes, ReactNode } from "react";

interface SecondarySidebarHeaderProps {
  eyebrow: ReactNode;
  title: ReactNode;
  actions?: ReactNode;
  actionsProps?: HTMLAttributes<HTMLDivElement>;
  className?: string;
}

/** 统一工作台二级侧边栏的标题层级，并为各业务保留独立操作区。 */
export function SecondarySidebarHeader({
  eyebrow,
  title,
  actions,
  actionsProps,
  className,
}: SecondarySidebarHeaderProps) {
  const actionsClassName = [
    "bp-sidebar-header__actions",
    actionsProps?.className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <header
      className={`bp-sidebar-header${className ? ` ${className}` : ""}`}
    >
      <div className="bp-sidebar-header__heading">
        <span className="bp-sidebar-header__eyebrow">{eyebrow}</span>
        <strong className="bp-sidebar-header__title">{title}</strong>
      </div>
      {actions ? (
        <div {...actionsProps} className={actionsClassName}>
          {actions}
        </div>
      ) : null}
    </header>
  );
}
