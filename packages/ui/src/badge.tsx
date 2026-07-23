import type { HTMLAttributes } from 'react';
import { classNames } from './class-name';

export type BadgeTone = 'neutral' | 'success' | 'warning';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ className, tone = 'neutral', ...properties }: BadgeProps) {
  return (
    <span
      className={classNames('ks-ui-badge', `ks-ui-badge--${tone}`, className)}
      {...properties}
    />
  );
}
