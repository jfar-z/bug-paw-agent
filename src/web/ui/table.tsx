import type { HTMLAttributes, ReactNode } from "react";
import { Button } from "./controls";
import "./table.css";

/** 调用方提供可排序的列与行，不在组件内部改变业务排序规则。 */
export function Table<T>({
  label,
  columns,
  rows,
  rowKey,
  rowProps,
  className = "",
  layout = "stack",
  style,
  hidden,
  sort,
  onSort,
}: {
  label: string;
  columns: readonly {
    id: string;
    label: string;
    cell: (row: T) => ReactNode;
    width?: string;
    className?: string;
    sortable?: boolean;
  }[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  rowProps?: (row: T) => HTMLAttributes<HTMLTableRowElement>;
  className?: string;
  layout?: "stack" | "scroll";
  style?: HTMLAttributes<HTMLDivElement>["style"];
  hidden?: boolean;
  sort?: { column: string; ascending: boolean };
  onSort?: (id: string) => void;
}) {
  return (
    <div className={`bp-table ${!onSort && layout === "stack" ? "bp-table--static" : ""} ${className}`} style={style} hidden={hidden}>
      {/* 窄屏静态表格按行堆叠，显式保留表格语义。 */}
      <table role="table" aria-label={label}>
        <thead role="rowgroup">
          <tr role="row">
            {columns.map((c) => (
              <th
                scope="col"
                role="columnheader"
                key={c.id}
                className={c.className}
                style={{ width: c.width }}
                aria-sort={
                  sort?.column === c.id
                    ? sort.ascending
                      ? "ascending"
                      : "descending"
                    : undefined
                }
              >
                {c.sortable && onSort ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onSort(c.id)}
                  >
                    {c.label}
                    {sort?.column === c.id
                      ? sort.ascending
                        ? " ↑"
                        : " ↓"
                      : ""}
                  </Button>
                ) : (
                  c.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((row) => (
            <tr {...rowProps?.(row)} role="row" key={rowKey(row)}>
              {columns.map((c) => (
                <td role="cell" key={c.id} data-label={c.label} className={c.className}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
