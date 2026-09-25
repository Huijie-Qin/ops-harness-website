# ADR 0021：官网作为云端定时任务的控制面与编排器

状态：已接受。2026-09-25 用户拍板"定时任务上云"第一期方案，并批准官网承担云侧控制面。

## 背景

产品设计文档（产品仓库 `docs/specs/2026-09-25-cloud-workspace-execution-feasibility.md` §10、§11）决定：终端工作助手的定时任务可以选择"在云端执行"；云侧按**每用户一个实例**隔离；本地产品只是界面；身份沿用 WeLink 工号；凭证是官网按工号签发的个人访问令牌。云侧需要一个常驻的服务来保存任务与计划、排队运行、保存结果、签发令牌并按需拉起/休眠用户实例。用户明确选择由官网承担这一角色，而不是再起一个独立服务。

这与本仓库 `AGENTS.md` 第 4 行原先的职责清单（"不启动 DSH"）冲突，因此本 ADR 同步修订该条：官网进程本身仍然不在进程内运行 DSH、不读终端用户的 DSH_HOME；它只作为控制面与编排器，按用户拉起/停止隔离的云端实例。

## 决策

- **角色**：三方分工固定为 ① 官网 = 控制面 + 编排器；② 云端实例内的执行器插件（产品仓库 `@dsh-ops/cloud-executor`）= 只出站的工作进程；③ 本地云端任务插件（产品仓库 `@dsh-ops/cloud-tasks`）= 界面。官网拥有任务定义与计划（权威）、运行队列与租约、产物、令牌、实例状态；不解释任务内容，不调用模型。
- **契约**：三方共用产品仓库 `packages/shared/cloud-task-contract`（`@dsh-ops/cloud-task-contract`，contractVersion 1；第二期升级到包版本 0.2.1）。官网只从 vendor 制品导入 schema、常量和路由表，所有请求/响应用 strict schema 校验，错误码只用契约中的 `errorCodes`。官网不另维护一份协议实现；契约缺口先在官网侧用本地 zod 扩展绕过并在报告中登记，再回到产品仓库修改源包。
- **身份与凭证**：身份键是 WeLink 工号（与 tracking `users` 表 `issuer=welink` 对齐）。管理员在后台按工号签发个人访问令牌（`kind=user`），明文只在签发响应中出现一次，服务端只存 sha256；可到期、可吊销。执行器令牌（`kind=executor`）由官网在每次拉起实例时签发并通过环境变量注入，停止实例即吊销。自报工号不作为凭证；两类令牌不能互换路由。
- **每用户实例**：实例以工号命名（容器 `dsh-ops-cloud-<工号>`），数据目录 `<cloud.directory>/instances/<工号>/home` 作为该实例的 `DSH_HOME` 卷。实例由计划器按需拉起（有排队/运行中的运行）并在空闲 `idleStopMinutes` 后停止；停止的容器会被删除后重建，以便新令牌进入环境；卷保留。
- **执行器只出站**：实例不开放任何入站端口；执行器通过 `/api/cloud/v1/executor/*` 心跳（上报可用专家/技能目录、版本、仍在执行的运行）、领取（原子把本用户最早的 queued 运行改为 claimed，租约 `CLAIM_LEASE_MS`）、上报进度（续租）、上传产物（octet-stream，sha256 校验后落盘）、上报完成。用户接口与执行器接口都拒绝浏览器来源（有 `Origin` 或 `sec-fetch-site` 即 403），与 tracking 一致。
- **编排后端**：`cloud.orchestrator` 二选一。`docker` 通过 Docker Engine API（unix socket / Windows 命名管道，无第三方依赖）创建、启动、停止（10 秒后 kill）、检查容器，带内存/CPU 限制与标签；`process`（开发联调）用本机 Node 按 `pnpm local:bootstrap` 的同一套步骤初始化数据目录，再以 `--profile web --port <分配端口>` 拉起产品 Web Runtime，读到 `dsh web:` 行判定就绪，停止时清理进程树（Windows `taskkill /t /f`）。编排器失败只记录到实例的 `last_error`，不拖垮主循环，并有 5 分钟退避：在就绪行之前退出、启动超时（默认 3 分钟，杀进程树）或容器自行退出都记为 `error` 并退避，`last_error` 带退出码与脱敏后的输出末尾；就绪后意外退出记为 `stopped` 并在下一轮重拉，连续 3 次同样退避。官网自己停止的容器会被删除，因此"仍在但已退出"的容器一定是崩溃。计划器每轮也会核对没有待处理运行的实例是否仍然存活。
- **计划器**：每 30 秒一次：到期任务（`nextRunAt<=now`）创建 `queued` 运行并推进 `nextRunAt`（once → null；用户排队数达到 `MAX_QUEUED_RUNS_PER_USER` 时保持到期等待）；`claimed/running` 超过租约回到 `queued`，第三次直接 `failed`（`lease-expired`）；`queued` 超过 24 小时 `expired`；有待处理运行的用户确保实例运行；空闲实例停止。"下次触发时间"语义从产品 `scheduled-tasks/schedule.ts` 移植（once / interval / calendar，日历按 IANA 时区用 Intl 计算，DST 缺口跳过）。
- **数据保留**：运行记录与产物保留 `RESULT_RETENTION_DAYS`（7 天），维护任务每小时清理；吊销/过期的令牌 30 天后删除。存储是官网本地盘上的 SQLite（`<cloud.directory>/cloud.sqlite`，node:sqlite，WAL）与产物目录，不接对象存储。
- **组织模型 Key**：来自官网进程环境变量 `cloud.modelApiKeyEnv`，只注入实例环境，不进配置、日志或数据库。
- **默认关闭**：`cloud.enabled=false` 时所有 `/api/cloud/*` 与 `/api/admin/cloud/*` 返回 503 `CLOUD_NOT_ENABLED`，不创建目录与数据库。

