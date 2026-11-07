import * as React from "react"
import { cn } from "@/lib/utils"

// PageShell — the fixed heading hierarchy for work surfaces (web-design-system).
// It exists because the visual review found the page title routinely losing to
// filter bars and stat rows ("heading hierarchy collapse"). The contract is
// structural: title is always the first reading point; actions are right-anchored
// beside it; filters sit BELOW the header, never above it; the body scrolls
// inside the shell so the header stays put. Copy arrives as props.

export interface PageShellProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title: React.ReactNode
  subtitle?: React.ReactNode
  actions?: React.ReactNode
  filters?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
}

export function PageShell({
  title,
  subtitle,
  actions,
  filters,
  children,
  className,
  bodyClassName,
  ...props
}: PageShellProps) {
  return (
    <div className={cn("flex h-full flex-col overflow-hidden", className)} {...props}>
      <header className="flex shrink-0 items-start justify-between gap-4 px-4 pb-3 pt-4 md:px-6">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold leading-7 text-foreground">{title}</h1>
          {subtitle != null && <p className="mt-1 text-sm leading-5 text-muted-foreground">{subtitle}</p>}
        </div>
        {actions != null && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      {filters != null && <div className="shrink-0 px-4 pb-3 md:px-6">{filters}</div>}
      <div className={cn("min-h-0 flex-1 overflow-y-auto px-4 pb-4 md:px-6", bodyClassName)}>{children}</div>
    </div>
  )
}
