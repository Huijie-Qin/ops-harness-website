# ADR 0021：官网作为云端定时任务的控制面与编排器

状态：已接受。2026-09-25 用户拍板"定时任务上云"第一期方案，并批准官网承担云侧控制面。

## 背景

产品设计文档（产品仓库 `docs/specs/2026-09-25-cloud-workspace-execution-feasibility.md` §10、§11）决定：终端工作助手的定时任务可以选择"在云端执行"；云侧按**每用户一个实例**隔离；本地产品只是界面；身份沿用 WeLink 工号；凭证是官网按工号签发的个人访问令牌。云侧需要一个常驻的服务来保存任务与计划、排队运行、保存结果、签发令牌并按需拉起/休眠用户实例。用户明确选择由官网承担这一角色，而不是再起一个独立服务。

这与本仓库 `AGENTS.md` 第 4 行原先的职责清单（"不启动 DSH"）冲突，因此本 ADR 同步修订该条：官网进程本身仍然不在进程内运行 DSH、不读终端用户的 DSH_HOME；它只作为控制面与编排器，按用户拉起/停止隔离的云端实例。

## 决策

- **角色**：三方分工固定为 ① 官网 = 控制面 + 编排器；② 云端实例内的执行器插件（产品仓库 `@dsh-ops/cloud-executor`）= 只出站的工作进程；③ 本地云端任务插件（产品仓库 `@dsh-ops/cloud-tasks`）= 界面。官网拥有任务定义与计划（权威）、运行队列与租约、产物、令牌、实例状态；不解释任务内容，不调用模型。
- **契约**：三方共用产品仓库 `packages/shared/cloud-task-contract`（`@dsh-ops/cloud-task-contract`，contractVersion 1）。官网只从 vendor 制品导入 schema、常量和路由表，所有请求/响应用 strict schema 校验，错误码只用契约中的 `errorCodes`。官网不另维护一份协议实现；契约缺口先在官网侧用本地 zod 扩展绕过并在报告中登记，再回到产品仓库修改源包。
- **身份与凭证**：身份键是 WeLink 工号（与 tracking `users` 表 `issuer=welink` 对齐）。管理员在后台按工号签发个人访问令牌（`kind=user`），明文只在签发响应中出现一次，服务端只存 sha256；可到期、可吊销。执行器令牌（`kind=executor`）由官网在每次拉起实例时签发并通过环境变量注入，停止实例即吊销。自报工号不作为凭证；两类令牌不能互换路由。
- **每用户实例**：实例以工号命名（容器 `dsh-ops-cloud-<工号>`），数据目录 `<cloud.directory>/instances/<工号>/home` 作为该实例的 `DSH_HOME` 卷。实例由计划器按需拉起（有排队/运行中的运行）并在空闲 `idleStopMinutes` 后停止；停止的容器会被删除后重建，以便新令牌进入环境；卷保留。
- **执行器只出站**：实例不开放任何入站端口；执行器通过 `/api/cloud/v1/executor/*` 心跳（上报可用专家/技能目录、版本、仍在执行的运行）、领取（原子把本用户最早的 queued 运行改为 claimed，租约 `CLAIM_LEASE_MS`）、上报进度（续租）、上传产物（octet-stream，sha256 校验后落盘）、上报完成。用户接口与执行器接口都拒绝浏览器来源（有 `Origin` 或 `sec-fetch-site` 即 403），与 tracking 一致。
- **编排后端**：`cloud.orchestrator` 二选一。`docker` 通过 Docker Engine API（unix socket / Windows 命名管道，无第三方依赖）创建、启动、停止（10 秒后 kill）、检查容器，带内存/CPU 限制与标签；`process`（开发联调）用本机 Node 按 `pnpm local:bootstrap` 的同一套步骤初始化数据目录，再以 `--profile web --port <分配端口>` 拉起产品 Web Runtime，读到 `dsh web:` 行判定就绪，停止时清理进程树（Windows `taskkill /t /f`）。编排器失败只记录到实例的 `last_error`，不拖垮主循环，并有 5 分钟退避：在就绪行之前退出、启动超时（默认 3 分钟，杀进程树）或容器自行退出都记为 `error` 并退避，`last_error` 带退出码与脱敏后的输出末尾；就绪后意外退出记为 `stopped` 并在下一轮重拉，连续 3 次同样退避。官网自己停止的容器会被删除，因此"仍在但已退出"的容器一定是崩溃。计划器每轮也会核对没有待处理运行的实例是否仍然存活。
- **计划器**：每 30 秒一次：到期任务（`nextRunAt<=now`）创建 `queued` 运行并推进 `nextRunAt`（once → null；用户排队数达到 `MAX_QUEUED_RUNS_PER_USER` 时保持到期等待）；`claimed/running` 超过租约回到 `queued`，第三次直接 `failed`（`lease-expired`）；`queued` 超过 24 小时 `expired`；有待处理运行的用户确保实例运行；空闲实例停止。"下次触发时间"语义从产品 `scheduled-tasks/schedule.ts` 移植（once / interval / calendar，日历按 IANA 时区用 Intl 计算，DST 缺口跳过）。
- **数据保留**：运行记录与产物保留 `RESULT_RETENTION_DAYS`（7 天），维护任务每小时清理；吊销/过期的令牌 30 天后删除。存储是官网本地盘上的 SQLite（`<cloud.directory>/cloud.sqlite`，node:sqlite，WAL）与产物目录，不接对象存储。
- **组织模型 Key**：来自官网进程环境变量 `cloud.modelApiKeyEnv`，只注入实例环境，不进配置、日志或数据库。
- **默认关闭**：`cloud.enabled=false` 时所有 `/api/cloud/*` 与 `/api/admin/cloud/*` 返回 503 `CLOUD_NOT_ENABLED`，不创建目录与数据库。

## 后果

- 官网多了一个有状态的后台循环（计划器）与外部进程/容器依赖；部署时要给官网进程 Docker socket 访问权（或专用的 Docker 主机），并把 `cloud.directory` 放在持久盘。官网重启后 Docker 实例照常运行并被重新识别；进程后端的实例随官网进程退出而结束，重启后数据库中的实例状态被校正为 stopped。
- 令牌是网站的第一个面向终端用户的凭证；后台的令牌页只显示 hash 前缀，吊销即时生效。SSO 替换令牌只需换鉴权层，数据模型不变。
- 实例内的 DSH 只监听容器回环；进程后端在开发机上监听本机端口，`launchUrl` 只对进程后端在管理接口中返回。
- 尚未实现：官网层的出站白名单与 Landlock/bwrap 等容器内加固（属于镜像与宿主机配置）、按工号计量模型用量、多官网实例共享同一 SQLite。

## 验证

- `pnpm check`：新增 `test/cloud-*.test.ts` 覆盖令牌鉴权与吊销、浏览器来源拒绝、任务 CRUD 与 revision 冲突、计划器（假时钟：到期入队、追赶、队列上限、租约两次回退第三次失败、24 小时过期、空闲停机与令牌吊销、编排失败退避、7 天清理）、执行器领取/进度/产物往返（sha256 不匹配拒绝、完成时产物不一致拒绝）/完成、Docker 假 socket（创建/启动/复用/重建/停止/kill/缺镜像）、进程编排器（假产品仓库与假 dsh 入口：初始化、启动参数与环境、就绪判定、日志不含令牌、进程树清理）、时区/月末/DST 计划计算。
- `pnpm build`。
- 真实 Docker 主机上的镜像构建、容器拉起与完整执行链路需要 Linux 环境，本机（Windows ARM64 VM，无 Docker）无法完成，见 runbook 的"待验证"。
