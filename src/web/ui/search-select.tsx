import { Check, ChevronDown, Search } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import "./search-select.css";

type SearchSelectValue = string | number | boolean;

export interface SearchSelectOption<T extends SearchSelectValue> {
  value: T;
  label: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

interface SearchSelectProps<T extends SearchSelectValue> {
  ariaLabel?: string;
  id?: string;
  name?: string;
  required?: boolean;
  className?: string;
  style?: CSSProperties;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  options: readonly SearchSelectOption<T>[];
  value?: T;
  placeholder?: string;
  placeholderIcon?: ReactNode;
  searchable?: boolean;
  disabled?: boolean;
  onChange?: (value: T) => void;
}

/**
 * 为配置页提供可搜索、可键盘操作且不依赖浏览器原生样式的选择控件。
 */
export function SearchSelect<T extends SearchSelectValue>({
  ariaLabel,
  id,
  name,
  required,
  className = "",
  style,
  options,
  value,
  placeholder = "请选择",
  placeholderIcon,
  searchable = true,
  disabled = false,
  onChange,
  ...accessibility
}: SearchSelectProps<T>) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const popup = popupRef.current;
    const trigger = buttonRef.current;
    if (!open || !popup || !trigger) return;
    // 在滚动面板和模态框内使用顶层浮层，仍保留原有 DOM 焦点顺序。
    popup.showPopover?.();
    const position = () => {
      const rect = trigger.getBoundingClientRect();
      const view = window.visualViewport;
      const left = view?.offsetLeft ?? 0;
      const top = view?.offsetTop ?? 0;
      const width = view?.width ?? window.innerWidth;
      const height = view?.height ?? window.innerHeight;
      const below = top + height - rect.bottom;
      const above = rect.top - top;
      const placement = below < popup.scrollHeight + 8 && above > below;
      popup.style.maxHeight = `${Math.max(0, (placement ? above : below) - 12)}px`;
      popup.style.width = `${Math.min(width - 16, Math.max(rect.width, 240))}px`;
      popup.style.left = `${Math.max(left + 8, Math.min(rect.left, left + width - popup.offsetWidth - 8))}px`;
      popup.style.top = `${placement ? rect.top - popup.offsetHeight - 5 : rect.bottom + 5}px`;
    };
    position();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(position);
    observer?.observe(popup);
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [open]);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const selected = options.find((option) => Object.is(option.value, value));
  const filteredOptions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return options;
    return options.filter((option) =>
      `${option.label} ${option.description ?? ""}`
        .toLocaleLowerCase()
        .includes(normalized),
    );
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    (searchRef.current ?? listRef.current)?.focus({ preventScroll: true });
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu();
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
    };
  }, [open]);

  useEffect(() => {
    setActiveIndex(filteredOptions.findIndex((option) => !option.disabled));
  }, [query, open]);

  useEffect(() => {
    const list = listRef.current;
    const item = list?.querySelector<HTMLElement>(".is-active");
    if (!list || !item) return;
    const bounds = list.getBoundingClientRect();
    const row = item.getBoundingClientRect();
    if (row.top < bounds.top) list.scrollTop -= bounds.top - row.top;
    if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom;
  }, [activeIndex]);

  function choose(option: SearchSelectOption<T>) {
    if (option.disabled) return;
    onChange?.(option.value);
    closeMenu();
    buttonRef.current?.focus();
  }

  function closeMenu() {
    setOpen(false);
    setQuery("");
  }

  function handlePopupKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      // 先关闭下拉并恢复选择器焦点，避免同时关闭父弹层。
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      buttonRef.current?.focus();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      if (event.target === searchRef.current && (event.key === "Home" || event.key === "End")) return;
      event.preventDefault();
      const direction = event.key === "ArrowUp" || event.key === "End" ? -1 : 1;
      const start = event.key === "Home" ? -1 : event.key === "End" ? filteredOptions.length : activeIndex;
      for (let index = start + direction; index >= 0 && index < filteredOptions.length; index += direction) {
        if (filteredOptions[index].disabled) continue;
        setActiveIndex(index);
        break;
      }
    } else if ((event.key === "Enter" || (!searchable && event.key === " ")) &&
      (event.target === searchRef.current || event.target === listRef.current)) {
      event.preventDefault();
      const option = filteredOptions[activeIndex];
      if (option) choose(option);
    }
  }

  return (
    <div className={`bp-select ${className}`} style={style} ref={rootRef}
      onBlur={(event) => {
        if (open && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) closeMenu();
      }}
    >
      {name && <input type="hidden" name={name} value={value === undefined ? "" : String(value)} disabled={disabled} />}
      <button
        {...accessibility}
        id={id}
        value={value === undefined ? undefined : String(value)}
        ref={buttonRef}
        type="button"
        className="bp-select__trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        onClick={() => (open ? closeMenu() : setOpen(true))}
      >
        {(selected?.icon ?? placeholderIcon) && <span className="bp-select__icon" aria-hidden="true">{selected?.icon ?? placeholderIcon}</span>}
        <span className={selected ? undefined : "is-placeholder"}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open ? (
        <div className="bp-select__popover" ref={popupRef} popover={typeof HTMLElement.prototype.showPopover === "function" ? "manual" : undefined} onKeyDown={handlePopupKeyDown}>
          {searchable && <label className="bp-select__search">
            <Search size={14} aria-hidden="true" />
            <input
              ref={searchRef}
              aria-label={ariaLabel ? `筛选${ariaLabel}` : "筛选选项"}
              role="combobox"
              aria-expanded="true"
              aria-required={required}
              aria-controls={listboxId}
              aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>}
          <div
            id={listboxId}
            className="bp-select__options"
            ref={listRef}
            role="listbox"
            aria-label={ariaLabel}
            tabIndex={searchable ? undefined : -1}
            aria-activedescendant={!searchable && activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
          >
            {filteredOptions.map((option, index) => (
              <button
                key={optionKey(option.value)}
                id={`${listboxId}-${index}`}
                type="button"
                value={String(option.value)}
                role="option"
                tabIndex={-1}
                disabled={option.disabled}
                aria-selected={Object.is(option.value, value)}
                className={index === activeIndex ? "is-active" : undefined}
                onPointerMove={() => { if (!option.disabled) setActiveIndex(index); }}
                onClick={() => choose(option)}
              >
                {option.icon && <span className="bp-select__icon" aria-hidden="true">{option.icon}</span>}
                <span>
                  <strong>{option.label}</strong>
                  {option.description ? (
                    <small>{option.description}</small>
                  ) : null}
                </span>
                {Object.is(option.value, value) ? (
                  <Check size={15} aria-hidden="true" />
                ) : null}
              </button>
            ))}
            {!filteredOptions.length ? <p>没有匹配项</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function optionKey(value: SearchSelectValue): string {
  return `${typeof value}:${String(value)}`;
}
