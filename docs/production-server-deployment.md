# 工位有方业务正式服部署手册

本文只覆盖业务 API、IM Worker、视频 Worker、三个定时任务和 H5。它不授权自动连接或修改正式服务器；所有带 `--yes` 的命令都必须在一次性服务器配置、DNS、备份和安全门禁完成后人工执行。

正式服与测试服必须完全隔离：独立 SSH 目标、发布目录、环境文件、数据库、Redis、COS、证书和发布历史。正式服务器公网 IP 只写入 Git 忽略的 `config/*.production.local.env`，不要提交到仓库。

## 1. 上线前必须确定的输入

- API 域名：当前模板固定为 `api.yinlizhangyu.com`，DNS 必须解析到正式 CVM。
- H5 域名：尚未确定。确定后必须同时替换三处 `h5.example.com`：本机配置、服务器 H5 helper 配置和 Nginx 配置。
- SSH：正式服 Host Key、`loumai-deploy` 的独立密钥和端口。`ubuntu` 只用于一次性主机初始化，不能作为日常发布账号。
- PostgreSQL：使用腾讯云提供、可与证书名称匹配的 DNS endpoint；准备独立的运行账号和迁移账号，运行账号不得有 DDL 权限。
- PostgreSQL CA：安装到 `/etc/loumai/certs/tencentdb-ca.pem`，不能使用 IP endpoint 或 `sslmode=require` 代替 `verify-full`。
- Redis：首选公网不可达的托管私网 TLS `rediss://` 地址。若负责人明确接受单机故障风险，
  可临时使用只监听 `127.0.0.1`、启用 TLS 和持久化的本机 Redis，并将
  `LOUMAI_BACKEND_LOCAL_REDIS_APPROVED=true`；迁移到托管 Redis 后必须恢复为 `false`。
- COS/CAM：生产 Bucket、地域、最小权限凭据、CORS；房源视频直传第一次上线必须保持关闭。
- TLS：API 和 H5 的有效证书。
- 备份：腾讯数据库自动备份、异地或不可变副本，以及最近 90 天内真实恢复演练的证据。
- 拓扑：当前迁移锁只管理这一台 CVM 上列出的 writer。正式上线时不得存在第二台 API/Worker 或外部 cron 同时写库。

缺少任一项时，保留模板占位符并停止，不要为了“先跑起来”关闭门禁。

## 2. 一次性主机初始化

以下操作必须由管理员通过腾讯云控制台或 `ubuntu` 的受控 sudo 会话完成。不要让日常发布流程自动覆盖 `/usr/local/sbin`、`/etc/systemd/system` 或 `/etc/sudoers.d`。

### 2.1 系统账号和目录

创建八个不同 UID：发布、API、视频、IM、定时任务、迁移、构建和备份用户。另建只用于读取 PostgreSQL 公共 CA 的 `loumai-db-ca` 组；`loumai-deploy` 需要 SSH，其他账号禁止交互登录。

```bash
sudo groupadd --system loumai-db-ca
sudo useradd --create-home --shell /bin/bash loumai-deploy
sudo useradd --system --home-dir /var/lib/loumai-api --create-home --shell /usr/sbin/nologin loumai-api
sudo useradd --system --home-dir /var/lib/loumai-video --create-home --shell /usr/sbin/nologin loumai-video
sudo useradd --system --home-dir /var/lib/loumai-im --create-home --shell /usr/sbin/nologin loumai-im
sudo useradd --system --home-dir /var/lib/loumai-jobs --create-home --shell /usr/sbin/nologin loumai-jobs
sudo useradd --system --home-dir /var/lib/loumai-migrate --create-home --shell /usr/sbin/nologin loumai-migrate
sudo useradd --system --home-dir /var/lib/loumai-build --create-home --shell /usr/sbin/nologin loumai-build
sudo useradd --system --home-dir /var/lib/loumai-backup --create-home --shell /usr/sbin/nologin loumai-backup
sudo usermod --append --groups loumai-db-ca loumai-api
sudo usermod --append --groups loumai-db-ca loumai-video
sudo usermod --append --groups loumai-db-ca loumai-im
sudo usermod --append --groups loumai-db-ca loumai-jobs
sudo usermod --append --groups loumai-db-ca loumai-migrate
sudo usermod --append --groups loumai-db-ca loumai-backup
```

把正式部署公钥写入 `/home/loumai-deploy/.ssh/authorized_keys`，目录权限 `0700`、文件权限 `0600`，所有者均为 `loumai-deploy`。该用户不能属于 `sudo`、`admin`、`wheel` 或其他通用提权组。

