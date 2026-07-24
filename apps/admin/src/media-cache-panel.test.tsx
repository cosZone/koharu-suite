import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MediaCachePanel } from './App';

describe('MediaCachePanel', () => {
  it('shows bounded usage, sanitized failures, object state, and reason-gated owner actions', () => {
    const markup = renderToStaticMarkup(
      <MediaCachePanel
        busyAction={null}
        nextCursor="next-page"
        notice="媒体缓存对账完成。"
        objects={[
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
            variant: 'original',
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
            variant: 'original',
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
            variant: 'original',
          },
        ]}
        onAction={vi.fn()}
        onLoadMore={vi.fn()}
        onReasonChange={vi.fn()}
        onReconcile={vi.fn()}
        reasons={{}}
        status={{
          commands: [
            {
              completedAt: null,
              createdAt: '2026-07-24T08:00:00.000Z',
              errorCode: null,
              id: '50000000-0000-4000-8000-000000000001',
              operation: 'reconcile',
              result: null,
              state: 'pending',
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
              variant: 'original',
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
        }}
      />,
    );

    expect(markup).toContain('aria-labelledby="media-cache-title"');
    expect(markup).toContain('aria-label="媒体缓存容量"');
    expect(markup).toContain('5.00 GiB');
    expect(markup).toContain('download_failed');
    expect(markup).toContain('最近的维护命令');
    expect(markup).toContain('reconcile · pending');
    expect(markup).toContain('驱逐本地副本');
    expect(markup.match(/>重试<\/button>/g)).toHaveLength(2);
    expect(markup).toContain('integrity_conflict');
    expect(markup).toContain('加载更多缓存对象');
    expect(markup).toContain('role="status"');
    expect(markup.match(/disabled=""/g)).toHaveLength(4);
    expect(markup).not.toContain('telegramFileId');
    expect(markup).not.toContain('blobs/');
  });
});