## 后果

### 2026-09-25 端到端验证修正

- 首次创建任务之前需要专家目录，因此已认证用户第一次读取空 `/catalog` 可幂等唤醒实例；有历史目录时只读缓存并标记 stale，保留空闲休眠。
- 官网配置显式提供成对的模型 `modelBaseUrl` / `modelName`，密钥仍只从 `modelApiKeyEnv` 读取并注入；模型路由不再靠隐式容器默认值决定。Docker 可配置非 root 数字 `user`，由部署环境保证 bind home 权限，应用不自动 chown 已有数据。
- 启动和停止按用户串行；同名 Docker 容器必须匹配员工、角色与 home 挂载才允许接管或停止；`created` 遗留容器作为启动失败进入退避。保留原容器名，跨官网同名冲突显式失败。
- 租约到期即失效，迟到心跳不得复活；已申请取消的失联运行直接结束，不重排。协议目前没有每次领取独立的 attempt ID，不能承诺跨进程旧请求的严格 fencing；执行器同时实施本地租约截止和中止，后续若需要严格幂等外部副作用，应扩展协议并升级两侧。

### 2026-09-25 Docker 内 bubblewrap 兼容模式

真实 Docker 5.15 内核的联调探针中，DSH 原生沙箱不可用时拒绝执行 Bash；安装 bubblewrap 后，Docker 默认 seccomp 与 `/proc` mount 约束仍阻止其建立内部沙箱。因此增加显式的 `cloud.docker.sandbox: native | bubblewrap`，默认 `native` 保留现有 Docker 默认与 DSH 失败即拒绝行为，只有部署人员主动选择才启用兼容配置。

`bubblewrap` 使用受控的 Moby v24.0.2 默认 seccomp 快照，仅追加 `clone`、`unshare`、`mount`、`umount2`、`pivot_root` 五项 allow（探针逐一移除均不能启动）；来源与 SHA-256 固定在 `server/cloud/docker-sandbox.ts`，完整 Apache-2.0 许可证及来源登记随源码和生产构建分发。Docker 创建请求同时固定 `CapDrop: [ALL]`、`Privileged: false`、`no-new-privileges=true`、只读 rootfs、`/tmp` 的 128 MiB tmpfs（`rw,exec,nosuid,nodev,size=128m,mode=1777`）；移除 Docker 默认 `/proc/*` masked/readonly 项，保留 `MaskedPaths: [/sys/firmware]`。该模式默认显式使用 `1000:1000`，也可配置其他非 root `docker.user`，不依赖任意镜像的默认 USER。不接收任意 seccomp 文件、内联规则或 `unconfined`。

`/tmp` 显式允许 `exec` 是 DSH 官方原生模块加载器的兼容要求：`node-addon-native-custom-loader` 将已校验的预编译模块复制到缓存，再由 `dlopen` 加载；Docker tmpfs 默认 `noexec` 会让映射失败，并使依赖该加载器的产品插件无法载入。真实同镜像探针仅切换此项即从加载失败恢复；保留 `nosuid`、`nodev`、容量限制与全部容器权限约束，不修改 `node_modules` 或引入私有缓存开关。DSH 内部 bubblewrap 仍为任务建立独立沙箱。

