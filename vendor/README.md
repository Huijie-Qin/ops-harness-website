# 共享发布协议制品

`dsh-ops-release-contract-0.1.1.tgz` 是产品仓库 `packages/shared/release-contract` 的原始 pnpm pack 产物，统一官网与 Desktop 的显式 HTTP/HTTPS 源地址规则。来源提交、输入哈希与制品 SHA-256 记录在 [release-contract.json](release-contract.json)。源包由产品仓库维护；官网不直接修改制品内的校验器。旧 0.1.0 制品保留用于审计，不再被当前依赖引用。

未提交源码的本地联调制品以 `sourceWorkingTree: true` 明确标记，`sourceCommit` 记录基线，`sourceSha256` 固定实际输入；不将基线提交冒充已包含改动的发布提交。正式发布应从审核后的对应源码重新构建并核对输入哈希。

本仓库随源码保存此包，安装不需要相邻 checkout、私有 registry 凭据或联网拉取 Git 仓库。pnpm-lock.yaml 校验 tarball 完整性；第三方依赖仍按锁文件从 npm 安装。没有新增第三方协议实现、原生依赖或许可证授权。

升级时先在产品仓库修改源包、递增精确版本、运行契约与 Desktop 更新测试并提交审核后的源码。在该仓库执行：

```sh
pnpm --filter @dsh-ops/release-contract build
pnpm --dir packages/shared/release-contract pack --pack-destination /path/to/ops-harness-website/vendor
```

随后在官网更新 package.json 中的制品路径、此来源清单和锁文件，执行 `pnpm install`、`pnpm check`、`pnpm build`。确认旧客户端兼容性后在 Windows x64 完成跨仓库更新烟测。不得覆盖同版本制品或单独维护另一份协议源码。协议源码的 Git 历史保留在产品仓库，后续可以改用受控 registry 分发相同包。

## 云端定时任务协议

`dsh-ops-cloud-task-contract-0.2.1-<sha256前12位>.tgz` 来自产品仓库 `packages/shared/cloud-task-contract` 的 pnpm pack，是产品 Host、官网控制面与云端执行器三方共用的协议（zod strict schema、限额常量、`cloudRoutes` 路由表，contractVersion 1）。来源、工作区输入及 SHA-256 见 [cloud-task-contract.json](cloud-task-contract.json)。官网只导入 `@dsh-ops/cloud-task-contract` 的 schema/常量/路由，不加载 Host/Cordis，也不在本仓库另写一份协议实现；契约缺口先用本地 zod 扩展并在报告中登记，再回产品仓库改源包。更新方式与运营打点协议相同：产品仓库 build 后 pack 到 vendor，以内容哈希命名新制品，更新 package.json、输入/制品哈希，执行官网 `pnpm install --no-frozen-lockfile` 与 check/build。当前制品来自产品仓库已提交的源码 4a0f9bf（分支 claude/cloud-workspace-task-execution-123920，契约 0.2.1），输入哈希已核对；正式发布应从合入主线并审核后的源码重新生成。

## 运营打点协议

`dsh-ops-tracking-0.1.0-<sha256前12位>.tgz` 来自产品仓库 `packages/shared/logger-tracking` 的 pnpm pack。来源、工作区输入及 SHA-256 见 [tracking.json](tracking.json)。官网仅导入 `@dsh-ops/tracking/contracts`，不加载 Host/Cordis。更新时在产品仓库完成 build/test 后 pack 到 vendor，以内容哈希命名新制品（避免同路径缓存旧包），更新 package.json、输入/制品哈希，执行官网 `pnpm install --no-frozen-lockfile` 与 check/build。当前为明确标记的 sourceWorkingTree 联调制品，正式发布应从审核后的源码重新生成。
