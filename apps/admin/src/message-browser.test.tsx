import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  ApiRequestError,
  completeSearchSelection,
  fetchJson,
  hydrateManagedMessage,
  isMessageInChannel,
  MessageLoadingOwner,
  MessageRequestGuard,
  recoverMessageVisibilityConflict,
  resolveRefreshedMessageSelection,
  SEARCH_MESSAGE_LOAD_ERROR,
} from './App';
import { MessageBrowser } from './components/desk/browse/messages';
import type { Message } from './lib/types';

const message: Message = {
  authorSignature: null,
  channel: { id: 'channel-id', title: 'Test channel', username: 'test' },
  content: { html: null, kind: 'text', text: 'hello' },
  id: 'message-id',
  media: [],
  publishedAt: '2026-08-02T00:20:00.000Z',
  revision: 1,
  sourceUrl: 'https://t.me/test/1',
  tombstoned: true,
  updatedAt: '2026-08-02T00:21:00.000Z',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function render(overrides: Partial<Parameters<typeof MessageBrowser>[0]> = {}) {
  return renderToStaticMarkup(
    <MessageBrowser
      busyAction={null}
      loading={false}
      messageVisibilityFilter="all"
      messages={[message]}
      nextCursor={null}
      onLoadMore={vi.fn()}
      onMessageVisibility={vi.fn()}
      onMessageVisibilityFilterChange={vi.fn()}
      onReasonChange={vi.fn()}
      onRevealRaw={vi.fn()}
      onSelectMessage={vi.fn()}
      raw={null}
      rawLoading={false}
      reason=""
      selectedMessage={message}
      {...overrides}
    />,
  );
}

describe('MessageBrowser visibility management', () => {
  it('keeps hidden messages selectable and offers an audited restore action', () => {
    const markup = render();

    expect(markup).toContain('已隐藏 · 公开访问返回 404');
    expect(markup).toContain('恢复公开访问');
    expect(markup).toContain('说明为何恢复公开');
    expect(markup).toContain('disabled=""');
  });

  it('requires a reason and confirms hiding without claiming Telegram deletion', () => {
    const visible = { ...message, tombstoned: false };
    const markup = render({
      messages: [visible],
      reason: 'not for public archive',
      selectedMessage: visible,
    });

    expect(markup).toContain('隐藏消息');
    expect(markup).toContain('不会回写 Telegram');
    expect(markup).not.toContain('disabled=""');
  });

  it('offers a hidden-only recovery filter and keyset pagination control', () => {
    const markup = render({ messageVisibilityFilter: 'hidden', nextCursor: 'cursor-2' });

    expect(markup).toContain('仅看已隐藏');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('加载更多消息');
  });

  it('distinguishes filtered empty states from an empty archive', () => {
    expect(
      render({ messageVisibilityFilter: 'hidden', messages: [], selectedMessage: null }),
    ).toContain('这个频道没有已隐藏的消息。');
    expect(
      render({ messageVisibilityFilter: 'visible', messages: [], selectedMessage: null }),
    ).toContain('这个频道没有公开消息。');
  });

  it('disables visibility controls while a channel scope is loading', () => {
    const markup = render({ loading: true, reason: 'valid owner reason' });

    expect(markup).toContain('disabled="" maxLength="500"');
    expect(markup).toContain('正在加载');
  });
});

describe('message management request recovery', () => {
  it('preserves HTTP status and API error code for typed conflict handling', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: { code: 'message_visibility_conflict', message: 'stale message' } },
          { status: 409 },
        ),
      ),
    );

    const error = await fetchJson('/api/v1/admin/messages/message-id/hide').catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ code: 'message_visibility_conflict', status: 409 });
    vi.unstubAllGlobals();
  });

  it('refreshes exactly once on a visibility conflict without retrying the mutation', async () => {
    const refresh = vi.fn(async () => undefined);
    const recovered = await recoverMessageVisibilityConflict(
      new ApiRequestError('stale message', 409, 'message_visibility_conflict'),
      message.id,
      refresh,
    );

    expect(recovered).toBe(true);
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(message.id);
    await expect(
      recoverMessageVisibilityConflict(new Error('network failed'), message.id, refresh),
    ).resolves.toBe(false);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('hydrates a public search selection with the same managed message identity', () => {
    const { tombstoned: _tombstoned, updatedAt: _updatedAt, ...publicSelection } = message;
    expect(hydrateManagedMessage(publicSelection, [message])).toEqual(message);
  });

  it('opens message management only after the exact managed message has loaded', async () => {
    const load = deferred<Message>();
    const navigate = vi.fn();
    const reportError = vi.fn();
    const select = vi.fn();

    const selection = completeSearchSelection({
      isCurrent: () => true,
      load: () => load.promise,
      navigate,
      reportError,
      select,
    });

    expect(select).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    load.resolve(message);

    await expect(selection).resolves.toBe(true);
    expect(select).toHaveBeenCalledWith(message);
    expect(navigate).toHaveBeenCalledWith('/messages');
    expect(reportError).not.toHaveBeenCalled();
  });

  it('reports an exact search hydration failure without leaving the search page', async () => {
    const load = deferred<Message>();
    const navigate = vi.fn();
    const reportError = vi.fn();
    const select = vi.fn();
    const selection = completeSearchSelection({
      isCurrent: () => true,
      load: () => load.promise,
      navigate,
      reportError,
      select,
    });

    load.reject(new Error('network failed'));

    await expect(selection).resolves.toBe(false);
    expect(reportError).toHaveBeenCalledWith(SEARCH_MESSAGE_LOAD_ERROR);
    expect(select).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('ignores exact search hydration after the user leaves the search route', async () => {
    const load = deferred<Message>();
    const navigate = vi.fn();
    const reportError = vi.fn();
    const select = vi.fn();
    let pathname = '/search';
    const selectionPath = pathname;
    const selection = completeSearchSelection({
      isCurrent: () => pathname === selectionPath,
      load: () => load.promise,
      navigate,
      reportError,
      select,
    });

    pathname = '/settings';
    load.resolve(message);

    await expect(selection).resolves.toBe(false);
    expect(select).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it('does not let a stale channel request overwrite the current message view', async () => {
    const guard = new MessageRequestGuard();
    const channelA = deferred<Message[]>();
    const apply = vi.fn();
    const channelAToken = guard.begin('channel-a:all');
    const channelARequest = channelA.promise.then((items) => {
      if (guard.isCurrent(channelAToken)) apply(items);
    });

    guard.begin('channel-b:hidden');
    channelA.resolve([message]);
    await channelARequest;

    expect(apply).not.toHaveBeenCalled();
  });

  it('keeps selection B when mutation A refresh completes in the same scope', async () => {
    const messageB: Message = {
      ...message,
      content: { ...message.content, text: 'message B' },
      id: 'message-b',
    };
    const refreshed = deferred<Message[]>();
    let selectionVersion = 1;
    const operationSelectionVersion = selectionVersion;
    let currentSelection: Message | null = message;
    const refresh = refreshed.promise.then((items) => {
      currentSelection = resolveRefreshedMessageSelection({
        current: currentSelection,
        items,
        preferred: message,
        preferRequested: selectionVersion === operationSelectionVersion,
      });
    });

    selectionVersion += 1;
    currentSelection = messageB;
    refreshed.resolve([message, messageB]);
    await refresh;

    expect(currentSelection).toEqual(messageB);
  });

  it('lets only the current scope request clear the loading state', async () => {
    const owner = new MessageLoadingOwner();
    const channelA = deferred<void>();
    const channelB = deferred<void>();
    let loading = true;
    const tokenA = owner.begin('channel-a:all');
    const requestA = channelA.promise.finally(() => {
      if (owner.isCurrent(tokenA)) loading = false;
    });
    const tokenB = owner.begin('channel-b:hidden');
    const requestB = channelB.promise.finally(() => {
      if (owner.isCurrent(tokenB)) loading = false;
    });

    channelA.resolve();
    await requestA;
    expect(loading).toBe(true);

    channelB.resolve();
    await requestB;
    expect(loading).toBe(false);
  });

  it('rejects visibility management for a message from a different channel scope', () => {
    expect(isMessageInChannel(message, message.channel.id)).toBe(true);
    expect(isMessageInChannel(message, 'other-channel')).toBe(false);
    expect(isMessageInChannel(null, message.channel.id)).toBe(false);
  });
});
