# ADR 0012：Markdown 帮助文档与管理员编辑

> 本文保留迁移前的决策背景与路径；当前仓库布局和两端配置责任以 [ADR 0014](0014-standalone-website-repository.md) 为准。

- 状态：接受，2026-09-13 用户要求按章节维护 Markdown 并引入开源在线编辑器。
- 范围：独立官网 `src/website`，不引入 DSH 插件或改变 Desktop 更新协议。

## 开源调研与选择

2026-09-13 通过 GitHub 官方 API 核对，Star 数是当日快照，不作为维护质量的唯一依据。

| 方案 | Stars | 维护与适配 | 结论 |
| --- | ---: | --- | --- |
| [Vditor](https://github.com/Vanessa219/vditor) | 11,317 | MIT，2026-09-11 有更新；TypeScript、框架无关，官方支持 Vue；所见即所得、即时渲染、Markdown 分屏三种模式，中文维护友好 | 采用 `vditor@4.0.0` |
| [Milkdown](https://github.com/Milkdown/milkdown) | 11,908 | MIT，活跃；ProseMirror / remark 插件体系，有 Vue 集成，适合深度定制 | 本次需要完整源码编辑与分屏工作流，集成成本更高 |
| [md-editor-v3](https://github.com/imzbf/md-editor-v3) | 2,587 | MIT，Vue 3 / TypeScript 原生适配，活跃；主要为 Markdown 分屏体验 | 可作为后续 Vue 原生替代方案 |
| [TOAST UI Editor](https://github.com/nhn/tui.editor) | 18,023 | MIT，2024-08-01 后未更新，仓库已归档 | 不因 Star 较高引入归档项目 |

Vditor 来源为 npm 官方仓库，维护者 Vanessa，无原生构建。通过 Vue 组件管理初始化、内容同步与销毁，仅管理员页面延迟加载。依赖锁定精确版本，由 pnpm-lock.yaml 锁定传递依赖；不修改 node_modules，不创建上游 Patch。编辑器资源从已安装包复制到本站构建目录，不依赖公网 CDN。复杂图表扩展不属于本次帮助文档格式；正文以标准 Markdown、列表、表格、链接、图片和代码块为准。

## 内容与持久化

`content/guide/*.md` 为受 Git 管理的发布基线；每章一个文件，YAML frontmatter 保存稳定 ID、标题、分组、排序和简介。正文不再嵌在 Vue / TypeScript。FAQ 同样是一章 Markdown。支持直接修改源文件，开发服务重新读取即可显示；生产构建携带基线文件。

在线修改保存在 `.runtime/website-content/guide`，以 Markdown 覆盖对应基线。服务端是唯一权威来源，前端只持有尚未保存的草稿；不在 localStorage 保存业务内容或凭据。在线内容优先，部署新代码不会覆盖人工编辑。管理员可下载当前 Markdown，人工审查后纳入 Git；运行状态不自动反向写入源码。备份时同时备份该内容目录。

提供章节新增、编辑、排序/分组、回收与恢复、历史版本查看和恢复。写入需携带读取时的 revision，冲突返回 409，保留当前草稿。文件经过 schema 校验，以同目录临时文件加原子 rename 提交，写入串行且用文件锁隔离同目录的多个进程；历史保留被替换的完整 Markdown。章节 ID / 大小 / 数量受限，拒绝路径穿越和不安全符号链接。

## 管理员与网络边界

公开阅读接口只读；独立管理员登录使用配置指定的环境变量提供密码，不提供默认密码，不写入源码或普通日志。未配置凭据时公开阅读可用，管理员写入关闭。管理员会话为随机 HttpOnly、SameSite=Strict Cookie，HTTPS 地址添加 Secure；会话有时限，退出立即失效。

所有管理写操作检查配置中的站点 Origin、Host、JSON 类型及会话 CSRF token；登录限制失败频率。原有 release 路由继续只读，不提供发布安装包的网页管理入口。Markdown 渲染关闭原始 HTML，并限制链接和图片地址；不执行文档中的脚本。编辑器所需的 inline 样式仅在管理员页面 CSP 中允许，script-src 仅允许 self 与锁定版本 ant.js 图标资源的 SHA-256 哈希。Vditor 4.0.0 默认以同步请求读取该脚本后内联执行；服务启动时根据随构建发布的确切字节计算哈希，只在管理员页面许可，不允许任意 inline / eval，不修改上游依赖或私有对象。

管理员凭据由部署人员通过环境或其凭据管理器提供，不能因本地模式省略服务端鉴权。验收使用独立临时内容目录与仅存在于测试进程环境的凭据，不修改真实帮助正文。

2026-09-13 根据用户指定本地开发密码的要求，只有 `--dev`、监听地址为 loopback 且 `websiteUrl` 为 loopback HTTP 时，密码最短长度为 6；其他环境仍为 16，最大均为 256。该例外不改变登录、会话、限流或 CSRF 校验，不提供默认密码。实际凭据只传入当前服务进程的环境，不写入源码或配置。

## 验证

覆盖章节解析、BOM/CRLF、非法 frontmatter、路径/符号链接、并发冲突、历史恢复、回收、鉴权/CSRF/Origin/限流，以及安全 Markdown。真实浏览器检查公开阅读、目录和搜索、管理员编辑/保存/刷新/历史、退出、桌面和手机布局，并验证生产环境资源不依赖外部 CDN。
