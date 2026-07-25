import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { publishMediaCacheMutationReceipt } from './App';
import { CacheObjectsCard } from './components/desk/browse/cache';
import { ScanCard } from './components/desk/browse/scan-card';
import { mediaCachePrunePreviewMatches, StorageToolsCard } from './components/desk/browse/tools';
import { PulseLane } from './components/desk/lane-pulse';

const basicStatus = {
  commands: [
    {
      completedAt: null,
      createdAt: '2026-07-24T08:00:00.000Z',
      errorCode: null,
      id: '50000000-0000-4000-8000-000000000001',
      operation: 'reconcile' as const,
      result: null,
      state: 'pending' as const,
      updatedAt: '2026-07-24T08:00:00.000Z',
    },
  ],
  enabled: true,
  failures: [
    {
      lastErrorClass: 'upstream',
      lastErrorCode: 'download_failed',
      objectId: '10000000-0000-4000-8000-000000000002',
      planId: '40000000-0000-4000-8000-000000000002',
      reasonCode: null,
      state: 'blocked',
      updatedAt: '2026-07-24T08:00:00.000Z',
      variant: 'original' as const,
    },
  ],
  stateCounts: {
    blobs: [{ count: 1, state: 'ready' }],
    objects: [
      { count: 1, state: 'blocked' },
      { count: 1, state: 'ready' },
    ],
    plans: [
      { count: 1, state: 'blocked' },
      { count: 1, state: 'ready' },
    ],
  },
  usage: {
    lastReconciledAt: null,
    maxBytes: '5368709120',
    readyBytes: '1048576',
    reservedBytes: '2097152',
    updatedAt: '2026-07-24T08:00:00.000Z',
  },
};

const basicObjects = [
  {
    actualBytes: '1048576',
    canonicalMediaId: '20000000-0000-4000-8000-000000000001',
    declaredBytes: '1048576',
    id: '10000000-0000-4000-8000-000000000001',
    kind: 'photo',
    messageId: '30000000-0000-4000-8000-000000000001',
    planId: '40000000-0000-4000-8000-000000000001',
    planState: 'ready',
    reasonCode: null,
    state: 'ready',
    updatedAt: '2026-07-24T08:00:00.000Z',
    variant: 'original' as const,
  },
  {
    actualBytes: null,
    canonicalMediaId: '20000000-0000-4000-8000-000000000002',
    declaredBytes: '2097152',
    id: '10000000-0000-4000-8000-000000000002',
    kind: 'video',
    messageId: '30000000-0000-4000-8000-000000000002',
    planId: '40000000-0000-4000-8000-000000000002',
    planState: 'blocked',
    reasonCode: 'upstream_unavailable',
    state: 'blocked',
    updatedAt: '2026-07-24T08:00:00.000Z',
    variant: 'original' as const,
  },
  {
    actualBytes: null,
    canonicalMediaId: '20000000-0000-4000-8000-000000000003',
    declaredBytes: '1024',
    id: '10000000-0000-4000-8000-000000000003',
    kind: 'photo',
    messageId: '30000000-0000-4000-8000-000000000003',
    planId: '40000000-0000-4000-8000-000000000003',
    planState: 'blocked',
    reasonCode: 'integrity_conflict',
    state: 'integrity_conflict',
    updatedAt: '2026-07-24T08:00:00.000Z',
    variant: 'original' as const,
  },
];

const tieredStatus = {
  backends: [
    {
      ...({
        bucket: 'bucket-secret',
        endpoint: 'https://storage-secret.example',
      } as Record<string, string>),
      enabled: true,
      id: 'local',
      kind: 'local' as const,
      label: 'Local hot tier',
      lastReconciledAt: null,
      locationStateCounts: [{ count: 1, state: 'ready' }],
      maxBytes: '5368709120',
      readPriority: 10,
      readable: true,
      readyBytes: '3145728',
      updatedAt: '2026-07-24T08:00:00.000Z',
      writable: true,
      writePriority: 20,
    },
    {
      enabled: true,
      id: 's3-default',
      kind: 's3' as const,
      label: 'S3 durable tier',
      lastReconciledAt: null,
      locationStateCounts: [{ count: 1, state: 'missing' }],
      maxBytes: '10737418240',
      readPriority: 20,
      readable: true,
      readyBytes: '0',
      updatedAt: '2026-07-24T08:00:00.000Z',
      writable: true,
      writePriority: 10,
    },
  ],
  commands: [
    {
      completedAt: null,
      createdAt: '2026-07-24T08:00:00.000Z',
      errorCode: null,
      id: 'safe-command-id',
      operation: 'migrate' as const,
      result: null,
      sourceBackendId: 'local',
      state: 'pending' as const,
      targetBackendId: 's3-default',
      targetBytes: null,
      updatedAt: '2026-07-24T08:00:00.000Z',
    },
  ],
  enabled: true,
  failures: [],
  stateCounts: {
    blobs: [{ count: 1, state: 'ready' }],
    objects: [{ count: 1, state: 'ready' }],
    plans: [{ count: 1, state: 'ready' }],
  },
  usage: {
    lastReconciledAt: null,
    maxBytes: '5368709120',
    readyBytes: '3145728',
    reservedBytes: '0',
    updatedAt: '2026-07-24T08:00:00.000Z',
  },
};

