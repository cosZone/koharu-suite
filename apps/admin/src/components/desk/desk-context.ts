import { useOutletContext } from 'react-router-dom';
import type {
  AdminConfigResponse,
  AdminStatus,
  BlockedTask,
  Channel,
  ConfiguredChannel,
  MediaCacheObject,
  MediaCachePolicy,
  MediaCachePrunePreview,
  MediaCacheStatus,
  Message,
  ReconciliationFinding,
  ReconciliationRun,
  RerenderResult,
} from '@/lib/types';
import type { SearchPublicMessage } from '@/SearchAndFeedsPanel';

/* actionError 按页面归位:错误显示在发起操作的那个页面顶部 */
export type ActionPage =
  | 'cache'
  | 'channels'
  | 'messages'
  | 'reconciliation'
  | 'settings'
  | 'triage';

export interface Desk {
  status: AdminStatus | null;
  channels: Channel[];
  config: AdminConfigResponse | null;
  configuredChannels: ConfiguredChannel[];
  blockedTasks: BlockedTask[];
  loading: boolean;
  findings: ReconciliationFinding[];
  findingsNextCursor: string | null;
  runs: ReconciliationRun[];
  mediaCacheStatus: MediaCacheStatus | null;
  mediaCacheObjects: MediaCacheObject[];
  mediaCacheNextCursor: string | null;
  mediaCachePrunePreview: MediaCachePrunePreview | null;
  busyAction: string | null;
  reasons: Record<string, string>;
  actionError: { page: ActionPage; message: string } | null;
  rerenderResult: RerenderResult | null;
  selectedChannel: string | null;
  messages: Message[];
  messagesLoading: boolean;
  selectedMessage: Message | null;
  raw: unknown;
  rawLoading: boolean;
  onReasonChange(key: string, reason: string): void;
  onConfigSave(changes: Record<string, string | null>, reason: string): void;
  onSelectArchiveChannel(channelId: string): void;
  onSelectMessage(message: Message): void;
  onSelectSearchMessage(message: SearchPublicMessage): void;
  onRevealRaw(): void;
  onTaskAction(task: BlockedTask, action: 'retry' | 'skip', reason: string): void;
  onFindingAction(
    finding: ReconciliationFinding,
    action: 'hide' | 'ignore' | 'repair' | 'unhide',
    reason: string,
  ): void;
  onLoadMoreFindings(): void;
  onRerender(): void;
  onCacheRetry(object: MediaCacheObject, reason: string): void;
  onChannelToggle(channel: ConfiguredChannel): void;
  onCacheAction(object: MediaCacheObject, action: 'evict' | 'retry', reason: string): void;
  onCacheProtect(object: MediaCacheObject, action: 'protect' | 'unprotect', reason: string): void;
  onCachePolicy(object: MediaCacheObject, policy: MediaCachePolicy, reason: string): void;
  onCacheCopy(
    object: MediaCacheObject,
    sourceBackendId: string,
    targetBackendId: string,
    reason: string,
  ): void;
  onCacheRestore(object: MediaCacheObject, targetBackendId: string, reason: string): void;
  onCacheLoadMore(): void;
  onStorageCopy(sourceBackendId: string, targetBackendId: string, reason: string): void;
  onStoragePrune(
    action: 'apply' | 'preview',
    targetBackendId: string,
    targetBytes: string,
    reason: string,
  ): void;
  onPrunePreviewClear(): void;
  onReconcile(reason: string): void;
  onScan(): void;
  onSessionRevoked(message: string): Promise<void>;
  onSignOut(): void;
}

export function useDesk(): Desk {
  return useOutletContext<Desk>();
}
