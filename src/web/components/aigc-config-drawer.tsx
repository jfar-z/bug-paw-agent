import { IconButton } from "../ui/controls";
import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";


/** 配置抽屉约束键盘焦点，关闭后恢复触发按钮，并支持未保存确认。 */
export function AigcConfigDrawer({ title, eyebrow, description, busy = false, onClose, children, footer }: {
  title: string;
  eyebrow: string;
  description: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  const titleId = useId();
  const root = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    root.current?.focus();
    function keydown(event: KeyboardEvent) {
      // 后出现的二次确认对话框独立处理焦点，避免两个弹层争抢 Tab。
      if (document.querySelector(".configuration-dialog-backdrop, dialog[open]")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
      }
      if (event.key !== "Tab") return;
      const controls = [...(root.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary") ?? [])]
        .filter((element) => element.getClientRects().length > 0 && element.getAttribute("tabindex") !== "-1");
      const first = controls[0];
      const last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !root.current?.contains(document.activeElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !root.current?.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    }
    document.addEventListener("keydown", keydown);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", keydown);
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);

  return createPortal(<div className="aigc-config-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={root} tabIndex={-1} className="aigc-config-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="aigc-config-drawer__header"><div><small className="aigc-config-eyebrow">{eyebrow}</small><h2 id={titleId}>{title}</h2><p>{description}</p></div><IconButton label="关闭编辑" disabled={busy} onClick={onClose}><X size={19} /></IconButton></header>
      <div className="aigc-config-drawer__content">{children}</div>
      <footer className="aigc-config-drawer__footer">{footer}</footer>
    </section>
  </div>, document.body);
}
