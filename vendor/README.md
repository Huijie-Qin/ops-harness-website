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
