export interface ImportCancellation {
  cleanup(): void;
  signal: AbortSignal;
}

export function registerImportCancellation(): ImportCancellation {
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
  };
  let cleanedUp = false;

  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);

  return {
    cleanup() {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      process.off('SIGINT', abort);
      process.off('SIGTERM', abort);
    },
    signal: controller.signal,
  };
}

export async function closeImportResources(
  ...closeResources: Array<() => Promise<void>>
): Promise<void> {
  const results = await Promise.allSettled(closeResources.map((close) => close()));
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'Multiple Telegram Desktop import resources failed to close',
    );
  }
}
