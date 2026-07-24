import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ReconciliationPanel } from './App';

describe('ReconciliationPanel', () => {
  it('renders category counts, an accessible status, and disables dangerous actions while busy', () => {
    const markup = renderToStaticMarkup(
      <ReconciliationPanel
        busy
        findings={[
          {
            evidenceVersion: 2,
            id: '019bf895-0e70-7881-83b3-471b8dbb1b36',
            kind: 'derived_html_drift',
            messageId: null,
            messageTombstoned: false,
            sanitizedDetails: { reason: 'Rendered HTML differs from durable content' },
            severity: 'error',
            state: 'open',
            telegramChatId: '-1002234260754',
          },
          {
            evidenceVersion: 1,
            id: '019bf895-0e70-7881-83b3-471b8dbb1b37',
            kind: 'derived_html_drift',
            messageId: null,
            messageTombstoned: false,
            sanitizedDetails: {},
            severity: 'warning',
            state: 'resolved',
            telegramChatId: '-1002234260754',
          },
          {
            evidenceVersion: 3,
            id: '019bf895-0e70-7881-83b3-471b8dbb1b38',
            kind: 'desktop_absence_candidate',
            messageId: '019bf895-0e70-7881-83b3-471b8dbb1b39',
            messageTombstoned: false,
            sanitizedDetails: { reason: 'Desktop export did not contain this message' },
            severity: 'warning',
            state: 'open',
            telegramChatId: '-1002234260754',
          },
        ]}
        notice="对账扫描完成"
        nextCursor="019bf895-0e70-7881-83b3-471b8dbb1b40"
        onAction={vi.fn()}
        onLoadMore={vi.fn()}
        onReasonChange={vi.fn()}
        onScan={vi.fn()}
        reasons={{}}
        runs={[]}
      />,
    );

    expect(markup).toContain('aria-label="已加载 Finding 类别统计"');
    expect(markup).toContain('<strong>2</strong> derived_html_drift');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('对账扫描完成');
    expect(markup.match(/disabled=""/g)).toHaveLength(6);
    expect(markup).toContain('placeholder="说明为何修复或忽略"');
    expect(markup).toContain('隐藏并公开返回 404');
    expect(markup).toContain('finding、来源证据与审计记录会继续保留');
    expect(markup).toContain('加载更多 findings');
  });
});
