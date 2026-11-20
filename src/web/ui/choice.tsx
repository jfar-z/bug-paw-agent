import type { InputHTMLAttributes, ReactNode } from "react";
import "./choice.css";

type ChoiceProps = InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode };
function Choice({ label, type, role, className = "", ...props }: ChoiceProps) {
  const input = <input {...props} type={type} role={role}
    className={label === undefined ? `bp-choice__input ${className}` : "bp-choice__input"} />;
  // 表格及已有标签的字段可以复用输入而不生成嵌套标签。
  if (label === undefined) return input;
  return (
    <label className={`bp-choice ${className}`}>
      {input}
      {label}
    </label>
  );
}
export function Checkbox(props: ChoiceProps) {
  return <Choice {...props} type="checkbox" />;
}
export function Radio(props: ChoiceProps) {
  return <Choice {...props} type="radio" />;
}
export function Switch(props: ChoiceProps) {
  return <Choice {...props} type="checkbox" role="switch" />;
}
