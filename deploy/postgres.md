# PostgreSQL 部署与迁移

适用于 Moonward，不依赖其他网关的账号、数据库或 Redis。PostgreSQL 17 同时保存账号、聊天、附件、配额和生成状态。Worker 通过租约领取任务，API 通过 `LISTEN/NOTIFY` 唤醒订阅并从数据库读取增量。通知不是消息存储，刷新页面不会重发请求。API 的监听连接需要直连或会话级连接池，不能使用事务级连接池。

## 初始化与备份

生产只使用项目根目录的一份 Compose 和一份环境文件，见[首次部署](../README.md)。首次启动时数据库容器在空卷上事务性建表，生成受限运行角色，并创建空的网关和模型目录。保留卷重启不会重新初始化。应用与 Worker 通过专用网络连接 PostgreSQL，不需要映射 5432。

备份目录应私有；在项目目录执行 `umask 077` 后使用 `docker compose exec -T -u postgres db pg_dump -Fc moonward > /protected/moonward.dump`。单独安全备份 `.env`。在隔离实例的空库（预先创建所需角色）用 `pg_restore --exit-on-error` 演练还原。不要用 SQLite 的备份命令处理生产数据库。

可以用 `docker compose up -d --scale worker=2 --wait` 增加 Worker，但管理员设定的容量不是性能保证。以下是历史测试，不代表新部署已经通过百路并发验收。

## 验收与恢复

使用**专用测试数据库**设置 `MOONWARD_TEST_DATABASE_URL`，不要指向生产。以下测试创建和清理各自的 schema，使用本机模拟上游，不产生网关费用：

```bash
node --test test/postgres.test.ts
npm run test:browser -- postgres-ui.spec.ts
SOAK_SECONDS=1800 node test/postgres-load.ts
```

先验收 200 次突发提交、100 路活跃生成、30 分钟流式传输及文本完整性；目标提交 P95 < 500 ms，增量送达 P95 < 250 ms。再按已确认的费用和速率预算，分 10、25、50、100 路验证真实网关，单独记录限流、断流与计费。

单独演练旧登录迁移时，在隔离的测试集群提供有建库权限的 `MOONWARD_TEST_ADMIN_DATABASE_URL`，执行 `node --test test/postgres-import.test.ts`。该测试创建、验证并删除自己的数据库，不需要生产快照。

### 本地验收记录

本机隔离测试使用 PostgreSQL 17（内存文件系统）、一个 API 进程、两个 Worker 进程和模拟流式网关。一个测试账号向 200 个空会话同时提交，随后复用已完成的会话。它不是生产磁盘、真实网关或 200 个独立账号的测试。

| 30 分钟结果 | 测量值 |
| --- | ---: |
| 实际上游请求 / 完成且比对全文一致 | 917 / 917 |
| 每秒采样活跃生成：平均 / 最低 / 峰值 | 99.97 / 98 / 100 |
| 首批 200 请求端到端提交 P95 | **503 ms（未达 < 500 ms）** |
| 全程端到端提交 P95 | 452 ms |
| 719,651 个增量时间样本，客户端送达 P95 | 106 ms |

这轮长测未完全通过，不作为上线批准。目标机器应使用拟上线存储与反代重新测试，保留突发和整体两组数据，不以一次通过的短测替代长测。

在目标部署环境分别测试直连 API 和经过反向代理的路径，记录并发数、提交和送达 P95、意外中断数及全文一致性。可从 `MOONWARD_TEST_ACTIVE=4` 开始；经测试代理时设置 `MOONWARD_TEST_BACKEND_PORT` 和 `MOONWARD_TEST_PROXY_PORT`，代理和后端都必须绑定回环地址。使用模拟网关，不要把真实账号、聊天记录或凭据作为测试样本。

使用 `pg_dump -Fc` 备份至受控位置，用 `pg_restore --exit-on-error` 演练还原到**另一空库**；另行安全备份 `AUTH_SECRET`。要求时间点恢复时配置 WAL 归档。SQLite 备份工具不适用于 PostgreSQL。对外开放写入前可停新服务并切回旧 SQLite；接受第一笔新写入后，旧快照已不完整，不能直接切回，须先冻结写入并核对迁移后的增量。