风险权衡：为非特权用户命名空间开放上述 syscall，并取消 Docker 对 `/proc` 的额外 mount 保护，会扩大容器内可用的内核接口；外层非 root、无 capabilities、禁止提权和只读 rootfs 限制 proc 写入，内层 bubblewrap 继续隔离子进程与文件系统。该设置不等价于每任务网络隔离，外部出站 ACL 仍由 Docker 网络和网关负责。镜像必须安装 bubblewrap；不支持时仍由 DSH 拒绝执行，不自动降级成无沙箱。升级内核、Docker、Moby profile 或 DSH 时须重跑允许工作区写入、拒绝工作区外写入的真实探针与完整任务链路。

### 默认 Docker 网络的租户隔离

真实双容器探针证明，共用默认 bridge 时即使没有发布端口，也能通过容器 IP 互相访问。因此 `cloud.docker.network=bridge` 现在表示官网管理的每用户独立 bridge 网络，名称包含 cloud.directory 的稳定 namespace 与规范化工号；使用员工、角色和目录 hash 标签校验归属，禁止接管其他部署的同名网络，且创建新容器前网络必须没有其他容器。网络设置 `enable_icc=false`，停止并删除容器后仅回收空的自有网络。官网重启不会删除仍运行实例的网络。

显式配置其他网络名称时，该网络由部署者管理；官网不创建/删除它，跨租户 ACL 由网络管理员保证。该修复保留容器的互联网出站，不提供域名白名单、模型出口代理或磁盘配额。已有共享 bridge 上的运行保持原状态，须有序停止并重建才能启用新隔离；不得将它们标记为已完成隔离验收。网络数量受 Docker daemon 的地址池约束，生产部署需按同时在线实例数配置并验收。删除容器时传 `v=true` 回收历史镜像声明的匿名卷，用户 home 仍为独立 bind mount，不被删除。

- 官网多了一个有状态的后台循环（计划器）与外部进程/容器依赖；部署时要给官网进程 Docker socket 访问权（或专用的 Docker 主机），并把 `cloud.directory` 放在持久盘。官网重启后 Docker 实例照常运行并被重新识别；进程后端的实例随官网进程退出而结束，重启后数据库中的实例状态被校正为 stopped。
- 令牌是网站的第一个面向终端用户的凭证；后台的令牌页只显示 hash 前缀，吊销即时生效。SSO 替换令牌只需换鉴权层，数据模型不变。
- 实例内的 DSH 只监听容器回环；进程后端在开发机上监听本机端口，`launchUrl` 只对进程后端在管理接口中返回。
- 尚未实现：官网层的出站白名单、按工号计量模型用量、多官网实例共享同一 SQLite。容器内沙箱依赖部署环境；显式 bubblewrap 兼容模式的边界见上文。

## 第二期增补：云端工作区、云端会话与事件回传（2026-09-25）

用户拍板按"路线 B"在云侧复刻工作区与会话：本地发起一个在云端实例里执行的会话，事件实时回传本地展示，可追问、取消当前轮、关闭；每用户在自己的实例里有若干命名工作区，可打包快照下载。契约升级到 0.2.1（contractVersion 仍为 1，只增加 schema 与路由）。官网侧的增量决策：

- **官网仍不解释会话内容**：执行器把 DSH `SessionFollowFrame` 原样 JSON 按 `seq` 上报，官网只按 `(session, seq)` 存储并按 `since` 分页/长轮询转发，由本地插件按 DSH 版本渲染。单帧 512 KiB、单批上传 200 帧 / 8 MiB、每会话 50 000 帧，超限把会话标 `failed`（`event-limit`）。事件读取每页最多 200 帧，同时按序截取 JSON 数组不超过 3 MiB 的连续前缀，为本地 4 MiB 响应上限留出元数据空间；小帧保持原页容量，大帧按 `nextSince` / `hasMore` 继续读取。
- **命令队列代替入站调用**：实例依旧只出站。用户侧的创建/追问/取消/关闭/打包都变成按用户 FIFO 的执行器命令（`cloud_commands`），执行器用与领取运行相同的方式领取并回报结果；每用户同时只允许一条已领取命令，其他用户不受影响。租约 120 秒，到期回队一次、第二次失败并把会话标 `failed`；未领取、失租或已回队的命令拒收结果，已结束命令的回报重试保持幂等。当前没有命令续租或独立 attempt ID，不能承诺跨进程陈旧请求的严格 fencing；执行器须按领取期限停止过期操作。`session.cancel` 额外通过帧上报响应的 `cancelRequested` 传达，两条通道幂等。
- **状态由执行器上报驱动**：`queued → starting → running ⇄ idle → closed|failed`；`session.start` 结果带 `instanceSessionId` 后进入 `running`；终态不可逆。追问只在 `idle`/`running` 允许，一期不做审批/提问回传（云端会话一律无人值守）。
- **实例生命周期扩展**：排队命令与未结束会话都使实例保持运行；`idle` 会话不阻止空闲停机，停机或崩溃时 `idle|running` 会话被关闭（`instance-stopped` / `instance-failed`），不做跨实例恢复。
- **工作区**：每用户 20 个，记录在官网、目录在实例（执行器回报 `relativePath`）；快照复用产物存储（`ws_<workspaceId>.zip`，只留最新），删除工作区只删记录与快照，不远程删目录。
- **保留与管理**：终态会话及其事件、已结束命令保留 7 天；管理台新增会话/命令只读视图与"关闭会话"。
- **限流**：用户令牌 600 次/分钟、执行器令牌 1200 次/分钟（长轮询与帧上报的频率高于一期）。

