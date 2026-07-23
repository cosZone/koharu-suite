import { twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { type FormEvent, useEffect, useState } from 'react';

const authClient = createAuthClient({
  plugins: [twoFactorClient()],
});

interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

interface Channel {
  id: string;
  title: string;
  username: string | null;
}

interface ConfiguredChannel {
  disabledAt: string | null;
  enabled: boolean;
  telegramChatId: string;
  title: string;
  username: string | null;
}

interface BlockedTask {
  attemptCount: number;
  blockedAt: string;
  channelTitle: string;
  channelUsername: string | null;
  id: string;
  lastError: string | null;
  telegramUpdateId: string;
}

interface Message {
  authorSignature: string | null;
  channel: Channel;
  content: {
    kind: 'caption' | 'none' | 'text';
    text: string | null;
  };
  id: string;
  media: Array<{ fileName: string | null; kind: string }>;
  publishedAt: string;
  revision: number;
  sourceUrl: string | null;
}

interface AdminStatus {
  collector: 'running' | 'stopped';
  counts: {
    activeChannels: number;
    blockedTasks: number;
    configuredChannels: number;
    messages: number;
    pendingTasks: number;
    retryingTasks: number;
    skippedTasks: number;
    staleRendererRevisions: number;
    updates: number;
  };
  lastCheckpoint: string | null;
  owner: {
    email: string;
    twoFactorEnabled: boolean;
  };
  version: string;
}

interface TotpSetup {
  backupCodes: string[];
  secret: string;
  totpURI: string;
}

interface RerenderResult {
  currentVersion: number;
  hasMore: boolean;
  updated: number;
}

type AuthStep = 'login' | 'two-factor';
type VerifyMethod = 'recovery' | 'totp';

async function fetchJson<T extends object>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const body = (await response.json()) as T | ApiError;

  if (!response.ok) {
    const message = 'error' in body ? body.error.message : `Request failed with ${response.status}`;
    throw new Error(message);
  }

  return body as T;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));
}

