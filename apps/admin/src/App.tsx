import { useCallback, useEffect, useRef, useState } from 'react';
import {
  HashRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { toast } from 'sonner';
import { LoginCard } from '@/components/auth/login-card';
import type { ActionPage, Desk } from '@/components/desk/desk-context';
import { ChannelStrip, RouteStrip, Sidebar, TopBar } from '@/components/desk/frame';
import {
  CachePage,
  ChannelsPage,
  MessagesPage,
  OverviewPage,
  ReconciliationPage,
  SearchPage,
  SettingsPage,
  SystemPage,
} from '@/components/desk/pages';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { authClient } from '@/lib/auth';
import type {
  AdminStatus,
  ApiError,
  BlockedTask,
  Channel,
  ConfiguredChannel,
  MediaCacheCommandReceipt,
  MediaCacheObject,
  MediaCachePolicy,
  MediaCachePrunePreview,
  MediaCacheStatus,
  Message,
  MessageVisibilityFilter,
  MessageVisibilityResult,
  ReconciliationFinding,
  ReconciliationRun,
  RerenderResult,
} from '@/lib/types';
import type { SearchPublicMessage } from './SearchAndFeedsPanel';
import { startStatusPoller } from './status-poller';

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export async function fetchJson<T extends object>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const body = (await response.json()) as T | ApiError;

  if (!response.ok) {
    const message = 'error' in body ? body.error.message : `Request failed with ${response.status}`;
    throw new ApiRequestError(message, response.status, 'error' in body ? body.error.code : null);
  }

  return body as T;
}

export function hydrateManagedMessage(current: Message | null, items: Message[]): Message | null {
  if (!current) return null;
  return items.find((candidate) => candidate.id === current.id) ?? current;
}

export async function recoverMessageVisibilityConflict(
  reason: unknown,
  messageId: string,
  refresh: (messageId: string) => Promise<void>,
): Promise<boolean> {
  if (
    !(reason instanceof ApiRequestError) ||
    reason.status !== 409 ||
    reason.code !== 'message_visibility_conflict'
  ) {
    return false;
  }
  await refresh(messageId);
  return true;
}

export interface MessageRequestToken {
  generation: number;
  scope: string;
}

export class MessageRequestGuard {
  private generation = 0;

  begin(scope: string): MessageRequestToken {
    this.generation += 1;
    return { generation: this.generation, scope };
  }

  invalidate(): void {
    this.generation += 1;
  }

  isCurrent(token: MessageRequestToken): boolean {
    return token.generation === this.generation;
  }
}

export interface MessageLoadingToken {
  generation: number;
  scope: string;
}

export class MessageLoadingOwner {
  private generation = 0;

  begin(scope: string): MessageLoadingToken {
    this.generation += 1;
    return { generation: this.generation, scope };
  }

  isCurrent(token: MessageLoadingToken): boolean {
    return token.generation === this.generation;
  }
}

export function resolveRefreshedMessageSelection(input: {
  current: Message | null;
  items: Message[];
  preferRequested: boolean;
  preferred: Message | undefined;
}): Message | null {
  if (input.preferRequested && input.preferred) return input.preferred;
  if (input.current) {
    return input.items.find((candidate) => candidate.id === input.current?.id) ?? input.current;
  }
  return input.items[0] ?? null;
}

export function isMessageInChannel(
  message: Message | null,
  channelId: string | null,
): message is Message {
  return message !== null && channelId !== null && message.channel.id === channelId;
}

export const SEARCH_MESSAGE_LOAD_ERROR = '无法加载这条消息的管理状态，请重试。';

