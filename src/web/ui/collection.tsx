import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "./controls";
import "./collection.css";
export { SearchField } from "./controls";
export { Table } from "./table";
export { SegmentedControl } from "./segmented-control";

type Option = { id: string; label: string };

/** 各选项对应独立筛选条件，取消仅移除当前条件。 */
export function FilterChips({
  options,
  value,
  onChange,
}: {
  options: readonly Option[];
  value: readonly string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <div className="bp-group" role="group" aria-label="筛选条件">
      {options.map(({ id, label }) => (
        <Button
          key={id}
          size="sm"
          aria-pressed={value.includes(id)}
          onClick={() =>
            onChange(
              value.includes(id)
                ? value.filter((key) => key !== id)
                : [...value, id],
            )
          }
        >
          {label}
        </Button>
      ))}
    </div>
  );
}
export function UnsavedChangesBar({
  dirty,
  busy,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  busy?: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  return dirty ? (
    <div className="bp-save-bar">
      <span role="status">有未保存更改</span>
      <Button size="sm" disabled={busy} onClick={onDiscard}>
        撤销更改
      </Button>
      <Button size="sm" variant="primary" loading={busy} onClick={onSave}>
        保存
      </Button>
    </div>
  ) : null;
}

/** 使用原生非模态浮层承接外部点击与 Escape，锚点变化时重算边界。 */
export function Popover({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const id = useId(),
    trigger = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    function position() {
      const el = panel.current,
        anchor = trigger.current;
      if (!el || !anchor) return;
      const box = anchor.getBoundingClientRect();
      el.style.left =
        Math.max(8, Math.min(box.left, innerWidth - el.offsetWidth - 8)) + "px";
      el.style.top =
        (innerHeight - box.bottom >= el.offsetHeight + 8
          ? box.bottom + 4
          : Math.max(8, box.top - el.offsetHeight - 4)) + "px";
    }
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open]);
  return (
    <>
      <Button ref={trigger} popoverTarget={id} aria-expanded={open}>
        {label}
      </Button>
      <div
        id={id}
        ref={panel}
        popover="auto"
        className="bp-popover"
        onToggle={(e) => setOpen(e.newState === "open")}
      >
        {children}
      </div>
    </>
  );
}
