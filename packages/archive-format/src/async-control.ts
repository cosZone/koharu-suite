const ITERATOR_CLEANUP_TIMEOUT_MS = 100;

/** Start one operation without a check-then-subscribe AbortSignal race. */
export function runWithAbort<T>(
  operation: () => PromiseLike<T> | T,
  signal: AbortSignal | undefined,
  abortReason: () => unknown = () => signal?.reason,
): Promise<T> {
  if (signal === undefined) return Promise.resolve().then(operation);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: (value: T | unknown) => void, value: T | unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = (): void => finish(reject, abortReason());

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    Promise.resolve()
      .then(operation)
      .then(
        (value) => finish(resolve as (value: T | unknown) => void, value),
        (error: unknown) => finish(reject, error),
      );
  });
}

/** Iterator cleanup must not mask the primary result or wait forever. */
export async function closeIteratorBestEffort<T>(iterator: AsyncIterator<T>): Promise<void> {
  if (iterator.return === undefined) return;

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ITERATOR_CLEANUP_TIMEOUT_MS);
    timer.unref();
  });
  try {
    await Promise.race([
      Promise.resolve()
        .then(() => iterator.return?.())
        .then(() => undefined),
      timeout,
    ]);
  } catch {
    // Cleanup is bounded and best-effort; preserve the primary result/error.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
