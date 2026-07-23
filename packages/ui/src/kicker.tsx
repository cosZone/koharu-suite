import type { HTMLAttributes } from 'react';
import { classNames } from './class-name';

export type KickerProps = HTMLAttributes<HTMLParagraphElement>;

export function Kicker({ className, ...properties }: KickerProps) {
  return <p className={classNames('ks-ui-kicker', className)} {...properties} />;
}