function Login({ onComplete }: { onComplete(): Promise<void> }) {
  const [authStep, setAuthStep] = useState<AuthStep>('login');
  const [verifyMethod, setVerifyMethod] = useState<VerifyMethod>('totp');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [trustDevice, setTrustDevice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const result = await authClient.signIn.email({
        email,
        password,
        rememberMe: true,
      });
      if (result.error) {
        throw new Error(result.error.message ?? '登录失败');
      }
      if (result.data && 'twoFactorRedirect' in result.data && result.data.twoFactorRedirect) {
        setAuthStep('two-factor');
        return;
      }

      await onComplete();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登录失败');
    } finally {
      setBusy(false);
    }
  }

  async function submitTwoFactor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const result =
        verifyMethod === 'totp'
          ? await authClient.twoFactor.verifyTotp({ code, trustDevice })
          : await authClient.twoFactor.verifyBackupCode({ code });
      if (result.error) {
        throw new Error(result.error.message ?? '验证码无效');
      }

      await onComplete();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '验证码无效');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-page__folio" aria-hidden="true">
        01
      </div>
      <section className="auth-card">
        <div className="brand-mark" aria-hidden="true">
          小
        </div>
        <p className="eyebrow">KOHARU SUITE · OWNER DESK</p>
        <h1>{authStep === 'login' ? '回到你的内容室。' : '再确认一次。'}</h1>
        <p className="lede">
          {authStep === 'login'
            ? '这里只有一把钥匙。登录后可以查看归档状态、浏览消息，并按需揭示 Telegram 原始数据。'
            : '密码已经通过。输入认证器代码，或改用一枚尚未使用的恢复代码。'}
        </p>

        {authStep === 'login' ? (
          <form className="auth-form" onSubmit={submitPassword}>
            <label>
              <span>Owner email</span>
              <input
                autoComplete="username"
                name="email"
                onChange={(event) => setEmail(event.target.value)}
                required
                type="email"
                value={email}
              />
            </label>
            <label>
              <span>Password</span>
              <input
                autoComplete="current-password"
                minLength={12}
                name="password"
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </label>
            {error ? <p className="form-error">{error}</p> : null}
            <button className="button button--primary" disabled={busy} type="submit">
              {busy ? '正在验证…' : '进入管理台'}
            </button>
          </form>
        ) : (
          <form className="auth-form" onSubmit={submitTwoFactor}>
            <fieldset className="segmented" aria-label="验证方式">
              <button
                aria-pressed={verifyMethod === 'totp'}
                onClick={() => {
                  setCode('');
                  setVerifyMethod('totp');
                }}
                type="button"
              >
                认证器
              </button>
              <button
                aria-pressed={verifyMethod === 'recovery'}
                onClick={() => {
                  setCode('');
                  setVerifyMethod('recovery');
                  setTrustDevice(false);
                }}
                type="button"
              >
                恢复代码
              </button>
            </fieldset>
            <label>
              <span>{verifyMethod === 'totp' ? '6 位动态代码' : '一次性恢复代码'}</span>
              <input
                autoComplete="one-time-code"
                inputMode={verifyMethod === 'totp' ? 'numeric' : 'text'}
                name="code"
                onChange={(event) => setCode(event.target.value)}
                required
                value={code}
              />
            </label>
            {verifyMethod === 'totp' ? (
              <label className="check-field">
                <input
                  checked={trustDevice}
                  name="trust-device"
                  onChange={(event) => setTrustDevice(event.target.checked)}
                  type="checkbox"
                />
                <span>信任这台设备 30 天</span>
              </label>
            ) : null}
            {error ? <p className="form-error">{error}</p> : null}
            <button className="button button--primary" disabled={busy} type="submit">
              {busy ? '正在确认…' : '完成验证'}
            </button>
          </form>
        )}

        <p className="auth-note">
          {authStep === 'login'
            ? 'Owner 只能通过本机 kodama CLI 创建或重置。'
            : '信任设备默认关闭；它不会跳过密码。'}
        </p>
      </section>
    </main>
  );
}

