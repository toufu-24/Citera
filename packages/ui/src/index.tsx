import type { ButtonHTMLAttributes, PropsWithChildren } from "react";

export type ButtonTone = "primary" | "secondary" | "danger";

export function Button({
  tone = "secondary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: ButtonTone }) {
  return (
    <button className={`citera-button citera-button-${tone} ${className}`.trim()} {...props} />
  );
}

export function StatusBadge({
  children,
  tone = "neutral",
}: PropsWithChildren<{ tone?: "neutral" | "info" | "success" | "warning" }>) {
  return <span className={`citera-status citera-status-${tone}`}>{children}</span>;
}
