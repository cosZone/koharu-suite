# Telegram 对账与恢复

[English](./README.en.md)

`koharu-suite` 的对账流程用于发现 Bot 持续采集、Telegram Desktop 历史导入和公开消息投影之间的
不一致。它不会把数字空洞当作真实消息，也不会自动从 Telegram 拉取历史。

## 它能知道什么

finding 会保留证据的强弱，而不是统一解释为“消息丢了”：

- durable task pending、blocked、owner skip 是数据库里的确定事实；
- disabled window、Bot retention、`update_id` 跳跃和频道 message ID 空洞只是风险或弱信号；
- Desktop observation 的 stale/conflict 是来源间的确定差异，但不会覆盖 current；
- source-media evidence 缺失、HTML renderer drift 和 invalid current pointer 可以在现有不可变证据
  唯一证明时修复；
- 只有显式声明为完整的频道有界范围，才可以产生 Desktop absence candidate；它仍不是删除事实。

Bot `update_id` 是一个 Bot 的全局序列，并不是频道消息编号。Telegram 还可能因为其他 update 类型、
过滤、长期空闲和 retention 产生合法跳跃。因此数字 gap 永远不会自动创建消息、隐藏内容或推断删除。

## 扫描

对一个或多个已配置频道运行临时 dry-run：

```bash
pnpm exec kodama reconcile telegram \
  --channel=-1001234567890 \
  --channel=-1009876543210
```

默认模式只读取同一个 PostgreSQL snapshot，不写 run、finding 或 audit。`--json` 输出同一份有版本、
有界且脱敏的报告，适合自动化。退出码：

- `0`：clean 或修复已完成；
- `2`：扫描完成，但仍有 open finding 或单项错误；
- `1`：fatal 或 interrupted。

worker 使用 PostgreSQL durable schedule/lease，默认每小时运行一次 persisted scan。重启后会继续从
数据库 claim；同一时间只允许一个对账任务。scheduled worker 只创建/更新 finding，不执行修复。

Owner Desk 显示最近扫描、类别计数和有限 finding 列表。管理响应不会包含消息正文、raw JSON、绝对
路径、Telegram file ID 或 Desktop locator。

## 显式修复

安全修复必须由本地 CLI 或 Owner Desk 显式触发，并提供 1–500 字符的理由：

```bash
pnpm exec kodama reconcile telegram \
  --channel=-1001234567890 \
  --apply \
  --reason "Verified evidence before deterministic repair"
```

apply 会再次验证 finding 的 evidence version，使用全局 advisory lock 和行锁，并把 run、reason、
before/after state 写入审计。允许的修复仅限：

- 从不可变 Desktop observation 恢复可证明的 run/observation lineage；
- 从不可变 observation raw 恢复 source-media evidence；
- 用当前 renderer 重建派生 HTML/version；
- revision 序列唯一且连续时修复 invalid current pointer。

gap、stale、conflict、ambiguous media 和未声明完整范围的 absence 不会被 promote；G2.2 也不会自动把
conflict 设为 current。重复 apply 会返回已有终态或 no-op 审计，不复制消息、revision、raw 或
observation。

## Desktop 辅助补洞

当 finding 指向 disabled/retention/message gap：

1. 在 Telegram Desktop 重新导出目标公开频道的 JSON；
2. 先运行 `kodama import telegram-desktop` dry-run；
3. 审阅报告后显式加 `--apply`；
4. 再运行 reconciliation scan。

```bash
pnpm exec kodama import telegram-desktop \
  --input /path/to/result.json \
  --channel=-1001234567890

pnpm exec kodama import telegram-desktop \
  --input /path/to/result.json \
  --channel=-1001234567890 \
  --apply
```

导入继续复用同一个 source-neutral writer。相同或重叠 export 会留下精确 run lineage，但不会复制
canonical 内容。Desktop export 缺少某条消息本身不代表删除；只有 owner 可以对明确的 absence
candidate 带理由 hide/unhide。

只有你确认 export 对一个明确范围完整时，才在 apply 中重复使用
`--complete-range=<channel>:<startMessageId>:<endMessageId>`：

```bash
pnpm exec kodama import telegram-desktop \
  --input /path/to/result.json \
  --channel=-1001234567890 \
  --complete-range=-1001234567890:1:500 \
  --apply
```

范围必须属于已选择频道，并且只在 clean import run 上保存。它允许对账生成弱
`desktop_absence_candidate`，不会自动隐藏消息。

## 可见性与证据保留

被 owner 隐藏的消息使用 tombstone：

- 从公开列表过滤；
- 公开详情返回普通 `404`；
- suite message ID 不变；
- revision、raw、media、source observation、lineage 和 audit 继续保留。

service token 可以在 scope 允许时读取管理摘要或执行确定性内容修复，但不能 hide/unhide。
raw/provenance 仍只允许 owner 主动揭示，并返回 `Cache-Control: private, no-store`。

## 重跑、回滚与升级

- 扫描、import 和安全 repair 都按 stable key/evidence version 设计为可重跑；
- 在升级前按[部署手册](../deployment/README.md)备份 PostgreSQL；
- migration 只做 additive change；回滚旧应用不会删除新的 runs/findings/lineage/tombstone evidence；
- 若旧版本在回滚期间写入可确定恢复的 evidence，升级后重新 scan/apply；
- 不要手工删除 reconciliation 或 source-evidence 表来“清理”告警。

G2.2 不下载媒体二进制、不建立本地缓存，也不生成缩略图；这些属于 G2.3。
