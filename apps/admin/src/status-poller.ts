export interface StatusPollerOptions<T> {
  fetchStatus(signal: AbortSignal): Promise<T>;
  intervalMs?: number;
  onError?(reason: unknown): void;
  onStatus(status: T): void;
}

const DEFAULT_STATUS_POLL_INTERVAL_MS = 10_000;

function isAbortError(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError';
}

export function startStatusPoller<T>({
  fetchStatus,
  intervalMs = DEFAULT_STATUS_POLL_INTERVAL_MS,
  onError,
  onStatus,
}: StatusPollerOptions<T>): () => void {
  let activeController: AbortController | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    timer = setTimeout(poll, intervalMs);
  };

  const poll = async () => {
    if (stopped) {
      return;
    }

    const controller = new AbortController();
    activeController = controller;
    try {
      const status = await fetchStatus(controller.signal);
      if (!stopped && !controller.signal.aborted) {
        onStatus(status);
      }
    } catch (reason) {
      if (!stopped && !isAbortError(reason)) {
        onError?.(reason);
      }
    } finally {
      if (activeController === controller) {
        activeController = null;
      }
      if (!stopped) {
        schedule();
      }
    }
  };

  schedule();

  return () => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    activeController?.abort();
    activeController = null;
  };
}
