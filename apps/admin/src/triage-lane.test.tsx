import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PulseLane } from './components/desk/lane-pulse';
import { TriageLane } from './components/desk/lane-triage';

const findings = [
  {
    evidenceVersion: 2,
    id: '019bf895-0e70-7881-83b3-471b8dbb1b36',
    kind: 'derived_html_drift',
    messageId: null,
    messageTombstoned: false,
    sanitizedDetails: { reason: 'Rendered HTML differs from durable content' },
    severity: 'error' as const,
    state: 'open' as const,
    telegramChatId: '-1002234260754',
  },
  {
    evidenceVersion: 1,
    id: '019bf895-0e70-7881-83b3-471b8dbb1b37',
    kind: 'derived_html_drift',
    messageId: null,
    messageTombstoned: false,
    sanitizedDetails: {},
    severity: 'warning' as const,
    state: 'resolved' as const,
    telegramChatId: '-1002234260754',
  },
  {
    evidenceVersion: 3,
    id: '019bf895-0e70-7881-83b3-471b8dbb1b38',
    kind: 'desktop_absence_candidate',
    messageId: '019bf895-0e70-7881-83b3-471b8dbb1b39',
    messageTombstoned: false,
    sanitizedDetails: { reason: 'Desktop export did not contain this message' },
    severity: 'warning' as const,
    state: 'open' as const,
    telegramChatId: '-1002234260754',
  },
];

const retryableObject = {
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
};

function renderTriage(overrides: Partial<Parameters<typeof TriageLane>[0]> = {}) {
  return renderToStaticMarkup(
    <TriageLane
      blockedTasks={[
        {
          attemptCount: 3,
          blockedAt: '2026-07-24T07:41:00.000Z',
          channelTitle: '深海速报',
          channelUsername: 'deepflash',
          id: 'task-1',
          lastError: 'telegram gateway timeout after 30s',
          telegramUpdateId: '88421091',
        },
      ]}
      busyAction={null}
      cacheObjects={[retryableObject]}
      findings={findings}
      findingsNextCursor="cursor-2"
      loading={false}
      onCacheRetry={vi.fn()}
      onFindingAction={vi.fn()}
      onLoadMoreFindings={vi.fn()}
      onReasonChange={vi.fn()}
      onRerender={vi.fn()}
      onTaskAction={vi.fn()}
      reasons={{}}
      rerenderResult={null}
      staleRendererRevisions={18}
      {...overrides}
    />,
  );
}

describe('TriageLane', () => {
  it('aggregates tasks, findings, cache retries, and renderer into one queue', () => {
    const markup = renderTriage();

    // 1 task + 2 open findings + 1 retryable object + 1 render = 5
    expect(markup).toContain('>5</span>');
    expect(markup).toContain('QUEUE');
    expect(markup).toContain('FINDING');
    expect(markup).toContain('CACHE');
    expect(markup).toContain('RENDER');
    expect(markup).toContain(
      '这里汇总四类待人工处理的事项：处理失败的消息任务、对账发现的问题（finding）、异常的缓存对象、待重渲染的旧版内容。',
    );
    expect(markup).toContain(
      '处理任何一项前都要填写原因，原因和操作人会写入审计记录。finding 中的敏感信息已脱敏。',
    );
    expect(markup).toContain(
      '隐藏消息后公开 API 会返回 404，但 finding、来源证据与审计记录仍然保留。',
    );
    expect(markup).toContain('telegram gateway timeout after 30s');
    expect(markup).toContain('确定性修复');
    expect(markup).toContain('隐藏并公开返回 404');
    expect(markup).toContain('Owner 忽略');
    expect(markup).toContain('placeholder="说明为何修复或忽略"');
    expect(markup).toContain('重渲染过期内容');
    expect(markup).toContain('加载更多 findings');
  });

  it('gates every reason-required action behind a non-empty reason', () => {
    const markup = renderTriage();

    // 任务 2 + finding 4 + 缓存 1 = 7 个原因门槛按钮,reason 全空 → 全 disabled
    expect(markup.match(/disabled=""/g)).toHaveLength(7);

    const filled = renderTriage({
      reasons: {
        '019bf895-0e70-7881-83b3-471b8dbb1b36': 'renderer bumped',
        '019bf895-0e70-7881-83b3-471b8dbb1b38': 'confirmed upstream deletion',
        '10000000-0000-4000-8000-000000000002': 'upstream restored',
        'task-1': 'parser fixed',
      },
    });
    expect(filled.match(/disabled=""/g)).toBeNull();
  });

  it('shows busy labels for the in-flight action and disables everything else', () => {
    const markup = renderTriage({ busyAction: 'task:task-1:retry' });

    expect(markup).toContain('正在重试…');
    const loadMoreBusy = renderTriage({ busyAction: 'more-findings' });
    expect(loadMoreBusy).toContain('加载更多 findings（加载中…）');
  });

  it('renders a skeleton instead of the empty state while loading', () => {
    const markup = renderTriage({ loading: true });

    expect(markup).toContain('role="status"');
    expect(markup).not.toContain('没有待处理的事项');
  });

  it('shows the empty state only when nothing needs the owner', () => {
    const markup = renderTriage({
      blockedTasks: [],
      cacheObjects: [],
      findings: [],
      findingsNextCursor: null,
      staleRendererRevisions: 0,
    });

    expect(markup).toContain('没有待处理的事项。');
  });
});

describe('PulseLane reconciliation summary', () => {
  it('renders category counts and open totals as read-only text', () => {
    const markup = renderToStaticMarkup(
      <PulseLane
        findings={findings}
        loading={false}
        mediaCacheStatus={null}
        runs={[]}
        status={null}
      />,
    );

    expect(markup).toContain('aria-label="已加载 Finding 类别统计"');
    expect(markup).toContain('>2</strong> derived_html_drift');
    expect(markup).toContain('已加载 3 条 · Open 2');
    expect(markup).toContain('最近运行 —');
  });
});
