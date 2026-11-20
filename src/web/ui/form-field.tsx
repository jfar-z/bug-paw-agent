import { useId, type ReactNode } from "react";
import { Switch } from "./choice";
import "./controls.css";

/** 调用方将绑定属性传给实际控件，读屏即可关联标签、说明和错误。 */
export function FormField({
  label,
  hint,
  error,
  required,
  inherit,
  children,
}: {
  label: string;
  inherit?: {
    active: boolean;
    value: string;
    onChange: (active: boolean) => void;
    label?: string;
  };
  hint?: string;
  error?: string;
  required?: boolean;
  children: (props: {
    id: string;
    disabled?: boolean;
    required?: boolean;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean;
  }) => ReactNode;
}) {
  const id = useId();
  const descriptions = [hint && id + "-hint", error && id + "-error"]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="bp-field">
      <label htmlFor={id}>
        {label}
        {required && " *"}
      </label>
      {inherit && (
        <>
          <Switch
            label={inherit.label ?? "使用全局默认值"}
            checked={inherit.active}
            onChange={(event) => inherit.onChange(event.target.checked)}
          />
          <small>当前继承：{inherit.value}</small>
        </>
      )}
      {children({
        disabled: inherit?.active,
        id,
        required,
        "aria-describedby": descriptions || undefined,
        "aria-invalid": error ? true : undefined,
      })}
      {hint && <small id={id + "-hint"}>{hint}</small>}
      {error && (
        <small role="alert" className="bp-field__error" id={id + "-error"}>
          {error}
        </small>
      )}
    </div>
  );
}
