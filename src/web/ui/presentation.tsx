import type { ReactNode } from "react";
import { Button } from "./controls";
import "./presentation.css";

export function StatusBadge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "success" | "danger" | "warning";
  children: ReactNode;
}) {
  return <span className={"bp-badge bp-badge--" + tone}>{children}</span>;
}
export function Progress({
  label,
  value,
  max = 100,
}: {
  label: string;
  value: number;
  max?: number;
}) {
  return (
    <progress
      className="bp-progress"
      aria-label={label}
      value={value}
      max={max}
    />
  );
}
export function EmptyState({
  title,
  description,
  image,
  action,
}: {
  title: string;
  description?: string;
  image?: string;
  action?: ReactNode;
}) {
  return (
    <div className="bp-empty">
      {image && <img className="bp-empty__image" src={image} alt="" />}
      <div>
        <strong>{title}</strong>
        {description && <p>{description}</p>}
        {action}
      </div>
    </div>
  );
}
export function Skeleton({ label = "正在加载" }: { label?: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      className="bp-skeleton"
      aria-busy="true"
    >
      <i />
      <i />
      <i />
    </div>
  );
}
export function Pagination({
  page,
  total,
  itemCount,
  label = "分页",
  onChange,
}: {
  page: number;
  total: number;
  itemCount?: number;
  label?: string;
  onChange: (page: number) => void;
}) {
  return (
    <nav className="bp-pagination" aria-label={label}>
      <Button
        size="sm"
        aria-label="上一页"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        ‹
      </Button>
      <output>
        {page} / {total}{itemCount !== undefined && `，共 ${itemCount} 项`}
      </output>
      <Button
        size="sm"
        aria-label="下一页"
        disabled={page >= total}
        onClick={() => onChange(page + 1)}
      >
        ›
      </Button>
    </nav>
  );
}
