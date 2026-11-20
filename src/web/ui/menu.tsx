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
import { Button } from "./controls";
import "./menu.css";

/** 保持选项可见并管理键盘焦点。普通操作执行后回到触发按钮。 */
export function Menu({
  label,
  items,
  icon,
}: {
  label: string;
  icon?: ReactNode;
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
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null),
    menu = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    id = useId();
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  useLayoutEffect(() => {
    if (!open || !menu.current || !trigger.current) return;
    const popup = menu.current,
      button = trigger.current;
    function place() {
      const rect = button.getBoundingClientRect(),
        height = popup.offsetHeight;
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
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div
      className="bp-menu"
      ref={root}
      onBlur={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget))
          setOpen(false);
      }}
    >
      <Button
        ref={trigger}
        aria-label={label}
        className={icon ? "bp-button--icon" : undefined}
        title={icon ? label : undefined}
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
      {open && (
        <div
          role="menu"
          aria-label={label}
          className="bp-menu__popup"
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
          {items.map((i) => (
            <Fragment key={i.key}>{i.separatorBefore && <div role="separator" className="bp-menu__separator"/>}<button
              role="menuitem"
              type="button"
              className="bp-menu__item"
              tabIndex={-1}
              key={i.key}
              disabled={i.disabled}
              data-danger={i.danger || undefined}

              onClick={() => {
                close();
                i.onSelect();
              }}
            >
              {i.icon && <span aria-hidden="true">{i.icon}</span>}{i.label}
            </button></Fragment>
          ))}
        </div>
      )}
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
