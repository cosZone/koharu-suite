import {
  type AriaAttributes,
  cloneElement,
  type LabelHTMLAttributes,
  type ReactElement,
  type ReactNode,
  useId,
} from 'react';
import { classNames } from './class-name';

interface FieldControlProps {
  'aria-describedby'?: string;
  'aria-invalid'?: AriaAttributes['aria-invalid'];
  id?: string;
}

export interface FieldProps
  extends Omit<LabelHTMLAttributes<HTMLLabelElement>, 'children' | 'htmlFor'> {
  children: ReactElement<FieldControlProps>;
  error?: ReactNode;
  hint?: ReactNode;
  label: ReactNode;
}

export function Field({ children, className, error, hint, label, ...properties }: FieldProps) {
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
  const control = cloneElement(children, {
    ...accessibilityProperties,
  });

  return (
    <label
      className={classNames('ks-ui-field', className)}
      data-invalid={error ? 'true' : undefined}
      htmlFor={controlId}
      {...properties}
    >
      <span className="ks-ui-field__label">{label}</span>
      {control}
      {hint ? (
        <span className="ks-ui-field__hint" id={hintId ?? undefined}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="ks-ui-field__error" id={errorId ?? undefined} role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}
