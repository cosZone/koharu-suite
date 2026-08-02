export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

export interface Channel {
  id: string;
  title: string;
  username: string | null;
}

export interface ConfiguredChannel {
  disabledAt: string | null;
  enabled: boolean;
  telegramChatId: string;
  title: string;
  username: string | null;
}

export interface BlockedTask {
  attemptCount: number;
  blockedAt: string;
  channelTitle: string;
  channelUsername: string | null;
  id: string;
  lastError: string | null;
  telegramUpdateId: string;
}

export interface Message {
  authorSignature: string | null;
  channel: Channel;
  content: {
    html: string | null;
    kind: 'caption' | 'none' | 'text';
    text: string | null;
  };
  id: string;
  media: Array<{ fileName: string | null; kind: string }>;
  publishedAt: string;
  revision: number;
  sourceUrl: string | null;
  tombstoned?: boolean;
  updatedAt?: string;
}

export interface MessageVisibilityResult {
  actionId: string;
  changed: boolean;
  messageId: string;
  tombstoned: boolean;
  updatedAt: string;
}

export type MessageVisibilityFilter = 'all' | 'hidden' | 'visible';

export interface AdminStatus {
  collector: {
    heartbeatAt: string | null;
    lastTelegramSuccessAt: string | null;
    startedAt: string | null;
    state: 'running' | 'stale' | 'stopped';
    version: string | null;
  };
  counts: {
    activeChannels: number;
    blockedTasks: number;
    configuredChannels: number;
    messages: number;
    pendingTasks: number;
    retryingTasks: number;
    skippedTasks: number;
    staleRendererRevisions: number;
    updates: number;
  };
  lastCheckpoint: string | null;
  owner: {
    email: string;
    twoFactorEnabled: boolean;
  };
  version: string;
}

export interface TotpSetup {
  backupCodes: string[];
  secret: string;
  totpURI: string;
}

export interface RerenderResult {
  currentVersion: number;
  hasMore: boolean;
  updated: number;
}

export interface ReconciliationFinding {
  evidenceVersion: number;
  id: string;
  kind: string;
  messageId: string | null;
  messageTombstoned: boolean;
  sanitizedDetails: { reason?: string };
  severity: 'error' | 'warning';
  state: 'ignored' | 'open' | 'resolved';
  telegramChatId: string | null;
}

export interface ReconciliationRun {
  completedAt: string | null;
  id: string;
  mode: string;
  startedAt: string;
  status: string;
}

export interface MediaCacheStatus {
  backends?: Array<{
    enabled: boolean;
    id: string;
    kind: 'local' | 's3';
    label: string;
    lastReconciledAt: string | null;
    locationStateCounts: Array<{ count: number; state: string }>;
    maxBytes: string;
    readPriority: number;
    readable: boolean;
    readyBytes: string;
    updatedAt: string;
    writable: boolean;
    writePriority: number;
  }>;
  commands: Array<{
    completedAt: string | null;
    createdAt: string;
    errorCode: string | null;
    id: string;
    operation: 'evict' | 'migrate' | 'prune' | 'reconcile' | 'restore';
    result: Record<string, unknown> | null;
    sourceBackendId?: string | null;
    state: 'failed' | 'pending' | 'running' | 'succeeded';
    targetBackendId?: string | null;
    targetBytes?: string | null;
    updatedAt: string;
  }>;
  enabled: boolean;
  failures: Array<{
    lastErrorClass: string | null;
    lastErrorCode: string | null;
    objectId: string;
    planId: string;
    reasonCode: string | null;
    state: string;
    updatedAt: string;
    variant: 'original' | 'thumbnail';
  }>;
  stateCounts: {
    blobs: Array<{ count: number; state: string }>;
    objects: Array<{ count: number; state: string }>;
    plans: Array<{ count: number; state: string }>;
  };
  usage: {
    lastReconciledAt: string | null;
    maxBytes: string;
    readyBytes: string;
    reservedBytes: string;
    updatedAt: string | null;
  };
}

export interface MediaCacheObject {
  actualBytes: string | null;
  canonicalMediaId: string;
  declaredBytes: string | null;
  evictedPolicy?: 'recache_on_access' | 'stay_evicted';
  id: string;
  kind: string;
  locations?: Array<{
    backendId: string;
    lastAccessedAt: string;
    state: 'copying' | 'corrupt' | 'deleting' | 'evicted' | 'missing' | 'ready';
    updatedAt: string;
    verifiedAt: string | null;
    verifiedBytes: string | null;
  }>;
  messageId: string;
  planId: string;
  planState: string;
  protection?: {
    active: boolean;
    expired: boolean;
    expiresAt: string | null;
    protectedAt: string;
    updatedAt: string;
  } | null;
  reasonCode: string | null;
  state: string;
  updatedAt: string;
  variant: 'original' | 'thumbnail';
}

export interface MediaCacheCommandReceipt {
  commandId: string;
  operation: 'evict' | 'migrate' | 'prune' | 'reconcile' | 'restore';
  state: 'pending';
}

export interface MediaCachePrunePreview {
  candidates: number;
  hasMore: boolean;
  projectedReadyBytes: string;
  readyBytes: string;
  removableBytes: string;
  targetBackendId: string;
  targetBytes: string;
}

export type MediaCachePolicy = 'recache_on_access' | 'stay_evicted';

export interface SearchChannel {
  id: string;
  title: string;
  username: string | null;
}

export interface SearchPublicMessage {
  authorSignature: string | null;
  channel: SearchChannel;
  content: {
    html: string | null;
    kind: 'caption' | 'none' | 'text';
    text: string | null;
  };
  id: string;
  media: Array<{ fileName: string | null; kind: string }>;
  publishedAt: string;
  revision: number;
  sourceUrl: string | null;
}

export interface SearchMatch {
  score: number | null;
  snippet: string;
}

export interface SearchResult {
  match: SearchMatch;
  message: SearchPublicMessage;
}

export interface SearchResponse {
  items: SearchResult[];
  mode: 'short_substring' | 'trigram';
  nextCursor: string | null;
}

export interface SearchRequest {
  channel: string;
  from: string;
  q: string;
  sort: 'newest' | 'relevance';
  to: string;
}
