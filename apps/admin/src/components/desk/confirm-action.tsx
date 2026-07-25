import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

/*
 * 替代 window.confirm 的统一确认层。confirmText 逐字沿用原确认文案;
 * destructive 操作把确认按钮设为 destructive。
 */
export function ConfirmAction({
  busy,
  busyLabel,
  confirmText,
  disabled,
  label,
  onConfirm,
  variant = 'outline',
}: {
  busy?: boolean;
  busyLabel?: string;
  confirmText: string;
  disabled?: boolean;
  label: string;
  onConfirm(): void;
  variant?: 'destructive' | 'ghost' | 'outline' | 'secondary';
}) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      <Button
        disabled={disabled ?? false}
        onClick={() => setOpen(true)}
        type="button"
        variant={variant}
      >
        {busy ? (busyLabel ?? label) : label}
      </Button>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="font-serif">{label}</AlertDialogTitle>
          <AlertDialogDescription>{confirmText}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onConfirm();
              setOpen(false);
            }}
            variant={variant === 'destructive' ? 'destructive' : 'outline'}
          >
            确认
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
