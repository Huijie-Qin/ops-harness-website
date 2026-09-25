# 云端定时任务：控制面与编排器运维

官网作为终端工作助手"云端定时任务"的控制面与编排器（决策见 [ADR 0021](../adr/0021-cloud-task-execution.md)）。本手册覆盖配置、令牌签发、两种实例后端、目录布局与故障排查。协议以 vendor 中的 `@dsh-ops/cloud-task-contract` 为准，路径前缀 `/api/cloud/v1`。

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
| cloud.docker.socketPath | /var/run/docker.sock（Windows 为 //./pipe/docker_engine） | Docker Engine API 套接字 |
| cloud.docker.image | dsh-ops-cloud:latest | 实例镜像（Node 24 + DSH + 产品 bundle + 云端 overlay + 执行器插件） |
| cloud.docker.memoryMb / cpus / network | 2048 / 1 / bridge | 容器资源与网络 |
| cloud.docker.instancePort | 3080 | 以 `DSH_OPS_CLOUD_INSTANCE_PORT` 注入，供镜像入口决定容器内 DSH 监听端口（只监听容器回环） |
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
  "docker": { "image": "dsh-ops-cloud:2026.09", "websiteUrlForInstances": "http://172.17.0.1:4173" }
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

管理接口沿用管理员 Cookie 会话、Host/Origin 与 CSRF 校验。

## 实例后端

### Docker

- 官网进程需要读写 `cloud.docker.socketPath`；镜像需预先构建并存在于该 Docker 主机（官网不会拉取镜像，缺镜像时实例 `last_error` 为 `image … not found`）。
- 容器名 `dsh-ops-cloud-<工号>`，标签 `dsh-ops.cloud.employee`；数据卷 `<directory>/instances/<工号>/home:/data/home`（容器内 `DSH_HOME=/data/home`）。
- 注入环境：`DSH_OPS_CLOUD_EXECUTOR=1`、`DSH_OPS_CLOUD_WEBSITE_URL`、`DSH_OPS_CLOUD_EXECUTOR_TOKEN`、`DSH_OPS_CLOUD_INSTANCE_ID`、`DSH_OPS_DEFAULT_MODEL_API_KEY`（若官网环境提供）、`DSH_PERMISSION_MODE=workspace-write`、`DSH_TELEMETRY_DISABLED=1`、`DSH_OPS_CLOUD_INSTANCE_PORT`。
- 停止先 `stop?t=10`，失败或超时再 `kill`，随后删除容器；卷（bind mount）不受影响，新令牌只能通过创建时的环境进入，所以每次拉起都是重新创建。仍然存在但状态为 `exited`/`dead` 的容器意味着它自行退出：实例记为 `error`（`container exited with exit code N`）并进入 5 分钟退避，退避后重建。
- 官网重启后通过容器名重新识别正在运行的实例。

### 本机进程（开发联调）

- 首次拉起某个工号时，用 `DSH_OPS_HOME=<home>`、`DSH_OPS_ALLOW_EXTERNAL_HOME=1` 执行产品仓库 `scripts/sync-content.mjs`，再执行 `node <dshEntry> plugin --profile web add --allow-build=node-pty <scripts/_shared.mjs 的 webProfilePluginSources>`；产品仓库需先完成 `pnpm install` 与 `pnpm build`。
- 之后每次以 `node <dshEntry> --profile web [--patch <overlay>…] --no-open --port <端口>` 拉起，cwd 为产品仓库，`DSH_HOME=<home>`。stdout/stderr 追加到 `<directory>/instances/<工号>/instance.log`（0600，只含 DSH 自己的输出）。读到 `dsh web:` 行即视为就绪；管理接口的实例列表在进程后端下返回该 `launchUrl`，便于开发者打开实例页面。
- 停止：Windows `taskkill /pid <pid> /t /f`，其它平台 SIGTERM 10 秒后 SIGKILL。官网退出会停止全部本机实例；重启后旧记录校正为 stopped。
- 启动失败检测：在 `dsh web:` 之前退出 → 实例 `error`，`last_error` = 退出码 + 输出末尾 20 行（含 TOKEN/KEY/SECRET/PASSWORD 的环境值与 `Bearer …` 一律替换为 `[redacted]`，写入 instance.log 的内容同样脱敏），进入 5 分钟退避；`startupTimeoutMs`（默认 180000）内没有就绪行 → 杀进程树、同样 `error`+退避；就绪后意外退出 → `stopped` + `last_error`，下一轮可重拉，连续 3 次进入退避。用户接口 `me.instance.state` 只显示状态，完整 `last_error` 只在管理接口。
- 本机进程后端不隔离网络与文件系统，只用于联调。

