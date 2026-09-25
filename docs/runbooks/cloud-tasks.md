# 云端定时任务：控制面与编排器运维

官网作为终端工作助手"云端定时任务"的控制面与编排器（决策见 [ADR 0021](../adr/0021-cloud-task-execution.md)）。本手册覆盖配置、令牌签发、两种实例后端、目录布局与故障排查；第二期（持久云端工作区、云端会话、执行器命令队列与事件回传）见文末专节。协议以 vendor 中的 `@dsh-ops/cloud-task-contract`（0.2.1，contractVersion 1）为准，路径前缀 `/api/cloud/v1`。

## 配置

在 `config/website.json`（或 `DSH_OPS_WEBSITE_CONFIG` 指向的完整配置）中增加 `cloud` 节；缺省全部关闭，未知键仍严格拒绝：

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| cloud.enabled | false | 打开控制面与编排器；false 时 `/api/cloud/*` 与 `/api/admin/cloud/*` 返回 503 `CLOUD_NOT_ENABLED` |
| cloud.directory | ../.runtime/website-cloud | 相对配置文件目录；存放 `cloud.sqlite`、`artifacts/`、`instances/` |
| cloud.orchestrator | docker | `docker`（生产）或 `process`（开发联调） |
| cloud.idleStopMinutes | 15 | 无待处理运行且最近活动早于该分钟数的实例被停止 |
| cloud.executorPollMs | 5000 | 心跳响应里下发给执行器的领取轮询间隔 |
| cloud.modelApiKeyEnv | DSH_OPS_CLOUD_MODEL_API_KEY | 官网进程环境中保存组织模型 Key 的变量名；只注入实例环境（`DSH_OPS_DEFAULT_MODEL_API_KEY`），不写日志与数据库 |
| cloud.modelBaseUrl / modelName | 不设置 | 必须成对配置；显式选择实例使用的 OpenAI 兼容模型端点与模型名称，注入 `DSH_OPS_CLOUD_MODEL_BASE_URL` / `DSH_OPS_CLOUD_MODEL_NAME`；URL 不接受凭据、查询参数和 fragment，可使用 HTTP 进行本地模拟 |
| cloud.docker.socketPath | /var/run/docker.sock（Windows 为 //./pipe/docker_engine） | Docker Engine API 套接字 |
| cloud.docker.image | dsh-ops-cloud:latest | 实例镜像（Node 24 + DSH + 产品 bundle + 云端 overlay + 执行器插件） |
| cloud.docker.memoryMb / cpus / network | 2048 / 1 / bridge | 容器资源；默认 bridge 为每用户独立的受控 bridge；其他显式网络名由部署方管理隔离策略 |
| cloud.docker.extraHosts | [] | 显式的 `hostname:IP` / `hostname:host-gateway` 映射，最多 32 项且主机名不得重复；Docker Engine `HostConfig.ExtraHosts`，用于容器访问宿主机官网 |
| cloud.docker.sandbox | native | `native` 保留默认 Docker / DSH 沙箱，失败时拒绝执行；`bubblewrap` 为已装 bwrap 的受控镜像启用固定兼容配置，风险与边界见 ADR 0021 |
| cloud.docker.instancePort | 3080 | 以 `DSH_OPS_CLOUD_INSTANCE_PORT` 注入，供镜像入口决定容器内 DSH 监听端口（只监听容器回环） |
| cloud.docker.user | native 用镜像默认；bubblewrap 用 1000:1000 | 可选非 root 数字 `uid:gid`（如 `1000:1000`），须与实例 bind mount 目录的权限匹配；不会自动 chown 或放宽权限，`HOME` 与 `DSH_HOME` 均在 `/data/home` |
| cloud.docker.websiteUrlForInstances | 同 websiteUrl | 容器内访问官网的地址，例如 `http://host.docker.internal:4173` |
| cloud.process.productRepo | 空 | 产品仓库路径（相对配置文件目录），进程后端必填 |
| cloud.process.dshEntry | 空 | DSH CLI 入口；空则从 `productRepo/apps/desktop` 解析 `@deepseek-ai/dsh` 的 bin |
| cloud.process.overlays | [] | 追加的 `--patch` profile overlay，例如指向真实官网的 tracking overlay 与云端执行器 overlay |
| cloud.process.nodeExecutable | 空 | 空则用官网自己的 Node |
| cloud.process.portRangeStart | 3400 | 每个实例从该端口起分配本机端口 |

