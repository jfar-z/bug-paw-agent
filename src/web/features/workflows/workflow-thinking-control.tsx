import { Button } from "../../ui/controls";
import { BrainCircuit, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ThinkingLevel } from "../../../shared/configuration-contracts";

const labels: Record<ThinkingLevel | "default", string> = {
  default: "模型默认", off: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最大",
};

/** 模型框右侧的强度图标，仅提供模型支持的等级并支持键盘选择。 */
export function WorkflowThinkingControl({ levels, value, disabled, onChange }: {
  levels: readonly ThinkingLevel[];
  value?: ThinkingLevel;
  disabled: boolean;
  onChange(value: ThinkingLevel | undefined): void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const label = `思考强度：${labels[value ?? "default"]}${disabled ? "；当前不可调整" : ""}`;
  useEffect(() => {
    if (!open || disabled) return;
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, disabled]);
  return <div className="wf-thinking-control" ref={root} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <Button ref={trigger} type="button" className="wf-button" title={label} aria-label={label}
      disabled={disabled} aria-haspopup="menu" aria-expanded={open && !disabled}
      onClick={() => setOpen(!open)}><BrainCircuit size={18} aria-hidden="true" /></Button>
    {open && !disabled && <div ref={menu} className="wf-thinking-menu" role="menu" aria-label="思考强度" onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
      const options = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
      const index = options.indexOf(document.activeElement as HTMLButtonElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
        options[next]?.focus();
      }
    }}>
      {([undefined, ...levels] as const).map((level) => <button key={level ?? "default"} type="button"
        role="menuitemradio" aria-checked={level === value} onClick={() => {
          onChange(level);
          setOpen(false);
          trigger.current?.focus();
        }}><span>{labels[level ?? "default"]}</span>{level === value && <Check size={14} aria-hidden="true" />}</button>)}
    </div>}
  </div>;
}