function SecurityPanel({
  enabled,
  onSessionRevoked,
}: {
  enabled: boolean;
  onSessionRevoked(message: string): Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function beginSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const result = await authClient.twoFactor.enable({
        issuer: 'koharu-suite',
        password,
      });
      if (result.error) {
        throw new Error(result.error.message ?? '无法开始 TOTP 设置');
      }

      const totpURI = result.data.totpURI;
      const secret = new URL(totpURI).searchParams.get('secret');
      if (!secret) {
        throw new Error('TOTP secret 缺失');
      }
      setSetup({
        backupCodes: result.data.backupCodes,
        secret,
        totpURI,
      });
      setPassword('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法开始 TOTP 设置');
    } finally {
      setBusy(false);
    }
  }

  async function finishSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const result = await authClient.twoFactor.verifyTotp({ code, trustDevice: false });
      if (result.error) {
        throw new Error(result.error.message ?? '动态代码无效');
      }
      await onSessionRevoked('TOTP 已启用，所有旧会话已撤销。请重新登录。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '动态代码无效');
    } finally {
      setBusy(false);
    }
  }

  async function disableTotp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const result = await authClient.twoFactor.disable({ password });
      if (result.error) {
        throw new Error(result.error.message ?? '无法关闭 TOTP');
      }
      await onSessionRevoked('TOTP 已关闭，所有旧会话已撤销。请重新登录。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法关闭 TOTP');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel security-panel" aria-labelledby="security-title">
      <div className="panel__heading">
        <div>
          <p className="kicker">SECURITY</p>
          <h2 id="security-title">双重验证</h2>
        </div>
        <span className={`badge ${enabled ? 'badge--good' : ''}`}>
          {enabled ? '已启用' : '未启用'}
        </span>
      </div>

      {!enabled && !setup ? (
        <form className="compact-form" onSubmit={beginSetup}>
          <p>使用当前密码开始设置。完成验证前，TOTP 不会生效。</p>
          <label>
            <span>当前密码</span>
            <input
              autoComplete="current-password"
              minLength={12}
              name="totp-enable-password"
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>
          {error ? <p className="form-error">{error}</p> : null}
          <button className="button button--quiet" disabled={busy} type="submit">
            开始设置
          </button>
        </form>
      ) : null}

      {!enabled && setup ? (
        <form className="compact-form setup-sheet" onSubmit={finishSetup}>
          <p>在认证器中手动输入密钥，再输入生成的 6 位代码。</p>
          <code className="secret">{setup.secret}</code>
          <details>
            <summary>显示完整 otpauth URI</summary>
            <code className="uri">{setup.totpURI}</code>
          </details>
          <div className="recovery-codes">
            <strong>现在保存恢复代码</strong>
            <p>每枚只能使用一次，离开此页后不会再次显示。</p>
            <ul>
              {setup.backupCodes.map((backupCode) => (
                <li key={backupCode}>
                  <code>{backupCode}</code>
                </li>
              ))}
            </ul>
          </div>
          <label>
            <span>认证器代码</span>
            <input
              autoComplete="one-time-code"
              inputMode="numeric"
              name="totp-setup-code"
              onChange={(event) => setCode(event.target.value)}
              required
              value={code}
            />
          </label>
          {error ? <p className="form-error">{error}</p> : null}
          <button className="button button--primary" disabled={busy} type="submit">
            {busy ? '正在启用…' : '验证并启用'}
          </button>
        </form>
      ) : null}

      {enabled ? (
        <form className="compact-form" onSubmit={disableTotp}>
          <p>关闭需要再次输入密码，并会撤销全部登录会话。</p>
          <label>
            <span>当前密码</span>
            <input
              autoComplete="current-password"
              minLength={12}
              name="totp-disable-password"
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>
          {error ? <p className="form-error">{error}</p> : null}
          <button className="button button--danger" disabled={busy} type="submit">
            关闭 TOTP
          </button>
        </form>
      ) : null}
    </section>
  );
}