## 目录布局

```text
<cloud.directory>/
  cloud.sqlite            # 令牌（只有 sha256）、实例、任务、运行（node:sqlite，WAL）
  artifacts/<runId>.zip   # 执行器上传的产物，sha256 校验后落盘，7 天后随运行记录删除
  instances/<工号>/home/  # 该用户实例的 DSH_HOME（容器内挂到 /data/home）
  instances/<工号>/instance.log   # 仅进程后端
```

备份 `cloud.directory` 整体（含 SQLite WAL/SHM）。删除某个用户的实例数据前先在后台停止实例。

## 运行状态与接口

- 任务状态：`scheduled` / `paused`；`nextRunAt` 由计划计算（once 触发后为 null）。修改任务与切换状态都要携带 `expectedRevision`，不一致返回 409 `REVISION_CONFLICT`。删除任务会取消排队中的运行；有执行中的运行时返回 409 `TASK_RUNNING`。
- 运行状态：`queued → claimed → running → succeeded | failed | cancelled | timed-out`，另有 `expired`（排队 24 小时无人领取）。租约到期两次回队列，第三次 `failed`（`errorCode=lease-expired`）。取消排队中的运行立即生效；取消执行中的运行只是标记，执行器在下一次心跳的 `cancelRunIds` 中收到。
- 用户接口鉴权 `Authorization: Bearer <用户令牌>`；执行器接口 `Bearer <执行器令牌>`；两类令牌不能互换。拒绝带 `Origin`/`sec-fetch-site` 的请求。每个令牌每分钟最多 300 次请求，JSON 体最多 64 KiB，产物最多 `MAX_ARTIFACT_BYTES`（256 MiB）。
- 产物下载 `GET /api/cloud/v1/runs/<runId>/artifact`：`attachment`，`ETag` 为 sha256，响应头 `X-Artifact-Sha256`、`X-Artifact-File-Count`，支持 `If-None-Match` 与 Range。
- 管理接口：`GET/POST /api/admin/cloud/tokens`、`DELETE /api/admin/cloud/tokens/:hashPrefix`、`GET /api/admin/cloud/instances`、`POST /api/admin/cloud/instances/:employeeId/stop`、`GET /api/admin/cloud/runs?employeeId&limit`。

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
| 运行反复回到 `queued` 后 `failed lease-expired` | 执行器领取后没有上报进度/心跳续租，检查执行器日志与网络 |
| 上传产物 400 `ARTIFACT_MISMATCH` | 执行器计算的 sha256 与上传字节不一致；完成报文里的 artifact 也必须与已上传文件一致 |
| 429 `RATE_LIMITED` | 单令牌超过每分钟 300 次，或并发上传超过 4 个 |

## 待验证（本机无法完成）

Windows ARM64 开发机没有 Docker：Docker 编排只通过假 Engine API 的单元测试验证；真实镜像构建、容器拉起与休眠唤醒、出站白名单、容器内加固需要在 Linux Docker 主机上完成。进程后端在本机通过假 dsh 入口验证了初始化、启动参数、就绪判定与进程树清理；与真实产品仓库的联调需要先在产品仓库完成 `pnpm install` 与 `pnpm build`。
