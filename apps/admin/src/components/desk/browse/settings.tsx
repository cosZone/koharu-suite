import { useEffect, useState } from 'react';
import { ConfirmAction } from '@/components/desk/confirm-action';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { AdminConfigResponse, AdminConfigSetting } from '@/lib/types';

export interface ConfigSettingsCardProps {
  config: AdminConfigResponse;
  busyAction: string | null;
  reasons: Record<string, string>;
  onReasonChange(key: string, reason: string): void;
  onSave(changes: Record<string, string | null>, reason: string): void;
}

/* endpoint/bucket/prefix 共同决定 S3 命名空间,变更前必须先迁移数据 */
const S3_NAMESPACE_ENV_NAMES = new Set(['S3_ENDPOINT', 'S3_BUCKET', 'S3_PREFIX']);

/*
 * 表单基线:有待重启覆盖时显示覆盖值(密钥除外,永不回显),
 * 否则显示当前生效值;密钥始终从空开始。
 */
export function configSettingBaseline(setting: AdminConfigSetting): string {
  if (setting.secret) {
    return '';
  }
  if (typeof setting.pendingValue === 'string') {
    return setting.pendingValue;
  }
  return typeof setting.effective === 'string' ? setting.effective : '';
}

export function configSettingInitialValues(config: AdminConfigResponse): Record<string, string> {
  const values: Record<string, string> = {};
  for (const section of config.sections) {
    for (const setting of section.settings) {
      values[setting.envName] = configSettingBaseline(setting);
    }
  }
  return values;
}

export interface ConfigPendingChanges {
  changes: Record<string, string | null>;
  editCount: number;
  errors: Record<string, string>;
}

/*
 * 变更计算:清除标记优先(映射为 null,即删除覆盖);
 * 未改动的字段(含留空的密钥)省略;非法数字只记 error 不进 changes。
 */
export function configPendingChanges(
  config: AdminConfigResponse,
  values: Record<string, string>,
  clears: ReadonlySet<string>,
): ConfigPendingChanges {
  const changes: Record<string, string | null> = {};
  const errors: Record<string, string> = {};
  let editCount = 0;
  for (const section of config.sections) {
    for (const setting of section.settings) {
      if (clears.has(setting.envName)) {
        editCount += 1;
        changes[setting.envName] = null;
        continue;
      }
      const baseline = configSettingBaseline(setting);
      const value = values[setting.envName] ?? baseline;
      if (value === baseline) {
        continue;
      }
      editCount += 1;
      if (setting.kind === 'number' && !/^\d+$/.test(value)) {
        errors[setting.envName] = '请输入非负整数。';
        continue;
      }
      changes[setting.envName] = value;
    }
  }
  return { changes, editCount, errors };
}

/*
 * 运行配置表单:按注册表分组渲染,密钥只写,locked 项禁用,
 * 有覆盖的项可标记「清除」(提交为 null 即删除覆盖);保存需必填
 * reason 并经 ConfirmAction 确认;变更重启后生效。
 */
