import { type AriaAttributes, cloneElement, type ReactElement, type ReactNode, useId } from 'react';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

interface FieldControlProps {
  'aria-describedby'?: string;
  'aria-invalid'?: AriaAttributes['aria-invalid'];
  id?: string;
}

export interface FieldProps {
  children: ReactElement<FieldControlProps>;
  className?: string;
  error?: ReactNode;
  hint?: ReactNode;
  label: ReactNode;
}

/* label ↔ control 自动关联;error 时挂 aria-invalid + aria-describedby + role=alert */
export function Field({ children, className, error, hint, label }: FieldProps) {
  const generatedId = useId();
  const controlId = children.props.id ?? `${generatedId}-control`;
  const hintId = hint ? `${generatedId}-hint` : null;
  const errorId = error ? `${generatedId}-error` : null;
  const describedBy = [children.props['aria-describedby'], hintId, errorId]
    .filter(Boolean)
    .join(' ');
  const accessibilityProperties: FieldControlProps = { id: controlId };
  if (describedBy) {
    accessibilityProperties['aria-describedby'] = describedBy;
  }
  if (error) {
    accessibilityProperties['aria-invalid'] = true;
  } else if (children.props['aria-invalid'] !== undefined) {
    accessibilityProperties['aria-invalid'] = children.props['aria-invalid'];
  }
  const control = cloneElement(children, accessibilityProperties);

  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={controlId}>{label}</Label>
      {control}
      {hint ? (
        <p className="text-xs text-muted-foreground" id={hintId ?? undefined}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="text-xs text-destructive" id={errorId ?? undefined} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