```bash
sudo install -d -m 0755 -o root -g root \
  /srv/loumai-backend \
  /srv/loumai-backend/backend-releases \
  /srv/loumai-backend/incoming \
  /srv/loumai-h5-production \
  /srv/loumai-h5-production/frontend-releases \
  /srv/loumai-h5-production/incoming
sudo install -d -m 0700 -o loumai-video -g loumai-video /var/lib/loumai-video/tmp
sudo install -d -m 0700 -o loumai-backup -g loumai-backup /var/backups/loumai
sudo install -d -m 0755 -o root -g root /etc/loumai
sudo install -d -m 0700 -o root -g root /etc/loumai/database-profiles
sudo install -d -m 0750 -o root -g loumai-db-ca /etc/loumai/certs
sudo install -d -m 0700 -o loumai-build -g loumai-build /var/lib/loumai-build/.cache/uv
```

安装 Nginx、PostgreSQL 客户端、curl、rsync、tar、flock 等系统工具。固定 Python、uv、FFmpeg 和 ffprobe 必须位于 `/opt/loumai-runtime`、归 root 所有且不可由发布用户写入；FFmpeg 必须包含 `libx264`。具体固定运行时规则沿用 [`backend-auto-release.md`](backend-auto-release.md) 中的运行时与视频 Worker 章节。

### 2.2 安装 root-owned helper 和最小 sudo 规则

从经过评审的部署仓库精确 commit 取出以下文件，用一次性管理员会话安装；安装前后核对 SHA256：

- `backend/remote/loumai-backend-release` → `/usr/local/sbin/loumai-backend-release`，`root:root 0755`
- `frontend/remote/loumai-h5-release` → `/usr/local/sbin/loumai-h5-release`，`root:root 0755`
- `backend/remote/production-deploy.sudoers.example` → `/etc/sudoers.d/loumai-deploy`，`root:root 0440`

```bash
sudo visudo -cf /etc/sudoers.d/loumai-deploy
sudo -u loumai-deploy sudo -n /usr/local/sbin/loumai-backend-release version
sudo -u loumai-deploy sudo -n /usr/local/sbin/loumai-h5-release version
```

当前后端 helper 协议版本为 `6`，H5 helper 协议版本为 `4`。本机发布器还会验证 helper 文件的完整 SHA256 指纹，因此仅版本号相同但源码不同也会被拒绝。

#### 已初始化正式服只升级 helper（不部署）

遇到“实际 5，要求 6”时，不要重做 bootstrap、关闭版本检查或修改旧 release 的元数据。管理员先核对线上环境、当前 commit、DB revision、配置和业务进程快照，审核新旧 helper 差异；在共享发布锁下备份旧文件，再将候选文件安装到 root 私有暂存目录，校验语法、版本、SHA256 和只读 preflight，最后同文件系统原子替换。失败只恢复 helper，不能借此切换应用或恢复数据库。

2026-08-28 按“修复正式服 helper，但先不部署”的授权完成：

- `/usr/local/sbin/loumai-backend-release` 从 `5` 升至 `6`，保持 `root:root 0755`。新 SHA256：`7f3c260cac8dd0d820b44381e340abe8531b6fc7938e0897d54e325cdf3ba627`，与本机实际 helper 一致。
- 旧文件保留在服务器 `/var/backups/loumai-backend-helper-production.GwzuDMar/loumai-backend-release`，目录 root 私有；旧 SHA256：`d4e9ed0680abf81a8c3b953d45b3c36e4c85422a41a0924b1a34d9e16b0989e9`。
- 升级前后均运行 release `20260824T065827Z-60cf6a5500`、commit `60cf6a55000fb171a54e200bc9d2d945f12df222`，云库 revision 保持 `20260822_0086`。没有打包或上传业务产物、切换版本、运行迁移、修改应用配置或重启业务服务；三个常驻进程 PID/启动时间及五份部署/应用/数据库配置文件哈希均未变化。
- `backend status --env production`、`backend env-audit --env production`、`backend deploy --env production --dry-run` 均退出 0。状态为 `HEALTHY`、`RECOVERY_REQUIRED=false`、`DATABASE_WRITERS=verified`；公网健康检查 HTTP 200，应用和数据库均为 `ok`。
- 环境审计为 **0 阻断、32 警告、7 提示**。警告包含开发/正式环境差异、地图/ASR 等配置缺失及新旧 Settings 变量差异，未自动复制开发配置、删除旧变量或启用功能。真正上线新业务版本前必须逐项确认，不能把只读预检通过等同于完整上线验收。
- 本机后端与正式管理后台部署专项测试 **71 项通过**，Bash 语法与差异检查通过；本次没有执行真实业务发布命令。

