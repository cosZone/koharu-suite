import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';

/* 安全扫描(对账页):触发一次全频道对账扫描,只更新 findings,不修改文章 */
export function ScanCard({
  busyAction,
  canScan,
  onScan,
}: {
  busyAction: string | null;
  canScan: boolean;
  onScan(): void;
}) {
  return (
    <Card aria-labelledby="scan-title">
      <CardHeader>
        <h3 className="font-serif text-base font-semibold" id="scan-title">
          安全扫描
        </h3>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-xs leading-5 text-muted-foreground">
          需要历史补洞时，请导出 Telegram Desktop JSON 后重新扫描。
        </p>
        <div>
          <Button
            disabled={busyAction !== null || !canScan}
            onClick={onScan}
            type="button"
            variant="outline"
          >
            {busyAction === 'scan' ? '处理中…' : '运行安全扫描'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