示例（生产，Docker）：

```json
"cloud": {
  "enabled": true,
  "directory": "/srv/website-cloud",
  "orchestrator": "docker",
  "modelBaseUrl": "https://api.deepseek.com/v1",
  "modelName": "deepseek-v4-flash",
  "docker": { "image": "dsh-ops-cloud:2026.09", "user": "1000:1000", "websiteUrlForInstances": "http://172.17.0.1:4173" }
}
```

示例（开发联调，本机进程）：

```json
"cloud": {
  "enabled": true,
  "orchestrator": "process",
  "idleStopMinutes": 5,
  "process": { "productRepo": "../../ops-harness", "overlays": ["../../ops-harness/profiles/web/overlays/cloud-executor.patch.yml"] }
}
```

修改配置后重启官网。启动日志打印 `[cloud] tasks=enabled orchestrator=… directory=…`。

## 令牌签发与吊销

1. 管理员登录 `/admin` → "云端任务"页签（或直接调用管理接口）。
2. `POST /api/admin/cloud/tokens {"employeeId":"<工号>","label":"备注","expiresInDays":90}` 返回 `{ token, record }`。**明文只出现这一次**，交给用户填入工作助手"设置 → 云端执行"。工号会被规范化为小写。
3. `GET /api/admin/cloud/tokens` 只显示 hash 前 12 位、工号、类型（user/executor）、备注、创建/到期/吊销/最近使用时间。
4. `DELETE /api/admin/cloud/tokens/<hash 前缀（12–64 位十六进制）>` 吊销；前缀有歧义时返回 400。吊销即时生效，用户下次请求 401。
5. 执行器令牌由官网在拉起实例时自动签发，停止实例自动吊销；不要手工签发执行器令牌。

工号允许普通名称中的点（如 `w.123`），但拒绝单独的 `.` / `..` 路径段；实例文件路径与旧令牌鉴权同样执行该检查，避免多个身份共享或越过实例目录。

管理接口沿用管理员 Cookie 会话、Host/Origin 与 CSRF 校验。

## 实例后端

### Docker

- 官网进程需要读写 `cloud.docker.socketPath`；镜像需预先构建并存在于该 Docker 主机（官网不会拉取镜像，缺镜像时实例 `last_error` 为 `image … not found`）。
- Linux 或没有内置宿主机 DNS 的 Docker Desktop 上，`websiteUrlForInstances: "http://host.docker.internal:4173"` 应配合 `extraHosts: ["host.docker.internal:host-gateway"]`；官网监听地址须能接受来自容器网关的连接。不要把 `127.0.0.1` 当作容器访问宿主机的地址。修改映射后新建实例才生效，已运行容器应先有序停止再唤醒。
- 若 DSH 报告原生沙箱不可用，可在安装 bubblewrap 的非 root 镜像上显式选 `sandbox: "bubblewrap"`。官网仅使用受控 Moby v24.0.2 seccomp 快照加 5 项 syscall，固定无 capabilities、禁止提权、只读 root 与 `/tmp` tmpfs（`rw,exec,nosuid,nodev,size=128m,mode=1777`）；不会使用 privileged/unconfined 或加载任意 profile。`exec` 供 DSH 官方原生模块加载器从临时缓存 `dlopen` 预编译模块，默认 `noexec` 会导致映射失败；无需修改依赖包或私有缓存设置。该模式调整 `/proc` mount 限制以允许 bwrap 建立内部隔离，外部出站限制仍需网络网关提供，详见 [ADR 0021](../adr/0021-cloud-task-execution.md)。
- 默认 `network: "bridge"` 会为每个工号创建独立网络，名称 `dsh-ops-cloud-net-<目录hash>-<工号>`，仅允许自有实例接入；停止删除实例后回收该空网络。显式配置其他网络时，部署者负责跨租户 ACL，官网不管理其生命周期。修改 sandbox、网络或用户后，已运行实例须有序停止再重建；不会为了配置更新强杀正在执行的任务。
- 容器名 `dsh-ops-cloud-<工号>`，标签 `dsh-ops.cloud.employee`；数据卷 `<directory>/instances/<工号>/home:/data/home`（容器内 `DSH_HOME=/data/home`）。
- Linux 部署应使用专用非 root 官网用户，并让 `cloud.docker.user` 与新建 home 目录的 UID/GID 一致；已有 home 由部署人员核对所有权。官网不会递归改写已有数据的 owner，也不使用 `chmod 777`。Docker Desktop 的文件共享映射可能允许原本 UID 不匹配的写入，不能替代 Linux 权限验收。
- 检查或停止同名容器前，核对员工/角色标签和实际 home 挂载路径；属于另一个官网数据目录时拒绝接管或删除，记录清晰错误。保留现有命名以兼容已有部署；多个官网共用 Docker 主机时不能用同一工号的同名实例。
- 注入环境：`DSH_OPS_CLOUD_EXECUTOR=1`、`DSH_OPS_CLOUD_WEBSITE_URL`、`DSH_OPS_CLOUD_EXECUTOR_TOKEN`、`DSH_OPS_CLOUD_INSTANCE_ID`、`DSH_OPS_DEFAULT_MODEL_API_KEY`（若官网环境提供）、`DSH_PERMISSION_MODE=workspace-write`、`DSH_TELEMETRY_DISABLED=1`、`DSH_OPS_CLOUD_INSTANCE_PORT`。
- 停止先 `stop?t=10`，失败或超时再 `kill`，随后删除容器；卷（bind mount）不受影响，新令牌只能通过创建时的环境进入，所以每次拉起都是重新创建。仍然存在但状态为 `exited`/`dead` 的容器意味着它自行退出：实例记为 `error`（`container exited with exit code N`）并进入 5 分钟退避，退避后重建。
- 官网重启后通过容器名重新识别正在运行的实例。
- `created` 但从未启动的容器也记为 `error`，退避结束后重建；不会永久停留在 `starting`。管理员在拉起过程中停止实例时，等待该次拉起完成后再停止并吊销令牌。

