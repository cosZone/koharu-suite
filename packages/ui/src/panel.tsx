import type { HTMLAttributes } from 'react';
import { classNames } from './class-name';

export type PanelProps = HTMLAttributes<HTMLElement>;
export type PanelHeaderProps = HTMLAttributes<HTMLDivElement>;

export function Panel({ className, ...properties }: PanelProps) {
  return <section className={classNames('ks-ui-panel', className)} {...properties} />;
}

export function PanelHeader({ className, ...properties }: PanelHeaderProps) {
  return <div className={classNames('ks-ui-panel-header', className)} {...properties} />;
}
