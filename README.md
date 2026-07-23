# koharu-suite

[中文](#中文) · [English](#english)

## 中文

`koharu-suite` 是 [astro-koharu](https://github.com/cosZone/astro-koharu) 的可选伴生后台，计划提供
Telegram 多频道归档、动态内容、统一管理与静态发布能力。

核心原则：

- 默认保持 astro-koharu 的纯静态构建与部署体验；
- 需要时再连接独立的 suite 后端；
- 内容与媒体可导出、可恢复，移除后端不影响既有静态站点；
- 以 PostgreSQL、Astro 6 Live Content Collections 和开放 JSON API 为基础。

> 当前状态：规划阶段，尚未开始实现。路线图将通过 GitHub Issues 跟踪。

## English

`koharu-suite` is an optional content backend and publishing companion for
[astro-koharu](https://github.com/cosZone/astro-koharu). It is planned to provide multi-channel Telegram
archiving, live content, unified administration, and static publishing workflows.

The static astro-koharu experience remains the default. The suite is connected only when its dynamic
capabilities are needed.

> Status: planning. Implementation has not started yet.

## License

[AGPL-3.0](./LICENSE)