### 本机进程（开发联调）

- 首次拉起某个工号时，用 `DSH_OPS_HOME=<home>`、`DSH_OPS_ALLOW_EXTERNAL_HOME=1` 执行产品仓库 `scripts/sync-content.mjs`，再执行 `node <dshEntry> plugin --profile web add --allow-build=node-pty <scripts/_shared.mjs 的 webProfilePluginSources>`；产品仓库需先完成 `pnpm install` 与 `pnpm build`。
- 之后每次以 `node <dshEntry> --profile web [--patch <overlay>…] --no-open --port <端口>` 拉起，cwd 为产品仓库，`DSH_HOME=<home>`。stdout/stderr 追加到 `<directory>/instances/<工号>/instance.log`（0600，只含 DSH 自己的输出）。读到 `dsh web:` 行即视为就绪；管理接口的实例列表在进程后端下返回该 `launchUrl`，便于开发者打开实例页面。
- 停止：Windows `taskkill /pid <pid> /t /f`，其它平台 SIGTERM 10 秒后 SIGKILL。官网退出会停止全部本机实例；重启后旧记录校正为 stopped。
- 启动失败检测：在 `dsh web:` 之前退出 → 实例 `error`，`last_error` = 退出码 + 输出末尾 20 行（含 TOKEN/KEY/SECRET/PASSWORD 的环境值与 `Bearer …` 一律替换为 `[redacted]`，写入 instance.log 的内容同样脱敏），进入 5 分钟退避；`startupTimeoutMs`（默认 180000）内没有就绪行 → 杀进程树、同样 `error`+退避；就绪后意外退出 → `stopped` + `last_error`，下一轮可重拉，连续 3 次进入退避。用户接口 `me.instance.state` 只显示状态，完整 `last_error` 只在管理接口。
- 本机进程后端不隔离网络与文件系统，只用于联调。

## 目录布局

```text
<cloud.directory>/
  cloud.sqlite            # 令牌（只有 sha256）、实例、任务、运行、工作区、会话与事件、命令队列（node:sqlite，WAL，schema 2）
  artifacts/<runId>.zip   # 执行器上传的产物，sha256 校验后落盘，7 天后随运行记录删除
  artifacts/ws_<workspaceId>.zip  # 工作区快照，每个工作区只保留最新一份，随工作区删除
  instances/<工号>/home/  # 该用户实例的 DSH_HOME（容器内挂到 /data/home）
  instances/<工号>/instance.log   # 仅进程后端
```

首次用第二期官网（cloud-task-contract 0.2.1）打开旧的 `cloud.sqlite`（schema 1）时会在事务中原地追加第二期的表并把 schema 记为 2；升级只增表不改旧表，可重复执行。不支持的数据库版本在任何 schema 写入前拒绝，迁移出错则回滚并停止启动。

