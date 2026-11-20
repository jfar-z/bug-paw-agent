import { useId, type ReactNode } from "react";
import { Button } from "./controls";
import "./tabs.css";

export function Tabs<T extends string>({
  panelId,
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  panelId?: string;
  items: readonly { id: T; label: string; panel?: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const id = useId();
  return (
    <div>
      <div className="bp-tabs" role="tablist" aria-label={label}>
        {items.map((item, index) => (
          <Button
            key={item.id}
            size="sm"
            role="tab"
            id={panelId ? panelId + "-" + item.id : id + "-tab-" + index}
            aria-controls={panelId ?? id + "-panel-" + index}
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
                document
                  .getElementById(
                    panelId
                      ? panelId + "-" + items[target].id
                      : id + "-tab-" + target,
                  )
                  ?.focus();
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
            aria-labelledby={id + "-tab-" + index}
            hidden={value !== item.id}
          >
            {item.panel}
          </div>
        ))}
    </div>
  );
}
