import "./collapse.css";
import type { ReactNode } from "react";

interface CollapseProps {
  expanded: boolean;
  className: string;
  children: ReactNode;
}

/** 为活动详情提供一致的折叠结构与可访问状态。 */
export function Collapse({ expanded, className, children }: CollapseProps) {
  return (
    <div
      className={`bp-collapse ${className}${expanded ? " is-expanded" : ""}`}
      aria-hidden={!expanded}
      inert={!expanded}
    >
      <div className="bp-collapse__inner">{children}</div>
    </div>
  );
}
