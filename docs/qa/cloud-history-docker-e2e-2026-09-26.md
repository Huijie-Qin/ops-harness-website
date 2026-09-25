# 云会话与定时任务历史 Docker 验收（2026-09-26）

本轮验证共享契约 0.3.0、官网 schema 3 与产品执行器的实际链路。使用隔离官网 `127.0.0.1:44183`、隔离本地 Web `127.0.0.1:43181`、QA 工号 `huijieqin-e91f-ux`；操作经本地 Host RPC 代理转发，令牌及真实模型 Key 未写入测试脚本、配置或证据文件。未操作已有官网 44173 或其用户任务。

## 环境与结果

云端使用完整产品镜像 `ops-harness-cloud:browser-product`，ID `sha256:0f54d3e6c025ec8d15d8cb0baa26c4036416a636ac5fb729bcc9b8816b9cf4b2`。该镜像经冻结锁文件安装、原生模块编译与完整工作区构建；执行环境为本机 macOS Docker 24.0.2 / Linux 5.15.49 aarch64。模型为真实 DeepSeek `deepseek-v4-flash`，通过部署配置注入。

| 验证 | 观测结果 |
| --- | --- |
| 同一云会话连续两轮 | 两次真实 Bash tool/call 与 tool/result；458 帧包含 37 条持久事件（seq 0–36），两个 turn/end |
| 工作区连续性 | 第一轮创建的文件由第二轮读取并追加；实体文件两行标记逐字匹配 |
| 同工作区定时任务 | 创建一次计划后暂停，仅手动执行一次；读取前两轮文件并生成任务输出，实体文件逐字匹配；run succeeded |
| 定时任务实时历史 | 278 帧包含全部 29 条持久事件（seq 0–28），包括最终 turn/end、两个工具调用及结果 |
| 调度历史只读 | prompt、cancel、close 均返回 INVALID_REQUEST，运行取消仍由 run 接口负责 |
| 旧日志冷读取 | 仅移除该 QA run 的会话索引，保留 run 与原生持久日志；POST run session 自动建立新索引并导出；空 snapshot 加 29 条事件，与实时持久事件逐条一致 |
| 缺失与恢复 | 仅把 QA 历史的原生 ID 临时改为不存在的测试 ID；读取返回 unavailable / SESSION_QUERY_SESSION_NOT_FOUND，事件为 0，旧缓存未残留；恢复真实 ID 后同一历史入口成功导出 |
| 冷读取无执行副作用 | 成功、失败与重试期间，原生压缩日志均为 21,080 字节，SHA-256 始终为 `f449ab7ea9172980f0d9cc126c20f4db8b04081801e2192c7d3a43451dfdff24`；该工作区仍只有原来的两个原生会话 |
| 重复打开 | 历史 ready 后重复请求保持同一个 session ID，不再创建导出命令；三次实际导出命令分别 done / failed / done，均仅一次领取 |
| 实际能力目录 | browser 为已添加且可用；WeLink 等已装配工具按真实未添加状态展示；operations-platform-auth 与 data-agent 单独列为装配禁用，不把 Linux 等同于全部工具不支持 |

冷读取实现只调用公开 sessionQuery 观察与 sessionController.page；不创建 Agent 或发送 prompt。原生日志哈希与会话数量是本轮运行证据，不是对模型服务商计费系统的独立审计。

## 可追溯记录

- 云工作区：`cw_73e0fff9b5e89bb159b0ba6c4a19755e`。
- 交互会话：`cs_2b0e4b2294654be9785cf681ae079554`。
- 定时任务运行：`cr_67d3955baebb5fd6eb3eebe7568134d5`。
- 冷读取后的只读历史：`cs_3407958716993308afb4caa465173628`。
- 产品仓库本地证据：`.runtime/qa/cloud-history/2026-09-26/live.json`、`cold.json`；临时脚本位于 `.runtime/tmp/cloud-history/2026-09-26/`。这些运行数据不纳入发布制品。
- 官网源码验证：初次 HTTP 验收前 `pnpm check` 141/141、构建通过；其后补充旧任务工作区可读名称及保留用户命名的幂等校正，完整检查为 143/143。执行器 65/65 测试与构建通过。名称校正只影响官网显示名，不改变该 Docker 镜像或原生目录。

镜像生成前的一次目录访问曾触发 image not found，实例按既有规则进入五分钟退避。镜像生成后通过管理员公开 stop 接口重置该 QA 实例，再由正常 catalog 请求唤醒，未修改数据库绕过退避。

验收结束时，测试任务保持暂停，交互及只读历史均已关闭，保留供统一界面核验。本轮不等同于生产发布；生产 Linux/x64 与 UID/GID 挂载权限仍需目标环境验收，公网出站白名单、模型出口代理及持久盘配额仍未实现或验证。
