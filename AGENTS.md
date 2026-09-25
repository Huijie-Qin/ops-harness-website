# 官网开发约定

- 修改前阅读 README、相关 docs/adr 与 docs/runbooks，并执行 git status --short，保留用户的既有修改。
- 本仓库拥有官网页面、Markdown 文档、管理后台、发布存储、公开更新 API，以及云端定时任务的控制面与编排器。官网进程本身不在进程内运行 DSH，也不读取终端用户的 DSH_HOME、用户会话或 Desktop 状态；但可以按用户拉起/停止隔离的云端实例（Docker 容器，开发联调用本机进程），并持有云端任务、运行记录、产物与令牌，见 docs/adr/0021-cloud-task-execution.md 与 docs/runbooks/cloud-tasks.md。云端任务协议的唯一源码在产品仓库 `packages/shared/cloud-task-contract`，官网只消费 vendor 制品。
- 使用 Node.js 24 及锁定的 pnpm 11.19.0；依赖保持精确版本。共享发布协议的唯一源码在产品仓库，本仓库仅使用 vendor 中的版本制品，按 vendor/README.md 更新。
- 可变内容写到 config 指定的 .runtime 目录。密码通过环境注入，不保存到源码、普通日志或配置文件，不自动反向同步在线内容到 Git；仅管理员明确点击并确认“同步到 content”时，将已保存的文档、目录和图片写回源码，保留备份并校验 revision，不执行 Git 提交。
- Host 是状态权威来源。沿用鉴权、CSRF、并发 revision、互斥锁和原子写入；发布归档不可覆盖，上传不执行文件；不修改 node_modules 或第三方实现。
- UI 沿用现有 Vue 组件、tokens、应用内确认框与可访问交互；不使用原生 select / window.confirm。检查键盘、Escape、焦点、窄屏与减少动态效果。没有产品价值时不要在公开页面展示实现术语。
- 完成 pnpm check 和 pnpm build；UI 修改还需真实浏览器验收并检查 Console、网络及页面切换。临时发布与内容测试使用隔离目录，结束后清理。Windows 更新验收需在目标平台执行，不以 macOS 测试替代。
- 默认监听 loopback。公网发布需明确授权和 HTTPS 网关；不得全局关闭 TLS 验证，不将 .runtime、密码或安装包加入 Git。