function OperationsPanel({
  blockedTasks,
  channels,
  loading,
  onChannelToggle,
  onRerender,
  onTaskAction,
}: {
  blockedTasks: BlockedTask[];
  channels: ConfiguredChannel[];
  loading: boolean;
  onChannelToggle(channel: ConfiguredChannel): Promise<void>;
  onRerender(): Promise<RerenderResult>;
  onTaskAction(task: BlockedTask, action: 'retry' | 'skip', reason: string): Promise<void>;
}) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [rerenderResult, setRerenderResult] = useState<RerenderResult | null>(null);

  async function run(actionKey: string, operation: () => Promise<string>) {
    setBusyAction(actionKey);
    setError(null);
    setNotice(null);
    try {
      setNotice(await operation());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败');
    } finally {
      setBusyAction(null);
    }
  }

  async function actOnTask(task: BlockedTask, action: 'retry' | 'skip') {
    const reason = reasons[task.id]?.trim() ?? '';
    if (!reason) {
      setError('重试或跳过前必须填写操作原因。');
      return;
    }

    await run(`task:${task.id}:${action}`, async () => {
      await onTaskAction(task, action, reason);
      setReasons((current) => {
        const next = { ...current };
        delete next[task.id];
        return next;
      });
      return action === 'retry'
        ? `Update ${task.telegramUpdateId} 已重新进入处理队列。`
        : `Update ${task.telegramUpdateId} 已由 Owner 显式跳过。`;
    });
  }

  async function toggleChannel(channel: ConfiguredChannel) {
    await run(`channel:${channel.telegramChatId}`, async () => {
      await onChannelToggle(channel);
      return `${channel.title} 已${channel.enabled ? '停用' : '启用'}。历史归档没有被删除。`;
    });
  }

  async function rerender() {
    await run('rerender', async () => {
      const result = await onRerender();
      setRerenderResult(result);
      return result.updated > 0
        ? `已用 renderer v${result.currentVersion} 更新 ${result.updated} 条过期修订。`
        : `所有修订都已是 renderer v${result.currentVersion}。`;
    });
  }

  return (
    <section className="operations" aria-labelledby="operations-title">
      <div className="operations__heading">
        <div>
          <p className="kicker">OPERATIONS</p>
          <h2 id="operations-title">运维台</h2>
          <p>处理阻塞任务、控制采集频道，以及更新过期的内容渲染。</p>
        </div>
        <span className={`badge ${blockedTasks.length === 0 ? 'badge--good' : 'badge--warning'}`}>
          {loading ? '读取中…' : `${blockedTasks.length} 个阻塞任务`}
        </span>
      </div>

      {error ? (
        <p className="operation-feedback operation-feedback--error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="operation-feedback operation-feedback--success" role="status">
          {notice}
        </p>
      ) : null}

      <div className="operations__grid">
        <section className="operation-card operation-card--tasks" aria-labelledby="blocked-title">
          <div className="operation-card__heading">
            <div>
              <p className="kicker">QUEUE</p>
              <h3 id="blocked-title">阻塞任务</h3>
            </div>
            <span>{blockedTasks.length}</span>
          </div>
          <p className="operation-help">
            系统不会自动跳过失败任务。每次重试或跳过都会记录 Owner 和原因。
          </p>

          <div className="task-stack">
            {blockedTasks.map((task) => {
              const reason = reasons[task.id] ?? '';
              const taskBusy = busyAction !== null;
              return (
                <article className="blocked-task" key={task.id}>
                  <header>
                    <div>
                      <strong>{task.channelTitle}</strong>
                      <span>
                        Update {task.telegramUpdateId} · 已尝试 {task.attemptCount} 次
                      </span>
                    </div>
                    <time dateTime={task.blockedAt}>{formatDate(task.blockedAt)}</time>
                  </header>
                  {task.lastError ? <pre>{task.lastError}</pre> : null}
                  <label>
                    <span>操作原因（必填，将写入审计记录）</span>
                    <input
                      disabled={taskBusy}
                      maxLength={500}
                      onChange={(event) =>
                        setReasons((current) => ({
                          ...current,
                          [task.id]: event.target.value,
                        }))
                      }
                      placeholder="例如：已修复解析器，重新处理"
                      value={reason}
                    />
                  </label>
                  <div className="blocked-task__actions">
                    <button
                      className="button button--primary"
                      disabled={taskBusy || reason.trim().length === 0}
                      onClick={() => actOnTask(task, 'retry')}
                      type="button"
                    >
                      {busyAction === `task:${task.id}:retry` ? '正在重试…' : '重试任务'}
                    </button>
                    <button
                      className="button button--danger"
                      disabled={taskBusy || reason.trim().length === 0}
                      onClick={() => actOnTask(task, 'skip')}
                      type="button"
                    >
                      {busyAction === `task:${task.id}:skip` ? '正在跳过…' : '显式跳过'}
                    </button>
                  </div>
                </article>
              );
            })}
            {!loading && blockedTasks.length === 0 ? (
              <p className="empty-state empty-state--good">队列畅通，没有等待 Owner 处理的任务。</p>
            ) : null}
          </div>
        </section>

        <div className="operations__side">
          <section className="operation-card" aria-labelledby="configured-channels-title">
            <div className="operation-card__heading">
              <div>
                <p className="kicker">COLLECTOR</p>
                <h3 id="configured-channels-title">采集频道</h3>
              </div>
              <span>{channels.filter((channel) => channel.enabled).length} 启用</span>
            </div>
            <div className="channel-switches">
              {channels.map((channel) => {
                const channelBusy = busyAction === `channel:${channel.telegramChatId}`;
                return (
                  <div className="channel-switch" key={channel.telegramChatId}>
                    <div className="channel-switch__copy">
                      <strong>{channel.title}</strong>
                      <span className="channel-switch__identity">
                        {channel.username ? `@${channel.username}` : channel.telegramChatId}
                      </span>
                      {!channel.enabled && channel.disabledAt ? (
                        <small className="channel-switch__disabled">
                          停用于 {formatDate(channel.disabledAt)}
                        </small>
                      ) : null}
                    </div>
                    <button
                      aria-label={`${channel.enabled ? '停用' : '启用'} ${channel.title}`}
                      className={`toggle ${channel.enabled ? 'is-enabled' : ''}`}
                      disabled={busyAction !== null}
                      onClick={() => toggleChannel(channel)}
                      type="button"
                    >
                      <span aria-hidden="true" />
                      {channelBusy ? '更新中' : channel.enabled ? '启用' : '停用'}
                    </button>
                  </div>
                );
              })}
              {!loading && channels.length === 0 ? (
                <p className="empty-state">还没有配置 Telegram 频道。</p>
              ) : null}
            </div>
            <p className="operation-help">停用只会停止后续采集，不会删除已经归档的消息。</p>
          </section>

          <section className="operation-card rerender-card" aria-labelledby="rerender-title">
            <div className="operation-card__heading">
              <div>
                <p className="kicker">RENDERER</p>
                <h3 id="rerender-title">内容重渲染</h3>
              </div>
              {rerenderResult ? <span>v{rerenderResult.currentVersion}</span> : null}
            </div>
            <p className="operation-help">
              仅处理 renderer 版本落后的修订，每次最多一批；已经是当前版本的内容不会改写。
            </p>
            <button
              className="button button--quiet"
              disabled={busyAction !== null}
              onClick={rerender}
              type="button"
            >
              {busyAction === 'rerender'
                ? '正在重渲染…'
                : rerenderResult?.hasMore
                  ? '继续处理下一批'
                  : '重渲染过期内容'}
            </button>
            {rerenderResult ? (
              <p className="rerender-result">
                本批更新 {rerenderResult.updated} 条
                {rerenderResult.hasMore ? '，仍有下一批待处理。' : '，已处理完毕。'}
              </p>
            ) : null}
          </section>
        </div>
      </div>
    </section>
  );
}