`status` 末尾旧 release 元数据中的 `tool.backend_release_tool` 仍为 `5`，表示该业务包当时使用的构建工具版本，不是当前安装 helper 的版本。旧 release 保持只读，不应为了显示 `6` 而改写历史记录。

随后在 2026-08-28 16:20（北京时间）根据单独授权完成了正式 env 补齐：新增 57 项、仅调整已有 ASR 开关，原生产凭据与拓扑保留；仍未发布、迁移或重启。最新审计为 0 阻断、22 警告、42 提示。新增地图/ASR/公众号凭据暂与测试环境共用，公众号和厂商推送未启用。备份及验收详情见 [正式服后端环境变量补齐与验收说明](../../managedocx/01-一键发布/正式服后端环境变量补齐与验收说明.md)，上面的 32 警告是只修复 helper 时的历史结果。

### 2.3 安装服务器配置和密钥

基于模板创建下列文件。真实口令、Token 和 AccessKey 只写在服务器 root-owned `0600` 文件中，不能放进本机部署配置、Git、聊天或发布产物。

| 模板 | 服务器目标 |
| --- | --- |
| `backend/remote/loumai-backend-release.production.env.example` | `/etc/loumai/backend-release.env` |
| `frontend/remote/loumai-h5-release.production.env.example` | `/etc/loumai/h5-release.env` |
| `backend/remote/database-profile.production.cloud.env.example` | `/etc/loumai/database-profiles/cloud.env` |
| `backend/remote/database-active.production.env.example` | `/etc/loumai/database-active.env` |
| `backend/remote/production-backup-evidence.env.example` | `/etc/loumai/production-backup-evidence.env` |

应用配置分别放在 `/etc/loumai/backend.env` 和 `/etc/loumai/sms.env`。这两个基础文件禁止出现 `DATABASE_URL`、`MIGRATION_DATABASE_URL`、`LOUMAI_DATABASE_PROFILE` 或 `LOUMAI_DATABASE_NAME`。

数据库 CA 文件设为 `root:loumai-db-ca 0640`。API、视频、IM、jobs、迁移和备份身份必须加入 `loumai-db-ca`；除此之外的账号不能读取该文件。安装后执行 `sudo chown root:loumai-db-ca /etc/loumai/certs/tencentdb-ca.pem` 和 `sudo chmod 0640 /etc/loumai/certs/tencentdb-ca.pem`。

`cloud.env` 同时保存运行 URL 与迁移 URL，只允许 root 发布 helper 读取。`database-active.env` 只保存运行 URL，由 systemd 加载，严禁包含 `MIGRATION_DATABASE_URL`。每次切换 profile 时 helper 都会重新生成这个最小运行文件，避免 API/Worker 获得 DDL 凭据。

迁移账号必须具备目标数据库的 `CONNECT`、`TEMPORARY`，以及 `public` schema 的 `USAGE`、`CREATE`；部分历史迁移会创建事务级临时表。运行账号和备份账号必须继续禁止 `CREATE`、`TEMPORARY`。数据库所有者初始化时执行：

```sql
GRANT TEMPORARY ON DATABASE loumai_production TO loumai_migrate;
```

运行账号对业务序列只授予 `USAGE / SELECT`，并显式撤销 `UPDATE`。这既允许列默认值调用 `nextval`（包括 `properties_property_no_seq` 自动生成公开房源编号），又禁止普通业务进程调用 `setval` 重置编号。远端 helper 会同步现有序列和默认权限，并在预检中拒绝仍有序列 `UPDATE` 的运行账号；迁移账号仍由独立 DDL 权限合同管理。

备份证据中的 `BACKUP_POLICY_REFERENCE` 必须使用
`tencentdb-postgresql/地域/postgres-实例ID/策略ID` 格式，并对应腾讯云控制台中的真实实例与自动备份策略；模板占位值不会通过预检。

正式应用配置至少满足：

