import { useRef } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button, IconButton, TextField } from "./controls";
import "./key-value-editor.css";

export interface KeyValueRow {
  key: string;
  value: string;
}

interface KeyValueEditorProps {
  label: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  emptyLabel?: string;
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
}

/** 键值行复用公共输入框和按钮，使组件独立展示时也具有完整外观。 */
export function KeyValueEditor({
  label,
  rows,
  onChange,
  keyPlaceholder = "键",
  valuePlaceholder = "值",
  emptyLabel = "尚未添加条目",
}: KeyValueEditorProps) {
  // 同一行编辑后继承原标识，删掉中间一行时后续输入保有自己的 DOM 与焦点。
  const ids = useRef(new WeakMap<KeyValueRow, number>());
  const next = useRef(0);
  function rowId(row: KeyValueRow) {
    const saved = ids.current.get(row);
    if (saved !== undefined) return saved;
    const id = next.current++;
    ids.current.set(row, id);
    return id;
  }
  function updateRow(index: number, field: keyof KeyValueRow, value: string) {
    const updated = { ...rows[index], [field]: value };
    ids.current.set(updated, rowId(rows[index]));
    onChange(rows.map((row, position) => (position === index ? updated : row)));
  }

  return (
    <section className="bp-key-value" aria-label={label}>
      <div className="bp-key-value__heading">
        <strong>{label}</strong>
        <Button
          size="sm"
          variant="ghost"
          icon={<Plus aria-hidden="true" />}
          onClick={() => onChange([...rows, { key: "", value: "" }])}
        >
          添加一行
        </Button>
      </div>
      {rows.length === 0 && <p>{emptyLabel}</p>}
      {rows.map((row, index) => (
        <div className="bp-key-value__row" key={rowId(row)}>
          <TextField
            aria-label={`${label} 键 ${index + 1}`}
            placeholder={keyPlaceholder}
            value={row.key}
            onChange={(event) => updateRow(index, "key", event.target.value)}
          />
          <TextField
            aria-label={`${label} 值 ${index + 1}`}
            placeholder={valuePlaceholder}
            value={row.value}
            onChange={(event) => updateRow(index, "value", event.target.value)}
          />
          <IconButton
            label={`删除 ${label} 第 ${index + 1} 行`}
            onClick={() =>
              onChange(rows.filter((_, position) => position !== index))
            }
          >
            <Trash2 />
          </IconButton>
        </div>
      ))}
    </section>
  );
}