function Dashboard({ onSessionRevoked }: { onSessionRevoked(message: string): Promise<void> }) {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [configuredChannels, setConfiguredChannels] = useState<ConfiguredChannel[]>([]);
  const [blockedTasks, setBlockedTasks] = useState<BlockedTask[]>([]);
  const [operationsLoading, setOperationsLoading] = useState(true);
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const [raw, setRaw] = useState<unknown>(null);
  const [rawLoading, setRawLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    Promise.all([
      fetchJson<AdminStatus>('/api/v1/admin/status', { signal: controller.signal }),
      fetchJson<{ items: Channel[] }>('/api/v1/channels', { signal: controller.signal }),
      fetchJson<{ items: BlockedTask[] }>('/api/v1/admin/tasks/blocked', {
        signal: controller.signal,
      }),
      fetchJson<{ items: ConfiguredChannel[] }>('/api/v1/admin/channels', {
        signal: controller.signal,
      }),
    ])
      .then(([nextStatus, channelResult, taskResult, configuredChannelResult]) => {
        setStatus(nextStatus);
        setChannels(channelResult.items);
        setBlockedTasks(taskResult.items);
        setConfiguredChannels(configuredChannelResult.items);
        setSelectedChannel(channelResult.items[0]?.id ?? null);
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') {
          return;
        }
        setError(reason instanceof Error ? reason.message : '无法加载管理状态');
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setOperationsLoading(false);
        }
      });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!selectedChannel) {
      setMessages([]);
      return;
    }

    const controller = new AbortController();
    fetchJson<{ items: Message[] }>(
      `/api/v1/messages?channel=${encodeURIComponent(selectedChannel)}`,
      { signal: controller.signal },
    )
      .then((result) => {
        setMessages(result.items);
        setSelectedMessage(result.items[0] ?? null);
        setRaw(null);
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') {
          return;
        }
        setError(reason instanceof Error ? reason.message : '无法加载消息');
      });

    return () => controller.abort();
  }, [selectedChannel]);

  async function revealRaw() {
    if (!selectedMessage) {
      return;
    }

    setRawLoading(true);
    setError(null);
    try {
      const result = await fetchJson<{ update: unknown }>(
        `/api/v1/admin/messages/${selectedMessage.id}/raw`,
        { cache: 'no-store' },
      );
      setRaw(result.update);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法读取原始 update');
    } finally {
      setRawLoading(false);
    }
  }

  async function actOnTask(task: BlockedTask, action: 'retry' | 'skip', reason: string) {
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
                action === 'retry' ? current.counts.pendingTasks + 1 : current.counts.pendingTasks,
              skippedTasks:
                action === 'skip' ? current.counts.skippedTasks + 1 : current.counts.skippedTasks,
            },
          }
        : current,
    );
  }

  async function toggleConfiguredChannel(channel: ConfiguredChannel) {
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
  }

  async function rerenderOutdated() {
    const result = await fetchJson<RerenderResult>('/api/v1/admin/rerender', { method: 'POST' });
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
    return result;
  }

  async function signOut() {
    await authClient.signOut();
    await onSessionRevoked('已安全退出。');
  }

  return (
    <main className="desk">
      <header className="desk-header">
        <div className="desk-brand">
          <span className="brand-mark brand-mark--small" aria-hidden="true">
            小
          </span>
          <div>
            <p className="eyebrow">KOHARU SUITE</p>
            <strong>Owner Desk</strong>
          </div>
        </div>
        <div className="desk-header__actions">
          <span className={`live-state ${status?.collector === 'running' ? 'is-live' : ''}`}>
            <span aria-hidden="true" />
            {status?.collector === 'running' ? 'Collector 运行中' : 'Collector 未运行'}
          </span>
          <button className="text-button" onClick={signOut} type="button">
            退出
          </button>
        </div>
      </header>

      {error ? (
        <div className="page-error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="desk-grid">
        <aside className="rail">
          <p className="kicker">ARCHIVE</p>
          <h2>频道</h2>
          <nav aria-label="归档频道">
            {channels.map((channel) => (
              <button
                className={selectedChannel === channel.id ? 'is-active' : ''}
                key={channel.id}
                onClick={() => setSelectedChannel(channel.id)}
                type="button"
              >
                <span>{channel.title}</span>
                <small>{channel.username ? `@${channel.username}` : '私有链接不可用'}</small>
              </button>
            ))}
          </nav>
          <div className="rail__footer">
            <span>{status?.owner.email ?? '正在读取 owner…'}</span>
            <span>Server v{status?.version ?? '—'}</span>
          </div>
        </aside>

        <section className="workspace">
          <section className="stats" aria-label="归档统计">
            {[
              ['配置频道', status?.counts.configuredChannels ?? '—'],
              ['活跃频道', status?.counts.activeChannels ?? '—'],
              ['消息', status?.counts.messages ?? '—'],
              ['Updates', status?.counts.updates ?? '—'],
              ['待处理', status?.counts.pendingTasks ?? '—'],
              ['重试中', status?.counts.retryingTasks ?? '—'],
              ['已阻塞', status?.counts.blockedTasks ?? '—'],
              ['已跳过', status?.counts.skippedTasks ?? '—'],
              ['待重渲染', status?.counts.staleRendererRevisions ?? '—'],
              ['Checkpoint', status?.lastCheckpoint ? formatDate(status.lastCheckpoint) : '—'],
            ].map(([label, value]) => (
              <div className="stat" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </section>

          <div className="content-grid">
            <section className="panel message-list" aria-labelledby="message-list-title">
              <div className="panel__heading">
                <div>
                  <p className="kicker">LEDGER</p>
                  <h2 id="message-list-title">最近消息</h2>
                </div>
                <span className="badge">{messages.length} 条</span>
              </div>
              <div className="message-list__items">
                {messages.map((message) => (
                  <button
                    className={selectedMessage?.id === message.id ? 'is-active' : ''}
                    key={message.id}
                    onClick={() => {
                      setSelectedMessage(message);
                      setRaw(null);
                    }}
                    type="button"
                  >
                    <time>{formatDate(message.publishedAt)}</time>
                    <strong>{message.content.text?.slice(0, 72) || '［无文字内容］'}</strong>
                    <span>
                      rev.{message.revision} · {message.media.length} 个媒体
                    </span>
                  </button>
                ))}
                {messages.length === 0 ? (
                  <p className="empty-state">这个频道还没有归档消息。</p>
                ) : null}
              </div>
            </section>

            <section className="panel message-detail" aria-labelledby="message-detail-title">
              <div className="panel__heading">
                <div>
                  <p className="kicker">MESSAGE</p>
                  <h2 id="message-detail-title">消息详情</h2>
                </div>
                {selectedMessage?.sourceUrl ? (
                  <a href={selectedMessage.sourceUrl} rel="noreferrer" target="_blank">
                    原消息 ↗
                  </a>
                ) : null}
              </div>
              {selectedMessage ? (
                <>
                  <div className="message-copy">
                    <p>{selectedMessage.content.text || '这条消息没有文字内容。'}</p>
                    <dl>
                      <div>
                        <dt>发布时间</dt>
                        <dd>{formatDate(selectedMessage.publishedAt)}</dd>
                      </div>
                      <div>
                        <dt>署名</dt>
                        <dd>{selectedMessage.authorSignature ?? '—'}</dd>
                      </div>
                      <div>
                        <dt>内容类型</dt>
                        <dd>{selectedMessage.content.kind}</dd>
                      </div>
                    </dl>
                  </div>
                  <div className="raw-zone">
                    <div>
                      <strong>Telegram raw update</strong>
                      <p>仅在主动点击后读取；响应不会被缓存。</p>
                    </div>
                    <button
                      className="button button--quiet"
                      disabled={rawLoading}
                      onClick={revealRaw}
                      type="button"
                    >
                      {rawLoading ? '正在读取…' : raw === null ? '揭示原始数据' : '重新读取'}
                    </button>
                  </div>
                  {raw !== null ? (
                    <pre className="raw-view">{JSON.stringify(raw, null, 2)}</pre>
                  ) : null}
                </>
              ) : (
                <p className="empty-state">选择一条消息查看详情。</p>
              )}
            </section>
          </div>

          <OperationsPanel
            blockedTasks={blockedTasks}
            channels={configuredChannels}
            loading={operationsLoading}
            onChannelToggle={toggleConfiguredChannel}
            onRerender={rerenderOutdated}
            onTaskAction={actOnTask}
          />

          {status ? (
            <SecurityPanel
              enabled={status.owner.twoFactorEnabled}
              onSessionRevoked={onSessionRevoked}
            />
          ) : null}
        </section>
      </div>
    </main>
  );
}

export function App() {
  const session = authClient.useSession();
  const [notice, setNotice] = useState<string | null>(null);

  async function refreshSession() {
    await session.refetch();
  }

  async function handleSessionRevoked(message: string) {
    setNotice(message);
    await session.refetch();
  }

  if (session.isPending) {
    return (
      <main className="loading-page">
        <div className="loading-mark" role="status" aria-label="正在读取 session">
          小
        </div>
      </main>
    );
  }

  if (!session.data) {
    return (
      <>
        {notice ? (
          <div className="toast" role="status">
            {notice}
          </div>
        ) : null}
        <Login onComplete={refreshSession} />
      </>
    );
  }

  return <Dashboard onSessionRevoked={handleSessionRevoked} />;
}
