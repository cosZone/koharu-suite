import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { authClient } from '@/lib/auth';
import { cn } from '@/lib/utils';

type AuthStep = 'login' | 'two-factor';
type VerifyMethod = 'recovery' | 'totp';

export function LoginCard({ onComplete }: { onComplete(): Promise<void> }) {
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
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <p className="text-xs tracking-wide text-faint">KOHARU SUITE · OWNER DESK</p>
        <h1 className="mt-3 font-serif text-3xl font-semibold">
          {authStep === 'login' ? '回到你的内容室。' : '再确认一次。'}
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {authStep === 'login'
            ? '这里只有一把钥匙。登录后可以查看归档状态、浏览消息，并按需揭示 Telegram 原始数据。'
            : '密码已经通过。输入认证器代码，或改用一枚尚未使用的恢复代码。'}
        </p>

        <div className="mt-8 rounded-lg border bg-card p-6">
          {authStep === 'login' ? (
            <form className="grid gap-4" onSubmit={submitPassword}>
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
              {error ? (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
              <Button disabled={busy} type="submit">
                {busy ? '正在验证…' : '进入管理台'}
              </Button>
            </form>
          ) : (
            <form className="grid gap-4" onSubmit={submitTwoFactor}>
              <fieldset className="grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border">
                <legend className="sr-only">验证方式</legend>
                <button
                  aria-pressed={verifyMethod === 'totp'}
                  className={cn(
                    'bg-card px-3 py-2 text-sm transition-colors',
                    verifyMethod === 'totp'
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
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
                  className={cn(
                    'bg-card px-3 py-2 text-sm transition-colors',
                    verifyMethod === 'recovery'
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
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
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <input
                    checked={trustDevice}
                    className="accent-primary"
                    name="trust-device"
                    onChange={(event) => setTrustDevice(event.target.checked)}
                    type="checkbox"
                  />
                  <span>信任这台设备 30 天</span>
                </label>
              ) : null}
              {error ? (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
              <Button disabled={busy} type="submit">
                {busy ? '正在确认…' : '完成验证'}
              </Button>
            </form>
          )}
        </div>

        <p className="mt-4 text-xs leading-5 text-faint">
          {authStep === 'login'
            ? 'Owner 只能通过本机 kodama CLI 创建或重置。'
            : '信任设备默认关闭；它不会跳过密码。'}
        </p>
      </div>
    </main>
  );
}
