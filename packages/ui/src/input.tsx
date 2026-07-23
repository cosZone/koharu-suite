import type { InputHTMLAttributes } from 'react';
import { classNames } from './class-name';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export function Input({ className, ...properties }: InputProps) {
  return <input className={classNames('ks-ui-input', className)} {...properties} />;
}
