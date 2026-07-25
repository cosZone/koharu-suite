import type { CSSProperties } from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

/* G3.1:固定深色;success 不引入彩色,通知一律中性,错误用 destructive */
function Toaster({ ...props }: ToasterProps) {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--error-bg': 'var(--popover)',
          '--error-text': 'var(--destructive)',
        } as CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster };
