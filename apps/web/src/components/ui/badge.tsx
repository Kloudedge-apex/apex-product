import { cn } from "@/lib/cn";

const variants: Record<string, string> = {
  default: "bg-apex-indigo/10 text-apex-indigo-light",
  success: "bg-green-500/10 text-green-400",
  warning: "bg-yellow-500/10 text-yellow-400",
  error: "bg-red-500/10 text-red-400",
  info: "bg-blue-500/10 text-blue-400",
  muted: "bg-gray-500/10 text-gray-400",
};

interface BadgeProps {
  variant?: keyof typeof variants;
  children: React.ReactNode;
  className?: string;
  dot?: boolean;
}

export function Badge({ variant = "default", children, className, dot }: BadgeProps) {
  const dotColors: Record<string, string> = {
    default: "bg-apex-indigo",
    success: "bg-green-400",
    warning: "bg-yellow-400",
    error: "bg-red-400",
    info: "bg-blue-400",
    muted: "bg-gray-400",
  };

  return (
    <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium", variants[variant], className)}>
      {dot && <span className={cn("w-1.5 h-1.5 rounded-full", dotColors[variant])} />}
      {children}
    </span>
  );
}
