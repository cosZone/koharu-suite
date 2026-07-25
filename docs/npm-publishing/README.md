# `@coszone/koharu-astro` npm 发布

本流程只发布 `packages/koharu-astro`。server、Admin 与内部 UI 继续保持 private，不由 npm workflow
发布。

## PR 产物门

功能分支中的 package 版本是 `0.0.0`，minor Changeset 在 Version Packages PR 中把它提升为首个
`0.1.0`。发布前执行：

```bash
pnpm install --frozen-lockfile
pnpm pack:koharu-astro
```

该命令会：

1. 构建 package；
2. 生成 `.artifacts/koharu-astro/package.tgz`；
3. 只允许 `dist`、`package.json`、中英文 README 与完整 LICENSE；
4. 扫描常见 token、私钥、本机路径、私有仓名称及敏感环境变量赋值；
5. 验证 public registry、public access、provenance 与 repository metadata；
6. 执行不需要 npm 登录的 `npm publish --dry-run --access public`；
7. 输出 tarball 的 SHA-256。

fixture 必须使用审计后的 `.tgz`，不能用 `workspace:*` 代替发布制品。功能 PR 的 CI 会 pack
一次，并把同一份 tarball 依次交给 minimal fixture 和固定 template fixture。

## 首次 package bootstrap：owner checkpoint

首次发布前，owner 必须亲自确认：

- npm 上存在 `coszone` organization，当前 npm 账号是有发布权限的 member/owner；
- npm 账号已开启 2FA，并能完成一次交互式验证；
- Version Packages PR 已合并，tarball 内版本是 `0.1.0`，registry 是
  `https://registry.npmjs.org/`；
- `npm view @coszone/koharu-astro` 仍为 404，包名没有被其他主体占用；
- 从 Version Packages PR 合并后的成功 main CI 下载原始 artifact，其 SHA-256 与 CI
  `Pack and audit koharu-astro` 步骤输出一致。

下载并检查实际待发布文件：

```bash
gh run download <main-ci-run-id> \
  --name koharu-astro-npm-package \
  --dir .artifacts/koharu-astro-ci
shasum -a 256 .artifacts/koharu-astro-ci/package.tgz
tar -xOf .artifacts/koharu-astro-ci/package.tgz package/package.json
```

macOS 与 Linux 的 gzip 实现可能让两个内容相同的 `.tgz` 得到不同的压缩包 SHA-256。不要用本机
重建的 tarball 替换 CI artifact；首次发布直接使用上面下载并核对过的原始文件。

新 package 尚不存在时无法预先绑定 trusted publisher，也不能使用 staged publishing。首次公开必须
由 owner 在本地交互式执行：

```bash
npm login --registry=https://registry.npmjs.org/
npm publish .artifacts/koharu-astro-ci/package.tgz \
  --access public \
  --tag latest \
  --provenance=false \
  --registry=https://registry.npmjs.org/
```

该命令是不可逆的 owner checkpoint，npm 会要求 2FA。`--provenance=false` 只用于这一次本地
bootstrap：本地终端无法生成 GitHub Actions provenance。不要删除 package metadata 中的
`publishConfig.provenance: true`。任何 scope ownership、2FA、版本或 digest 不一致都必须停止；
不要换个人 scope，也不要创建长期 automation token。

## 后续版本：OIDC + staged approval

package 存在后，在 npm package Settings 中添加唯一 trusted publisher：

- Provider：GitHub Actions
- Organization/User：`cosZone`
- Repository：`koharu-suite`
- Workflow：`stage-koharu-astro.yml`
- Environment：`npm`

同时在 GitHub 创建受保护的 `npm` environment，并要求 owner approval。两端都完成后，设置 repository
variable `NPM_TRUSTED_PUBLISHING_CONFIGURED=true`，解锁 workflow 的 fail-closed gate。仓库不得添加
`NPM_TOKEN`；workflow 使用 GitHub-hosted runner、固定 npm `11.18.0` 与 `id-token: write` 获取短期
OIDC 身份。npm staged publishing 要求 CLI `>=11.15.0`。

后续版本：

1. 合并 Changeset 生成的 Version Packages PR；
2. 手动运行 `Stage koharu-astro on npm`，选择 `latest` 或 `next` 并确认 stage；
3. workflow 重新构建、审计 tarball，再通过 OIDC 执行 `npm stage publish`；
4. owner 在 npm 核对 staged manifest、SHA-256、version 与 dist-tag 后，用 2FA approve；
5. 从 registry 安装精确版本，在独立 Astro fixture 再跑一次 smoke。

OIDC trusted publishing 会为公开仓库中的公开 package 自动生成 provenance，不需要长期 npm token，
也不需要额外传 `--provenance`。

## 回退

npm 已发布版本不可覆盖。发现严重问题时 deprecate 受影响版本并发布修复版本；不要依赖 unpublish。
未启用 adapter 的 Astro 站点不受影响，已启用站点可 pin 旧版本或移除 live config 恢复纯静态路径。

英文版见 [README.en.md](./README.en.md)。