控制面回归补充：事件长轮询唤醒后重新校验用户令牌，吊销或到期即拒绝返回新事件；快照命令结果必须与上传内容的 SHA-256、字节数、文件数全部相符，工作区在上传期间被删除时清理晚到的归档。schema 1 → 2 的增量迁移在事务中完成，并在写入之前拒绝不支持的数据库版本。

## 验证

- 第二期：`test/cloud-sessions.test.ts` 覆盖工作区 CRUD/唯一名/上限/删除规则、会话创建→命令领取（携带会话/工作区/提示词）→结果→帧批次（重发幂等、跳号 409 带 lastSeq、批内不连续 400、超大帧 413）→分页与长轮询（帧到达唤醒、状态变化唤醒、超时空返回、终态不等待）→追问/取消/关闭状态机→并发上限→帧上限→执行器失败回报→管理接口与管理员关闭；命令租约回队/失败；实例唤醒与空闲停机关闭会话；快照上传/下载/覆盖/删除；保留清理；schema 1 → 2 原地升级。
- `pnpm check`：新增 `test/cloud-*.test.ts` 覆盖令牌鉴权与吊销、浏览器来源拒绝、任务 CRUD 与 revision 冲突、计划器（假时钟：到期入队、追赶、队列上限、租约两次回退第三次失败、24 小时过期、空闲停机与令牌吊销、编排失败退避、7 天清理）、执行器领取/进度/产物往返（sha256 不匹配拒绝、完成时产物不一致拒绝）/完成、Docker 假 socket（创建/启动/复用/重建/停止/kill/缺镜像）、进程编排器（假产品仓库与假 dsh 入口：初始化、启动参数与环境、就绪判定、日志不含令牌、进程树清理）、时区/月末/DST 计划计算。
- `pnpm build`。
- 初版历史记录：原 Windows ARM64 VM 没有 Docker，仅完成假 Engine API 等自动化验证，未完成真实镜像构建或容器链路。
- 2026-09-25 本轮更新：在 macOS 的 Docker 24.0.2（Linux 5.15.49、aarch64）完成真实镜像构建、当前编排器创建与删除实例、bubblewrap 容器约束、每用户独立 bridge 的跨租户直接 IP HTTP 拒绝、自身 loopback 访问和 `host-gateway` 宿主 HTTP 访问验证。
- 真实 DeepSeek 模型的 Bash 任务在 6.371 秒完成，已有实际 `tool/call` 与结果记录，并下载产物断言工作区可写、既存工作区外目录不可写、命令子进程环境不含模型 Key 或执行器令牌。使用确定性模拟模型另行通过 UI 运行中取消、排队取消、60.049 秒超时、官网短暂重启后原容器内同一运行续跑、本地 Runtime 关闭后的单次计划执行；模拟结果不冒充真实模型工具调用。
- 最后补充专家必要工具可用性判断后的产品最终镜像 `sha256:8293475f929e846652ef54f0650875f4dd02bb12d7a341e68c95943af28f6884` 已重建并重复通过真实 Bash 验收：运行 `cr_650d49a81d8a3567323a1a13a7a706e7` 耗时 3.958 秒，新会话记录包含 Bash `tool/call` 与 `tool/result` 验收标记，下载文件的工作区可写、外目录拒绝、模型 Key 与执行器令牌不可见四项断言再次通过。证据见产品仓库的 [Docker 端到端验收报告](../../../ops-harness/docs/qa/cloud-tasks-docker-e2e-2026-09-25.md)（本地并列检出路径）。此结果不替代生产 Linux/x64 主机与 bind mount 权限验收；出站白名单、模型出口代理和持久盘配额仍未实现或验证。