const protectedObject = {
  actualBytes: '1048576',
  canonicalMediaId: '20000000-0000-4000-8000-000000000001',
  declaredBytes: '1048576',
  evictedPolicy: 'stay_evicted' as const,
  id: '10000000-0000-4000-8000-000000000001',
  kind: 'photo',
  locations: [
    {
      backendId: 'local',
      lastAccessedAt: '2026-07-24T08:00:00.000Z',
      state: 'ready' as const,
      updatedAt: '2026-07-24T08:00:00.000Z',
      verifiedAt: '2026-07-24T08:00:00.000Z',
      verifiedBytes: '1048576',
    },
    {
      backendId: 's3-default',
      lastAccessedAt: '2026-07-24T08:00:00.000Z',
      ...({
        etag: 'secret-etag',
        storageKey: 'blobs/secret',
      } as Record<string, string>),
      state: 'missing' as const,
      updatedAt: '2026-07-24T08:00:00.000Z',
      verifiedAt: null,
      verifiedBytes: null,
    },
  ],
  messageId: '30000000-0000-4000-8000-000000000001',
  planId: '40000000-0000-4000-8000-000000000001',
  planState: 'ready',
  protection: {
    active: true,
    expired: false,
    expiresAt: null,
    protectedAt: '2026-07-24T08:00:00.000Z',
    updatedAt: '2026-07-24T08:00:00.000Z',
  },
  reasonCode: null,
  state: 'ready',
  updatedAt: '2026-07-24T08:00:00.000Z',
  variant: 'original' as const,
};

function renderCacheObjects(overrides: Partial<Parameters<typeof CacheObjectsCard>[0]> = {}) {
  return renderToStaticMarkup(
    <CacheObjectsCard
      busyAction={null}
      nextCursor="next-page"
      objects={basicObjects}
      onAction={vi.fn()}
      onCopy={vi.fn()}
      onLoadMore={vi.fn()}
      onPolicy={vi.fn()}
      onProtect={vi.fn()}
      onReasonChange={vi.fn()}
      onRestore={vi.fn()}
      reasons={{}}
      status={basicStatus}
      {...overrides}
    />,
  );
}

describe('PulseLane media cache readouts', () => {
  it('shows bounded usage, sanitized failures, and recent commands', () => {
    const markup = renderToStaticMarkup(
      <PulseLane
        findings={[]}
        loading={false}
        mediaCacheStatus={basicStatus}
        runs={[]}
        status={null}
      />,
    );

    expect(markup).toContain('aria-label="媒体缓存容量"');
    expect(markup).toContain('5.00 GiB');
    expect(markup).toContain('download_failed');
    expect(markup).toContain('最近的维护命令');
    expect(markup).toContain('reconcile · pending');
    expect(markup).not.toContain('telegramFileId');
    expect(markup).not.toContain('blobs/');
  });

  it('shows storage tiers without leaking backend secrets', () => {
    const markup = renderToStaticMarkup(
      <PulseLane
        findings={[]}
        loading={false}
        mediaCacheStatus={tieredStatus}
        runs={[]}
        status={null}
      />,
    );

    expect(markup).toContain('存储后端');
    expect(markup).toContain('Local hot tier');
    expect(markup).toContain('S3 durable tier');
    expect(markup).toContain('migrate · pending · local → s3-default');
    expect(markup).not.toContain('https://storage-secret.example');
    expect(markup).not.toContain('bucket-secret');
  });
});

