import type { InputHTMLAttributes, ReactNode } from "react";
import "./choice.css";

type ChoiceProps = InputHTMLAttributes<HTMLInputElement> & { label: ReactNode };
function Choice({ label, type, role, className = "", ...props }: ChoiceProps) {
  return (
    <label className={`bp-choice ${className}`}>
      <input {...props} type={type} role={role} className="bp-choice__input" />
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
