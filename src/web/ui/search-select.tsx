import { Check, ChevronDown, Search } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import "./search-select.css";

type SearchSelectValue = string | number | boolean;

export interface SearchSelectOption<T extends SearchSelectValue> {
  value: T;
  label: string;
  description?: string;
}

interface SearchSelectProps<T extends SearchSelectValue> {
  ariaLabel: string;
  options: readonly SearchSelectOption<T>[];
  value?: T;
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: T) => void;
}

/**
 * 为配置页提供可搜索、可键盘操作且不依赖浏览器原生样式的选择控件。
 */
export function SearchSelect<T extends SearchSelectValue>({
  ariaLabel,
  options,
  value,
  placeholder = "请选择",
  disabled = false,
  onChange,
}: SearchSelectProps<T>) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const popup = popupRef.current,
      trigger = rootRef.current;
    if (!open || !popup || !trigger) return;
    const position = () => {
      const rect = trigger.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom;
      popup.dataset.above = String(
        below < popup.offsetHeight + 8 && rect.top > below,
      );
      popup.style.translate =
        Math.min(0, window.innerWidth - 8 - rect.left - popup.offsetWidth) +
        "px 0";
    };
    position();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(position);
    observer?.observe(popup);
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
  }, [open]);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
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
    searchRef.current?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  function choose(option: SearchSelectOption<T>) {
    onChange(option.value);
    closeMenu();
    rootRef.current?.querySelector("button")?.focus();
  }

  function closeMenu() {
    setOpen(false);
    setQuery("");
  }

  function handleSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      // 先关闭下拉并恢复选择器焦点，避免同时关闭父弹层。
      event.preventDefault();
      closeMenu();
      rootRef.current?.querySelector("button")?.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) =>
        Math.min(current + 1, Math.max(filteredOptions.length - 1, 0)),
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter" && filteredOptions[activeIndex]) {
      event.preventDefault();
      choose(filteredOptions[activeIndex]);
    }
  }

  return (
    <div className="bp-select" ref={rootRef}>
      <button
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
        <span className={selected ? undefined : "is-placeholder"}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open ? (
        <div className="bp-select__popover" ref={popupRef}>
          <label className="bp-select__search">
            <Search size={14} aria-hidden="true" />
            <span className="visually-hidden">筛选{ariaLabel}</span>
            <input
              ref={searchRef}
              aria-label={`筛选${ariaLabel}`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
          </label>
          <div
            id={listboxId}
            className="bp-select__options"
            role="listbox"
            aria-label={ariaLabel}
          >
            {filteredOptions.map((option, index) => (
              <button
                key={optionKey(option.value)}
                type="button"
                role="option"
                aria-selected={Object.is(option.value, value)}
                className={index === activeIndex ? "is-active" : undefined}
                onPointerMove={() => setActiveIndex(index)}
                onClick={() => choose(option)}
              >
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