describe('CacheObjectsCard', () => {
  it('renders object state and reason-gated owner actions', () => {
    const markup = renderCacheObjects();

    expect(markup).toContain('驱逐本地副本');
    expect(markup).toContain('integrity_conflict');
    expect(markup.match(/>重试<\/button>/g)).toHaveLength(2);
    expect(markup).toContain('加载更多缓存对象');
    // reason 全空 → 2 个重试 + 1 个驱逐全部 disabled
    expect(markup.match(/disabled=""/g)).toHaveLength(3);
    expect(markup).not.toContain('telegramFileId');
    expect(markup).not.toContain('blobs/');
  });

  it('hides eviction for protected objects and shows location state safely', () => {
    const markup = renderCacheObjects({
      nextCursor: null,
      objects: [protectedObject],
      reasons: { '10000000-0000-4000-8000-000000000001': 'maintenance' },
      status: tieredStatus,
    });

    expect(markup).toContain('local: ready');
    expect(markup).toContain('s3-default: missing');
    expect(markup).toContain('长期保护');
    expect(markup).toContain('保持驱逐');
    expect(markup).toContain('移除保护');
    expect(markup).toContain('恢复到 S3 durable tier');
    expect(markup).not.toContain('驱逐本地副本');
    expect(markup).not.toContain('blobs/secret');
    expect(markup).not.toContain('secret-etag');
  });
});

describe('StorageToolsCard', () => {
  it('keeps prune apply gated behind a matching zero-write preview', () => {
    const markup = renderToStaticMarkup(
      <StorageToolsCard
        busyAction={null}
        onCopy={vi.fn()}
        onPrune={vi.fn()}
        onPrunePreviewClear={vi.fn()}
        onReasonChange={vi.fn()}
        onReconcile={vi.fn()}
        prunePreview={{
          candidates: 2,
          hasMore: false,
          projectedReadyBytes: '1048576',
          readyBytes: '3145728',
          removableBytes: '2097152',
          targetBackendId: 'local',
          targetBytes: '1048576',
        }}
        reasons={{ 'storage-prune': 'release local hot-tier space' }}
        status={tieredStatus}
      />,
    );

    expect(markup).toContain('批量复制');
    expect(markup).toContain('按账本顺序复制一个有界批次；源位置会保留。');
    expect(markup).toContain('预览严格零写；应用时会基于最新账本重新规划，结果可能变化。');
    expect(markup).toContain('aria-label="整理预览"');
    expect(markup).toContain('>local</dd>');
    expect(markup).toContain('>1.00 MiB</dd>');
    expect(markup).toContain('2.00 MiB');
    // 预览目标(1.00 MiB)与默认目标字节数(后端 readyBytes 3.00 MiB)不一致 → 禁用
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>应用重新规划<\/button>/);
    expect(markup).toContain('运行媒体缓存对账');
    expect(markup).not.toContain('bucket-secret');
  });
});

describe('ScanCard', () => {
  it('offers the reconciliation scan with the desktop-export hint', () => {
    const markup = renderToStaticMarkup(<ScanCard busyAction={null} canScan onScan={vi.fn()} />);

    expect(markup).toContain('运行安全扫描');
    expect(markup).toContain('需要历史补洞时，请导出 Telegram Desktop JSON 后重新扫描。');

    const disabled = renderToStaticMarkup(
      <ScanCard busyAction={null} canScan={false} onScan={vi.fn()} />,
    );
    expect(disabled).toMatch(/<button[^>]*disabled=""[^>]*>运行安全扫描<\/button>/);
  });
});

describe('mediaCachePrunePreviewMatches', () => {
  it('invalidates apply when the preview belongs to different prune inputs', () => {
    const preview = {
      candidates: 2,
      hasMore: false,
      projectedReadyBytes: '1048576',
      readyBytes: '3145728',
      removableBytes: '2097152',
      targetBackendId: 'local',
      targetBytes: '1048576',
    };

    expect(mediaCachePrunePreviewMatches(preview, 'local', '1048576')).toBe(true);
    expect(mediaCachePrunePreviewMatches(preview, 's3-default', '1048576')).toBe(false);
    expect(mediaCachePrunePreviewMatches(preview, 'local', '2097152')).toBe(false);
    expect(mediaCachePrunePreviewMatches(null, 'local', '1048576')).toBe(false);
  });
});

describe('publishMediaCacheMutationReceipt', () => {
  it('publishes a durable receipt before a best-effort refresh and never rejects on refresh failure', async () => {
    const notices: string[] = [];

    await expect(
      publishMediaCacheMutationReceipt({
        async refresh() {
          expect(notices).toEqual(['复制命令已入队（command-1）。']);
          throw new Error('status unavailable');
        },
        refreshFailureNotice: '复制命令已入队（command-1），但状态刷新失败；请稍后手动确认。',
        setNotice(notice) {
          notices.push(notice);
        },
        successNotice: '复制命令已入队（command-1）。',
      }),
    ).resolves.toBeUndefined();
    expect(notices).toEqual([
      '复制命令已入队（command-1）。',
      '复制命令已入队（command-1），但状态刷新失败；请稍后手动确认。',
    ]);
  });
});
