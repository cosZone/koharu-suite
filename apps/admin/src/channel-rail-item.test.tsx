import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChannelRailItem, formatChannelId, writeChannelIdToClipboard } from './App';

const channel = {
  id: '10000000-0000-4000-8000-000000000001',
  title: 'cos test dev channel backup',
  username: null,
};

describe('ChannelRailItem', () => {
  it('shows a recognizable Suite ID and an accessible full-ID copy action', () => {
    const markup = renderToStaticMarkup(
      <ChannelRailItem channel={channel} onSelect={vi.fn()} selected />,
    );

    expect(markup).toContain('Suite ID 10000000…0001');
    expect(markup).toContain('复制 cos test dev channel backup 的完整 Suite 频道 ID');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-atomic="true"');
  });

  it('copies the full UUID rather than its recognizable display form', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    await writeChannelIdToClipboard(channel.id, { writeText });

    expect(formatChannelId(channel.id)).toBe('10000000…0001');
    expect(writeText).toHaveBeenCalledWith(channel.id);
  });

  it('exposes clipboard failures to the component', async () => {
    await expect(
      writeChannelIdToClipboard(channel.id, {
        writeText: vi.fn().mockRejectedValue(new Error('permission denied')),
      }),
    ).rejects.toThrow('permission denied');
  });
});