```dotenv
APP_ENVIRONMENT=production
ALLOW_INSECURE_TEST_SETTINGS=false
API_DOCS_ENABLED=false
ALLOW_MOCK_WECHAT=false
REGISTRATION_SMS_VERIFICATION_ENABLED=true
GEO_WEBVIEW_COOKIE_SECURE=true
BACKEND_ALLOWED_HOSTS=api.yinlizhangyu.com
BACKEND_CORS_ORIGINS=https://替换为正式H5域名
BACKEND_CORS_ORIGIN_REGEX=
FILE_STORAGE_PROVIDER=tencent_cos
VIDEO_TRANSCODE_ENABLED=true
PROPERTY_VIDEO_DIRECT_UPLOAD_ENABLED=false
```

同时配置非 mock 短信、微信、COS、视频媒体票据、作业 Token、AI/IM（如启用）和 `rediss://`。不要在文档或命令行中展开真实值。

### 2.4 安装 systemd 和 Nginx

把六个 `*.production.service.example` 和三个 `*.production.timer.example` 安装到 `/etc/systemd/system/`，去掉 `.production` 与 `.example`：

- `loumai-api.service`
- `loumai-im-worker.service`
- `loumai-video-worker.service`
- `loumai-app-push-dispatcher.service/.timer`
- `loumai-rent-billing.service/.timer`
- `loumai-file-storage-cleanup.service/.timer`

```bash
sudo systemctl daemon-reload
sudo systemctl disable --now \
  loumai-api.service loumai-im-worker.service loumai-video-worker.service \
  loumai-app-push-dispatcher.timer loumai-rent-billing.timer loumai-file-storage-cleanup.timer
```

首次 `bootstrap` 成功前必须保持这些 unit 停止。成功后 helper 才会启动、验证并设置开机自启。租金任务显式使用 `Asia/Shanghai` 业务时区。

Nginx 使用：

- `backend/remote/nginx-no-media-ticket-log.conf.example`：放在 `http {}` 内，access log 不记录查询串。
- `backend/remote/nginx-production-api.conf.example`：API 与共享的 HTTP 默认拒绝站点。
- `frontend/remote/nginx-production-h5.conf.example`：H5；替换域名和证书路径。

API 模板拥有同一台主机唯一的 `listen 80 default_server`，不要在 H5 文件重复添加。DNS 和证书完成后先运行 `sudo nginx -t`，再 reload。上线前用带随机 `media_ticket` 的故障请求检查 Nginx error log；确认查询凭据没有落盘。长期方案应淘汰 query credential，而不是只依赖 access log 格式。

## 3. 本机正式服配置

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai
cp config/backend.production.example.env config/backend.production.local.env
cp config/frontend.production.example.env config/frontend.production.local.env
chmod 600 config/backend.production.local.env config/frontend.production.local.env
```

在忽略的本机文件中填写 `loumai-deploy@正式服地址`、SSH key、源码绝对路径、正式域名和分支。不要填写数据库 URL、口令或 AccessKey。

后端正式源码必须位于 `master`（或经评审后同步修改 `BACKEND_EXPECTED_BRANCH`），工作区干净且 `HEAD` 等于 upstream。

前端仓库的 `.env.production` 目前仍是测试配置，必须先改成并提交：

```dotenv
VITE_APP_ENV=production
VITE_API_BASE_URL=https://api.yinlizhangyu.com/api/v1
VITE_CHANNEL_BINDING_H5_BASE_URL=https://替换为正式H5域名
VITE_TIANDITU_WEB_MAP_BASE_URL=https://替换为正式H5域名/
VITE_ENABLE_TEST_ACCOUNTS=false
```

发布器会拒绝 `test.yinlizhangyu.com`、localhost、私网地址、测试账号开关和错误的环境标签；ZIP 交付模式也执行同样的产物扫描。

## 4. 第一次发布

### 4.1 后端 bootstrap

全新正式服没有 `backend-current` 时，普通 `deploy` 会明确拒绝，必须执行且只能执行一次 `bootstrap`：

```bash
./loumai-deploy backend status --env production
./loumai-deploy backend bootstrap --env production --dry-run
./loumai-deploy backend bootstrap --env production --yes
./loumai-deploy backend env-audit --env production --all
./loumai-deploy backend status --env production
```

首次状态应显示 `INITIALIZED=false`、`CURRENT=NONE`、`DB_REVISION=bootstrap` 和 `DATABASE_WRITERS=not_initialized`。bootstrap 会在安装首个受控产物后读取真实数据库：只有空库 `base` 或产物迁移图中的受控祖先 revision 才能继续。随后按“停写 → 再核对 revision → 本机备份 → Alembic 前向迁移 → 原子切换 → API/Worker 健康检查 → timers → enable”的顺序执行。

成功状态必须显示 `INITIALIZED=true`、当前 release、唯一 DB revision、`DATABASE_WRITERS=verified`，三个长驻 service 和三个 timer 均 active/enabled。

### 4.2 H5 首次发布

后端公网健康检查和环境审计全部通过后再发布 H5：

```bash
./loumai-deploy frontend status --env production
./loumai-deploy frontend deploy --env production --dry-run
./loumai-deploy frontend deploy --env production --yes
./loumai-deploy frontend status --env production
```

远端预检会同时绑定 `production` 环境、发布根目录和公网 URL，防止误投到另一台同类服务器。

### 4.3 房源视频直传第二阶段

第一次发布保持：

```dotenv
PROPERTY_VIDEO_DIRECT_UPLOAD_ENABLED=false
```

并保持 `/etc/loumai/backend-release.env` 中：

```dotenv
LOUMAI_BACKEND_PROPERTY_VIDEO_DIRECT_UPLOAD_APPROVED=false
```

只有完成 COS Bucket 版本状态、CAM/STS、CORS、小程序上传合法域名以及 H5/小程序/iOS/Android 四端验收后，才同时把两项改为 `true`，再执行 `env-audit`、`deploy --dry-run` 和 `deploy --yes`。helper 会调用真实 COS/STS canary；任一项失败都会在迁移和停服务前阻断。

## 5. 日常发布和回滚

后端：

```bash
./loumai-deploy backend env-audit --env production
./loumai-deploy backend status --env production
./loumai-deploy backend deploy --env production --dry-run
./loumai-deploy backend deploy --env production --yes
./loumai-deploy backend status --env production
```

H5：

```bash
./loumai-deploy frontend status --env production
./loumai-deploy frontend deploy --env production --dry-run
./loumai-deploy frontend deploy --env production --yes
./loumai-deploy frontend status --env production
```

后端回滚只切应用代码，不 downgrade 或 restore 数据库，必须人工确认目标版本兼容当前 schema：

```bash
./loumai-deploy backend rollback --env production \
  --release RELEASE_ID --ack-db-schema-compatible --yes
