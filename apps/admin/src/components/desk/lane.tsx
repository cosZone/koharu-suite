import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export function Lane({
  children,
  className,
  id,
  titleId,
}: {
  children: ReactNode;
  className?: string;
  id: string;
  titleId: string;
}) {
  return (
    <section aria-labelledby={titleId} className={cn('scroll-mt-12', className)} id={id}>
      {children}
    </section>
  );
}

export function LaneHeader({
  action,
  count,
  description,
  index,
  title,
  titleId,
}: {
  action?: ReactNode;
  count?: ReactNode;
  description?: ReactNode;
  index?: string;
  title: string;
  titleId: string;
}) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div>
        {index ? <p className="text-xs tracking-wide text-faint">{index}</p> : null}
        <div className="mt-1 flex items-baseline gap-3">
          <h2 className="font-serif text-lg font-semibold" id={titleId}>
            {title}
          </h2>
          {count}
        </div>
        {description ? (
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function LaneBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mt-3 grid gap-2', className)}>{children}</div>;
}

export function LaneItem({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('rounded-lg border bg-card p-3', className)}>{children}</div>;
}

export function LaneEmpty({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        'rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground',
        className,
      )}
    >
      {children}
    </p>
  );
}

export function LaneSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="grid gap-2" role="status">
      <span className="sr-only">正在加载</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton className="h-16 w-full rounded-lg" key={index} />
      ))}
    </div>
  );
}
