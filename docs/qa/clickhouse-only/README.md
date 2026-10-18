# ClickHouse 单库与回退后补数验收

日期：2026-10-18。基线 `common/main`（`da75d73`），表结构参考 `origin/main`（`ff07b05`）。

环境：Windows、Node.js 24.20.0、pnpm 11.19.0；真实 ClickHouse 26.3.52.9 在本机 WSL Ubuntu 的隔离目录运行，仅监听 loopback。每项数据库测试创建独立 `website_test_<uuid>` 数据库，结束后删除。

结果：

- `pnpm typecheck`：通过。
- `pnpm build`：通过。
- 设置 `CH_TEST_URL` 后运行 `pnpm exec tsx --test test/tracking*.test.ts`：29/29 通过，无跳过。
- 同环境 `pnpm check`：141/142 通过，无跳过；唯一失败是原有 `test/admin-content.test.ts:105` 发布草稿删除在 Windows 返回 503。将未修改的 `common/main` 对应源码导出到隔离目录，单独运行该测试，同位置复现相同 503。该失败不涉及运营存储。

实际验证了：原有九类统计、员工跨设备/环境归属、资料新旧时间、匿名行为、乱序终态、Token/Skill 统计、保留期、管理员鉴权和输入边界；只具备 SELECT/INSERT 的 writer 与只读 reader；并发重传和队列过期；部分写入中断及发布响应丢失后的重启恢复；接管旧版本表并持续隐藏未发布尾部；补数修正 pending、映射已有员工、补入 45 天前的数据、跳过坏行、源文件字节不变及重复补数零新增。

另用编译产物执行 `dist/scripts/tracking/cli.js init`、`backfill`，启动 `dist/server/main.js`；健康检查、首次上报 ACK、重复上报 ACK 和登录后管理员统计均通过，统计包含补入和新上报的两条事实。服务启动无 SQLite 加载警告。源代码检查确认 `server/` 中不存在 SQLite 导入或查询逻辑。

生产未执行迁移或改写。隔离测试数据库和临时源/配置已清理。操作说明见 [切换与补数手册](../../runbooks/clickhouse-migration.md)。

## 指定时间增量补数

同日增加必填 `--since`，在原环境重新验证：

- `pnpm check`（真实隔离 ClickHouse）：144/145 通过，无跳过；32 项 tracking 测试全部通过。唯一失败仍是上述 `test/admin-content.test.ts:105` Windows 发布草稿删除问题。
- `pnpm build`、类型检查和编译后的 CLI `--help`：通过。
- 新增实际 SQLite 查询测试覆盖全部 11 张业务表：起点前 1 毫秒排除、起点包含、时区等价、北京时间跨日、迟到事件按接收时间、接收表缺失时回退发生时间、旧 pending 关联记录、用户 ID 映射与资料保护、无时间表的依赖选择、日汇总依赖、累计计数跳过、坏 JSON 与缺失表、源文件不变、重复补数零新增。
- 真实 ClickHouse 补数测试先以较晚起点补近期记录，再提前起点补入 45 天前的记录，并确认重复执行不重复写入。CLI 缺失/非法时间在加载配置和连接目标前失败。

本次仍未连接或修改生产库。

## 补数内存与请求超时

同日将 `pnpm tracking` 的 Node 老生代堆上限设置为 16384 MiB，离线 CLI 请求/查询预算统一为默认 300000 毫秒：

- `pnpm check`（真实隔离 ClickHouse）：145/148 通过，无跳过；35 项 tracking 测试全部通过，类型检查通过。除已知 Windows 发布草稿删除失败外，两项 HTTP 测试遇到随机监听端口触发 Node `bad port`；单独复跑对应两个测试文件后 20/21 通过，仅保留原有 `test/admin-content.test.ts:105` 失败。
- `pnpm build`、源码及编译后的 CLI `--help`：通过。
- 实际子进程从 package 脚本读取启动参数，验证堆上限不低于 16384 MiB；本机 Node 24 显示总堆上限 16576 MiB。验证默认/自定义预算输出及非法超时在加载配置前拒绝。
- 模拟传输验证初始化 DDL、启动读取、按键查询、旧版本读取、提交日志、实体 INSERT、水位发布和中断恢复均获得离线预算，在线配置对象未被修改。原有真实 ClickHouse 中断恢复及重复补数测试继续通过。

没有执行生产补数，也未测量生产耗时。测试数据库、临时文件和本次隔离 ClickHouse 实例已清理。
