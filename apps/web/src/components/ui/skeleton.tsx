import { cn } from "@/lib/cn";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("animate-pulse bg-apex-surface rounded-lg", className)} />
  );
}

export function CardSkeleton() {
  return (
    <div className="card animate-pulse">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 bg-apex-surface rounded-xl" />
        <div className="flex-1">
          <div className="h-4 bg-apex-surface rounded w-32 mb-2" />
          <div className="h-3 bg-apex-surface rounded w-20" />
        </div>
      </div>
      <div className="h-3 bg-apex-surface rounded w-full mb-2" />
      <div className="h-3 bg-apex-surface rounded w-3/4" />
    </div>
  );
}

export function StatSkeleton() {
  return (
    <div className="card animate-pulse">
      <div className="flex items-center justify-between mb-4">
        <div className="h-3 bg-apex-surface rounded w-24" />
        <div className="w-5 h-5 bg-apex-surface rounded" />
      </div>
      <div className="h-8 bg-apex-surface rounded w-16" />
    </div>
  );
}

export function TableRowSkeleton() {
  return (
    <div className="flex items-center justify-between p-4 rounded-lg bg-apex-surface animate-pulse">
      <div className="flex items-center gap-3">
        <div className="w-5 h-5 bg-apex-navy rounded" />
        <div>
          <div className="h-4 bg-apex-navy rounded w-32 mb-1" />
          <div className="h-3 bg-apex-navy rounded w-20" />
        </div>
      </div>
      <div className="h-4 bg-apex-navy rounded w-16" />
    </div>
  );
}
