import { useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button, IconButton } from "./controls";
import "./ui.css";

export interface FileChoice<T> {
  source: string;
  id: string;
  name: string;
  ref: T;
  type?: string;
  size?: number;
}
type Entry<T> = Omit<FileChoice<T>, "source">;
export interface FileSource<T> {
  id: string;
  label: string;
  render: (options: {
    multiple: boolean;
    accept: string;
    add: (files: Entry<T>[]) => void;
  }) => ReactNode;
}
const fileKey = <T,>(file: FileChoice<T>) =>
  JSON.stringify([file.source, file.id]);

/** 来源保留自己的引用格式，本地选择、拖放与粘贴共用校验和变更通知。 */
export function FileField<T>({
  sources,
  value,
  onChange,
  multiple = true,
  accept = "",
  maxCount = Infinity,
  maxSize = Infinity,
  disabled = false,
  label = "文件来源",
  deviceSource,
}: {
  sources: readonly FileSource<T>[];
  value: readonly FileChoice<T>[];
  onChange: (files: FileChoice<T>[]) => void;
  multiple?: boolean;
  accept?: string;
  maxCount?: number;
  maxSize?: number;
  disabled?: boolean;
  label?: string;
  deviceSource?: { id: string; map: (file: File) => Entry<T> };
}) {
  const [sourceId, setSourceId] = useState(sources[0]?.id),
    [errors, setErrors] = useState<string[]>([]),
    [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const source = sources.find((s) => s.id === sourceId) ?? sources[0];
  function append(id: string, files: Entry<T>[]) {
    if (disabled || !files.length) return;
    const rejected: string[] = [],
      merged = new Map((multiple ? value : []).map((f) => [fileKey(f), f]));
    const types = accept
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const file of files) {
      const full = { ...file, source: id },
        key = fileKey(full);
      const mime = (file.type ?? "").toLowerCase();
      if (
        types.length &&
        !types.some((type) =>
          type.startsWith(".")
            ? file.name.toLowerCase().endsWith(type)
            : type.endsWith("/*")
              ? mime.startsWith(type.slice(0, -1))
              : mime === type,
        )
      ) {
        rejected.push(file.name + "：允许的类型为 " + accept);
        continue;
      }
      if ((file.size ?? 0) > maxSize) {
        rejected.push(file.name + "：超过大小上限 " + (maxSize >= 1048576 ? maxSize / 1048576 + " MiB" : maxSize >= 1024 ? maxSize / 1024 + " KiB" : maxSize + " 字节"));
        continue;
      }
      if (
        !merged.has(key) &&
        merged.size >= Math.min(maxCount, multiple ? Infinity : 1)
      ) {
        rejected.push(file.name + "：超过选择数量上限");
        continue;
      }
      merged.set(key, full);
    }
    const next = [...merged.values()];
    setErrors(rejected);
    setNotice("");
    if (
      next.length &&
      (!multiple ||
        next.length !== value.length ||
        next.some((f, i) => f !== value[i]))
    ) {
      onChange(next);
      if (!multiple && value.length)
        setNotice("已将 " + value[0].name + " 替换为 " + next[0].name);
    }
  }
  function receive(files: FileList) {
    if (deviceSource && sources.some((s) => s.id === deviceSource.id))
      append(deviceSource.id, Array.from(files, deviceSource.map));
  }
  return (
    <fieldset
      className="bp-files"
      disabled={disabled}
      tabIndex={deviceSource ? 0 : undefined}
      data-dragging={dragging || undefined}
      onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setDragging(false)}}
      onDragOver={(e) => {
        if (!disabled && deviceSource && e.dataTransfer.types.includes("Files")) {
          e.preventDefault();setDragging(true);
        }
      }}
      onDrop={(e) => {
        setDragging(false);
        if (deviceSource && e.dataTransfer.files.length) {
          e.preventDefault();
          receive(e.dataTransfer.files);
        }
      }}
      onPaste={(e) => {
        if (deviceSource && e.clipboardData.files.length) {
          e.preventDefault();
          receive(e.clipboardData.files);
        }
      }}
    >
      <legend>{label}</legend>
      <div className="bp-actions">
        {sources.map((s) => (
          <Button
            key={s.id}
            size="sm"
            aria-pressed={s.id === source?.id}
            onClick={() => setSourceId(s.id)}
          >
            {s.label}
          </Button>
        ))}
      </div>
      <div key={source?.id} className="bp-files__source">
        {source?.render({
          multiple,
          accept,
          add: (files) => append(source.id, files),
        })}
      </div>
      {errors.length > 0 && (
        <ul role="alert" className="bp-field__error">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      <small role="status">{notice}</small>
      {!value.length ? (
        <small>尚未选择文件</small>
      ) : (
        <ul className="bp-files__list">
          {value.map((file) => (
            <li className="bp-files__row" key={fileKey(file)}>
              <span>{file.name}</span>
              <small>
                {sources.find((s) => s.id === file.source)?.label ??
                  file.source}
              </small>
              <IconButton
                label={"移除 " + file.name}
                onClick={() => {
                  onChange(value.filter((f) => fileKey(f) !== fileKey(file)));
                  setNotice("");
                  setErrors([]);
                }}
              >
                <X />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
