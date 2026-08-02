import type { ReactNode } from 'react';
import { CacheObjectsCard } from '@/components/desk/browse/cache';
import { ChannelsCard } from '@/components/desk/browse/channels';
import { MessageBrowser } from '@/components/desk/browse/messages';
import { ScanCard } from '@/components/desk/browse/scan-card';
import { SecurityCard } from '@/components/desk/browse/security';
import { StorageToolsCard } from '@/components/desk/browse/tools';
import { type ActionPage, useDesk } from '@/components/desk/desk-context';
import { FindingItem } from '@/components/desk/finding-item';
import { LaneEmpty } from '@/components/desk/lane';
import {
  CollectorStatus,
  MediaCacheReadouts,
  ReconciliationBaseline,
  StatsStrip,
} from '@/components/desk/lane-pulse';
import { TriageLane } from '@/components/desk/lane-triage';
import { SearchAndFeedsPanel } from '@/SearchAndFeedsPanel';

function PageHeader({ children, title }: { children?: ReactNode; title: string }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h1 className="font-serif text-lg font-semibold">{title}</h1>
      {children}
    </div>
  );
}

function PageAlert({ page }: { page: ActionPage }) {
  const { actionError } = useDesk();
  if (actionError?.page !== page) return null;
  return (
    <p className="mb-2 rounded-md border px-3 py-2 text-sm text-destructive" role="alert">
      {actionError.message}
    </p>
  );
}

export function OverviewPage() {
  const desk = useDesk();
  return (
    <div className="p-3">
      <PageAlert page="triage" />
      <div className="mb-3 overflow-hidden rounded-lg border">
        <StatsStrip loading={desk.loading} status={desk.status} />
      </div>
      <TriageLane
        blockedTasks={desk.blockedTasks}
        busyAction={desk.busyAction}
        cacheObjects={desk.mediaCacheObjects}
        findings={desk.findings}
        findingsNextCursor={desk.findingsNextCursor}
        loading={desk.loading}
        onCacheRetry={desk.onCacheRetry}
        onFindingAction={desk.onFindingAction}
        onLoadMoreFindings={desk.onLoadMoreFindings}
        onReasonChange={desk.onReasonChange}
        onRerender={desk.onRerender}
        onTaskAction={desk.onTaskAction}
        reasons={desk.reasons}
        rerenderResult={desk.rerenderResult}
        staleRendererRevisions={desk.status?.counts.staleRendererRevisions ?? 0}
      />
    </div>
  );
}

export function MessagesPage() {
  const desk = useDesk();
  return (
    <div className="p-3">
      <PageAlert page="messages" />
      <MessageBrowser
        busyAction={desk.busyAction}
        loading={desk.messagesLoading}
        messageVisibilityFilter={desk.messageVisibilityFilter}
        messages={desk.messages}
        nextCursor={desk.messagesNextCursor}
        onLoadMore={desk.onLoadMoreMessages}
        onMessageVisibility={desk.onMessageVisibility}
        onMessageVisibilityFilterChange={desk.onMessageVisibilityFilterChange}
        onReasonChange={desk.onReasonChange}
        onRevealRaw={desk.onRevealRaw}
        onSelectMessage={desk.onSelectMessage}
        raw={desk.raw}
        rawLoading={desk.rawLoading}
        reason={desk.selectedMessage ? (desk.reasons[desk.selectedMessage.id] ?? '') : ''}
        selectedMessage={desk.selectedMessage}
      />
    </div>
  );
}

export function SearchPage() {
  const desk = useDesk();
  return (
    <div className="p-3">
      <SearchAndFeedsPanel channels={desk.channels} onSelectMessage={desk.onSelectSearchMessage} />
    </div>
  );
}

export function ChannelsPage() {
  const desk = useDesk();
  return (
    <div className="p-3">
      <PageAlert page="channels" />
      <ChannelsCard
        busyAction={desk.busyAction}
        channels={desk.configuredChannels}
        onToggle={desk.onChannelToggle}
      />
    </div>
  );
}

export function CachePage() {
  const desk = useDesk();
  return (
    <div className="p-3">
      <PageAlert page="cache" />
      {desk.mediaCacheStatus ? (
        <div className="grid gap-3">
          <MediaCacheReadouts mediaCacheStatus={desk.mediaCacheStatus} />
          <CacheObjectsCard
            busyAction={desk.busyAction}
            nextCursor={desk.mediaCacheNextCursor}
            objects={desk.mediaCacheObjects}
            onAction={desk.onCacheAction}
            onCopy={desk.onCacheCopy}
            onLoadMore={desk.onCacheLoadMore}
            onPolicy={desk.onCachePolicy}
            onProtect={desk.onCacheProtect}
            onReasonChange={desk.onReasonChange}
            onRestore={desk.onCacheRestore}
            reasons={desk.reasons}
            status={desk.mediaCacheStatus}
          />
          <StorageToolsCard
            busyAction={desk.busyAction}
            onCopy={desk.onStorageCopy}
            onPrune={desk.onStoragePrune}
            onPrunePreviewClear={desk.onPrunePreviewClear}
            onReasonChange={desk.onReasonChange}
            onReconcile={desk.onReconcile}
            prunePreview={desk.mediaCachePrunePreview}
            reasons={desk.reasons}
            status={desk.mediaCacheStatus}
          />
        </div>
      ) : null}
    </div>
  );
}

export function ReconciliationPage() {
  const desk = useDesk();
  return (
    <div className="p-3">
      <PageHeader title="对账" />
      <PageAlert page="reconciliation" />
      <div className="grid gap-3 xl:grid-cols-3">
        <div className="grid content-start gap-2 xl:col-span-2">
          {desk.findings.map((finding) => (
            <FindingItem
              busy={desk.busyAction !== null}
              finding={finding}
              key={finding.id}
              onFindingAction={desk.onFindingAction}
              onReasonChange={desk.onReasonChange}
              reason={desk.reasons[finding.id] ?? ''}
            />
          ))}
          {desk.findings.length === 0 ? (
            <LaneEmpty>尚无 finding。运行扫描以建立当前基线。</LaneEmpty>
          ) : null}
        </div>
        <div className="grid content-start gap-3">
          <ScanCard
            busyAction={desk.busyAction}
            canScan={desk.configuredChannels.length > 0}
            onScan={desk.onScan}
          />
          <ReconciliationBaseline findings={desk.findings} runs={desk.runs} />
        </div>
      </div>
    </div>
  );
}

export function SystemPage() {
  const desk = useDesk();
  return (
    <div className="p-3">
      <PageHeader title="系统状态" />
      {desk.loading ? null : <CollectorStatus status={desk.status} />}
    </div>
  );
}

export function SettingsPage() {
  const desk = useDesk();
  return (
    <div className="max-w-2xl p-3">
      <div className="grid gap-3">
        {desk.status ? (
          <SecurityCard
            enabled={desk.status.owner.twoFactorEnabled}
            onSessionRevoked={desk.onSessionRevoked}
          />
        ) : null}
      </div>
    </div>
  );
}