export async function completeSearchSelection(input: {
  isCurrent(): boolean;
  load(): Promise<Message>;
  navigate(path: '/messages'): void;
  reportError(message: string): void;
  select(message: Message): void;
}): Promise<boolean> {
  try {
    const managedMessage = await input.load();
    if (!input.isCurrent()) return false;
    input.select(managedMessage);
    input.navigate('/messages');
    return true;
  } catch {
    if (!input.isCurrent()) return false;
    input.reportError(SEARCH_MESSAGE_LOAD_ERROR);
    return false;
  }
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

export async function publishMediaCacheMutationReceipt(input: {
  refresh(): Promise<void>;
  refreshFailureNotice: string;
  setNotice(notice: string): void;
  successNotice: string;
}): Promise<void> {
  input.setNotice(input.successNotice);
  try {
    await input.refresh();
  } catch {
    input.setNotice(input.refreshFailureNotice);
  }
}

function adminMessagesUrl(
  channelId: string,
  visibility: MessageVisibilityFilter,
  cursor?: string,
): string {
  const search = new URLSearchParams({ channel: channelId, limit: '50', visibility });
  if (cursor) search.set('cursor', cursor);
  return `/api/v1/admin/messages?${search.toString()}`;
}

function messageScopeKey(channelId: string, visibility: MessageVisibilityFilter): string {
  return `${channelId}:${visibility}`;
}

function DeskShell({ onSessionRevoked }: { onSessionRevoked(message: string): Promise<void> }) {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [configuredChannels, setConfiguredChannels] = useState<ConfiguredChannel[]>([]);
  const [blockedTasks, setBlockedTasks] = useState<BlockedTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesNextCursor, setMessagesNextCursor] = useState<string | null>(null);
  const [messageVisibilityFilter, setMessageVisibilityFilter] =
    useState<MessageVisibilityFilter>('all');
  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const [raw, setRaw] = useState<unknown>(null);
  const [rawLoading, setRawLoading] = useState(false);
  const [findings, setFindings] = useState<ReconciliationFinding[]>([]);
  const [findingsNextCursor, setFindingsNextCursor] = useState<string | null>(null);
  const [runs, setRuns] = useState<ReconciliationRun[]>([]);
  const [mediaCacheStatus, setMediaCacheStatus] = useState<MediaCacheStatus | null>(null);
  const [mediaCacheObjects, setMediaCacheObjects] = useState<MediaCacheObject[]>([]);
  const [mediaCacheNextCursor, setMediaCacheNextCursor] = useState<string | null>(null);
  const [mediaCachePrunePreview, setMediaCachePrunePreview] =
    useState<MediaCachePrunePreview | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<{ page: ActionPage; message: string } | null>(
    null,
  );
  const [rerenderResult, setRerenderResult] = useState<RerenderResult | null>(null);
  const messageSelectionVersion = useRef(0);
  const messageLoadingOwner = useRef(new MessageLoadingOwner());
  const messageRequestGuard = useRef(new MessageRequestGuard());
  const currentMessageScope = selectedChannel
    ? messageScopeKey(selectedChannel, messageVisibilityFilter)
    : null;
  const currentMessageScopeRef = useRef(currentMessageScope);
  currentMessageScopeRef.current = currentMessageScope;
  const skipAutoSelectRef = useRef(false);
  const location = useLocation();
  const locationPathRef = useRef(location.pathname);
  locationPathRef.current = location.pathname;
  const navigate = useNavigate();
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    mainRef.current?.scrollTo(0, 0);
  }, [location.pathname]);

  const onReasonChange = useCallback((key: string, reason: string) => {
    setReasons((current) => ({ ...current, [key]: reason }));
  }, []);

  function clearReason(key: string) {
    setReasons((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  useEffect(() => {
    const controller = new AbortController();
    let stopStatusPoller: (() => void) | null = null;

    Promise.all([
      fetchJson<AdminStatus>('/api/v1/admin/status', { signal: controller.signal }),
      fetchJson<{ items: Channel[] }>('/api/v1/channels', { signal: controller.signal }),
      fetchJson<{ items: BlockedTask[] }>('/api/v1/admin/tasks/blocked', {
        signal: controller.signal,
      }),
      fetchJson<{ items: ConfiguredChannel[] }>('/api/v1/admin/channels', {
        signal: controller.signal,
      }),
      fetchJson<{ items: ReconciliationFinding[]; nextCursor: string | null }>(
        '/api/v1/admin/reconciliation/findings?limit=20',
        { signal: controller.signal },
      ),
      fetchJson<{ items: ReconciliationRun[] }>('/api/v1/admin/reconciliation/runs?limit=5', {
        signal: controller.signal,
      }),
      fetchJson<MediaCacheStatus>('/api/v1/admin/media-cache/status', {
        signal: controller.signal,
      }),
      fetchJson<{ items: MediaCacheObject[]; nextCursor: string | null }>(
        '/api/v1/admin/media-cache/objects?limit=20',
        { signal: controller.signal },
      ),
    ])
      .then(
        ([
          nextStatus,
          channelResult,
          taskResult,
          configuredChannelResult,
          findingResult,
          runResult,
          nextMediaCacheStatus,
          mediaCacheObjectResult,
        ]) => {
          setStatus(nextStatus);
          setChannels(channelResult.items);
          setBlockedTasks(taskResult.items);
          setConfiguredChannels(configuredChannelResult.items);
          setFindings(findingResult.items);
          setFindingsNextCursor(findingResult.nextCursor);
          setRuns(runResult.items);
          setMediaCacheStatus(nextMediaCacheStatus);
          setMediaCacheObjects(mediaCacheObjectResult.items);
          setMediaCacheNextCursor(mediaCacheObjectResult.nextCursor);
          setSelectedChannel((current) => current ?? channelResult.items[0]?.id ?? null);
          setLoadError(null);
        },
      )
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') {
          return;
        }
        setLoadError(errorMessage(reason, '无法加载管理状态'));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          stopStatusPoller = startStatusPoller<AdminStatus>({
            fetchStatus: (signal) =>
              fetchJson<AdminStatus>('/api/v1/admin/status', {
                cache: 'no-store',
                signal,
              }),
            onError(reason) {
              setStatusError(errorMessage(reason, '无法刷新采集状态'));
            },
            onStatus(nextStatus) {
              setStatus(nextStatus);
              setStatusError(null);
            },
          });
        }
      });

    return () => {
      controller.abort();
      stopStatusPoller?.();
    };
  }, [loadNonce]);

  useEffect(() => {
    if (!selectedChannel) {
      messageLoadingOwner.current.begin('no-channel');
      setMessages([]);
      setMessagesNextCursor(null);
      setMessagesLoading(false);
      setSelectedMessage(null);
      setRaw(null);
      return;
    }

    const controller = new AbortController();
    const scope = messageScopeKey(selectedChannel, messageVisibilityFilter);
    const loadingToken = messageLoadingOwner.current.begin(scope);
    const requestToken = messageRequestGuard.current.begin(scope);
    const selectionVersion = messageSelectionVersion.current;
    setMessagesLoading(true);
    fetchJson<{ items: Message[]; nextCursor: string | null }>(
      adminMessagesUrl(selectedChannel, messageVisibilityFilter),
      { signal: controller.signal },
    )
      .then((result) => {
        if (!messageRequestGuard.current.isCurrent(requestToken)) return;
        setMessages(result.items);
        setMessagesNextCursor(result.nextCursor);
        setSelectedMessage((current) => hydrateManagedMessage(current, result.items));
        if (messageSelectionVersion.current === selectionVersion) {
          if (skipAutoSelectRef.current) {
            skipAutoSelectRef.current = false;
          } else {
            setSelectedMessage(result.items[0] ?? null);
            setRaw(null);
          }
        }
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') {
          return;
        }
        if (!messageRequestGuard.current.isCurrent(requestToken)) return;
        setActionError({ page: 'messages', message: errorMessage(reason, '无法加载消息') });
      })
      .finally(() => {
        if (messageLoadingOwner.current.isCurrent(loadingToken)) {
          setMessagesLoading(false);
        }
      });

    return () => controller.abort();
  }, [messageVisibilityFilter, selectedChannel]);

  function retryLoad() {
    setLoadError(null);
    setLoading(true);
    setLoadNonce((current) => current + 1);
  }

  async function revealRaw() {
    if (!isMessageInChannel(selectedMessage, selectedChannel) || messagesLoading) {
      return;
    }

    setRawLoading(true);
    setActionError(null);
    try {
      const result = await fetchJson<{ update: unknown }>(
        `/api/v1/admin/messages/${selectedMessage.id}/raw`,
        { cache: 'no-store' },
      );
      setRaw(result.update);
    } catch (reason) {
      setActionError({ page: 'messages', message: errorMessage(reason, '无法读取原始 update') });
    } finally {
      setRawLoading(false);
    }
  }

  function selectArchiveChannel(channelId: string) {
    if (channelId === selectedChannel) return;
    messageRequestGuard.current.invalidate();
    messageLoadingOwner.current.begin(messageScopeKey(channelId, messageVisibilityFilter));
    messageSelectionVersion.current += 1;
    setMessages([]);
    setMessagesNextCursor(null);
    setMessagesLoading(true);
    setSelectedMessage(null);
    setRaw(null);
    setSelectedChannel(channelId);
  }

  function selectSearchMessage(message: SearchPublicMessage) {
    messageSelectionVersion.current += 1;
    const selectionVersion = messageSelectionVersion.current;
    const selectionPath = location.pathname;
    setSelectedMessage(message);
    setRaw(null);
    if (message.channel.id !== selectedChannel) {
      messageRequestGuard.current.invalidate();
      messageLoadingOwner.current.begin(
        messageScopeKey(message.channel.id, messageVisibilityFilter),
      );
      skipAutoSelectRef.current = true;
      setMessages([]);
      setMessagesNextCursor(null);
      setMessagesLoading(true);
      setSelectedChannel(message.channel.id);
    }
    void completeSearchSelection({
      isCurrent: () =>
        messageSelectionVersion.current === selectionVersion &&
        locationPathRef.current === selectionPath,
      load: () => fetchJson<Message>(`/api/v1/admin/messages/${message.id}`, { cache: 'no-store' }),
      navigate: (path) => navigate(path),
      reportError: (error) => toast.error(error),
      select: (managedMessage) => setSelectedMessage(managedMessage),
    });
  }

  function changeMessageVisibilityFilter(filter: MessageVisibilityFilter) {
    if (filter === messageVisibilityFilter) return;
    messageRequestGuard.current.invalidate();
    if (selectedChannel) {
      messageLoadingOwner.current.begin(messageScopeKey(selectedChannel, filter));
    }
    messageSelectionVersion.current += 1;
    setMessages([]);
    setMessagesNextCursor(null);
    setMessagesLoading(true);
    setSelectedMessage(null);
    setRaw(null);
    setMessageVisibilityFilter(filter);
  }

  async function refreshMessageManagement(
    preferredMessageId?: string,
    currentRequestToken?: MessageRequestToken,
    shouldPreferMessage: () => boolean = () => true,
  ): Promise<void> {
    if (!selectedChannel) return;
    const scope = messageScopeKey(selectedChannel, messageVisibilityFilter);
    if (currentMessageScopeRef.current !== scope) return;
    if (
      currentRequestToken &&
      (currentRequestToken.scope !== scope ||
        !messageRequestGuard.current.isCurrent(currentRequestToken))
    ) {
      return;
    }
    const requestToken = currentRequestToken ?? messageRequestGuard.current.begin(scope);
    const loadingToken = messageLoadingOwner.current.begin(scope);
    setMessagesLoading(true);
    try {
      const result = await fetchJson<{ items: Message[]; nextCursor: string | null }>(
        adminMessagesUrl(selectedChannel, messageVisibilityFilter),
        { cache: 'no-store' },
      );
      if (!messageRequestGuard.current.isCurrent(requestToken)) return;
      let preferred =
        preferredMessageId && shouldPreferMessage()
          ? result.items.find((candidate) => candidate.id === preferredMessageId)
          : undefined;
      if (!preferred && preferredMessageId && shouldPreferMessage()) {
        try {
          const exact = await fetchJson<Message>(`/api/v1/admin/messages/${preferredMessageId}`, {
            cache: 'no-store',
          });
          if (!messageRequestGuard.current.isCurrent(requestToken)) return;
          if (exact.channel.id === selectedChannel) preferred = exact;
        } catch (reason) {
          if (!(reason instanceof ApiRequestError && reason.status === 404)) throw reason;
        }
      }
      if (!messageRequestGuard.current.isCurrent(requestToken)) return;
      setMessages(result.items);
      setMessagesNextCursor(result.nextCursor);
      setSelectedMessage((current) =>
        resolveRefreshedMessageSelection({
          current,
          items: result.items,
          preferred,
          preferRequested: shouldPreferMessage(),
        }),
      );
      if (shouldPreferMessage()) setRaw(null);
    } finally {
      if (messageLoadingOwner.current.isCurrent(loadingToken)) {
        setMessagesLoading(false);
      }
    }
  }

  async function changeMessageVisibility(
    message: Message,
    action: 'hide' | 'unhide',
    reason: string,
  ) {
    if (!message.updatedAt) {
      setActionError({ page: 'messages', message: '请从消息列表重新选择这条消息后再操作。' });
      return;
    }
    if (!selectedChannel || message.channel.id !== selectedChannel || messagesLoading) {
      setActionError({ page: 'messages', message: '消息视图正在切换，请等待当前频道加载完成。' });
      return;
    }
    const operationSelectionVersion = messageSelectionVersion.current;
    const shouldPreferOperationTarget = () =>
      messageSelectionVersion.current === operationSelectionVersion;
    const operationToken = messageRequestGuard.current.begin(
      messageScopeKey(selectedChannel, messageVisibilityFilter),
    );
    const busyKey = `message:${message.id}:${action}`;
    setBusyAction(busyKey);
    setActionError(null);
    try {
      const result = await fetchJson<MessageVisibilityResult>(
        `/api/v1/admin/messages/${message.id}/${action}`,
        {
          body: JSON.stringify({ expectedUpdatedAt: message.updatedAt, reason }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        },
      );
      if (!messageRequestGuard.current.isCurrent(operationToken)) {
        toast.success('消息可见性操作已完成；当前已切换到其他消息视图。');
        return;
      }
      const updated = {
        ...message,
        tombstoned: result.tombstoned,
        updatedAt: result.updatedAt,
      };
      setMessages((current) => {
        const next = current.map((candidate) =>
          candidate.id === message.id ? updated : candidate,
        );
        return next.filter(
          (candidate) =>
            messageVisibilityFilter === 'all' ||
            (messageVisibilityFilter === 'hidden' && candidate.tombstoned) ||
            (messageVisibilityFilter === 'visible' && !candidate.tombstoned),
        );
      });
      setSelectedMessage((current) => (current?.id === message.id ? updated : current));
      clearReason(message.id);
      let refreshFailed = false;
      try {
        await refreshMessageManagement(message.id, operationToken, shouldPreferOperationTarget);
      } catch {
        if (messageRequestGuard.current.isCurrent(operationToken)) {
          refreshFailed = true;
        }
      }
      if (!messageRequestGuard.current.isCurrent(operationToken)) {
        toast.success('消息可见性操作已完成；当前已切换到其他消息视图。');
        return;
      }
      toast.success(
        action === 'hide'
          ? '消息已从公开页面、API、搜索与 RSS 隐藏；来源证据仍保留。'
          : '消息已恢复公开访问。',
      );
      if (refreshFailed) {
        setActionError({
          page: 'messages',
          message: '可见性操作已完成，但列表刷新失败；请手动重新载入确认最新状态。',
        });
      }
    } catch (reason) {
      if (!messageRequestGuard.current.isCurrent(operationToken)) return;
      try {
        if (
          await recoverMessageVisibilityConflict(reason, message.id, (messageId) =>
            refreshMessageManagement(messageId, operationToken, shouldPreferOperationTarget),
          )
        ) {
          if (!messageRequestGuard.current.isCurrent(operationToken)) return;
          setActionError({
            page: 'messages',
            message: '消息在操作前已发生变化，管理列表已刷新；请核对最新状态后重试。',
          });
        } else {
          setActionError({ page: 'messages', message: errorMessage(reason, '操作失败') });
        }
      } catch (refreshReason) {
        if (!messageRequestGuard.current.isCurrent(operationToken)) return;
        if (
          reason instanceof ApiRequestError &&
          reason.status === 409 &&
          reason.code === 'message_visibility_conflict'
        ) {
          setActionError({
            page: 'messages',
            message: errorMessage(refreshReason, '消息状态冲突，且刷新失败；请手动重新载入。'),
          });
        } else {
          setActionError({ page: 'messages', message: errorMessage(reason, '操作失败') });
        }
      }
    } finally {
      setBusyAction((current) => (current === busyKey ? null : current));
    }
  }

  async function runAction(
    busyKey: string,
    page: ActionPage,
    operation: () => Promise<string | null>,
  ) {
    setBusyAction(busyKey);
    setActionError(null);
    try {
      const notice = await operation();
      if (notice) {
        toast.success(notice);
      }
    } catch (reason) {
      setActionError({ page, message: errorMessage(reason, '操作失败') });
    } finally {
      setBusyAction((current) => (current === busyKey ? null : current));
    }
  }

  async function loadMoreMessages() {
    if (!selectedChannel || !messagesNextCursor) return;
    await runAction('more-messages', 'messages', async () => {
      const requestToken = messageRequestGuard.current.begin(
        messageScopeKey(selectedChannel, messageVisibilityFilter),
      );
      const result = await fetchJson<{ items: Message[]; nextCursor: string | null }>(
        adminMessagesUrl(selectedChannel, messageVisibilityFilter, messagesNextCursor),
      );
      if (!messageRequestGuard.current.isCurrent(requestToken)) return null;
      setMessages((current) => {
        const known = new Set(current.map((message) => message.id));
        return [...current, ...result.items.filter((message) => !known.has(message.id))];
      });
      setMessagesNextCursor(result.nextCursor);
      setSelectedMessage((current) =>
        current
          ? (result.items.find((candidate) => candidate.id === current.id) ?? current)
          : current,
      );
      return null;
    });
  }

  async function actOnTask(task: BlockedTask, action: 'retry' | 'skip', reason: string) {
    await runAction(`task:${task.id}:${action}`, 'triage', async () => {
      await fetchJson<{ success: true }>(`/api/v1/admin/tasks/${task.id}/${action}`, {
        body: JSON.stringify({ reason }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      setBlockedTasks((current) => current.filter((candidate) => candidate.id !== task.id));
      setStatus((current) =>
        current
          ? {
              ...current,
              counts: {
                ...current.counts,
                blockedTasks: Math.max(0, current.counts.blockedTasks - 1),
                pendingTasks:
                  action === 'retry'
                    ? current.counts.pendingTasks + 1
                    : current.counts.pendingTasks,
                skippedTasks:
                  action === 'skip' ? current.counts.skippedTasks + 1 : current.counts.skippedTasks,
              },
            }
          : current,
      );
      clearReason(task.id);
      return action === 'retry'
        ? `Update ${task.telegramUpdateId} 已重新进入处理队列。`
        : `Update ${task.telegramUpdateId} 已由 Owner 显式跳过。`;
    });
  }

  async function toggleConfiguredChannel(channel: ConfiguredChannel) {
    await runAction(`channel:${channel.telegramChatId}`, 'channels', async () => {
      const action = channel.enabled ? 'disable' : 'enable';
      const updated = await fetchJson<ConfiguredChannel>(
        `/api/v1/admin/channels/${encodeURIComponent(channel.telegramChatId)}/${action}`,
        { method: 'POST' },
      );
      setConfiguredChannels((current) =>
        current.map((candidate) =>
          candidate.telegramChatId === updated.telegramChatId ? updated : candidate,
        ),
      );
      setStatus((current) =>
        current
          ? {
              ...current,
              counts: {
                ...current.counts,
                activeChannels: Math.max(
                  0,
                  current.counts.activeChannels + (updated.enabled ? 1 : -1),
                ),
              },
            }
          : current,
      );
      return `${channel.title} 已${channel.enabled ? '停用' : '启用'}。历史归档没有被删除。`;
    });
  }

  async function rerenderOutdated() {
    await runAction('rerender', 'triage', async () => {
      const result = await fetchJson<RerenderResult>('/api/v1/admin/rerender', { method: 'POST' });
      setRerenderResult(result);
      setStatus((current) =>
        current
          ? {
              ...current,
              counts: {
                ...current.counts,
                staleRendererRevisions: Math.max(
                  0,
                  current.counts.staleRendererRevisions - result.updated,
                ),
              },
            }
          : current,
      );
      return null;
    });
  }

  async function refreshReconciliation() {
    const [findingResult, runResult] = await Promise.all([
      fetchJson<{ items: ReconciliationFinding[]; nextCursor: string | null }>(
        '/api/v1/admin/reconciliation/findings?limit=20',
      ),
      fetchJson<{ items: ReconciliationRun[] }>('/api/v1/admin/reconciliation/runs?limit=5'),
    ]);
    setFindings(findingResult.items);
    setFindingsNextCursor(findingResult.nextCursor);
    setRuns(runResult.items);
  }

  async function runReconciliationScan() {
    if (configuredChannels.length === 0) {
      return;
    }
    await runAction('scan', 'reconciliation', async () => {
      await fetchJson<{ runId: string }>('/api/v1/admin/reconciliation/scan', {
        body: JSON.stringify({
          telegramChannelIds: configuredChannels.map((channel) => channel.telegramChatId),
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      await refreshReconciliation();
      return '对账扫描完成，finding 已按同一快照更新。';
    });
  }

  async function loadMoreFindings() {
    if (!findingsNextCursor) return;
    await runAction('more-findings', 'triage', async () => {
      const result = await fetchJson<{
        items: ReconciliationFinding[];
        nextCursor: string | null;
      }>(
        `/api/v1/admin/reconciliation/findings?limit=20&cursor=${encodeURIComponent(findingsNextCursor)}`,
      );
      setFindings((current) => [...current, ...result.items]);
      setFindingsNextCursor(result.nextCursor);
      return null;
    });
  }

  async function actOnFinding(
    finding: ReconciliationFinding,
    action: 'hide' | 'ignore' | 'repair' | 'unhide',
    reason: string,
  ) {
    const verb = {
      hide: '隐藏消息并让公开 API 返回 404',
      ignore: '忽略此 finding',
      repair: '执行确定性修复',
      unhide: '恢复消息的公开访问',
    }[action];
    await runAction(`${finding.id}:${action}`, 'triage', async () => {
      await fetchJson<object>(`/api/v1/admin/reconciliation/findings/${finding.id}/${action}`, {
        body: JSON.stringify({
          expectedEvidenceVersion: finding.evidenceVersion,
          ...(action === 'hide' || action === 'unhide' ? { messageId: finding.messageId } : {}),
          reason,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      await refreshReconciliation();
      if (action === 'hide' || action === 'unhide') {
        const preferredMessageId =
          finding.messageId &&
          (selectedMessage?.id === finding.messageId ||
            messages.some((message) => message.id === finding.messageId))
            ? finding.messageId
            : undefined;
        await refreshMessageManagement(preferredMessageId);
      }
      clearReason(finding.id);
      return `${verb}已完成。`;
    });
  }

  async function refreshMediaCache() {
    const [nextStatus, objectResult] = await Promise.all([
      fetchJson<MediaCacheStatus>('/api/v1/admin/media-cache/status', { cache: 'no-store' }),
      fetchJson<{ items: MediaCacheObject[]; nextCursor: string | null }>(
        '/api/v1/admin/media-cache/objects?limit=20',
        { cache: 'no-store' },
      ),
    ]);
    setMediaCacheStatus(nextStatus);
    setMediaCacheObjects(objectResult.items);
    setMediaCacheNextCursor(objectResult.nextCursor);
  }

  async function refreshMediaCacheAfterSuccess(
    successNotice: string,
    refreshFailureNotice: string,
  ): Promise<void> {
    await publishMediaCacheMutationReceipt({
      refresh: refreshMediaCache,
      refreshFailureNotice,
      setNotice: (notice) => toast.success(notice),
      successNotice,
    });
  }

  async function loadMoreMediaCacheObjects() {
    if (!mediaCacheNextCursor) return;
    await runAction('more-objects', 'cache', async () => {
      const result = await fetchJson<{
        items: MediaCacheObject[];
        nextCursor: string | null;
      }>(
        `/api/v1/admin/media-cache/objects?limit=20&cursor=${encodeURIComponent(mediaCacheNextCursor)}`,
      );
      setMediaCacheObjects((current) => [...current, ...result.items]);
      setMediaCacheNextCursor(result.nextCursor);
      return null;
    });
  }

  async function actOnMediaCacheObject(
    object: MediaCacheObject,
    action: 'evict' | 'retry',
    reason: string,
    page: ActionPage = 'cache',
  ) {
    await runAction(`${object.id}:${action}`, page, async () => {
      const result = await fetchJson<MediaCacheCommandReceipt | { state: 'retry_wait' }>(
        `/api/v1/admin/media-cache/objects/${object.id}/${action}`,
        {
          body: JSON.stringify({ reason }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        },
      );
      clearReason(object.id);
      if (action === 'evict' && 'commandId' in result) {
        await refreshMediaCacheAfterSuccess(
          `驱逐命令已入队（${result.commandId}），将由 worker 执行。`,
          `驱逐命令已入队（${result.commandId}），但状态刷新失败；请稍后手动确认。`,
        );
      } else {
        await refreshMediaCacheAfterSuccess(
          '对象已重新进入缓存队列。',
          '对象已重新进入缓存队列，但状态刷新失败；请稍后手动确认。',
        );
      }
      return null;
    });
  }

  async function protectMediaCacheObject(
    object: MediaCacheObject,
    action: 'protect' | 'unprotect',
    reason: string,
  ) {
    await runAction(`${object.id}:${action}`, 'cache', async () => {
      await fetchJson<object>(`/api/v1/admin/media-cache/objects/${object.id}/${action}`, {
        body: JSON.stringify({ reason }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      clearReason(object.id);
      const successNotice = action === 'protect' ? '对象保护已启用。' : '对象保护已移除。';
      await refreshMediaCacheAfterSuccess(
        successNotice,
        `${successNotice.slice(0, -1)}，但状态刷新失败；请稍后手动确认。`,
      );
      return null;
    });
  }

  async function setMediaCachePolicy(
    object: MediaCacheObject,
    policy: MediaCachePolicy,
    reason: string,
  ) {
    await runAction(`${object.id}:policy`, 'cache', async () => {
      await fetchJson<object>(`/api/v1/admin/media-cache/objects/${object.id}/policy`, {
        body: JSON.stringify({ policy, reason }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      clearReason(object.id);
      const successNotice =
        policy === 'stay_evicted' ? '对象将保持驱逐状态。' : '对象已恢复按访问回填。';
      await refreshMediaCacheAfterSuccess(
        successNotice,
        `${successNotice.slice(0, -1)}，但状态刷新失败；请稍后手动确认。`,
      );
      return null;
    });
  }

  async function copyMediaCacheStorage(
    object: MediaCacheObject | null,
    sourceBackendId: string,
    targetBackendId: string,
    reason: string,
  ) {
    const busyKey = object ? `${object.id}:copy:${targetBackendId}` : 'storage-copy';
    await runAction(busyKey, 'cache', async () => {
      const result = await fetchJson<MediaCacheCommandReceipt>(
        '/api/v1/admin/media-cache/migrate',
        {
          body: JSON.stringify({
            ...(object ? { objectId: object.id } : {}),
            reason,
            sourceBackendId,
            targetBackendId,
          }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        },
      );
      clearReason(object?.id ?? 'storage-copy');
      await refreshMediaCacheAfterSuccess(
        `复制命令已入队（${result.commandId}）。`,
        `复制命令已入队（${result.commandId}），但状态刷新失败；请稍后手动确认。`,
      );
      return null;
    });
  }

  async function restoreMediaCacheObject(
    object: MediaCacheObject,
    targetBackendId: string,
    reason: string,
  ) {
    await runAction(`${object.id}:restore:${targetBackendId}`, 'cache', async () => {
      const result = await fetchJson<MediaCacheCommandReceipt>(
        `/api/v1/admin/media-cache/objects/${object.id}/restore`,
        {
          body: JSON.stringify({ reason, targetBackendId }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        },
      );
      clearReason(object.id);
      await refreshMediaCacheAfterSuccess(
        `恢复命令已入队（${result.commandId}）。`,
        `恢复命令已入队（${result.commandId}），但状态刷新失败；请稍后手动确认。`,
      );
      return null;
    });
  }

  async function pruneMediaCacheStorage(
    action: 'apply' | 'preview',
    targetBackendId: string,
    targetBytes: string,
    reason: string,
  ) {
    await runAction(`storage-prune-${action}`, 'cache', async () => {
      if (action === 'preview') {
        setMediaCachePrunePreview(null);
        const preview = await fetchJson<MediaCachePrunePreview>(
          '/api/v1/admin/media-cache/prune/preview',
          {
            body: JSON.stringify({ targetBackendId, targetBytes }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
          },
        );
        setMediaCachePrunePreview(preview);
        return '整理预览已更新；应用时会重新规划。';
      }
      const result = await fetchJson<MediaCacheCommandReceipt>('/api/v1/admin/media-cache/prune', {
        body: JSON.stringify({ reason, targetBackendId, targetBytes }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      setMediaCachePrunePreview(null);
      clearReason('storage-prune');
      await refreshMediaCacheAfterSuccess(
        `空间整理命令已入队（${result.commandId}）。`,
        `空间整理命令已入队（${result.commandId}），但状态刷新失败；请稍后手动确认。`,
      );
      return null;
    });
  }

  async function reconcileMediaCache(reason: string) {
    await runAction('reconcile', 'cache', async () => {
      const result = await fetchJson<MediaCacheCommandReceipt>(
        '/api/v1/admin/media-cache/reconcile',
        {
          body: JSON.stringify({ reason }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        },
      );
      clearReason('reconcile');
      await refreshMediaCacheAfterSuccess(
        `媒体缓存对账命令已入队（${result.commandId}），worker 会自动完成全部分页。`,
        `媒体缓存对账命令已入队（${result.commandId}），但状态刷新失败；请稍后手动确认。`,
      );
      return null;
    });
  }

  async function signOut() {
    await authClient.signOut();
    await onSessionRevoked('已安全退出。');
  }

  const scopedSelectedMessage = isMessageInChannel(selectedMessage, selectedChannel)
    ? selectedMessage
    : null;

  const desk: Desk = {
    status,
    channels,
    configuredChannels,
    blockedTasks,
    loading,
    findings,
    findingsNextCursor,
    runs,
    mediaCacheStatus,
    mediaCacheObjects,
    mediaCacheNextCursor,
    mediaCachePrunePreview,
    busyAction,
    reasons,
    actionError,
    rerenderResult,
    selectedChannel,
    messages,
    messagesLoading,
    messagesNextCursor,
    messageVisibilityFilter,
    selectedMessage: scopedSelectedMessage,
    raw: scopedSelectedMessage ? raw : null,
    rawLoading,
    onReasonChange,
    onSelectArchiveChannel: selectArchiveChannel,
    onSelectMessage: (message) => {
      messageSelectionVersion.current += 1;
      setSelectedMessage(message);
      setRaw(null);
    },
    onSelectSearchMessage: selectSearchMessage,
    onRevealRaw: revealRaw,
    onMessageVisibility: changeMessageVisibility,
    onLoadMoreMessages: loadMoreMessages,
    onMessageVisibilityFilterChange: changeMessageVisibilityFilter,
    onTaskAction: actOnTask,
    onFindingAction: actOnFinding,
    onLoadMoreFindings: loadMoreFindings,
    onRerender: rerenderOutdated,
    onCacheRetry: (object, reason) => void actOnMediaCacheObject(object, 'retry', reason, 'triage'),
    onChannelToggle: toggleConfiguredChannel,
    onCacheAction: (object, action, reason) => void actOnMediaCacheObject(object, action, reason),
    onCacheProtect: protectMediaCacheObject,
    onCachePolicy: setMediaCachePolicy,
    onCacheCopy: copyMediaCacheStorage,
    onCacheRestore: restoreMediaCacheObject,
    onCacheLoadMore: loadMoreMediaCacheObjects,
    onStorageCopy: (sourceBackendId, targetBackendId, reason) =>
      void copyMediaCacheStorage(null, sourceBackendId, targetBackendId, reason),
    onStoragePrune: pruneMediaCacheStorage,
    onPrunePreviewClear: () => setMediaCachePrunePreview(null),
    onReconcile: reconcileMediaCache,
    onScan: runReconciliationScan,
    onSessionRevoked,
    onSignOut: signOut,
  };

  const deskRoutes = [
    { title: '概览', to: '/' },
    { title: '消息', to: '/messages' },
    { title: '搜索', to: '/search' },
    { title: '频道', to: '/channels' },
    { title: '媒体缓存', to: '/cache' },
    { title: '对账', to: '/reconciliation' },
    { title: '系统', to: '/system' },
    { title: '设置', to: '/settings' },
  ];

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <TopBar
        blockedCount={status ? status.counts.blockedTasks : null}
        collectorState={status?.collector.state ?? null}
        email={status?.owner.email}
        onSignOut={signOut}
        version={status?.version}
      />
      <RouteStrip routes={deskRoutes} />
      <ChannelStrip
        channels={channels}
        onSelect={selectArchiveChannel}
        selectedId={selectedChannel}
      />
      {statusError ? (
        <p className="border-b px-3 py-1.5 text-xs text-destructive" role="alert">
          {statusError}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <Sidebar
          channels={channels}
          onSelect={selectArchiveChannel}
          routes={deskRoutes}
          selectedId={selectedChannel}
        />
        <main className="min-w-0 flex-1 overflow-y-auto" ref={mainRef}>
          {loadError ? (
            <div className="m-3 rounded-lg border p-4" role="alert">
              <p className="text-sm text-destructive">{loadError}</p>
              <Button
                className="mt-3"
                onClick={retryLoad}
                size="sm"
                type="button"
                variant="outline"
              >
                重试
              </Button>
            </div>
          ) : (
            <Outlet context={desk} />
          )}
        </main>
      </div>
    </div>
  );
}

export function App() {
  const session = authClient.useSession();

  async function refreshSession() {
    await session.refetch();
  }

  async function handleSessionRevoked(message: string) {
    toast.success(message);
    await session.refetch();
  }

  if (session.isPending) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <div aria-label="正在读取 session" className="font-serif text-2xl" role="status">
          小
        </div>
      </main>
    );
  }

  return (
    <>
      <Toaster />
      {session.data ? (
        <HashRouter>
          <Routes>
            <Route element={<DeskShell onSessionRevoked={handleSessionRevoked} />}>
              <Route element={<OverviewPage />} index />
              <Route element={<MessagesPage />} path="messages" />
              <Route element={<SearchPage />} path="search" />
              <Route element={<ChannelsPage />} path="channels" />
              <Route element={<CachePage />} path="cache" />
              <Route element={<ReconciliationPage />} path="reconciliation" />
              <Route element={<SystemPage />} path="system" />
              <Route element={<SettingsPage />} path="settings" />
              <Route element={<Navigate replace to="/" />} path="*" />
            </Route>
          </Routes>
        </HashRouter>
      ) : (
        <LoginCard onComplete={refreshSession} />
      )}
    </>
  );
}
