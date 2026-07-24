import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Kicker,
  Panel,
  PanelHeader,
} from '@koharu-suite/ui';
import { twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import {
  createElement,
  type FormEvent,
  Fragment,
  type ReactNode,
  useEffect,
  useState,
} from 'react';
import { startStatusPoller } from './status-poller';

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
    html: string | null;
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
  collector: {
    heartbeatAt: string | null;
    lastTelegramSuccessAt: string | null;
    startedAt: string | null;
    state: 'running' | 'stale' | 'stopped';
    version: string | null;
  };
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

interface ReconciliationFinding {
  evidenceVersion: number;
  id: string;
  kind: string;
  messageId: string | null;
  messageTombstoned: boolean;
  sanitizedDetails: { reason?: string };
  severity: 'error' | 'warning';
  state: 'ignored' | 'open' | 'resolved';
  telegramChatId: string | null;
}

interface ReconciliationRun {
  completedAt: string | null;
  id: string;
  mode: string;
  startedAt: string;
  status: string;
}

export interface MediaCacheStatus {
  commands: Array<{
    completedAt: string | null;
    createdAt: string;
    errorCode: string | null;
    id: string;
    operation: 'evict' | 'reconcile';
    result: Record<string, unknown> | null;
    state: 'failed' | 'pending' | 'running' | 'succeeded';
    updatedAt: string;
  }>;
  enabled: boolean;
  failures: Array<{
    lastErrorClass: string | null;
    lastErrorCode: string | null;
    objectId: string;
    planId: string;
    reasonCode: string | null;
    state: string;
    updatedAt: string;
    variant: 'original' | 'thumbnail';
  }>;
  stateCounts: {
    blobs: Array<{ count: number; state: string }>;
    objects: Array<{ count: number; state: string }>;
    plans: Array<{ count: number; state: string }>;
  };
  usage: {
    lastReconciledAt: string | null;
    maxBytes: string;
    readyBytes: string;
    reservedBytes: string;
    updatedAt: string | null;
  };
}

export interface MediaCacheObject {
  actualBytes: string | null;
  canonicalMediaId: string;
  declaredBytes: string | null;
  id: string;
  kind: string;
  messageId: string;
  planId: string;
  planState: string;
  reasonCode: string | null;
  state: string;
  updatedAt: string;
  variant: 'original' | 'thumbnail';
}

interface MediaCacheCommandReceipt {
  commandId: string;
  operation: 'evict' | 'reconcile';
  state: 'pending';
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

function formatBytes(value: string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1_024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let amount = bytes;
  let unit = 'B';
  for (const candidate of units) {
    amount /= 1_024;
    unit = candidate;
    if (amount < 1_024 || candidate === 'GiB') break;
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${unit}`;
}

const SAFE_MESSAGE_TAGS = new Set([
  'a',
  'blockquote',
  'code',
  'em',
  'pre',
  's',
  'span',
  'strong',
  'u',
]);
const SAFE_MESSAGE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tg:']);
const SAFE_LANGUAGE_CLASS = /^language-[a-zA-Z0-9_+-]{1,64}$/;

function safeMessageHref(value: string | null): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    return SAFE_MESSAGE_PROTOCOLS.has(url.protocol.toLowerCase()) ? value : null;
  } catch {
    return null;
  }
}

function safeMessageClass(element: Element): string | undefined {
  const value = element.getAttribute('class');
  if (
    value === 'tg-spoiler' ||
    value === 'tg-expandable-blockquote' ||
    (value !== null && SAFE_LANGUAGE_CLASS.test(value))
  ) {
    return value;
  }
  return undefined;
}

function renderSafeMessageNode(node: Node, key: string): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }

  const element = node as Element;
  const tagName = element.tagName.toLowerCase();
  const children = [...element.childNodes].map((child, index) =>
    renderSafeMessageNode(child, `${key}.${index}`),
  );
  if (!SAFE_MESSAGE_TAGS.has(tagName)) {
    return createElement(Fragment, { key }, children);
  }

  const properties: Record<string, unknown> = { key };
  if (tagName === 'a') {
    const href = safeMessageHref(element.getAttribute('href'));
    if (href === null) {
      return createElement(Fragment, { key }, children);
    }
    properties.href = href;
    properties.rel = 'nofollow noopener noreferrer';
  }
  const className = safeMessageClass(element);
  if (className !== undefined) {
    properties.className = className;
  }
  if (className === 'tg-spoiler') {
    properties.tabIndex = 0;
    properties.title = '聚焦或悬停以显示剧透内容';
  }
  return createElement(tagName, properties, children);
}

function SafeMessageContent({ html, text }: { html: string | null; text: string | null }) {
  if (html === null) {
    return <p>{text || '这条消息没有文字内容。'}</p>;
  }

  const document = new DOMParser().parseFromString(html, 'text/html');
  return (
    <div className="rendered-message">
      {[...document.body.childNodes].map((node, index) =>
        renderSafeMessageNode(node, String(index)),
      )}
    </div>
  );
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
    <main className="auth-page" data-koharu-ui>
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
            <Field label="Owner email">
              <Input
                autoComplete="username"
                name="email"
                onChange={(event) => setEmail(event.target.value)}
                required
                type="email"
                value={email}
              />
            </Field>
            <Field label="Password">
              <Input
                autoComplete="current-password"
                minLength={12}
                name="password"
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </Field>
            {error ? <p className="form-error">{error}</p> : null}
            <Button disabled={busy} type="submit">
              {busy ? '正在验证…' : '进入管理台'}
            </Button>
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
            <Field label={verifyMethod === 'totp' ? '6 位动态代码' : '一次性恢复代码'}>
              <Input
                autoComplete="one-time-code"
                inputMode={verifyMethod === 'totp' ? 'numeric' : 'text'}
                name="code"
                onChange={(event) => setCode(event.target.value)}
                required
                value={code}
              />
            </Field>
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
            <Button disabled={busy} type="submit">
              {busy ? '正在确认…' : '完成验证'}
            </Button>
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
    <Panel className="security-panel" aria-labelledby="security-title">
      <PanelHeader>
        <div>
          <Kicker>SECURITY</Kicker>
          <h2 id="security-title">双重验证</h2>
        </div>
        <Badge tone={enabled ? 'success' : 'neutral'}>{enabled ? '已启用' : '未启用'}</Badge>
      </PanelHeader>

      {!enabled && !setup ? (
        <form className="compact-form" onSubmit={beginSetup}>
          <p>使用当前密码开始设置。完成验证前，TOTP 不会生效。</p>
          <Field label="当前密码">
            <Input
              autoComplete="current-password"
              minLength={12}
              name="totp-enable-password"
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </Field>
          {error ? <p className="form-error">{error}</p> : null}
          <Button disabled={busy} type="submit" variant="quiet">
            开始设置
          </Button>
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
          <Field label="认证器代码">
            <Input
              autoComplete="one-time-code"
              inputMode="numeric"
              name="totp-setup-code"
              onChange={(event) => setCode(event.target.value)}
              required
              value={code}
            />
          </Field>
          {error ? <p className="form-error">{error}</p> : null}
          <Button disabled={busy} type="submit">
            {busy ? '正在启用…' : '验证并启用'}
          </Button>
        </form>
      ) : null}

      {enabled ? (
        <form className="compact-form" onSubmit={disableTotp}>
          <p>关闭需要再次输入密码，并会撤销全部登录会话。</p>
          <Field label="当前密码">
            <Input
              autoComplete="current-password"
              minLength={12}
              name="totp-disable-password"
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </Field>
          {error ? <p className="form-error">{error}</p> : null}
          <Button disabled={busy} type="submit" variant="danger">
            关闭 TOTP
          </Button>
        </form>
      ) : null}
    </Panel>
  );
}

function OperationsPanel({
  blockedTasks,
  channels,
  collector,
  loading,
  onChannelToggle,
  onRerender,
  onTaskAction,
}: {
  blockedTasks: BlockedTask[];
  channels: ConfiguredChannel[];
  collector: AdminStatus['collector'] | null;
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
    <section
      className="operations"
      aria-labelledby="operations-title"
      data-koharu-ui-tone="inverse"
    >
      <div className="operations__heading">
        <div>
          <Kicker>OPERATIONS</Kicker>
          <h2 id="operations-title">运维台</h2>
          <p>处理阻塞任务、控制采集频道，以及更新过期的内容渲染。</p>
        </div>
        <Badge tone={blockedTasks.length === 0 ? 'success' : 'warning'}>
          {loading ? '读取中…' : `${blockedTasks.length} 个阻塞任务`}
        </Badge>
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
              <Kicker>QUEUE</Kicker>
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
                  <Field label="操作原因（必填，将写入审计记录）">
                    <Input
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
                  </Field>
                  <div className="blocked-task__actions">
                    <Button
                      disabled={taskBusy || reason.trim().length === 0}
                      onClick={() => actOnTask(task, 'retry')}
                      type="button"
                    >
                      {busyAction === `task:${task.id}:retry` ? '正在重试…' : '重试任务'}
                    </Button>
                    <Button
                      disabled={taskBusy || reason.trim().length === 0}
                      onClick={() => actOnTask(task, 'skip')}
                      type="button"
                      variant="danger"
                    >
                      {busyAction === `task:${task.id}:skip` ? '正在跳过…' : '显式跳过'}
                    </Button>
                  </div>
                </article>
              );
            })}
            {!loading && blockedTasks.length === 0 ? (
              <EmptyState tone="success">队列畅通，没有等待 Owner 处理的任务。</EmptyState>
            ) : null}
          </div>
        </section>

        <div className="operations__side">
          <section className="operation-card" aria-labelledby="configured-channels-title">
            <div className="operation-card__heading">
              <div>
                <Kicker>COLLECTOR</Kicker>
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
                <EmptyState>还没有配置 Telegram 频道。</EmptyState>
              ) : null}
            </div>
            <dl className="collector-runtime">
              <div className="collector-runtime__item">
                <dt>Worker</dt>
                <dd>
                  {collector?.state === 'running'
                    ? '运行中'
                    : collector?.state === 'stale'
                      ? '心跳过期'
                      : '未运行'}
                </dd>
              </div>
              <div className="collector-runtime__item">
                <dt>版本</dt>
                <dd>{collector?.version ?? '—'}</dd>
              </div>
              <div className="collector-runtime__item">
                <dt>心跳</dt>
                <dd>{collector?.heartbeatAt ? formatDate(collector.heartbeatAt) : '—'}</dd>
              </div>
            </dl>
            <p className="operation-help">停用只会停止后续采集，不会删除已经归档的消息。</p>
          </section>

          <section className="operation-card rerender-card" aria-labelledby="rerender-title">
            <div className="operation-card__heading">
              <div>
                <Kicker>RENDERER</Kicker>
                <h3 id="rerender-title">内容重渲染</h3>
              </div>
              {rerenderResult ? <span>v{rerenderResult.currentVersion}</span> : null}
            </div>
            <p className="operation-help">
              仅处理 renderer 版本落后的修订，每次最多一批；已经是当前版本的内容不会改写。
            </p>
            <Button disabled={busyAction !== null} onClick={rerender} type="button" variant="quiet">
              {busyAction === 'rerender'
                ? '正在重渲染…'
                : rerenderResult?.hasMore
                  ? '继续处理下一批'
                  : '重渲染过期内容'}
            </Button>
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

interface MediaCachePanelProps {
  busyAction: string | null;
  nextCursor: string | null;
  notice: string | null;
  objects: MediaCacheObject[];
  onAction(object: MediaCacheObject, action: 'evict' | 'retry', reason: string): void;
  onLoadMore(): void;
  onReasonChange(key: string, reason: string): void;
  onReconcile(reason: string): void;
  reasons: Record<string, string>;
  status: MediaCacheStatus;
}

export function MediaCachePanel({
  busyAction,
  nextCursor,
  notice,
  objects,
  onAction,
  onLoadMore,
  onReasonChange,
  onReconcile,
  reasons,
  status,
}: MediaCachePanelProps) {
  const readyBytes = Number(status.usage.readyBytes);
  const reservedBytes = Number(status.usage.reservedBytes);
  const maxBytes = Math.max(1, Number(status.usage.maxBytes));
  const reconcileReason = reasons.reconcile?.trim() ?? '';

  return (
    <section className="media-cache" aria-labelledby="media-cache-title">
      <div className="media-cache__heading">
        <div>
          <Kicker>LOCAL CACHE</Kicker>
          <h2 id="media-cache-title">媒体缓存</h2>
          <p>缓存可随时重建；删除本地副本不会删除文章、媒体 metadata 或来源证据。</p>
        </div>
        <Badge tone={status.enabled ? 'success' : 'neutral'}>
          {status.enabled ? '已启用' : '未启用'}
        </Badge>
      </div>

      <div className="media-cache__usage">
        <div className="media-cache__usage-item">
          <span>已使用</span>
          <strong>{formatBytes(status.usage.readyBytes)}</strong>
        </div>
        <div className="media-cache__usage-item">
          <span>已预留</span>
          <strong>{formatBytes(status.usage.reservedBytes)}</strong>
        </div>
        <div className="media-cache__usage-item">
          <span>上限</span>
          <strong>{formatBytes(status.usage.maxBytes)}</strong>
        </div>
        <progress
          aria-label="媒体缓存容量"
          max={maxBytes}
          value={Math.min(maxBytes, Math.max(0, readyBytes + reservedBytes))}
        />
      </div>

      <ul className="media-cache__counts" aria-label="媒体缓存状态计数">
        {status.stateCounts.objects.map((entry) => (
          <li key={entry.state}>
            <strong>{entry.count}</strong> {entry.state}
          </li>
        ))}
        {status.stateCounts.objects.length === 0 ? <li>暂无缓存对象</li> : null}
      </ul>

      {notice ? (
        <p className="media-cache__notice" role="status">
          {notice}
        </p>
      ) : null}

      {status.failures.length > 0 ? (
        <div className="media-cache__failures">
          <h3>最近失败</h3>
          <ul>
            {status.failures.map((failure) => (
              <li key={failure.objectId}>
                <code>{failure.objectId.slice(0, 8)}</code>
                <span>
                  {failure.variant} · {failure.state} ·{' '}
                  {failure.reasonCode ??
                    failure.lastErrorCode ??
                    failure.lastErrorClass ??
                    'unknown'}
                </span>
                <time dateTime={failure.updatedAt}>{formatDate(failure.updatedAt)}</time>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {status.commands.length > 0 ? (
        <div className="media-cache__failures">
          <h3>最近的维护命令</h3>
          <ul>
            {status.commands.map((command) => (
              <li key={command.id}>
                <code>{command.id.slice(0, 8)}</code>
                <span>
                  {command.operation} · {command.state}
                  {command.errorCode ? ` · ${command.errorCode}` : ''}
                </span>
                <time dateTime={command.updatedAt}>{formatDate(command.updatedAt)}</time>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="media-cache__objects">
        {objects.map((object) => {
          const reason = reasons[object.id]?.trim() ?? '';
          const canEvict = object.state === 'ready';
          const canRetry = [
            'blocked',
            'evicted',
            'integrity_conflict',
            'missing',
            'retry_wait',
            'skipped',
          ].includes(object.state);
          const busy = busyAction !== null;
          return (
            <article key={object.id}>
              <header>
                <div>
                  <strong>
                    {object.kind} · {object.variant}
                  </strong>
                  <code>{object.id}</code>
                </div>
                <Badge
                  tone={
                    object.state === 'ready'
                      ? 'success'
                      : object.state === 'blocked' || object.state === 'integrity_conflict'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {object.state}
                </Badge>
              </header>
              <p>
                Post {object.planState} ·{' '}
                {object.actualBytes
                  ? formatBytes(object.actualBytes)
                  : object.declaredBytes
                    ? `声明 ${formatBytes(object.declaredBytes)}`
                    : '大小未知'}
                {object.reasonCode ? ` · ${object.reasonCode}` : ''}
              </p>
              {canEvict || canRetry ? (
                <>
                  <Field label="操作原因（必填，将写入审计记录）">
                    <Input
                      disabled={busy}
                      maxLength={500}
                      onChange={(event) => onReasonChange(object.id, event.target.value)}
                      placeholder={canEvict ? '例如：主动释放本地空间' : '例如：上游文件已恢复'}
                      value={reasons[object.id] ?? ''}
                    />
                  </Field>
                  <div className="media-cache__actions">
                    {canRetry ? (
                      <Button
                        disabled={busy || reason.length === 0}
                        onClick={() => onAction(object, 'retry', reason)}
                        type="button"
                      >
                        {busyAction === `${object.id}:retry` ? '正在重试…' : '重试'}
                      </Button>
                    ) : null}
                    {canEvict ? (
                      <Button
                        disabled={busy || reason.length === 0}
                        onClick={() => onAction(object, 'evict', reason)}
                        type="button"
                        variant="danger"
                      >
                        {busyAction === `${object.id}:evict` ? '正在驱逐…' : '驱逐本地副本'}
                      </Button>
                    ) : null}
                  </div>
                </>
              ) : null}
            </article>
          );
        })}
        {objects.length === 0 ? (
          <EmptyState tone="success">
            {status.enabled
              ? '尚未发现可缓存媒体。'
              : '启用 MEDIA_CACHE_ENABLED 后才会建立本地副本。'}
          </EmptyState>
        ) : null}
        {nextCursor ? (
          <Button disabled={busyAction !== null} onClick={onLoadMore} type="button" variant="quiet">
            加载更多缓存对象
          </Button>
        ) : null}
      </div>

      <div className="media-cache__reconcile">
        <Field label="对账原因（必填，将写入审计记录）">
          <Input
            disabled={busyAction !== null}
            maxLength={500}
            onChange={(event) => onReasonChange('reconcile', event.target.value)}
            placeholder="例如：卷已恢复，需要核对 DB 与文件系统"
            value={reasons.reconcile ?? ''}
          />
        </Field>
        <Button
          disabled={busyAction !== null || reconcileReason.length === 0}
          onClick={() => onReconcile(reconcileReason)}
          type="button"
          variant="quiet"
        >
          {busyAction === 'reconcile' ? '正在对账…' : '运行媒体缓存对账'}
        </Button>
      </div>
    </section>
  );
}

interface ReconciliationPanelProps {
  busy: boolean;
  findings: ReconciliationFinding[];
  notice: string | null;
  nextCursor: string | null;
  onAction(finding: ReconciliationFinding, action: 'hide' | 'ignore' | 'repair' | 'unhide'): void;
  onReasonChange(findingId: string, reason: string): void;
  onLoadMore(): void;
  onScan(): void;
  reasons: Record<string, string>;
  runs: ReconciliationRun[];
}

export function ReconciliationPanel({
  busy,
  findings,
  notice,
  nextCursor,
  onAction,
  onLoadMore,
  onReasonChange,
  onScan,
  reasons,
  runs,
}: ReconciliationPanelProps) {
  const categoryCounts = Object.entries(
    findings.reduce<Record<string, number>>((counts, finding) => {
      counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;
      return counts;
    }, {}),
  ).sort(([left], [right]) => left.localeCompare(right));

  return (
    <section className="reconciliation" aria-labelledby="reconciliation-title">
      <div className="reconciliation__heading">
        <div>
          <Kicker>RECONCILIATION</Kicker>
          <h2 id="reconciliation-title">对账与恢复</h2>
          <p>只展示脱敏 evidence。数字缺口是线索；安全扫描只更新 findings，不修改文章。</p>
          <p>隐藏后公开 API 返回 404，但 finding、来源证据与审计记录会继续保留。</p>
        </div>
        <Button disabled={busy} onClick={onScan} type="button">
          {busy ? '处理中…' : '运行安全扫描'}
        </Button>
      </div>
      {notice ? (
        <p className="reconciliation__notice" role="status">
          {notice}
        </p>
      ) : null}
      <div className="reconciliation__summary">
        <span>
          已加载 {findings.length} 条 · Open{' '}
          {findings.filter((item) => item.state === 'open').length}
        </span>
        <span>
          最近运行 {runs[0] ? `${runs[0].status} · ${formatDate(runs[0].startedAt)}` : '—'}
        </span>
        <span>需要历史补洞时，请导出 Telegram Desktop JSON 后重新扫描。</span>
      </div>
      <ul className="reconciliation__categories" aria-label="已加载 Finding 类别统计">
        {categoryCounts.map(([kind, count]) => (
          <li key={kind}>
            <strong>{count}</strong> {kind}
          </li>
        ))}
        {categoryCounts.length === 0 ? <li>当前无类别数据</li> : null}
      </ul>
      <div className="reconciliation__list">
        {findings.map((finding) => {
          const repairable = [
            'current_pointer_invalid',
            'derived_html_drift',
            'import_lineage_missing',
            'media_evidence_missing',
          ].includes(finding.kind);
          const tombstoneable =
            finding.kind === 'desktop_absence_candidate' && finding.messageId !== null;
          return (
            <article
              className={`reconciliation-item${finding.severity === 'error' ? ' is-error' : ''}`}
              key={finding.id}
            >
              <header>
                <Badge tone="warning">{finding.kind}</Badge>
                <span>
                  {finding.state} · evidence v{finding.evidenceVersion}
                </span>
              </header>
              <p>{finding.sanitizedDetails.reason ?? '需要 Owner 检查此 evidence。'}</p>
              {finding.state === 'open' || tombstoneable ? (
                <>
                  <Field label="审计原因">
                    <Input
                      maxLength={500}
                      onChange={(event) => onReasonChange(finding.id, event.target.value)}
                      placeholder="说明为何修复或忽略"
                      value={reasons[finding.id] ?? ''}
                    />
                  </Field>
                  <div className="reconciliation-item__actions">
                    {finding.state === 'open' && repairable ? (
                      <Button
                        disabled={busy}
                        onClick={() => onAction(finding, 'repair')}
                        type="button"
                      >
                        确定性修复
                      </Button>
                    ) : null}
                    {tombstoneable ? (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          onAction(finding, finding.messageTombstoned ? 'unhide' : 'hide')
                        }
                        type="button"
                        variant="quiet"
                      >
                        {finding.messageTombstoned ? '恢复公开访问' : '隐藏并公开返回 404'}
                      </Button>
                    ) : null}
                    {finding.state === 'open' ? (
                      <Button
                        disabled={busy}
                        onClick={() => onAction(finding, 'ignore')}
                        type="button"
                        variant="quiet"
                      >
                        Owner 忽略
                      </Button>
                    ) : null}
                  </div>
                </>
              ) : null}
            </article>
          );
        })}
        {findings.length === 0 ? (
          <EmptyState tone="success">尚无 finding。运行扫描以建立当前基线。</EmptyState>
        ) : null}
        {nextCursor ? (
          <Button disabled={busy} onClick={onLoadMore} type="button" variant="quiet">
            {busy ? '加载更多 findings（加载中…）' : '加载更多 findings'}
          </Button>
        ) : null}
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
  const [statusError, setStatusError] = useState<string | null>(null);
  const [reconciliationFindings, setReconciliationFindings] = useState<ReconciliationFinding[]>([]);
  const [reconciliationNextCursor, setReconciliationNextCursor] = useState<string | null>(null);
  const [reconciliationRuns, setReconciliationRuns] = useState<ReconciliationRun[]>([]);
  const [reconciliationBusy, setReconciliationBusy] = useState<string | null>(null);
  const [reconciliationNotice, setReconciliationNotice] = useState<string | null>(null);
  const [reconciliationReasons, setReconciliationReasons] = useState<Record<string, string>>({});
  const [mediaCacheStatus, setMediaCacheStatus] = useState<MediaCacheStatus | null>(null);
  const [mediaCacheObjects, setMediaCacheObjects] = useState<MediaCacheObject[]>([]);
  const [mediaCacheNextCursor, setMediaCacheNextCursor] = useState<string | null>(null);
  const [mediaCacheBusy, setMediaCacheBusy] = useState<string | null>(null);
  const [mediaCacheNotice, setMediaCacheNotice] = useState<string | null>(null);
  const [mediaCacheReasons, setMediaCacheReasons] = useState<Record<string, string>>({});

  useEffect(() => {
    const controller = new AbortController();
    let stopStatusPoller: (() => void) | null = null;

    Promise.all([
      fetchJson<AdminStatus>('/api/v1/admin/status', { signal: controller.signal }),
      fetchJson<{ items: Channel[] }>('/api/v1/channels', { signal: controller.signal }),
      fetchJson<{ items: BlockedTask[] }>('/api/v1/admin/tasks/blocked', {
        signal: controller.signal,
      }),
      fetchJson<{ items: ConfiguredChannel[] }>('/api/v1/admin/channels', {
        signal: controller.signal,
      }),
      fetchJson<{ items: ReconciliationFinding[]; nextCursor: string | null }>(
        '/api/v1/admin/reconciliation/findings?limit=20',
        { signal: controller.signal },
      ),
      fetchJson<{ items: ReconciliationRun[] }>('/api/v1/admin/reconciliation/runs?limit=5', {
        signal: controller.signal,
      }),
      fetchJson<MediaCacheStatus>('/api/v1/admin/media-cache/status', {
        signal: controller.signal,
      }),
      fetchJson<{ items: MediaCacheObject[]; nextCursor: string | null }>(
        '/api/v1/admin/media-cache/objects?limit=20',
        { signal: controller.signal },
      ),
    ])
      .then(
        ([
          nextStatus,
          channelResult,
          taskResult,
          configuredChannelResult,
          findingResult,
          runResult,
          nextMediaCacheStatus,
          mediaCacheObjectResult,
        ]) => {
          setStatus(nextStatus);
          setChannels(channelResult.items);
          setBlockedTasks(taskResult.items);
          setConfiguredChannels(configuredChannelResult.items);
          setReconciliationFindings(findingResult.items);
          setReconciliationNextCursor(findingResult.nextCursor);
          setReconciliationRuns(runResult.items);
          setMediaCacheStatus(nextMediaCacheStatus);
          setMediaCacheObjects(mediaCacheObjectResult.items);
          setMediaCacheNextCursor(mediaCacheObjectResult.nextCursor);
          setSelectedChannel(channelResult.items[0]?.id ?? null);
        },
      )
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') {
          return;
        }
        setError(reason instanceof Error ? reason.message : '无法加载管理状态');
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setOperationsLoading(false);
          stopStatusPoller = startStatusPoller<AdminStatus>({
            fetchStatus: (signal) =>
              fetchJson<AdminStatus>('/api/v1/admin/status', {
                cache: 'no-store',
                signal,
              }),
            onError(reason) {
              setStatusError(reason instanceof Error ? reason.message : '无法刷新采集状态');
            },
            onStatus(nextStatus) {
              setStatus(nextStatus);
              setStatusError(null);
            },
          });
        }
      });

    return () => {
      controller.abort();
      stopStatusPoller?.();
    };
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
    setStatus((current) =>
      current
        ? {
            ...current,
            counts: {
              ...current.counts,
              activeChannels: Math.max(
                0,
                current.counts.activeChannels + (updated.enabled ? 1 : -1),
              ),
            },
          }
        : current,
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

  async function refreshReconciliation() {
    const [findingResult, runResult] = await Promise.all([
      fetchJson<{ items: ReconciliationFinding[]; nextCursor: string | null }>(
        '/api/v1/admin/reconciliation/findings?limit=20',
      ),
      fetchJson<{ items: ReconciliationRun[] }>('/api/v1/admin/reconciliation/runs?limit=5'),
    ]);
    setReconciliationFindings(findingResult.items);
    setReconciliationNextCursor(findingResult.nextCursor);
    setReconciliationRuns(runResult.items);
  }

  async function runReconciliationScan() {
    const channelIds = configuredChannels.map((channel) => channel.telegramChatId);
    if (channelIds.length === 0) {
      setError('请先配置至少一个 Telegram 频道。');
      return;
    }
    setReconciliationBusy('scan');
    setError(null);
    try {
      await fetchJson<{ runId: string }>('/api/v1/admin/reconciliation/scan', {
        body: JSON.stringify({ telegramChannelIds: channelIds }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      await refreshReconciliation();
      setReconciliationNotice('对账扫描完成，finding 已按同一快照更新。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '对账扫描失败');
    } finally {
      setReconciliationBusy(null);
    }
  }

  async function loadMoreReconciliationFindings() {
    if (!reconciliationNextCursor) return;
    setReconciliationBusy('more');
    setError(null);
    try {
      const result = await fetchJson<{
        items: ReconciliationFinding[];
        nextCursor: string | null;
      }>(
        `/api/v1/admin/reconciliation/findings?limit=20&cursor=${encodeURIComponent(reconciliationNextCursor)}`,
      );
      setReconciliationFindings((current) => [...current, ...result.items]);
      setReconciliationNextCursor(result.nextCursor);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法加载更多 findings');
    } finally {
      setReconciliationBusy(null);
    }
  }

  async function actOnFinding(
    finding: ReconciliationFinding,
    action: 'hide' | 'ignore' | 'repair' | 'unhide',
  ) {
    const reason = reconciliationReasons[finding.id]?.trim() ?? '';
    if (!reason) {
      setError('修复或忽略 finding 前必须填写审计原因。');
      return;
    }
    const verb = {
      hide: '隐藏消息并让公开 API 返回 404',
      ignore: '忽略此 finding',
      repair: '执行确定性修复',
      unhide: '恢复消息的公开访问',
    }[action];
    if (!window.confirm(`${verb}？来源证据会保留，此操作会写入审计记录。`)) return;
    setReconciliationBusy(`${finding.id}:${action}`);
    setError(null);
    try {
      await fetchJson<object>(`/api/v1/admin/reconciliation/findings/${finding.id}/${action}`, {
        body: JSON.stringify({
          expectedEvidenceVersion: finding.evidenceVersion,
          ...(action === 'hide' || action === 'unhide' ? { messageId: finding.messageId } : {}),
          reason,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      await refreshReconciliation();
      setReconciliationNotice(`${verb}已完成。`);
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : `${verb}失败`);
    } finally {
      setReconciliationBusy(null);
    }
  }

  async function refreshMediaCache() {
    const [nextStatus, objectResult] = await Promise.all([
      fetchJson<MediaCacheStatus>('/api/v1/admin/media-cache/status', { cache: 'no-store' }),
      fetchJson<{ items: MediaCacheObject[]; nextCursor: string | null }>(
        '/api/v1/admin/media-cache/objects?limit=20',
        { cache: 'no-store' },
      ),
    ]);
    setMediaCacheStatus(nextStatus);
    setMediaCacheObjects(objectResult.items);
    setMediaCacheNextCursor(objectResult.nextCursor);
  }

  async function loadMoreMediaCacheObjects() {
    if (!mediaCacheNextCursor) return;
    setMediaCacheBusy('more');
    setError(null);
    try {
      const result = await fetchJson<{
        items: MediaCacheObject[];
        nextCursor: string | null;
      }>(
        `/api/v1/admin/media-cache/objects?limit=20&cursor=${encodeURIComponent(mediaCacheNextCursor)}`,
      );
      setMediaCacheObjects((current) => [...current, ...result.items]);
      setMediaCacheNextCursor(result.nextCursor);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法加载更多缓存对象');
    } finally {
      setMediaCacheBusy(null);
    }
  }

  async function actOnMediaCacheObject(
    object: MediaCacheObject,
    action: 'evict' | 'retry',
    reason: string,
  ) {
    if (
      action === 'evict' &&
      !window.confirm('驱逐这份本地副本？文章、媒体 metadata 与 Telegram 来源证据会保留。')
    ) {
      return;
    }
    setMediaCacheBusy(`${object.id}:${action}`);
    setError(null);
    setMediaCacheNotice(null);
    try {
      const result = await fetchJson<MediaCacheCommandReceipt | { state: 'retry_wait' }>(
        `/api/v1/admin/media-cache/objects/${object.id}/${action}`,
        {
          body: JSON.stringify({ reason }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        },
      );
      await refreshMediaCache();
      setMediaCacheReasons((current) => {
        const next = { ...current };
        delete next[object.id];
        return next;
      });
      setMediaCacheNotice(
        action === 'evict' && 'commandId' in result
          ? `驱逐命令已入队（${result.commandId}），将由 worker 执行。`
          : '对象已重新进入缓存队列。',
      );
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : '媒体缓存操作失败');
    } finally {
      setMediaCacheBusy(null);
    }
  }

  async function reconcileMediaCache(reason: string) {
    if (!window.confirm('运行媒体缓存对账？只会修复缓存账本与可丢弃的本地副本。')) return;
    setMediaCacheBusy('reconcile');
    setError(null);
    setMediaCacheNotice(null);
    try {
      const result = await fetchJson<MediaCacheCommandReceipt>(
        '/api/v1/admin/media-cache/reconcile',
        {
          body: JSON.stringify({ reason }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        },
      );
      await refreshMediaCache();
      setMediaCacheReasons((current) => ({ ...current, reconcile: '' }));
      setMediaCacheNotice(
        `媒体缓存对账命令已入队（${result.commandId}），worker 会自动完成全部分页。`,
      );
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : '媒体缓存对账失败');
    } finally {
      setMediaCacheBusy(null);
    }
  }

  async function signOut() {
    await authClient.signOut();
    await onSessionRevoked('已安全退出。');
  }

  return (
    <main className="desk" data-koharu-ui>
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
          <span
            className={`live-state ${
              status?.collector.state === 'running'
                ? 'is-live'
                : status?.collector.state === 'stale'
                  ? 'is-stale'
                  : ''
            }`}
          >
            <span aria-hidden="true" />
            {status?.collector.state === 'running'
              ? 'Collector 运行中'
              : status?.collector.state === 'stale'
                ? 'Collector 心跳过期'
                : 'Collector 未运行'}
          </span>
          <button className="text-button" onClick={signOut} type="button">
            退出
          </button>
        </div>
      </header>

      {(error ?? statusError) ? (
        <div className="page-error" role="alert">
          {error ?? statusError}
        </div>
      ) : null}

      <div className="desk-grid">
        <aside className="rail">
          <Kicker>ARCHIVE</Kicker>
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
            <Panel className="message-list" aria-labelledby="message-list-title">
              <PanelHeader>
                <div>
                  <Kicker>LEDGER</Kicker>
                  <h2 id="message-list-title">最近消息</h2>
                </div>
                <Badge>{messages.length} 条</Badge>
              </PanelHeader>
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
                {messages.length === 0 ? <EmptyState>这个频道还没有归档消息。</EmptyState> : null}
              </div>
            </Panel>

            <Panel className="message-detail" aria-labelledby="message-detail-title">
              <PanelHeader>
                <div>
                  <Kicker>MESSAGE</Kicker>
                  <h2 id="message-detail-title">消息详情</h2>
                </div>
                {selectedMessage?.sourceUrl ? (
                  <a href={selectedMessage.sourceUrl} rel="noreferrer" target="_blank">
                    原消息 ↗
                  </a>
                ) : null}
              </PanelHeader>
              {selectedMessage ? (
                <>
                  <div className="message-copy">
                    <SafeMessageContent
                      html={selectedMessage.content.html}
                      text={selectedMessage.content.text}
                    />
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
                    <Button disabled={rawLoading} onClick={revealRaw} type="button" variant="quiet">
                      {rawLoading ? '正在读取…' : raw === null ? '揭示原始数据' : '重新读取'}
                    </Button>
                  </div>
                  {raw !== null ? (
                    <pre className="raw-view">{JSON.stringify(raw, null, 2)}</pre>
                  ) : null}
                </>
              ) : (
                <EmptyState>选择一条消息查看详情。</EmptyState>
              )}
            </Panel>
          </div>

          <OperationsPanel
            blockedTasks={blockedTasks}
            channels={configuredChannels}
            collector={status?.collector ?? null}
            loading={operationsLoading}
            onChannelToggle={toggleConfiguredChannel}
            onRerender={rerenderOutdated}
            onTaskAction={actOnTask}
          />

          {mediaCacheStatus ? (
            <MediaCachePanel
              busyAction={mediaCacheBusy}
              nextCursor={mediaCacheNextCursor}
              notice={mediaCacheNotice}
              objects={mediaCacheObjects}
              onAction={actOnMediaCacheObject}
              onLoadMore={loadMoreMediaCacheObjects}
              onReasonChange={(key, reason) =>
                setMediaCacheReasons((current) => ({ ...current, [key]: reason }))
              }
              onReconcile={reconcileMediaCache}
              reasons={mediaCacheReasons}
              status={mediaCacheStatus}
            />
          ) : null}

          <ReconciliationPanel
            busy={reconciliationBusy !== null}
            findings={reconciliationFindings}
            notice={reconciliationNotice}
            nextCursor={reconciliationNextCursor}
            onAction={actOnFinding}
            onLoadMore={loadMoreReconciliationFindings}
            onReasonChange={(findingId, reason) =>
              setReconciliationReasons((current) => ({ ...current, [findingId]: reason }))
            }
            onScan={runReconciliationScan}
            reasons={reconciliationReasons}
            runs={reconciliationRuns}
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
