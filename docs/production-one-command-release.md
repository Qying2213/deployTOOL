# 正式服全量一键发布

更新时间：2026-08-31

## 日常命令

一次性初始化、DNS、证书、正式配置和发布包均验收完成后，在 Mac 终端执行：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai
./loumai-deploy production deploy --dry-run
./loumai-deploy production deploy --yes
```

真实命令固定按以下顺序执行：

1. 业务后端；
2. 业务前端正式 ZIP；
3. 管理后台后端；
4. 管理后台前端正式 ZIP；
5. 四个目标状态验收。

任一步失败立即停止。数据库迁移不自动降级，已经成功发布的组件也不会被总入口盲目回滚。

## 本机配置

复制示例文件并保持本地文件不进入 Git：

```bash
cp config/production.example.env config/production.local.env
```

文件只保存两个可信正式包的绝对路径：

```dotenv
PRODUCTION_H5_PACKAGE=/Users/qinyang/Desktop/h5-production.zip
PRODUCTION_ADMIN_PACKAGE=/Users/qinyang/Desktop/admin-production.zip
```

各组件仍使用原有独立 production 配置，避免在总入口重复保存 SSH、域名或环境信息：

- `config/backend.production.local.env`
- `config/frontend.production.local.env`
- `config/admin-backend.production.local.env`
- `config/admin-frontend.production.local.env`

## 上线前置条件

- 两个前端 ZIP 必须是正式构建，不能包含测试 API、SourceMap、隐藏密钥或路径穿越成员。
- 主后端和管理后台后端必须处于配置指定分支、工作区干净并与远端完全同步。
- 正式服务器上的四个 helper、systemd、Nginx、证书、数据库角色和停写栅栏必须已完成一次性安装。
- `production preflight` 必须全部通过；不能关闭 helper 指纹、环境审计、数据库备份或测试门禁。

当前准备状态（2026-08-31）：

- 主业务后端正式 helper 已与当前部署工具同步，状态、环境审计和部署预演通过；没有发布代码、迁移数据库或重启服务。
- 业务 H5 正式目录、helper、Nginx/证书及本机 production 配置已就绪；`CURRENT` 仍为空，等待正式 H5 ZIP。
- 管理后台后端源码已同步远端；正式域名、证书、服务/helper、本机 production 配置及正式后台 ZIP 尚未完成，因此全量真实发布会保持阻断。
- 本机尚未收到 `/Users/qinyang/Desktop/h5-production.zip` 和 `/Users/qinyang/Desktop/admin-production.zip`；测试包不能改名充当正式包。

2026-08-31 正式后端 helper 同步前已建立远端备份：

```text
/var/backups/loumai-backend-helper-production.dwdb9s5n/loumai-backend-release
```

同步后的 helper SHA256 为 `b4d2dc71567291890c2a16e9e7dffdadae57578a5dd66364147ef9436864e18c`。业务 H5 helper SHA256 为 `b3bf62148b03977683a2e94f83e79b95ea1b8fdc07c58852af30d96738982ac5`。这些记录只证明发布基础设施核验，不表示业务已经上线。

单独查询全部线上状态：

```bash
./loumai-deploy production status
```

单组件回滚必须使用对应组件命令并指定确切 release。数据库没有自动回滚入口。
