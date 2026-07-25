import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { ChannelStrip, RouteStrip, Sidebar, TopBar } from '@/components/desk/frame';
import { StatsStrip } from '@/components/desk/lane-pulse';
import { TriageLane } from '@/components/desk/lane-triage';
import type {
  AdminStatus,
  BlockedTask,
  MediaCacheObject,
  ReconciliationFinding,
} from '@/lib/types';
import './index.css';

/* 开发预览:mock 数据渲染真实壳层与概览页组件,仅供本地视觉核验 */

const channels = [
  { id: 'ch-1', title: '深海速报', username: 'deepflash' },
  { id: 'ch-2', title: '产品周报', username: 'productweekly' },
  { id: 'ch-3', title: '未命名频道', username: null },
];

const status: AdminStatus = {
  collector: {
    heartbeatAt: '2026-07-24T08:20:00.000Z',
    lastTelegramSuccessAt: '2026-07-24T08:20:00.000Z',
    startedAt: '2026-07-24T00:00:00.000Z',
    state: 'running',
    version: '0.9.2',
  },
  counts: {
    activeChannels: 2,
    blockedTasks: 2,
    configuredChannels: 3,
    messages: 12847,
    pendingTasks: 1,
    retryingTasks: 0,
    skippedTasks: 5,
    staleRendererRevisions: 18,
    updates: 15203,
  },
  lastCheckpoint: '2026-07-24T08:20:00.000Z',
  owner: { email: 'owner@example.com', twoFactorEnabled: false },
  version: '0.9.2',
};

const blockedTasks: BlockedTask[] = [
  {
    attemptCount: 3,
    blockedAt: '2026-07-24T07:41:00.000Z',
    channelTitle: '深海速报',
    channelUsername: 'deepflash',
    id: 'task-1',
    lastError: 'telegram gateway timeout after 30s',
    telegramUpdateId: '88421091',
  },
  {
    attemptCount: 2,
    blockedAt: '2026-07-24T03:17:00.000Z',
    channelTitle: '产品周报',
    channelUsername: 'productweekly',
    id: 'task-2',
    lastError: null,
    telegramUpdateId: '88420977',
  },
];

const findings: ReconciliationFinding[] = [
  {
    evidenceVersion: 3,
    id: 'f-1',
    kind: 'derived_html_drift',
    messageId: null,
    messageTombstoned: false,
    sanitizedDetails: { reason: '当前修订 HTML 与 renderer v4 输出不一致' },
    severity: 'warning',
    state: 'open',
    telegramChatId: '-1001234567890',
  },
  {
    evidenceVersion: 1,
    id: 'f-2',
    kind: 'desktop_absence_candidate',
    messageId: 'm-1',
    messageTombstoned: false,
    sanitizedDetails: { reason: 'Desktop 导出中不存在,疑似上游已删除' },
    severity: 'warning',
    state: 'open',
    telegramChatId: '-1001234567890',
  },
];

const cacheObjects: MediaCacheObject[] = [
  {
    actualBytes: null,
    canonicalMediaId: 'cm-1',
    declaredBytes: '2097152',
    id: 'obj-1',
    kind: 'video',
    messageId: 'm-1',
    planId: 'p-1',
    planState: 'blocked',
    reasonCode: 'integrity_conflict',
    state: 'integrity_conflict',
    updatedAt: '2026-07-24T08:00:00.000Z',
    variant: 'original',
  },
];

const root = document.getElementById('root');

if (!root) {
  throw new Error('Missing #root element');
}

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

createRoot(root).render(
  <StrictMode>
    <HashRouter>
      <div className="flex h-dvh flex-col overflow-hidden">
        <TopBar
          blockedCount={2}
          collectorState="running"
          email="owner@example.com"
          onSignOut={() => {}}
          version="0.9.2"
        />
        <RouteStrip routes={deskRoutes} />
        <ChannelStrip
          channels={channels}
          onSelect={() => {}}
          selectedId={channels[0]?.id ?? null}
        />
        <div className="flex min-h-0 flex-1">
          <Sidebar
            channels={channels}
            onSelect={() => {}}
            routes={deskRoutes}
            selectedId={channels[0]?.id ?? null}
          />
          <main className="min-w-0 flex-1 overflow-y-auto">
            <div className="p-3">
              <div className="mb-3 overflow-hidden rounded-lg border">
                <StatsStrip loading={false} status={status} />
              </div>
              <TriageLane
                blockedTasks={blockedTasks}
                busyAction={null}
                cacheObjects={cacheObjects}
                findings={findings}
                findingsNextCursor="cursor-2"
                loading={false}
                onCacheRetry={() => {}}
                onFindingAction={() => {}}
                onLoadMoreFindings={() => {}}
                onReasonChange={() => {}}
                onRerender={() => {}}
                onTaskAction={() => {}}
                reasons={{}}
                rerenderResult={null}
                staleRendererRevisions={18}
              />
            </div>
          </main>
        </div>
      </div>
    </HashRouter>
  </StrictMode>,
);