备份 `cloud.directory` 整体（含 SQLite WAL/SHM）。删除某个用户的实例数据前先在后台停止实例。

## 运行状态与接口

- 任务状态：`scheduled` / `paused`；`nextRunAt` 由计划计算（once 触发后为 null）。修改任务与切换状态都要携带 `expectedRevision`，不一致返回 409 `REVISION_CONFLICT`。删除任务会取消排队中的运行；有执行中的运行时返回 409 `TASK_RUNNING`。
- 运行状态：`queued → claimed → running → succeeded | failed | cancelled | timed-out`，另有 `expired`（排队 24 小时无人领取）。租约到期两次回队列，第三次 `failed`（`errorCode=lease-expired`）。取消排队中的运行立即生效；取消执行中的运行只是标记，执行器在下一次心跳的 `cancelRunIds` 中收到；执行器失联且租约到期时直接结束为 `cancelled`，不会再次排队。已到期租约不能被迟到心跳、进度、产物或完成请求复活。
- 新用户首次读取 `/catalog` 时若从未收到过专家目录，会异步拉起实例以准备首个任务所需的专家清单；重复请求共用同一次拉起并遵循启动失败退避。已收到的历史目录继续返回，标注 `stale`，页面轮询不会唤醒已休眠实例。
- 用户接口鉴权 `Authorization: Bearer <用户令牌>`；执行器接口 `Bearer <执行器令牌>`；两类令牌不能互换。拒绝带 `Origin`/`sec-fetch-site` 的请求。每个用户令牌每分钟最多 600 次请求、执行器令牌 1200 次（第二期的事件长轮询与帧上报需要余量），JSON 体最多 64 KiB（帧批次 8 MiB），产物最多 `MAX_ARTIFACT_BYTES`（256 MiB）。
- 产物下载 `GET /api/cloud/v1/runs/<runId>/artifact`：`attachment`，`ETag` 为 sha256，响应头 `X-Artifact-Sha256`、`X-Artifact-File-Count`，支持 `If-None-Match` 与 Range。
- 管理接口：`GET/POST /api/admin/cloud/tokens`、`DELETE /api/admin/cloud/tokens/:hashPrefix`、`GET /api/admin/cloud/instances`、`POST /api/admin/cloud/instances/:employeeId/stop`、`GET /api/admin/cloud/runs?employeeId&limit`、`GET /api/admin/cloud/sessions?employeeId&limit`、`POST /api/admin/cloud/sessions/:sessionId/close`、`GET /api/admin/cloud/commands?employeeId&limit`、`GET /api/admin/cloud/workspaces?employeeId`。

## 故障排查

