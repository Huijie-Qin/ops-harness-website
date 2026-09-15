# 办公助手官网

独立 Node.js + TypeScript + Vue 3 项目，包含产品介绍、使用指南、更新说明与 Desktop 发布服务。它不承载 DSH 业务 Runtime，也不读取 DSH_HOME。

源码从 ops-harness 的 `src/website` 迁移，保留首页动效、真实截图、帮助文档、Vditor 管理员、目录与图片管理、安装包上传、changelog 和 Desktop 更新 API。迁移边界见 [ADR 0014](docs/adr/0014-standalone-website-repository.md)。安装与运行不需要产品仓库或 DSH。

## 本地运行

代码 clone 到新服务器后，请按 [Ubuntu / Debian 简明部署手册](docs/runbooks/website-deployment-ubuntu-debian.md) 完成环境安装、配置、构建与启动。

在仓库根目录执行（Node.js 24、pnpm 11.19.0）：

```sh
pnpm install --frozen-lockfile
pnpm dev
```

需要管理员模式时，在执行 `pnpm dev` 前按 [维护手册](docs/runbooks/website-guide-maintenance.md#启用管理员模式) 从终端或部署环境注入密码；项目不保存默认密码。

默认访问 `http://127.0.0.1:4173`。开发时同一个 Node 进程处理 API 与 Vite，支持 Vue 热更新。

生产构建的本地预览：

```sh
pnpm build
pnpm start
```

公开页面为 `/`、`/guide`、`/releases`，官网管理员入口为 `/admin`。没有发布记录时，下载区显示“安装包准备中”，更新页展示 `content/development.json` 中明确标注的开发内容，不生成虚假下载链接。

## 首页与使用指南

- `client/HeroAtmosphere.vue`：参考 [DeepSeek Harness 官网](https://www.deepseek.com/harness/) 的蓝色光场与点阵空间感，自行实现 Canvas 动画。鼠标移动带动柔光、扩散涟漪与点阵视差/避让；支持暂停、系统减少动态效果偏好，以及离开可见区域/后台时停止刷新；不加载外部动画脚本。
- `client/WorkspacePreview.vue` / `ProductShot.vue`：展示真实项目的工具市场、我的技能、我的专家截图，支持键盘切换和查看原图。截图保存在 `public/assets/product/`，由开发与生产服务统一提供 `/assets/product/` 路径。
- `content/guide/*.md`：11 个独立 Markdown 章节，包含操作步骤、完成标志、示例与常见问题。更新功能时同步核对对应插件 README 和实际界面，不能将待接入能力描述为已经可用。
- `client/GuidePage.vue`：全文搜索、分组目录、前后章导航和示例复制。支持章节链接及原有 `#step-1` 至 `#step-4` 链接。

### 管理员与 Markdown 维护

管理员入口为 `/admin`。包含“文档编辑、目录与文档管理、发布包、图片库”四个区域。文档编辑页只编辑 Markdown 正文，提供文档选择、预览和正文历史恢复。目录与文档管理页以分组列表集中处理新建、名称与简介、移动、排序、隐藏及回收恢复，操作按钮直接显示。旧 `/guide/admin` 地址自动跳转到 `/admin`。完整操作、内容格式、部署凭据与备份方式见 [帮助文档维护手册](docs/runbooks/website-guide-maintenance.md)。选型比较见 [ADR 0012](docs/adr/0012-markdown-guide-administration.md)。

`client/GuideAdmin.vue` / `MarkdownEditor.vue` 提供管理员登录、Vditor 编辑、阅读预览、版本历史与回收站。管理员密码通过环境提供，没有默认密码；未配置时编辑接口关闭，公开阅读不受影响。日常保存发布到 `.runtime/website-content`。管理员可明确点击“同步到 content”，核对清单后将修改过的文档、目录和图片写回源码，以便检查并提交到主仓；不会自动执行 Git 操作。

编辑器仅在管理员页面加载，附属资源由 `scripts/prepare-assets.mjs` 从锁定的 npm 包复制到本站，生成目录不提交 Git。`scripts/copy-guide.mjs` 将 `content/guide`（包含 `navigation.json`）及 `content/media` 复制到生产构建中。图片继续使用 `/media/<sha256>.<ext>` 地址，在线目录没有该文件时读取构建中的图片。

### 实拍截图维护

当前三张 JPEG 于 2026-09-13 从产品仓库 ops-harness 完成 `pnpm local:bootstrap` 后的真实 Web Runtime 采集；源码基线为 `c75716f`，Profile 为 `web`，运行数据位于仓库 `.runtime/dsh-home`，访问地址为 `http://127.0.0.1:3081/`。图片尺寸均为 1470 × 746。

| 文件 | 实际采集页面 |
| --- | --- |
| tools.jpg | 工具市场 → 系统工具 → 网页抓取 |
| skills.jpg | SKILL 市场 → 我的技能 → 系统内置 |
| experts.jpg | 专家 → 我的专家 |

截图为浏览器内容原图，未用生成图片或重建 UI 替代。采集前折叠会话分组，避免展示私人会话标题；不得展示凭据、登录二维码、个人资料或敏感业务内容。页面中的工具状态与数量是该次运行的实际状态，不作为默认安装状态承诺。界面更新后按相同入口重新采集、检查内容并同步替换首页与指南共用的资源。

## 配置

官网统一使用本仓库根目录的 [`config/website.json`](config/website.json)，包含服务、发布存储、文档存储和管理员密码环境变量名称。也可通过 `DSH_OPS_WEBSITE_CONFIG` 指向另一份完整 JSON，开发服务、生产服务和发布 CLI 共用同一个配置入口。配置文件路径建议使用绝对路径；`releaseDirectory` 和 `contentDirectory` 都相对于该配置文件所在目录解析，也支持绝对路径。

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| schemaVersion | 1 | 配置版本 |
| websiteUrl | http://127.0.0.1:4173 | 官网对外地址，须与 Desktop 客户端配置一致 |
| host | 127.0.0.1 | 服务监听地址 |
| port | 4173 | 监听端口 |
| releaseDirectory | ../.runtime/website-releases | 安装包和发布目录数据 |
| contentDirectory | ../.runtime/website-content | 在线文档、历史、目录配置和图片 |
| adminPasswordEnv | DSH_OPS_WEBSITE_ADMIN_PASSWORD | 注入管理员密码的环境变量名称，配置中不保存密码 |

从旧配置迁移时，将原 `config/releases.json` 和 `config/website-content.json` 的字段合并到一份 `website.json`，仅保留一个 `schemaVersion`。如果新文件位置改变，应同步调整两个存储目录的相对路径，确保仍指向原数据；无需移动在线内容或发布归档。将官网进程原来的 `DSH_OPS_RELEASE_CONFIG` / `DSH_OPS_WEBSITE_CONTENT_CONFIG` 替换为 `DSH_OPS_WEBSITE_CONFIG` 后重启。只设置旧变量时服务和 CLI 会提示迁移并停止，不会静默改用默认目录。密码环境变量保持原名称。配置修改需要重启服务才能生效。

`websiteUrl` 接受 HTTP 或 HTTPS 源地址，包括内网 IP 和域名，不接受账号密码、子路径、查询串或 fragment；填写纯 URL，不要使用 Markdown 链接格式。`host` 与 `port` 控制实际监听，默认仍为 loopback。内网直连可将 `websiteUrl` 设为 `http://7.192.170.132:4173`，`host` 设为服务器网卡上的 `7.192.170.132`，`port` 保持 `4173`；浏览器也必须使用完全相同的协议、地址与端口。管理员密码要求、Host/Origin、CSRF 和 revision 校验继续生效。HTTP 不加密传输，此方式用于受控内网；公网部署仍应由 HTTPS 网关提供 TLS，并保留 Node 服务的 loopback 监听。仅把 `websiteUrl` 改成 HTTPS 不会自动启用 TLS。

以后更换地址时修改此值并重启官网，同时更新产品 Bundle 的 `ops-workbench.config.websiteUrl` 并重新构建客户端；Desktop 从实际加载的 Workbench 配置读取地址，不再使用产品 `config/releases.json` 或 `DSH_OPS_RELEASE_CONFIG`。两边的协议、主机与端口必须一致。共享发布协议 0.1.1 已统一支持 HTTP 和 HTTPS，官网直接使用同一校验器。旧安装包仍执行原 HTTPS / loopback 限制，须通过旧版可用更新源或手动安装升级到包含此改动的客户端后，才能切换到非回环 HTTP 地址；官网修改不会自动迁移旧客户端地址。

## 发布安装包

网页操作：登录 `/admin` → 发布包 → 新建发布，填写版本、平台、标题和 changelog（每行一条）。保存草稿后上传软件包，核对文件清单及 SHA-512，再点击“核对并发布”。上传支持进度与取消，每文件最多 2 GiB，每个平台最多 8 个文件。同版本的两个平台各建一个草稿，并保持标题、说明一致。大于 2 GiB 的包仍可使用 CLI（上限 20 GiB）。

已发布版本可修改标题、更新说明、上下架状态；安装包不可覆盖。草稿及其文件可移至本地回收目录。发布瞬间参与当前自动更新策略，网页新版本默认立即发布、100% 灰度；更细的发布时间、最低版本与灰度策略继续使用 CLI/受控目录维护。

先按 Desktop 文档在目标平台生成安装包。Windows 必须是 NSIS EXE（自动升级），可附 portable ZIP（手工下载）；macOS arm64 必须包含 ZIP（自动升级），可附 DMG（手工安装）。不支持同版本覆盖，应递增产品仓库的 `apps/desktop/package.json` 的版本重新构建。

也可以使用原有命令行流程：创建一份发布说明 JSON，例如 `content/release-notes.example.json`。从仓库根目录运行：

```sh
pnpm release --version 0.2.0 --platform windows-x64 --input /path/to/desktop-artifacts --notes content/release-notes.example.json --rollout 100
# 在 macOS 产物已传到本机的目录上登记另一个平台：
pnpm release --version 0.2.0 --platform macos-arm64 --input /path/to/desktop-mac-artifacts --notes content/release-notes.example.json --rollout 100
```

**CLI 的 `--input`、`--notes`、`--config` 相对路径基于本官网仓库根目录**；可使用绝对路径。`--config /path/to/website.json` 指定完整官网配置，优先于 `DSH_OPS_WEBSITE_CONFIG`；两者都未指定时使用 `config/website.json`。发布 CLI 不需要管理员密码。示例版本必须与真实产物版本一致，不会自动改写应用版本。文件名需包含独立的版本片段；Windows portable ZIP 还需包含 `x64`，macOS 文件名需包含 `arm64`，与当前构建命名一致。混合输入目录按平台筛选。发布工具自动计算大小和 SHA-512，不信任手填哈希。

工具会取得独占发布锁、复制产物到临时目录、计算哈希、验证契约，先提交不可变的 `archive/<version>/<platform>/`，再原子替换 `catalog.json`。同版两个平台共享完全相同的标题与说明。失败不会宣告发布成功；进程崩溃后的 `.publish.lock` 和孤立归档需由发布人员确认没有其他发布进程后检查处理，不自动删除。禁止直接覆盖归档内的文件。

目录结构：

```text
.runtime/website-releases/
  catalog.json
  .admin-drafts/<uuid>/draft.json
  .admin-drafts/<uuid>/files/
  .trash/
  archive/0.2.0/windows-x64/WiseOperation Assistant Setup 0.2.0.exe
  archive/0.2.0/macos-arm64/WiseOperation Assistant-0.2.0-arm64.zip
```

`catalog.json` 使用 `@dsh-ops/release-contract` 的严格 schema。每版可配置 `enabled`、`rolloutPercentage`（0–100）、`minimumVersion`、`publishedAt`。策略变更应停止发布写入，校验整份目录后用同目录临时文件 + rename 替换；不要在服务读取时原地截断文件。目录损坏时 API 返回 503 并保留原文件。

灰度只控制应用内升级；官网展示所有已启用且到达发布时间的版本并允许手动下载。稳定版不会升级到预览版；同版、低版、未启用、不匹配平台、未达到最低版本和不在灰度分组的安装实例都不会获得更新。灰度按安装 UUID + 版本 + 平台稳定分组，不记录设备、用户、会话或密钥。

## 管理接口

新增接口沿用管理员会话、Host/Origin 和 CSRF 校验，保存需携带当前 revision：

| 接口 | 用途 |
| --- | --- |
| GET/POST /api/admin/content-sync | 预览同步文件 / 校验 revision 后写回固定的 content 目录 |
| GET/PUT /api/admin/navigation | 分组、章节顺序与隐藏配置 |
| GET/POST /api/admin/images | 图片库及原始二进制上传（name 查询参数） |
| GET/HEAD /media/:sha256.:ext | 受控图片公开读取 |
| GET/POST /api/admin/releases | 发布清单 / 新建草稿 |
| GET/PUT/DELETE /api/admin/releases/drafts/:id | 读取、更新、移除草稿 |
| POST/DELETE /api/admin/releases/drafts/:id/files?name=... | 上传、移除软件包；上传使用 X-Revision |
| POST /api/admin/releases/drafts/:id/publish | 确认发布草稿 |
| PUT /api/admin/releases/published/:version | 修改版本说明及上下架状态 |

二进制上传使用 `application/octet-stream`，总超时 30 分钟，空闲超时 60 秒。最多两个并行上传；JSON 仍限制大小并使用 15 秒接收超时。生产网关需要匹配请求大小、超时，并转发原始 Host。备份时保留 `contentDirectory` 和 `releaseDirectory`。详见 [ADR 0013](docs/adr/0013-website-admin-assets-and-releases.md)。

## 公开 API

```http
GET /api/releases/check?installationId=123e4567-e89b-42d3-a456-426614174000&currentVersion=0.1.0&platform=windows-x64
```

无更新：`{"schemaVersion":1,"updateAvailable":false}`。有更新返回 `version`、`platform`、固定版本的 `feedUrl`、`releaseNotesUrl`、`artifact: {name, size, sha512}`。协议由产品仓库的 `packages/shared/release-contract/src/index.ts` 维护，官网使用锁定的同包制品，见 [共享协议来源与更新](vendor/README.md)。

| 接口 | 用途 |
| --- | --- |
| GET /health | 服务存活检查 |
| GET /api/releases | 官网版本记录和下载列表 |
| GET /api/releases/check | Desktop 升级策略 |
| GET /updates/archive/:version/windows-x64/latest.yml | electron-updater NSIS 元数据 |
| GET /updates/archive/:version/macos-arm64/latest-mac.yml | electron-updater macOS 元数据 |
| GET /updates/archive/:version/:platform/:filename | 目录中登记的文件，支持 HEAD、单段 Range、ETag |

安装包支持管理员网页上传发布与原有 CLI 发布，复用同一个发布事务。拒绝目录遍历、非法文件名、符号链接和目录外文件；下载流在连接断开时关闭。安装包可放在官网自己的持久化磁盘，目前不接第三方对象存储/CDN。

帮助文档另有只读 `/api/guide`（支持 `q` 全文搜索）、`/api/guide/:id`。`/api/admin/session` 和 `/api/admin/login` 提供登录，`/api/admin/guides`、`/api/admin/guides/:id` 及其 `history`、`restore`、`archive`、`export` 子路由需要管理员会话；写入同时检查 Origin、Host 和 CSRF，使用当前 revision 避免覆盖并发修改。

## 验证与依赖

```sh
pnpm check
pnpm build
```

运行时依赖：Vue 3.5.42（vuejs/core，MIT）、yaml 2.9.0（eemeli/yaml，ISC）、Vditor 4.0.0（Vanessa219/vditor，MIT）、markdown-it 15.0.2（markdown-it，MIT）、由产品仓库维护的 release-contract 0.1.1 制品。构建依赖：Vite 7.3.6 / @vitejs/plugin-vue 6.0.8（vitejs，MIT）、vue-tsc 3.3.11（vuejs/language-tools，MIT）、TypeScript 5.9.2（Microsoft，Apache-2.0）、tsx 4.23.12（privatenumber，MIT）。来源均为 npm；精确版本与完整传递依赖由 pnpm-lock.yaml 管理。Vite/esbuild 为开发构建依赖，不进入 Desktop 运行时。

Windows x64 上的真实 Desktop 更新烟测由产品仓库执行：先在官网运行 `pnpm build`，再在产品仓库设置 `DSH_OPS_WEBSITE_PROJECT` 为官网的绝对路径并运行 `pnpm desktop:smoke:updates`。这只用于跨仓库集成验收，日常运行不需要该变量。

GitHub 的 `Website checks` workflow 自动执行冻结安装、类型检查、测试及构建；跨仓库真实更新验收在产品仓库的 `Desktop and website update integration` 手动 workflow 中固定官网完整提交 SHA 后执行。
