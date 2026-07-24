const SHA256 = /^[0-9a-f]{64}$/u;
const BACKEND_ID = /^[a-z][a-z0-9_-]{0,63}$/u;
const DEFAULT_COALESCE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_ACCESS_BATCH = 100;

export interface MediaCacheBlobAccess {
  backendId: string;
  observedAt: Date;
  sha256: string;
}

export interface MediaCacheAccessWriter {
  writeAccesses(accesses: readonly MediaCacheBlobAccess[]): Promise<void>;
}

export class MediaCacheAccessCoalescer {
  readonly #intervalMs: number;
  readonly #lastWrittenAt = new Map<string, number>();
  readonly #now: () => Date;
  readonly #pending = new Map<string, MediaCacheBlobAccess>();
  readonly #writer: MediaCacheAccessWriter;
  #flushing: Promise<void> | undefined;

  constructor(
    writer: MediaCacheAccessWriter,
    now: () => Date = () => new Date(),
    intervalMs = DEFAULT_COALESCE_INTERVAL_MS,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new TypeError('Media cache access coalesce interval must be a positive integer');
    }
    this.#intervalMs = intervalMs;
    this.#now = now;
    this.#writer = writer;
  }

  observe(backendId: string, sha256: string, observedAt = this.#now()): void {
    assertAccess(backendId, sha256, observedAt);
    const key = accessKey(backendId, sha256);
    const current = this.#pending.get(key);
    if (!current || current.observedAt < observedAt) {
      this.#pending.set(key, {
        backendId,
        observedAt: new Date(observedAt),
        sha256,
      });
    }
  }

  flush(): Promise<void> {
    this.#flushing ??= this.#flush().finally(() => {
      this.#flushing = undefined;
    });
    return this.#flushing;
  }

  async #flush(): Promise<void> {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) {
      throw new TypeError('Media cache access clock returned an invalid date');
    }
    const nowMs = now.getTime();
    const snapshot = [...this.#pending]
      .filter(([key]) => {
        const lastWrittenAt = this.#lastWrittenAt.get(key);
        return lastWrittenAt === undefined || nowMs - lastWrittenAt >= this.#intervalMs;
      })
      .map(([, access]) => ({ ...access, observedAt: new Date(access.observedAt) }))
      .sort(
        (left, right) =>
          left.backendId.localeCompare(right.backendId) || left.sha256.localeCompare(right.sha256),
      );
    if (snapshot.length === 0) {
      this.#pruneHistory(nowMs);
      return;
    }

    for (let offset = 0; offset < snapshot.length; offset += MAX_ACCESS_BATCH) {
      const batch = snapshot.slice(offset, offset + MAX_ACCESS_BATCH);
      await this.#writer.writeAccesses(batch);
      for (const access of batch) {
        const key = accessKey(access.backendId, access.sha256);
        const pending = this.#pending.get(key);
        if (pending?.observedAt.getTime() === access.observedAt.getTime()) {
          this.#pending.delete(key);
        }
        this.#lastWrittenAt.set(key, nowMs);
      }
    }
    this.#pruneHistory(nowMs);
  }

  #pruneHistory(nowMs: number): void {
    for (const [sha256, writtenAt] of this.#lastWrittenAt) {
      if (!this.#pending.has(sha256) && nowMs - writtenAt >= this.#intervalMs) {
        this.#lastWrittenAt.delete(sha256);
      }
    }
  }
}

function assertAccess(backendId: string, sha256: string, observedAt: Date): void {
  if (!BACKEND_ID.test(backendId) || !SHA256.test(sha256)) {
    throw new TypeError('Media cache access must identify a backend and canonical blob SHA-256');
  }
  if (!Number.isFinite(observedAt.getTime())) {
    throw new TypeError('Media cache access time must be valid');
  }
}

function accessKey(backendId: string, sha256: string): string {
  return `${backendId}\0${sha256}`;
}