| 现象 | 检查 |
| --- | --- |
| 客户端得到 503 `CLOUD_NOT_ENABLED` | 实际加载的配置没有 `cloud.enabled: true`，或官网未重启 |
| 401 `UNAUTHORIZED` | 令牌被吊销/到期、用户令牌用在执行器路由（或反之）、`Authorization` 不是 `Bearer <32–128 位 token>` |
| 403 `FORBIDDEN` | 请求带了浏览器 `Origin`/`sec-fetch-site`；或执行器心跳/领取的 `instanceId` 与令牌工号不一致 |
| 409 `CONTRACT_VERSION_MISMATCH` | 执行器与官网的契约版本不同，更新 vendor 制品或执行器 |
| 任务一直 `queued`，实例 `error` | 看管理接口实例列表的 `lastError`：Docker socket 不可达、镜像不存在、进程后端 `productRepo` 未构建、DSH 在打印 `dsh web:` 前退出（`exited during startup (exit code N)` + instance.log 末尾 20 行，凭据已脱敏）、`startupTimeoutMs`（默认 3 分钟）内没有就绪行（进程被杀）、容器自行退出（`container exited with exit code N`）。同一工号 5 分钟内不再重复拉起；修复后退避结束自动重试，或先在后台停止实例再等下一轮 |
| 实例 `stopped` 且带 `lastError`（`exited unexpectedly`） | 就绪后意外退出；有待处理运行时下一轮（30 秒）自动重拉。连续 3 次（计数在官网进程内存中，实例被看到 running 时清零）进入同样的 5 分钟退避 |
| 实例 `running` 但 `catalog.stale=true` | 执行器 30 秒内没有心跳：容器内 DSH 未启动完成、`websiteUrlForInstances` 从容器内不可达、执行器令牌被吊销；看容器日志 / `instance.log` |
| 插件无法加载，原生模块提示 `failed to map segment` | 在只读根文件系统的 bubblewrap 配置下检查 `/tmp` tmpfs 是否显式含 `exec`。官方加载器需要从临时缓存加载原生模块；更新官网配置代码后有序停止并重建旧容器，不修改 `node_modules` |
| 运行反复回到 `queued` 后 `failed lease-expired` | 执行器领取后没有上报进度/心跳续租，检查执行器日志与网络 |
| 上传产物 400 `ARTIFACT_MISMATCH` | 执行器计算的 sha256 与上传字节不一致；完成报文里的 artifact 也必须与已上传文件一致 |
| 429 `RATE_LIMITED` | 单令牌超过每分钟限额（用户 600、执行器 1200），或并发上传超过 4 个 |
| 会话卡在 `queued` / `starting` | 实例没有拉起（看实例 `lastError`）或执行器没有领取命令；管理台"执行器命令"表看该会话的 `session.start` 是排队中、已领取还是失败。租约到期一次回队，第二次失败并把会话标 `failed`（`command-lease-expired`） |
| 会话 `closed` 且错误码 `instance-stopped` / `instance-failed` | 实例被空闲停机、管理员停止或崩溃；会话不会在新实例里恢复，用户需要重新发起。有排队命令或 `running` 会话时实例不会被空闲停机 |
| 会话 `failed` 且错误码 `event-limit` | 单个会话回传帧数超过 50 000（`DEFAULT_MAX_EVENTS_PER_SESSION`）；执行器应关闭该会话，用户重新发起 |
| 执行器上报帧得到 409 `INVALID_REQUEST`（消息含 `lastSeq=N`） | 批次起始 seq 大于官网已存的 `lastSeq+1`：执行器从 `N+1` 重发。重复发送已存的 seq 是幂等的（被忽略），批次内 seq 必须连续 |
| 工作区快照 404 | 尚未上传过快照，或 `workspace.snapshot` 命令还在排队/执行；`GET …/snapshot/archive` 只返回最新一份 |

## 第二期：云端工作区、云端会话、命令队列与事件回传

### 数据与限额

- `cloud_workspaces`：每用户最多 20 个命名工作区（同名 409 `INVALID_REQUEST`，超限 409 `QUEUE_FULL`）。记录创建后官网排入 `workspace.create`，执行器创建目录并回报 `relativePath`。删除只删记录、排队中的命令与快照文件，不删实例里的目录（本期不做远程删除）；有 `queued|starting|idle|running` 会话引用时 409 `TASK_RUNNING`。
- `cloud_sessions`：每用户同时最多 3 个未结束会话（`queued|starting|idle|running`，超限 409 `QUEUE_FULL`）。状态机：`queued`（创建，排入 `session.start`）→ `starting`（执行器领取 `session.start`）→ `running`（结果回报 `instanceSessionId`；首帧到达前也可 `running`）⇄ `idle`（执行器状态上报）→ `closed` / `failed`。终态不可再变。
- `cloud_session_events`：执行器回传的 DSH `SessionFollowFrame` 原样 JSON，按 `(session_id, seq)` 存储，单帧 ≤ 512 KiB、单批 ≤ 200 帧 / 8 MiB、每会话最多 50 000 帧（超过拒收并把会话标 `failed` `event-limit`）。官网只存储转发，不解释帧内容。
- `cloud_commands`：按用户 FIFO 的执行器命令（`session.start|session.prompt|session.cancel|session.close|workspace.create|workspace.snapshot`），状态 `queued → claimed → done|failed`。领取租约 `CLAIM_LEASE_MS`（120 秒）：到期回队一次（`session.start` 的会话退回 `queued`），第二次到期 `failed`（`command-lease-expired`），会话命令失败会把会话标 `failed`。同一会话的 `session.cancel` / `session.close`、同一工作区的 `workspace.snapshot` 排队中不重复入队。
- 保留：`closed|failed` 会话及其事件、已结束命令在 7 天后由维护任务删除；工作区不受保留期影响，快照随工作区删除。

### 用户接口（Bearer 用户令牌）

