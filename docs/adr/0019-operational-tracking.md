# ADR 0019：独立运营事件接收与统计

状态：已接受。2026-09-20 用户批准产品 shared/logger-tracking 与官网运营统计的编码。

官网新增机器采集 API `/api/tracking/v1/events:batch` 和管理员 `/api/admin/analytics/*`。普通 logger 保持原实现，官网不访问终端 DSH_HOME。

- 事件协议源码在产品仓库 `packages/shared/logger-tracking`，通过 `@dsh-ops/tracking/contracts` 的精确 vendor tarball 分发。纯契约不导入 DSH 或 Cordis；这些 Host peer 为 optional，官网不安装或运行插件。
- 2026-09-20 用户调整范围：开发调试免认证，生产验证暂不实现。仅 `--dev` 且 `trackingDevelopment: true` 开放本机 Host POST；不配置 Token 或凭据环境变量。批次自报 installationId/environment，服务端固定开发 tenant，拒绝 production、浏览器 Origin/Fetch-Metadata 与非 loopback 连接，仍限制大小、频率和并发。正常生产启动关闭采集入口。
- 按用户最新决定，直接采用工作助手左下角登录工号的同源 Host 字段（WeLink auth.accountLabel）；无需额外 SSO。事件可选携带 employee.source=welink 与规范化 employeeId，官网按 tenant + source + 工号跨安装去重。只用于统计归属，不用于管理员或生产上传鉴权。旧 identityRef 保留兼容，二者互斥；历史匿名记录不追归当前工号。identity-sessions 仍不开放。
- SQLite 单机本地盘，独立 analyticsDirectory，由有界 Worker 串行处理；WAL、FULL 同步、参数化查询与版本表。事件、去重、受影响日期汇总同一事务提交后确认。唯一 eventId 防重传，operationId 防重复终态。
- 终态可早于受理到达：暂挂起统计，等受理身份匹配后归属。身份快照绑定安装和发生时间，切号后不能重分配旧事件。
- 原始明细 90 天，幂等索引 120 天，轻量 activity_facts 与用户日汇总 400 天；补传限 30 天。facts 保留用户及动作去重键，支持平台/版本切片后的精确人数。每小时清理到期数据，不存消息/文档正文或凭据。
- 管理查询沿用现有管理员会话和 Host 检查，只读、分页、no-store。后台提供总览、用户明细/个人操作、活跃排名、功能使用、操作明细和采集状态。
- 默认环境由认证保护的 `GET /api/admin/analytics/context` 返回：只有显式开发采集模式为 development，其余为 production；省略 environment 的管理查询采用同一默认值。页面先取配置，再应用浏览器中保存的有效手动选择，避免开发数据被默认生产筛选隐藏。空态仅描述当前环境与筛选范围，匿名次数与实名人数保持区分。
- DAU 是已识别用户的人工业务受理，MAU 是截至日近30天去重，不累计 DAU。自动任务、匿名设备、页面访问、自动登录不增加 DAU。

产品新增公开会话事件适配：当前官方 Web 消息以 user + rpcId + clientTimeZone 组合识别，其他入口保留 unknown，子代理单列 agent；不把所有 user-role 消息计为人工。仅上报标识摘要、计数与白名单属性，不传消息/Skill 正文。日常联调直连本地 website；自动化验证使用隔离 fixture，不生成伪造生产用户统计。配置与恢复步骤见 [运营统计部署](../runbooks/operational-tracking.md)。

2026-09-20 增加 conversations / skills 管理查询与视图，用户明细增加对话、Token、Skill 加载指标。SQLite schema v2 事务新增 runtime_facts，保留400天并跟随 activity_facts 级联清理，兼容旧消息事件。Token 按每个已结束步骤的最新报告统计；总量四桶相加，推理为输出子集；缺失用量独立展示。Skill 以成功加载指令为使用事实，按运行时名称聚合，区分显式/模型及失败；不等同于工作流完成，不把全部会话用量重复归到每个技能。匿名次数与用量可见，用户人数按当前登录工号归属。

2026-09-20 增加 environment=all 查询和“全部环境”选项，各指标从事实行统一去重，不相加各环境人数。页面移除平台筛选并合并平台数据；协议仍保留平台字段用于兼容与诊断。采集状态遵守日期/环境/版本筛选并按事实中的安装 ID 去重，避免安装表仅保存最近环境造成错数。metricVersion 升为3：登录用户数为有工号/身份的前台活动用户去重，主动使用人数和 DAU/MAU仍仅人工业务行为。用户、功能、Token、Skill、明细与排名均支持工号归属和全部环境。