```

回滚前 helper 还会用当前生产环境验证目标版本的 Settings、数据库目标与权限、迁移祖先关系以及直传 COS 能力。H5 回滚使用对应 `--env production`。

## 6. 失败处理边界

- 数据库迁移一旦尝试，任何后续失败都会保持所有 writer 停止；禁止自动 downgrade 或自动 restore。
- 先保存命令输出中的 `CRITICAL_BACKUP`，核对数据库 revision，再决定前向修复或受控恢复。不要通过重启服务器“碰碰运气”。
- 迁移前失败只有在旧 API/Worker 已恢复、健康检查和 release 校验全部通过后才重新启动 timers；否则继续 fail-closed。
- 每次发布前的本机备份不能代替腾讯数据库异地备份。正式 helper 会验证最近 90 天恢复演练证据。
- 当前正式脚本只支持单 CVM writer 拓扑。扩容到多实例前必须增加全局 drain/维护栅栏。

## 7. 管理后台与其他独立目标

管理后台前后端已提供独立正式服发布链，见 [管理后台前后端正式服一键发布](admin-production-release.md)。主业务首次 bootstrap 仍不依赖后台；后台上线前必须安装其正式 unit/helper/独立运行凭据，并将 `loumai-company-management.service` 加入 `LOUMAI_BACKEND_AUXILIARY_DATABASE_SERVICES`。主发布器允许该服务使用专属应用/数据库 EnvironmentFiles，仍验证实际数据库目标和 TLS，并在迁移时协调停写。不能把测试 helper 或测试环境复制到正式服，也不能遗漏已运行的后台 writer。

官网 `website` 仍有独立发布链，不能复用本手册的业务 API/H5 或管理后台目录。

API、视频、IM 和 jobs 已使用不同系统 UID，并通过 `/proc` 隐藏降低横向读取风险；但业务 `Settings` 目前仍是统一配置模型，各角色仍会接收超出自身最小需要的部分应用密钥。helper 默认用 `LOUMAI_BACKEND_MONOLITHIC_SETTINGS_SECRET_SCOPE_APPROVED=false` 阻断正式发布；只有安全负责人明确接受这一临时风险后才能改为 `true`，并应随后在业务代码中拆分 role-specific Settings/credentials。迁移 DDL 凭据由独立 `loumai-migrate` 身份使用，且不会进入任何业务 systemd 进程。
