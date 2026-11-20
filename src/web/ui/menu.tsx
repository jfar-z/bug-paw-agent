import {
  Fragment, cloneElement,
  type ReactElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "./controls";
import "./menu.css";

/** 保持选项可见并管理键盘焦点。普通操作执行后回到触发按钮。 */
export function Menu({
  label,
  items,
  icon,
  title,
  disabled = false,
  portal = false,
  className = "",
}: {
  label: string;
  icon?: ReactNode;
  title?: string;
  disabled?: boolean;
  portal?: boolean;
  className?: string;
  items: readonly {
    key: string;
    label: string;
    onSelect: () => void;
    disabled?: boolean;
    icon?: ReactNode;
    danger?: boolean;
    separatorBefore?: boolean;
  }[];
}) {
  const [expanded, setOpen] = useState(false);
  const open = expanded && !disabled;
  const root = useRef<HTMLDivElement>(null),
    menu = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    id = useId();
  function close() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useLayoutEffect(() => {
    if (!open || !menu.current || !trigger.current) return;
    const popup = menu.current,
      button = trigger.current;
    function place() {
      const rect = button.getBoundingClientRect(),
        height = popup.offsetHeight;
      // 可滚动侧栏中的浮层使用视口坐标，避免被祖先的 overflow 裁切。
      if (portal) {
        const margin = 8;
        const gap = 4;
        const width = popup.offsetWidth;
        const top = rect.bottom + gap + height <= window.innerHeight - margin
          ? rect.bottom + gap
          : Math.max(margin, rect.top - gap - height);
        const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - margin - width));
        popup.style.top = `${top}px`;
        popup.style.left = `${left}px`;
        return;
      }
      popup.dataset.above = String(
        window.innerHeight - rect.bottom < height + 8 &&
          rect.top > window.innerHeight - rect.bottom,
      );
      popup.style.translate =
        Math.min(0, window.innerWidth - 8 - rect.left - popup.offsetWidth) +
        "px 0";
    }
    place();
    popup
      .querySelector<HTMLElement>("[role=menuitem]:not(:disabled)")
      ?.focus({ preventScroll: true });
    function onScroll(event: Event) {
      if (!portal) place();
      else if (event.target !== popup) close();
    }
    const onResize = portal ? close : place;
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, portal]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!root.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const popup = open && (
    <div
      role="menu"
      aria-label={label}
      className="bp-menu__popup"
      data-portal={portal || undefined}
      id={id}
      ref={menu}
      onKeyDown={(e) => {
        const buttons = Array.from(
          e.currentTarget.querySelectorAll<HTMLButtonElement>(
            "[role=menuitem]:not(:disabled)",
          ),
        );
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close();
          return;
        }
        if (e.key === "Tab" && portal) {
          // 浮层位于文档末尾，Tab 从原条目的导航顺序继续。
          close();
          return;
        }
        const targets: Record<string, number> = {
          ArrowDown: (index + 1) % buttons.length,
          ArrowUp: (index - 1 + buttons.length) % buttons.length,
          Home: 0,
          End: buttons.length - 1,
        };
        if (e.key in targets) {
          e.preventDefault();
          buttons[targets[e.key]]?.focus();
        }
      }}
    >
      {items.map((item) => (
        <Fragment key={item.key}>
          {item.separatorBefore && <div role="separator" className="bp-menu__separator" />}
          <button role="menuitem" type="button" className="bp-menu__item" tabIndex={-1}
            disabled={item.disabled} data-danger={item.danger || undefined}
            onClick={() => {
              close();
              item.onSelect();
            }}>
            {item.icon && <span aria-hidden="true">{item.icon}</span>}
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>
  );
  return (
    <div
      className={["bp-menu", className].filter(Boolean).join(" ")}
      ref={root}
      onBlur={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget) && !menu.current?.contains(e.relatedTarget))
          setOpen(false);
      }}
    >
      <Button
        ref={trigger}
        aria-label={label}
        className={icon ? "bp-button--icon" : undefined}
        title={title ?? (icon ? label : undefined)}
        disabled={disabled}
        aria-controls={open ? id : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {icon ? <span aria-hidden>{icon}</span> : label}
      </Button>
      {portal && popup ? createPortal(popup, document.body) : popup}
    </div>
  );
}

/** 鼠标和键盘均可查看说明，Esc 可主动收起。 */
export function Tooltip({
  label,
  children,
}: {
  label: string;
  children: ReactElement<{"aria-describedby"?:string;title?:string}>;
}) {
  const id = useId();
  const [visible, show] = useState(false);
  return (
    <span
      className="bp-tooltip"
      onPointerEnter={() => show(true)}
      onPointerLeave={() => show(false)}
      onFocus={() => show(true)}
      onBlur={() => show(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape") show(false);
      }}
    >
      {cloneElement(children, {title: "", "aria-describedby": [children.props["aria-describedby"], visible && id].filter(Boolean).join(" ") || undefined})}
      {visible && (
        <span id={id} role="tooltip" className="bp-tooltip__body">
          {label}
        </span>
      )}
    </span>
  );
}
