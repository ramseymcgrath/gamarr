import type { ReactNode } from "react";

export function EmptyState({
  eyebrow,
  title,
  children,
  action
}: {
  eyebrow?: string;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="empty-state">
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h2>{title}</h2>
      <div className="muted">{children}</div>
      {action && <div className="empty-action">{action}</div>}
    </section>
  );
}
