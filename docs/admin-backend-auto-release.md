# 独立管理后台后端一键发布说明

更新时间：2026-08-21

## 1. 当前部署结构

- 源码：`/Users/qinyang/Desktop/zuling/conpanyManagement`
- 测试服：`132.232.220.115`
- systemd：`loumai-company-management.service`
- 本机监听：`127.0.0.1:8100`
- 公网前缀：`https://test.yinlizhangyu.com/admin-api`
- 发布目录：`/srv/loumai-company-management/releases`
- 当前版本链接：`/srv/loumai-company-management/current`

测试服始终只有一套管理后台进程。该进程读取 `/etc/loumai/database-active.env`，跟随业务后端当前的 `local` 或 `cloud` 数据库 profile，不会同时启动一套连本机库、一套连云数据库。

## 2. 一键发布

正式发布：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai && ./loumai-deploy admin-backend deploy --yes
```

只做本地测试和服务器预检，不切换版本：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai && ./loumai-deploy admin-backend deploy --dry-run
```

查看当前版本、数据库 profile 和服务状态：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai && ./loumai-deploy admin-backend status
```

首次安装或升级服务器 helper、systemd、Nginx 登录限流：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai && ./loumai-deploy admin-backend prepare --yes
```

## 3. 回滚

先用 `status` 或服务器 releases 目录确认目标版本号，再执行：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai && ./loumai-deploy admin-backend rollback --release 版本号 --yes
```

回滚会校验源码哈希，原子切换 `current`，重启服务并检查本机和公网健康；失败会自动恢复原版本。

## 4. 发布器会自动完成什么

1. Ruff 静态检查与格式检查；
2. 管理后台后端全量 pytest；
3. 排除 `.env`、私钥、本地虚拟环境、缓存和 macOS 元数据；
4. 生成确定性源码哈希、`release.json` 和 `SHA256SUMS`；
5. 上传到隔离的 incoming 目录；
6. 在服务器为每个版本建立固定依赖运行时；
7. 原子切换版本并重启唯一的管理后台进程；
8. 同时检查本机 `/health`、公网 `/health` 和 `/ready`；
9. 新版本失败时自动恢复旧版本。

发布器不会上传本地 `.env`、数据库口令、JWT 密钥、COS 密钥或 SSH 私钥，也不会执行 Alembic 迁移。数据库迁移由主业务后端发布器统一管理。

## 5. 服务器日常检查

SSH 登录测试服后执行：

```bash
sudo -n /usr/local/sbin/loumai-company-management-release status
systemctl is-active loumai-company-management.service
systemctl is-enabled loumai-company-management.service
curl -fsS http://127.0.0.1:8100/health
echo
curl -fsS http://127.0.0.1:8100/ready
echo
```

公网检查：

```bash
curl -fsS https://test.yinlizhangyu.com/admin-api/health
echo
curl -fsS https://test.yinlizhangyu.com/admin-api/ready
echo
```

查看最近日志：

```bash
sudo journalctl -u loumai-company-management.service -n 100 --no-pager
```

持续跟踪日志：

```bash
sudo journalctl -u loumai-company-management.service -f
```

## 6. 数据库 local/cloud 切换

管理后台代码发布不切换数据库。需要切换整套测试服数据库时，使用业务后端的两条命令：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai && ./loumai-deploy backend deploy --yes
```

上面使用测试服本机 PostgreSQL。

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai && ./loumai-deploy backend deploy-cloud --yes
```

上面使用腾讯云 PostgreSQL。切换时主发布器会协调 API、IM Worker、视频 Worker和管理后台，防止不同写进程连接不同数据库。

## 7. 前端压缩包边界

本文只处理管理后台后端。尚未收到的管理后台前端 `dist.zip` 不在本发布链中，也不会因为后端发布被自动上线。收到前端包后，需要单独校验其 API Base URL、静态资源路径和路由刷新，再建立独立前端原子发布流程。

## 8. 当前验收基线

2026-08-21 已完成：

- 管理后台后端全量 23 项测试通过；
- 独立发布器 8 项安全合同测试通过；
- 真实连续发布两版成功；
- 从新版本回滚到旧版本成功；
- 从旧版本恢复到最新版本成功；
- `8100` 仅监听 `127.0.0.1`；
- 未登录访问后台账号接口返回 HTTP 401；
- systemd 低权限用户、内存/CPU/任务数限制生效；
- 当前服务连接 `local` 数据库 profile，状态与主业务后端一致。
