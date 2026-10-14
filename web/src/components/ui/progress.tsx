import { cn } from "@/lib/utils";

/** A thin bar; `value` is 0 to 100, or null for an indeterminate sweep. */
export function Progress({ value, className }: { value: number | null; className?: string }) {
  return (
    <div className={cn("relative h-1 w-full overflow-hidden rounded-full bg-muted", className)}>
      {value === null ? (
        <div className="absolute inset-y-0 w-1/3 animate-[pudding-sweep_1.2s_ease-in-out_infinite] rounded-full bg-foreground/70" />
      ) : (
        <div
          className="h-full rounded-full bg-foreground transition-[width] duration-500"
          style={{ width: `${Math.max(2, Math.min(100, value))}%` }}
        />
      )}
    </div>
  );
}
