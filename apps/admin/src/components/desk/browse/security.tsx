import { type FormEvent, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { authClient } from '@/lib/auth';
import type { TotpSetup } from '@/lib/types';

export interface SecurityCardProps {
  enabled: boolean;
  onSessionRevoked(message: string): Promise<void>;
}

/*
 * 账号双重验证,未启用 / 设置中 / 已启用三形态。
 * 流程与错误文案对齐 App.tsx SecurityPanel;错误就地 role="alert"。
 */
export function SecurityCard({ enabled, onSessionRevoked }: SecurityCardProps) {
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
    <Card aria-labelledby="security-card-title">
      <CardHeader>
        <div className="flex items-center gap-3">
          <h3 className="font-serif text-base font-semibold" id="security-card-title">
            双重验证
          </h3>
          <Badge variant="outline">{enabled ? '已启用' : '未启用'}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        {!enabled && !setup ? (
          <form className="grid gap-4" onSubmit={beginSetup}>
            <p className="text-sm text-muted-foreground">
              使用当前密码开始设置。完成验证前，TOTP 不会生效。
            </p>
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
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            <Button className="justify-self-start" disabled={busy} type="submit" variant="outline">
              开始设置
            </Button>
          </form>
        ) : null}

        {!enabled && setup ? (
          <form className="grid gap-4" onSubmit={finishSetup}>
            <p className="text-sm text-muted-foreground">
              在认证器中手动输入密钥，再输入生成的 6 位代码。
            </p>
            <code className="rounded-lg border bg-inset px-4 py-3 text-center font-mono text-sm tracking-[0.2em]">
              {setup.secret}
            </code>
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground underline underline-offset-4">
                显示完整 otpauth URI
              </summary>
              <code className="mt-2 block break-all rounded-lg border bg-inset px-4 py-3 font-mono text-xs leading-relaxed text-muted-foreground">
                {setup.totpURI}
              </code>
            </details>
            <div className="grid gap-2 border-t pt-4">
              <p className="text-sm font-medium">现在保存恢复代码</p>
              <p className="text-xs text-faint">每枚只能使用一次，离开此页后不会再次显示。</p>
              <ul className="grid grid-cols-2 gap-2 font-mono text-xs">
                {setup.backupCodes.map((backupCode) => (
                  <li className="rounded-lg border bg-inset px-3 py-2" key={backupCode}>
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
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            <Button disabled={busy} type="submit">
              {busy ? '正在启用…' : '验证并启用'}
            </Button>
          </form>
        ) : null}

        {enabled ? (
          <form className="grid gap-4" onSubmit={disableTotp}>
            <p className="text-sm text-muted-foreground">
              关闭需要再次输入密码，并会撤销全部登录会话。
            </p>
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
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            <Button
              className="justify-self-start"
              disabled={busy}
              type="submit"
              variant="destructive"
            >
              关闭 TOTP
            </Button>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
