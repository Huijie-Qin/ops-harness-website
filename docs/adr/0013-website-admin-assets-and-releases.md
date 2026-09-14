# ADR 0013：官网管理员管理发布包、目录与图片

> 本文保留迁移前的决策背景与路径；当前仓库布局和两端配置责任以 [ADR 0014](0014-standalone-website-repository.md) 为准。

状态：接受。用户于 2026-09-13 明确要求扩展管理员模式。

官网继续独立部署，不进入 DSH Runtime。沿用 ADR 0012 的环境密码、会话、同源检查与 CSRF。新增的上传和发布接口仅在管理员认证后可用，公开发布接口仍只读。

- 发布包先上传到 releaseDirectory/.admin-drafts；草稿包含版本、平台、标题、逐条 changelog 与 SHA-512 文件清单。发布前显式确认，复用原有 publishRelease 的校验、互斥锁、不可覆盖归档和原子 catalog 提交。发布后只允许修改说明与可见性，复用相同发布锁和乐观并发校验。协议保持 schemaVersion 1，CLI 继续可用。上传不执行或解压文件，单文件上限 2 GiB、每草稿 8 个文件、最多 100 个草稿、最多 2 个并行上传，上传可取消，超时清理临时文件。
- 文档目录是两级的分组与章节，单独保存为 contentDirectory/guide/navigation.json。支持命名、排序、移动与隐藏；隐藏只影响目录与搜索，直接链接仍可读，停止公开需要归档章节。新章节按 frontmatter 自动补入目录，归档不丢失原目录位置。保存使用章节同一个锁、原子写入和 revision 校验，不批量改写 Markdown。
- 图片保存在 contentDirectory/media，使用内容 SHA-256 文件名和受控 PNG/JPEG/WebP 格式，仅管理员可上传，公共读者按不可变地址读取。上限 10 MiB、4000 张、4000 万像素；拒绝 SVG、HTML、路径和伪装格式。Vditor 通过公开 upload.handler 与 insertValue API 接入上传、粘贴、拖入和图片库。正文仍为标准 Markdown，不允许原始 HTML 或远端图片。
- 运行时数据不会反向同步到 Git。新增 API 错误规范化；失败保留可重试草稿，已发布归档永不覆盖。测试发布使用隔离的配置和目录，验证完成后清理。

原维护文档中“只有 CLI 发布”“图片仅静态资源”和“frontmatter 决定全部目录顺序”的约束由本 ADR 替代。部署需为大文件上传设置匹配的网关大小与超时，并将 releaseDirectory 和 contentDirectory 一并备份。
