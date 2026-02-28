import Link from "next/link";
import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: { label: string; href: string };
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="text-center py-16">
      <Icon size={48} className="mx-auto text-apex-border mb-4" />
      <h2 className="text-lg font-semibold mb-2">{title}</h2>
      <p className="text-apex-muted max-w-md mx-auto mb-6">{description}</p>
      {action && (
        <Link href={action.href} className="btn-primary inline-flex items-center gap-2">
          {action.label}
        </Link>
      )}
    </div>
  );
}
