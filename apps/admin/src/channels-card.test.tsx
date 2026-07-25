import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChannelsCard, writeChannelIdToClipboard } from './components/desk/browse/channels';
import { formatChannelId } from './lib/format';
import type { ConfiguredChannel } from './lib/types';

const channel: ConfiguredChannel = {
  disabledAt: null,
  enabled: true,
  telegramChatId: '-1001234567890',
  title: 'cos test dev channel backup',
  username: 'cos_test_dev',
};

function renderCard(channels: ConfiguredChannel[] = [channel]) {
  return renderToStaticMarkup(
    <ChannelsCard busyAction={null} channels={channels} onToggle={vi.fn()} />,
  );
}

describe('ChannelsCard 频道 ID 复制', () => {
  it('shows a recognizable truncated ID and an accessible full-ID copy action', () => {
    const markup = renderCard();

    expect(markup).toContain('ID -1001234…7890');
    expect(markup).not.toContain('ID -1001234567890');
    expect(markup).toContain('复制 cos test dev channel backup 的完整频道 ID');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-atomic="true"');
  });

  it('keeps the title/username row and the toggle switch intact', () => {
    const markup = renderCard();

    expect(markup).toContain('@cos_test_dev');
    expect(markup).toContain('停用 cos test dev channel backup');
  });
});

describe('formatChannelId', () => {
  it('truncates long IDs in the middle', () => {
    expect(formatChannelId('10000000-0000-4000-8000-000000000001')).toBe('10000000…0001');
    expect(formatChannelId('-1001234567890')).toBe('-1001234…7890');
  });

  it('leaves short IDs untouched', () => {
    expect(formatChannelId('-100999')).toBe('-100999');
  });
});

describe('writeChannelIdToClipboard', () => {
  it('copies the full ID rather than its recognizable display form', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    await writeChannelIdToClipboard(channel.telegramChatId, { writeText });

    expect(writeText).toHaveBeenCalledWith('-1001234567890');
  });

  it('exposes clipboard failures to the caller', async () => {
    await expect(
      writeChannelIdToClipboard(channel.telegramChatId, {
        writeText: vi.fn().mockRejectedValue(new Error('permission denied')),
      }),
    ).rejects.toThrow('permission denied');
  });
});