| 接口 | 语义 |
| --- | --- |
| `GET/POST /workspaces` | 列表 / 创建 → 201 `{workspace}`，同时唤醒实例 |
| `GET/DELETE /workspaces/:id` | 读取 / 删除 → 204 |
| `POST /workspaces/:id/snapshot` | 请求打包 → 202 `{workspace}`（排入 `workspace.snapshot`） |
| `GET /workspaces/:id/snapshot/archive` | 下载最新快照 zip（`attachment`、ETag=sha256、`X-Artifact-Sha256`/`X-Artifact-File-Count`、Range）；无快照 404 |
| `GET/POST /sessions` | 列表 / 创建 → 201 `{session}`（state `queued`），立即排入 `session.start` 并唤醒实例 |
| `GET /sessions/:id` | 当前记录 |
| `POST /sessions/:id/prompt` | 追问 → 202；只在 `idle`/`running` 允许（其余 409 `INVALID_REQUEST`），`mode` 原样交给执行器 |
| `POST /sessions/:id/cancel` | 取消当前轮 → 200；允许 `starting|idle|running`；置 `cancelRequested`（下一次帧上报响应里可见）并排入 `session.cancel` |
| `POST /sessions/:id/close` | 关闭 → 200；`queued` 直接 `closed`（其 `session.start` 记为失败 `session-closed`），其余排入 `session.close`，执行器确认后才 `closed`；终态重复调用幂等 |
| `GET /sessions/:id/events?since&waitMs&limit` | 事件页：`since` 之后的连续帧（升序，`limit` ≤ 200），事件 JSON 数组同时受 3 MiB 字节预算限制；小帧可一次返回 200 条，最大合法帧也能前进至少一条。`nextSince` 为最后实际返回的 seq，达到条数或字节预算而仍有后续帧时 `hasMore=true`。没有新帧且 `waitMs`>0（≤ 30 000）时长轮询，帧到达、状态变化或取消标记变化都会唤醒；会话已终态时立即返回。等待结束后重新鉴权，期间令牌吊销或到期返回 401。响应 `{ session, events, nextSince, hasMore }` |

### 执行器接口（Bearer 执行器令牌）

| 接口 | 语义 |
| --- | --- |
| `POST /executor/commands/claim {instanceId}` | 领取本用户最早的 `queued` 命令 → 200 `{ command, leaseMs }`，无命令或本用户已有 `claimed` 命令时返回 204，防止并发轮询越过先前命令。`session.*` 带当前 `session`，`session.start` 与 `workspace.*` 带 `workspace`，`session.start`/`session.prompt` 带 `prompt`（后者还带 `mode`）。执行器应在同一轮询周期里先领命令再领运行 |
| `POST /executor/commands/:id/result` | 回报 `{ status: done\|failed, errorCode, message, relativePath?, artifact?, instanceSessionId? }` → 204。必须仍为 `claimed` 且租约未到期，否则 409 `INVALID_REQUEST`。`done`：`workspace.create` 必须带 `relativePath`；`session.start` 必须带 `instanceSessionId`；`workspace.snapshot` 必须带 `artifact`，SHA-256、字节数和文件数均须与已上传快照一致（否则 409 `ARTIFACT_MISMATCH`）；`session.close` 把会话置 `closed`；`session.cancel` 清 `cancelRequested`。`failed`：会话命令把会话标 `failed`（错误码来自回报），工作区命令只记录。对已结束命令重复回报是无害的 no-op（204）。`session.prompt` 应在 DSH 接受提示后立即回报，不等待整轮结束 |
| `POST /executor/sessions/:id/frames { events }` | 连续帧批次（`seq` 必须接续官网 `lastSeq`；已存的 seq 被忽略、可安全重发；起始 seq 跳号 → 409 `INVALID_REQUEST`，消息含 `lastSeq=N`；批内不连续 → 400；单帧超 512 KiB → 413）。响应 `{ lastSeq, cancelRequested }`。`cancelRequested` 不因上报而清零，只由 `session.cancel` 结果或非 `running` 的状态上报清零。会话 `failed` 后拒收 |
| `POST /executor/sessions/:id/status` | `{ state: idle\|running\|closed\|failed, turns?, errorCode, errorMessage }` → 200 `{session}`；终态会话忽略后续上报。`closed`/`failed` 会把该会话尚未领取/完成的命令记为失败 |
| `PUT /executor/workspaces/:id/snapshot` | zip 上传（`content-type: application/zip`，头 `x-artifact-sha256` 必填、`x-artifact-file-count` 可选）→ 200 `{workspace}`；覆盖上一份快照。上传期间工作区被删除则返回 404，并清理晚到归档 |

