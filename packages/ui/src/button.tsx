import type { ButtonHTMLAttributes } from 'react';
import { classNames } from './class-name';

export type ButtonVariant = 'danger' | 'primary' | 'quiet';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ className, variant = 'primary', ...properties }: ButtonProps) {
  return (
    <button
      className={classNames('ks-ui-button', `ks-ui-button--${variant}`, className)}
      {...properties}
    />
  );
}
