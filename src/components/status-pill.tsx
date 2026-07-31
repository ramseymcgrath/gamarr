import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Clock3
} from "lucide-react";

import { cn } from "@/lib/cn";

export function StatusPill({
  status,
  label
}: {
  status: string | null;
  label?: string;
}) {
  const normalized = (status ?? "untested").toLowerCase();
  const success = ["ok", "completed", "ready"].includes(normalized);
  const failure = ["failed", "error"].includes(normalized);
  const active = ["queued", "downloading", "submitting", "testing"].includes(
    normalized
  );
  const Icon = success
    ? CheckCircle2
    : failure
      ? AlertCircle
      : active
        ? Clock3
        : Circle;
  return (
    <span className={cn(
      "status-pill",
      success && "status-success",
      failure && "status-failure",
      active && "status-active"
    )}>
      <Icon aria-hidden="true" size={14} />
      {label ?? status ?? "Untested"}
    </span>
  );
}
