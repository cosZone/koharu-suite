const SHA256 = /^[0-9a-f]{64}$/u;
const DEFAULT_COALESCE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_ACCESS_BATCH = 100;

export interface MediaCacheBlobAccess {
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
  readonly #pending = new Map<string, Date>();
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

  observe(sha256: string, observedAt = this.#now()): void {
    assertAccess(sha256, observedAt);
    const current = this.#pending.get(sha256);
    if (!current || current < observedAt) {
      this.#pending.set(sha256, new Date(observedAt));
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
      .filter(([sha256]) => {
        const lastWrittenAt = this.#lastWrittenAt.get(sha256);
        return lastWrittenAt === undefined || nowMs - lastWrittenAt >= this.#intervalMs;
      })
      .map(([sha256, observedAt]) => ({ observedAt: new Date(observedAt), sha256 }))
      .sort((left, right) => left.sha256.localeCompare(right.sha256));
    if (snapshot.length === 0) {
      this.#pruneHistory(nowMs);
      return;
    }

    for (let offset = 0; offset < snapshot.length; offset += MAX_ACCESS_BATCH) {
      const batch = snapshot.slice(offset, offset + MAX_ACCESS_BATCH);
      await this.#writer.writeAccesses(batch);
      for (const access of batch) {
        const pending = this.#pending.get(access.sha256);
        if (pending?.getTime() === access.observedAt.getTime()) {
          this.#pending.delete(access.sha256);
        }
        this.#lastWrittenAt.set(access.sha256, nowMs);
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

function assertAccess(sha256: string, observedAt: Date): void {
  if (!SHA256.test(sha256)) {
    throw new TypeError('Media cache blob SHA-256 must be canonical lowercase hex');
  }
  if (!Number.isFinite(observedAt.getTime())) {
    throw new TypeError('Media cache access time must be valid');
  }
}
