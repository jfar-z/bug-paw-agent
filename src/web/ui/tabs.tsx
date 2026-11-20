import { useId, type ReactNode } from "react";
import { Button } from "./controls";
import "./tabs.css";

export function Tabs<T extends string>({
  panelId,
  tabIdPrefix,
  className = "",
  disabled,
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  panelId?: string | ((value: T) => string);
  tabIdPrefix?: string;
  className?: string;
  disabled?: boolean;
  items: readonly { id: T; label: ReactNode; panel?: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const id = useId();
  // 页面可以保留既有面板与挂载顺序，同时共享键盘切换。
  const tabId = (item: T) => (tabIdPrefix ?? (typeof panelId === "string" ? panelId : id + "-tab")) + "-" + item;
  return (
    <div>
      <div className={`bp-tabs ${className}`} role="tablist" aria-label={label}>
        {items.map((item, index) => (
          <Button
            key={item.id}
            size="sm"
            role="tab"
            id={tabId(item.id)}
            disabled={disabled}
            aria-controls={typeof panelId === "function" ? panelId(item.id) : panelId ?? id + "-panel-" + index}
            tabIndex={value === item.id ? 0 : -1}
            aria-selected={value === item.id}
            onClick={() => onChange(item.id)}
            onKeyDown={(e) => {
              const target = (
                {
                  Home: 0,
                  End: items.length - 1,
                  ArrowLeft: (index - 1 + items.length) % items.length,
                  ArrowRight: (index + 1) % items.length,
                } as Record<string, number>
              )[e.key];
              if (target !== undefined) {
                e.preventDefault();
                onChange(items[target].id);
                document.getElementById(tabId(items[target].id))?.focus();
              }
            }}
          >
            {item.label}
          </Button>
        ))}
      </div>
      {!panelId &&
        items.map((item, index) => (
          <div
            key={item.id}
            role="tabpanel"
            className="bp-tabs__panel"
            id={id + "-panel-" + index}
            aria-labelledby={tabId(item.id)}
            hidden={value !== item.id}
          >
            {item.panel}
          </div>
        ))}
    </div>
  );
}