export function ConfigSettingsCard({
  busyAction,
  config,
  onReasonChange,
  onSave,
  reasons,
}: ConfigSettingsCardProps) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    configSettingInitialValues(config),
  );
  const [clears, setClears] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    setValues(configSettingInitialValues(config));
    setClears(new Set());
  }, [config]);

  const busy = busyAction !== null;
  const reason = reasons['config-save']?.trim() ?? '';
  const { changes, editCount, errors } = configPendingChanges(config, values, clears);
  const hasErrors = Object.keys(errors).length > 0;

  function setValue(envName: string, value: string) {
    setValues((current) => ({ ...current, [envName]: value }));
  }

  function markClear(envName: string) {
    setClears((current) => new Set(current).add(envName));
  }

  function undoClear(envName: string) {
    setClears((current) => {
      const next = new Set(current);
      next.delete(envName);
      return next;
    });
  }

  function dirtyWarning(setting: AdminConfigSetting, baseline: string): string | null {
    if ((values[setting.envName] ?? baseline) === baseline) {
      return null;
    }
    if (S3_NAMESPACE_ENV_NAMES.has(setting.envName)) {
      return '警告：变更 S3 命名空间前需先完成已有数据迁移。';
    }
    if (setting.envName === 'MEDIA_CACHE_ROOT') {
      return '警告：仅修改路径，不会搬移已有缓存。';
    }
    return null;
  }

  function renderSetting(setting: AdminConfigSetting) {
    const baseline = configSettingBaseline(setting);
    const value = values[setting.envName] ?? baseline;
    const cleared = clears.has(setting.envName);
    const disabled = busy || setting.locked || cleared;
    // 已有覆盖(含待重启覆盖)才可清除;locked 项服务端拒绝一切变更
    const canClear =
      !setting.locked && (setting.source === 'override' || setting.pendingValue !== undefined);
    const warning = cleared ? null : dirtyWarning(setting, baseline);
    const hint = setting.locked ? (
      <>由环境变量锁定。{setting.description}</>
    ) : (
      <>
        {setting.description}
        {cleared ? (
          <span className="block text-destructive">
            已标记清除：保存后移除此项覆盖，重启后恢复默认值。
          </span>
        ) : null}
        {warning ? <span className="block text-destructive">{warning}</span> : null}
      </>
    );
    const clearControl = canClear ? (
      cleared ? (
        <Button
          disabled={busy}
          onClick={() => undoClear(setting.envName)}
          size="xs"
          type="button"
          variant="ghost"
        >
          撤销清除
        </Button>
      ) : (
        <Button
          className="text-destructive hover:text-destructive"
          disabled={busy}
          onClick={() => markClear(setting.envName)}
          size="xs"
          type="button"
          variant="ghost"
        >
          清除
        </Button>
      )
    ) : null;
    const label = (
      <span className="flex items-center gap-2">
        {setting.label}
        {setting.pendingRestart || cleared ? <Badge variant="outline">重启后生效</Badge> : null}
        {clearControl}
      </span>
    );

    if (setting.kind === 'boolean') {
      return (
        <div className="flex items-center justify-between gap-4" key={setting.envName}>
          <div>
            <p className="text-sm">{label}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
          </div>
          <Switch
            aria-label={setting.label}
            checked={value === 'true'}
            disabled={disabled}
            onCheckedChange={(checked) => setValue(setting.envName, checked ? 'true' : 'false')}
          />
        </div>
      );
    }

    return (
      <Field error={errors[setting.envName]} hint={hint} key={setting.envName} label={label}>
        <Input
          autoComplete={setting.secret ? 'new-password' : 'off'}
          disabled={disabled}
          inputMode={setting.kind === 'number' ? 'numeric' : undefined}
          onChange={(event) => setValue(setting.envName, event.target.value)}
          pattern={setting.kind === 'number' ? '[0-9]+' : undefined}
          placeholder={setting.secret ? '已配置（留空保持不变）' : undefined}
          type={setting.secret ? 'password' : 'text'}
          value={value}
        />
      </Field>
    );
  }

  return (
    <Card aria-labelledby="config-settings-title">
      <CardHeader>
        <h3 className="font-serif text-base font-semibold" id="config-settings-title">
          运行配置
        </h3>
        <p className="text-xs text-muted-foreground">
          变更保存到数据库，重启 server 与 worker 后生效；密钥只写不读。
        </p>
      </CardHeader>
      <CardContent className="grid gap-5">
        {config.sections.map((section, index) => (
          <section
            aria-labelledby={`config-section-${section.id}`}
            className={index > 0 ? 'grid gap-3 border-t pt-5' : 'grid gap-3'}
            key={section.id}
          >
            <h4 className="text-sm font-medium" id={`config-section-${section.id}`}>
              {section.label}
            </h4>
            {section.settings.map(renderSetting)}
          </section>
        ))}
        <section aria-labelledby="config-save-title" className="grid gap-3 border-t pt-5">
          <h4 className="text-sm font-medium" id="config-save-title">
            保存变更
          </h4>
          <Field label="变更原因（必填，将写入审计记录）">
            <Input
              disabled={busy}
              maxLength={500}
              onChange={(event) => onReasonChange('config-save', event.target.value)}
              placeholder="例如：启用 S3 耐久副本"
              value={reasons['config-save'] ?? ''}
            />
          </Field>
          <div>
            <ConfirmAction
              busy={busyAction === 'config-save'}
              busyLabel="正在保存…"
              confirmText="保存配置变更？变更将写入数据库，需重启 server 与 worker 后生效。"
              disabled={busy || editCount === 0 || hasErrors || reason.length === 0}
              label="保存配置变更"
              onConfirm={() => onSave(changes, reason)}
            />
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
