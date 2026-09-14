# ADR 0011：桌面升级与产品官网

> 本文保留迁移前的决策背景与路径；当前仓库布局和两端配置责任以 [ADR 0014](0014-standalone-website-repository.md) 为准。

- 状态：接受（2026-09-11，用户明确要求实现，官网先使用可配置的本地地址）
- 参考：dataelement/dsh-desktop，当前参考副本位于 code/dsh-desktop，只读；参考提交 `c7e6a59eec467810adb46032530533667af51f55`。

## 上游实现与本项目的取舍

上游的 `src/main/update/update-manager.ts` 负责 Electron 更新状态机、定时检查、下载和安装；
`update-policy.ts` / `version-catalog.ts` 处理版本策略及固定版本下载源，`skipped-version.ts`
保存跳过选择，`src/preload/update-view.ts` 提供受限的窗口通信。核心顺序是先取得服务端策略，
再将 electron-updater 的 generic provider 指向获准版本，确认后下载并交给平台安装器。

本项目沿用这一顺序和“自动检查、用户确认下载与安装”的行为，提供自己的 release check 服务、
产品窗口和配置；不引入上游应用业务代码，不修改上游副本，不复制关闭签名校验的设置。
为了延续 Windows 安装性能优化，当前统一完整下载，保留 NSIS 的 ZIP 压缩，不启用差分更新。

## 边界

Desktop 拥有整包更新的检查、下载、跳过版本、进度和安装生命周期。通过托盘的“检查更新”打开应用自有的更新窗口，自动检查发现新版本时显示同一窗口。更新窗口使用隔离、沙箱化的 preload；只接受该窗口主 frame 的 IPC，不向 DSH Web 页面或公网暴露安装接口。安装前明确确认重启并停止现有后台。业务插件与 Workbench 不持有更新状态。

用户要求在根目录 src 内新增官网子项目。src/website 是独立的 Node.js + TypeScript + Vue 项目，提供产品介绍、使用指南、更新说明、下载与 release check。它不启动 DSH，不读用户的 DSH_HOME、会话或密钥。开发默认只绑定 127.0.0.1:4173。正式部署由独立 Node 服务与 HTTPS 网关承担，不发布到 Sites。

packages/shared/release-contract 是两者实际共用的纯数据契约包，包含版本、平台、目录、配置和策略校验；不引入 Cordis、文件、网络或业务 UI 依赖。包在两端显式声明，不复制版本/URL 校验实现。

## 协议与配置

config/releases.json 是发布配置源，websiteUrl 默认 http://127.0.0.1:4173。Desktop 打包复制为 resources/release-config.json；开发读取源码配置。可通过显式 DSH_OPS_RELEASE_CONFIG 指定外部配置文件。允许 HTTPS 或 loopback HTTP，拒绝凭据、查询串、fragment、非根路径和远端明文 HTTP。不扩大 Desktop 后台的 TLS 特例。

GET /api/releases/check 接收 installationId（随机 UUID）、currentVersion、platform（windows-x64 / macos-arm64）。返回 schemaVersion: 1 与 updateAvailable；有更新时包含 version、feedUrl、releaseNotesUrl、artifact（文件名、字节数、SHA-512）。自动与手动检查使用同一策略：仅考虑启用、已到发布时间、匹配平台、满足最低版本和灰度百分比的更高版本，稳定版不进入预览版。灰度桶用 installationId + version + platform 的 SHA-256 决定，保证跨次检查稳定；无候选返回无更新。策略错误或源不可用停止检查，不回退到未受策略控制的 latest。

GET /api/releases 提供公开版本、说明和下载链接；GET /updates/archive/:version/:platform/latest.yml（macOS 为 latest-mac.yml）提供 electron-updater generic feed，文件由同目录下载路由流式输出，支持 HEAD 和单段 Range。服务端不信任请求的 Host/forwarded headers 来生成 URL。文件只来自经过 schema 校验的目录清单，拒绝越界、符号链接和未知文件。

发布目录在 .runtime/website-releases（可配置），不进入源码或安装包。发布 CLI 根据真实已构建、最终签名后的文件流式计算 SHA-512 和大小，复制到按版本/平台隔离的不可变目录，最后以锁和原子 rename 更新 catalog.json。缺少更新必需文件、重复版本平台、非法路径、校验失败时拒绝发布；未就绪产物不出现在检查接口。网页不伪造发布版或下载链接，初始开发版说明明确标识。

## 客户端行为

正式 Windows NSIS 与 macOS ARM64 支持安装更新；Windows ZIP/unpacked 通过安装器写入的标记区分，提供官网下载入口。启动 15–30 秒检查，之后每 6 小时，休眠恢复时按最后检查时间补检。autoDownload 与 autoInstallOnAppQuit 均关闭。单次操作互斥，检查与下载有超时/取消，卸载管理器清理定时器、监听和 IPC。跳过版本按 schemaVersion 保存在 Electron userData 下，原子写入，手动检查忽略跳过标记。

保持现有 NSIS useZip: true、differentialPackage: false 的安装性能优化；Windows 设置 disableDifferentialDownload，下载完整 EXE。macOS 使用 ZIP 更新、DMG 手动安装。更新仍由 electron-updater 校验 SHA-512；保留库的签名验证默认行为，不通过关闭签名验证完成生产升级。不提供自动降级或失败后的数据回滚，避免旧应用读取已经迁移的数据。

## 验证与交付

覆盖共享协议、服务端筛选与灰度、目录发布原子性、文件服务边界/Range、客户端确认/重试/取消/并发/跳过/安装前清理和 IPC 来源。完成官网与更新窗口真实浏览器/Chromium 验收、桌面包构建及 Windows 冒烟。生产签名、正式域名上线和 macOS 目标机升级验证另列实际完成情况，不以 Mock 代替。
