import { useRef, type ReactNode } from "react";
import { Button } from "./controls";
import "./ui.css";
import "./choice.css";

/** 选区锚点使用稳定键，筛选后只计算当前可见结果。 */
export function SelectableList<T>({
  rows,
  selected,
  onChange,
  keyOf,
  labelOf,
  renderRow,
}: {
  rows: readonly T[];
  selected: readonly string[];
  onChange: (keys: string[]) => void;
  keyOf: (row: T) => string;
  labelOf: (row: T) => string;
  renderRow: (row: T) => ReactNode;
}) {
  const anchor = useRef<string | null>(null),
    visible = rows.map(keyOf);
  const selection = new Set(selected);
  const count = visible.filter((key) => selection.has(key)).length;
  function toggle(keys: string[], checked: boolean) {
    onChange(
      checked
        ? [...new Set([...selected, ...keys])]
        : selected.filter((key) => !keys.includes(key)),
    );
  }
  function choose(key: string, shift: boolean) {
    const start =
        anchor.current === null ? -1 : visible.indexOf(anchor.current),
      end = visible.indexOf(key);
    toggle(
      shift && start >= 0
        ? visible.slice(Math.min(start, end), Math.max(start, end) + 1)
        : [key],
      !selection.has(key),
    );
    anchor.current = key;
  }
  return (
    <div className="bp-list">
      <div className="bp-list__bar">
        <label className="bp-choice">
          <input
            type="checkbox"
            className="bp-choice__input"
            aria-label="选择当前结果"
            checked={count > 0 && count === rows.length}
            ref={(el) => {
              if (el) el.indeterminate = count > 0 && count < rows.length;
            }}
            disabled={!rows.length}
            onChange={(e) => toggle(visible, e.target.checked)}
          />
          当前结果
        </label>
        <small>已选 {selected.length}</small>
        <Button
          size="sm"
          variant="ghost"
          disabled={!selected.length}
          onClick={() => onChange([])}
        >
          清除选择
        </Button>
      </div>
      {rows.map((row) => {
        const key = keyOf(row);
        return (
          <div
            key={key}
            className="bp-list__row" data-selected={selection.has(key) || undefined}
            onClick={(e) => {
              if (
                !(e.target as Element).closest(
                  "a,button,input,label,select,textarea,[role=button],[contenteditable=true]",
                )
              )
                choose(key, e.shiftKey);
            }}
          >
            <input
              type="checkbox"
              className="bp-choice__input"
              aria-label={"选择 " + labelOf(row)}
              checked={selection.has(key)}
              onChange={(e) =>
                choose(key, Boolean((e.nativeEvent as MouseEvent).shiftKey))
              }
            />
            {renderRow(row)}
          </div>
        );
      })}
      {!rows.length && <p>没有匹配项</p>}
    </div>
  );
}
