import type { HTMLAttributes } from 'react';
import { classNames } from './class-name';

export type EmptyStateTone = 'neutral' | 'success';

export interface EmptyStateProps extends HTMLAttributes<HTMLParagraphElement> {
  tone?: EmptyStateTone;
}

export function EmptyState({ className, tone = 'neutral', ...properties }: EmptyStateProps) {
  return (
    <p
      className={classNames('ks-ui-empty-state', `ks-ui-empty-state--${tone}`, className)}
      {...properties}
    />
  );
}
