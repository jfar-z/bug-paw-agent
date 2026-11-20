import type { ReactNode } from "react";

import "./section.css";

interface SectionProps {
  index?: number;
  title: string;
  description: string;
  children: ReactNode;
}

/**
 * 将同一组设置的标题、说明和控件组织为一个区域。
 */
export function Section({ index, title, description, children }: SectionProps) {
  return (
    <section className="bp-section">
      <div className="bp-section__heading">
        <div>
          {index !== undefined && <span>{String(index).padStart(2, "0")}</span>}
          <h2>{title}</h2>
        </div>
        <small>{description}</small>
      </div>
      <div>{children}</div>
    </section>
  );
}
