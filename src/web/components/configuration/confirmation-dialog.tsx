import { useEffect, useRef, type ReactNode } from "react";

interface ConfirmationDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  confirmDisabled?: boolean;
  confirmClassName?: string;
  destructive?: boolean;
  /** 可选影响清单独立滚动，避免项目较多时操作按钮落到视口外。 */
  children?: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * 为高影响操作提供应用内二次确认，避免使用浏览器原生确认框。
 */
export function ConfirmationDialog({ title, description, confirmLabel, busy = false, confirmDisabled = false, confirmClassName, destructive = true, children, onCancel, onConfirm }: ConfirmationDialogProps) {
  const titleId = "configuration-confirmation-title";
  const root = useRef<HTMLElement>(null);
  const latest = useRef({ busy, onCancel });
  latest.current = { busy, onCancel };
  const hasImpactList = Boolean(children);

  useEffect(() => {
    if (!hasImpactList) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    // 影响清单出现后先聚焦取消，避免键盘操作误触破坏性确认。
    root.current?.querySelector<HTMLButtonElement>("button")?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        if (!latest.current.busy) latest.current.onCancel();
      }
      if (event.key !== "Tab") return;
      const controls = [...(root.current?.querySelectorAll<HTMLElement>("[tabindex='0'], button:not(:disabled)") ?? [])];
      const first = controls[0];
      const last = controls.at(-1);
      if (!root.current?.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      if (previous?.isConnected) previous.focus();
    };
  }, [hasImpactList]);

  return (
    <div className="configuration-dialog-backdrop" role="presentation">
      <section ref={root} className="configuration-dialog provider-rename-dialog" style={children ? { maxHeight: "calc(100dvh - 40px)", gridTemplateRows: "auto minmax(0, 1fr) auto", overflowWrap: "anywhere" } : undefined} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy}>
        <header style={children ? { maxHeight: "34dvh", overflowY: "auto" } : undefined}><div><h2 id={titleId}>{title}</h2><p>{description}</p></div></header>
        {children ? <div tabIndex={0} role="region" aria-label="操作影响清单" style={{ overflowY: "auto", minHeight: 0 }}>{children}</div> : null}
        <footer>
          <button type="button" className="configuration-secondary-action" disabled={busy} onClick={onCancel}>取消</button>
          <button type="button" className={confirmClassName ?? (destructive ? "danger-button" : "configuration-primary-action")} disabled={busy || confirmDisabled} onClick={onConfirm}>{busy ? "处理中…" : confirmLabel}</button>
        </footer>
      </section>
    </div>
  );
}