每次领取命令、帧上报、状态上报、快照上传都会刷新实例的最近活动时间。

### 实例生命周期变化

- 有排队/已领取命令或 `queued|starting|running` 会话的用户，计划器每轮都会 `ensureRunning`；创建工作区/会话、请求快照都会立即尝试唤醒实例。
- 空闲停机条件增加"没有排队/已领取命令、没有 `queued|starting|running` 会话"；`idle` 会话不阻止停机。停机（空闲、管理员停止）与实例崩溃/意外退出时，该用户 `idle|running` 会话被置为 `closed`（错误码 `instance-stopped` / `instance-failed`），其未完成命令记为失败 `session-closed`；`starting` 会话靠命令租约回队后由新实例重新启动。
- 管理台"云端任务"页签新增"云端会话"与"执行器命令"两张表（随工号筛选），会话行可"关闭"（等价于用户侧 close）。

## 验证记录与剩余边界

第二期于 2026-09-25 使用本机 Docker 和真实 DeepSeek 模型完成跨仓验收：创建持久工作区、同一 DSH 会话续聊与工具调用、取消/关闭、快照下载与用户隔离、原工作区跨容器重建持久化、定时任务与会话共存、官网离线 46 秒后的状态与帧补偿、本地 Runtime 离线期间继续执行，以及空闲实例自动停止。产品与管理员页面完成真实浏览器验收，稳定态 Console 均为 0 errors / 0 warnings；本仓 `pnpm check` 133/133、构建通过。完整白盒流程、最终镜像、复现修复与证据索引见[第二期 Docker 验收报告](https://github.com/Huijie-Qin/ops-harness/blob/9cc685f5228a2b7d5ac92c8cbaea8804d27bec1f/docs/qa/cloud-sessions-docker-e2e-2026-09-25.md)。

初版历史环境为无 Docker 的 Windows ARM64 开发机：当时 Docker 编排只通过假 Engine API 单元测试，未完成真实镜像构建、容器拉起与休眠唤醒。进程后端当时使用假 dsh 入口验证初始化、启动参数、就绪判定与停止行为，该记录不代表真实产品 Runtime 已通过。

2026-09-25 在 macOS 的 Docker 24.0.2（Linux 5.15.49、aarch64）完成了真实镜像构建、当前编排器创建与删除实例、bubblewrap HostConfig 与内核权限约束、两个用户独立 bridge 之间的直接 IP HTTP 拒绝、自身 loopback 正常，以及两侧 `host-gateway` 访问宿主 HTTP 正常。独立网络探针停止后已回收专属网络；空闲实例停止、已有目录读取不唤醒也已验证。

真实 DeepSeek 模型的 Bash 任务在 6.371 秒完成，以实际 `tool/call` 和工具结果为证据。下载文件断言工作区写入成功、既存工作区外目录写入被拒绝、命令子进程环境不含模型 Key 与执行器令牌。后者只证明工具子进程环境过滤，不代表容器父进程或 Docker 管理员无法读取实例配置。

使用独立假 Key 和确定性模拟模型完成生命周期验收：经 UI 取消的运行进入 `cancelled`（本次运行约 19 秒），排队取消立即生效，超时运行在 60.049 秒进入 `timed-out`，官网短暂重启后相同容器中的同一运行继续执行，本地 Runtime 关闭后的单次计划仍在云端成功。这些结果与真实模型 Bash 验收分别记录。

最后补充专家必要工具可用性判断后的产品最终镜像 `sha256:8293475f929e846652ef54f0650875f4dd02bb12d7a341e68c95943af28f6884` 已重建并重复通过真实 Bash 验收。运行 `cr_650d49a81d8a3567323a1a13a7a706e7` 耗时 3.958 秒，新会话包含实际 Bash `tool/call` 与 `tool/result` 验收标记，下载产物再次通过工作区可写、外目录写入拒绝、模型 Key 与执行器令牌在命令子进程环境不可见四项断言。最终镜像复验与各项证据见产品仓库 [Docker 端到端验收报告](../../../ops-harness/docs/qa/cloud-tasks-docker-e2e-2026-09-25.md)（本地并列检出路径）。

生产 Linux/x64 与 bind mount UID/GID 权限仍须单独验收。模型出口代理、外部请求域名白名单与持久盘配额尚未实现或验证；自定义共享网络的跨租户 ACL 属于部署方责任。这些边界不因本地 Docker 链路或模拟模型测试成功而完成。
