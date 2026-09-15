# ADR 0014：官网迁移到独立仓库

- 状态：接受（2026-09-14，用户明确要求迁移到新建的 ops-harness-website 项目）。
- 替代 ADR 0011 中官网源码与 Desktop 位于同一 workspace、共享配置文件的部署安排；发布协议、鉴权和数据边界保持不变。

官网的 Vue 页面、Node 服务、Markdown 基线、实拍资源、管理员能力、发布 CLI、测试与维护文档迁移到 ops-harness-website 仓库根目录。它使用自己的 package.json、pnpm-lock.yaml、TypeScript 配置和 config，独立安装、构建与运行；不依赖相邻仓库、DSH Runtime 或 Desktop 构建。原仓库移除官网 workspace、源码和构建命令，不保留第二套实现。

`packages/shared/release-contract` 仍由 Desktop 仓库维护，是唯一协议实现源。官网通过仓库内附带的精确版本 npm tarball 消费其构建产物，pnpm 锁文件记录完整性，vendor 清单记录来源提交与 SHA-256。这是同一包的离线分发，不建立第二份可编辑实现，不要求发布 npm 包或链接相邻 checkout。协议变化先在源包修改并递增版本，再构建、打包、替换官网制品与清单、更新锁文件并验证两端；不得覆盖同版本制品。将来有受控 registry 后可以替换分发通道。

官网统一持有 `config/website.json`，配置监听、对外地址、发布存储、文档存储和管理员密码环境变量名；Desktop 仓库继续使用 `config/releases.json` 供安装包嵌入客户端。正式地址变更必须同时更新两端，已安装旧客户端仍遵循 ADR 0011 的地址迁移规则。在线文档、图片、历史、发布草稿和归档仅在忽略的运行目录中迁移，不写进源码或 Git；原运行目录保留为回退备份，迁移后仅新服务写入。密码继续由进程环境注入。管理员显式同步到源码的例外见 [ADR 0015](0015-admin-workspace-and-content-sync.md)。

2026-09-14 按用户要求合并官网原 `releases.json` 与 `website-content.json`。服务启动只读取一次完整配置，发布 CLI 复用相同加载器；外部配置入口统一为 `DSH_OPS_WEBSITE_CONFIG`，CLI 的 `--config` 优先。两个存储目录都相对于所选 JSON 所在目录解析，默认数据位置不变。仅提供旧配置环境变量时明确报错，避免迁移遗漏导致静默使用其他目录。配置校验在 vendor 的 `ReleaseConfigSchema` 上增加官网专属字段并保留严格未知字段检查，不修改共享协议制品；Desktop 配置格式与变量名称不变。管理员密码只在服务启动时从配置指定的环境变量读取，保留原有开发/生产长度策略，发布 CLI 不加载凭据。

Desktop 的真实更新集成烟测通过显式 `DSH_OPS_WEBSITE_PROJECT` 指定已经构建的官网 checkout，运行前检查项目身份与产物；未配置时清晰失败。该依赖仅属于主动执行的集成烟测，Desktop 日常构建、类型检查、单元测试、打包及用户运行均不需要官网 checkout。Windows x64 烟测的目标平台限制继续保留。

验收包括官网独立安装与冻结锁文件校验、类型检查、全部官网测试、生产构建和浏览器管理员/读者入口；同时回归共享协议、Desktop 更新单元测试和新的集成产物定位逻辑。未运行的目标平台烟测必须明确记录。

官网的自动检查迁入自己的 GitHub workflow。原 Desktop 构建 workflow 继续执行 Desktop 单元测试，跨仓库真实更新下载移至独立的 `Desktop and website update integration` 手动 workflow，强制输入审核过的官网完整提交 SHA，不拉取浮动 main。官网为私有仓库时需配置仅可读该仓库的 `WEBSITE_REPO_READ_TOKEN`；公开仓库可用默认 token。正式发布前必须运行该集成验收，普通 Desktop 构建不依赖官网仓库可用性。

2026-09-14 按用户明确要求，官网支持受控公司内网的非 loopback HTTP 地址。官网本地的 URL 适配层仅放宽 HTTP 协议限制，其他源地址校验继续调用 vendor 制品；发布路径及版本、平台校验也继续由同一制品生成，避免复制发布协议。服务与发布 CLI 共用此官网配置策略，下载列表与更新 API 可生成配置指定的 HTTP 链接；不修改 vendor、产品仓库或 Desktop 的 HTTPS / loopback 限制，不代表现有 Desktop 接受内网 HTTP 更新源。默认配置仍监听 loopback，公网仍使用 HTTPS 网关。管理员保留密码长度、Host/Origin、CSRF、revision、限流与会话规则，Cookie 的 Secure 标记随配置协议变化。浏览器创建目录和文档的标识改用 HTTP 可用的 getRandomValues，避免依赖仅安全上下文可用的 randomUUID。

2026-09-14 后续用户明确要求 Desktop 也支持 HTTP。共享协议在产品仓库升级为 0.1.1，官网同步精确制品和来源哈希，URL 适配文件改为直接重导出共享实现，不再转换协议。两端保持相同的 HTTP/HTTPS 接受范围及同源、固定版本路径校验；消息 schemaVersion 仍为 1。Desktop 地址归产品 Workbench 配置，旧客户端的升级和地址迁移要求见 README。
