# 工位有方统一部署工具

这个仓库只负责发布，不存放业务源码，也不保存测试服密码、Token、数据库连接串或私钥内容。

它统一发布五个独立目标：

| 目标 | 源码目录 | 线上内容 |
| --- | --- | --- |
| `frontend` | `../qiye-qianduan` | 测试服/正式服 H5 |
| `backend` | `../loumai-ai` | 测试服/正式服 FastAPI、数据库迁移、IM/视频 Worker、定时任务 |
| `admin-backend` | `../conpanyManagement` | 测试服/正式服独立企业管理后台后端 |
| `admin-frontend` | 同事交付的后台 ZIP | 独立测试站/正式管理后台站点 |
| `website` | `../guanwang` | 工位有方官网静态文件 |

日常操作只使用根目录的 `./loumai-deploy`。详细的一次性服务器安装说明放在 `docs/`，不要把安装步骤和日常发布混着执行。

管理后台正式服联合发布入口（首次资源安装完成后）：

```bash
./loumai-deploy admin deploy --env production --file /Users/qinyang/Desktop/admin-production.zip --yes
```

`admin` 是前后端顺序发布入口，不是第六个线上服务；`admin prepare --env production --yes` 只生成本机安装包。正式域名、独立数据库角色、证书及主业务停写保护必须先配置。完整说明见 [管理后台前后端正式服发布](docs/admin-production-release.md)。原有未写 `--env production` 的后台命令仍默认测试服。

## 1. 先记住这四条

1. 发布前，源码必须已经提交并推送，且工作区干净。
2. 涉及新配置时先运行 `env-audit`；日常先运行 `status`，再运行 `deploy --dry-run`，确认无误后才运行 `deploy --yes`。
3. `deploy --yes` 会修改服务器；`status` 和 `--dry-run` 不会切换线上版本。
4. 后端源码仓库中的 `.env` 不会随代码发布。测试服和正式服的真实环境变量分别保存在各自服务器的 `/etc/loumai/`。

## 2. 日常最常用命令

### 2.0 真正一键发布

如果你已经确认代码已提交并推送，可以直接复制下面两条单行命令。它们分别把后端和 H5 真实构建、上传并切换到测试服。

后端一键发布：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai && ./loumai-deploy backend deploy --yes
```

上面这条旧命令继续使用测试服务器本机 PostgreSQL。需要把同一套测试服后端切换为腾讯云 PostgreSQL 时，使用另一条明确命名的命令：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai && ./loumai-deploy backend deploy-cloud --yes
```

两个数据库是彼此独立的数据集；发布器只选择目标、备份、迁移和切换服务，不会把本机数据库的数据自动复制到云数据库。云数据库首次配置见[后端自动发布说明的双数据库章节](docs/backend-auto-release.md#测试服双数据库发布)。

测试服前端一键发布：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai && ./loumai-deploy frontend deploy --env test --yes
```

前端同事交付 H5 构建 ZIP 时，一键发布该压缩包：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai && ./loumai-deploy frontend deploy-package --file /绝对路径/web.zip --env test --yes
```

`deploy-package` 发布的是 `--file` 指定的 ZIP，不会重新构建你本机的 `qiye-qianduan`。ZIP 根目录可以直接包含 `index.html`，也可以只包含一个 `web/` 目录。收到新包后只需要替换命令中的绝对路径。

一键命令内部仍会执行 Git、测试、产物、哈希和服务器状态门禁；任何检查失败都会停止，不会强行上线。后端源码仓库里的本地 `.env` 不会随命令上传。启用 P1-MEDIA-02 前，必须先按[后端自动发布说明](docs/backend-auto-release.md#41-p1-media-02-视频-worker-一次性安装)一次性安装固定 FFmpeg、视频 Worker 和日志脱敏配置；该系统依赖不由日常一键命令下载。

> `website` 发布的是 `yinlizhangyu.com` 正式官网，不是测试服。官网首次初始化完成前，不能把 `website deploy --yes` 当作测试服一键发布命令使用。

如果需要先查看状态或预演，再使用下面的分步命令。

进入部署工具目录：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai
```

### 2.1 发布后端

```bash
./loumai-deploy backend env-audit --env test
./loumai-deploy backend status
./loumai-deploy backend deploy --dry-run
./loumai-deploy backend deploy --yes
./loumai-deploy backend deploy-cloud --dry-run
./loumai-deploy backend deploy-cloud --yes
./loumai-deploy backend status
```

- `deploy`：部署测试服，并让 API、IM Worker、视频 Worker 和独立管理后台使用测试服务器本机 PostgreSQL；
- `deploy-cloud`：部署测试服，并让上述全部数据库 writer 使用腾讯云 PostgreSQL；
- `status --database-profile local|cloud|active`：只读检查指定目标或当前活动目标。

最后一次 `status` 应显示：

- `CURRENT` 指向本次新 release；
- `DB_REVISION` 等于源码当前 Alembic head；
- `loumai-api.service`、`loumai-im-worker.service` 和启用视频功能后的 `loumai-video-worker.service` 都是 `active`。

#### 独立发布管理后台后端

业务后端切换 local/cloud 数据库时会统一停启并校验管理后台；管理后台代码本身使用独立版本链发布：

```bash
./loumai-deploy admin-backend deploy --dry-run
./loumai-deploy admin-backend deploy --yes
./loumai-deploy admin-backend status
./loumai-deploy admin-backend rollback --release RELEASE_ID --yes
```

首次安装或升级服务器 helper、systemd 资源限制及 Nginx 登录限流：

```bash
./loumai-deploy admin-backend prepare --yes
```

管理后台发布不会上传 `.env`、私钥、数据库口令或本地虚拟环境。它沿用测试服当前活动数据库 profile，但使用独立的发布目录、Python 运行时和回滚链。

完整安装、发布、检查及回滚说明见 [`docs/admin-backend-auto-release.md`](docs/admin-backend-auto-release.md)。

#### 独立发布管理后台前端 ZIP

先在阿里云添加 `admin-test` 的 A 记录为 `132.232.220.115`（无 AAAA），然后在 Mac 终端执行：

```bash
./loumai-deploy admin-frontend check-package --file /Users/qinyang/Desktop/gongweiyoufang-admin-20260827-test.zip
./loumai-deploy admin-frontend deploy-package --file /Users/qinyang/Desktop/gongweiyoufang-admin-20260827-test.zip --dry-run
./loumai-deploy admin-frontend deploy-package --file /Users/qinyang/Desktop/gongweiyoufang-admin-20260827-test.zip --yes
./loumai-deploy admin-frontend status
```

首次发布自动安装独立站点、HTTPS、续期定时器和后台前端专属 helper，后续复用；不改业务 H5、后端配置或数据库。已知旧测试 API 在部署副本内转换为同源 `/admin-api/api/v1`，原 ZIP 保留。只接受可信同事的测试包。详细范围、回滚及当前上线前置条件见 [后台前端发布说明](docs/admin-frontend-auto-release.md)。

### 2.2 发布测试服 H5

```bash
./loumai-deploy frontend status
./loumai-deploy frontend deploy --env test --dry-run
./loumai-deploy frontend deploy --env test --yes
./loumai-deploy frontend status
```

如果收到的是前端同事已经构建好的 ZIP，先只读预演，再正式发布：

```bash
./loumai-deploy frontend deploy-package --file /绝对路径/web.zip --env test --dry-run
./loumai-deploy frontend deploy-package --file /绝对路径/web.zip --env test --yes
./loumai-deploy frontend status
```

压缩包模式仍会运行部署工具自身的安全测试，但不会运行前端源码测试，也无法证明同事从哪个 Git commit 构建；发布记录会保存完整 ZIP SHA256，并明确标记 `source.kind=external_zip`。因此只接受可信同事交付的 H5 构建包，不能把网上下载或来源不明的 ZIP 直接上线。

### 2.3 部署业务正式服

业务正式服使用独立的 `production` 配置、云数据库和发布目录。全新服务器第一次后端发布必须使用一次性的 `bootstrap`，后续使用 `deploy`：

```bash
./loumai-deploy backend status --env production
./loumai-deploy backend bootstrap --env production --dry-run
./loumai-deploy backend bootstrap --env production --yes
./loumai-deploy backend env-audit --env production --all
./loumai-deploy backend status --env production

./loumai-deploy frontend status --env production
./loumai-deploy frontend deploy --env production --dry-run
./loumai-deploy frontend deploy --env production --yes
./loumai-deploy frontend status --env production
```

这些命令不能直接用于一台尚未完成用户隔离、root helper、systemd、TLS、腾讯数据库 CA、异地备份恢复演练、Redis/COS 和 DNS 配置的空服务器。完整首次安装顺序、正式模板和失败处理见 [`docs/production-server-deployment.md`](docs/production-server-deployment.md)。

### 2.4 发布正式官网（不是测试服）

先查询官网发布器状态：

```bash
./loumai-deploy website status
```

只有状态明确显示已经初始化、存在当前版本且 HTTPS 已启用后，日常更新才使用：

```bash
./loumai-deploy website deploy --dry-run
./loumai-deploy website deploy --yes
./loumai-deploy website status
```

如果状态显示 `INITIALIZED=false` 或 `CURRENT=NONE`，应先按照官网首次部署文档执行 `prepare` 和 `enable-https`，不要直接运行日常发布命令。日常官网发布只更新静态版本，不修改 DNS，也不会重复申请证书。

## 3. 命令会做什么

| 命令 | 是否修改服务器 | 作用 |
| --- | --- | --- |
| `status` | 否 | 查询当前版本、数据库版本和服务状态 |
| `build` | 否 | 在本机从确定 Git commit 构建并校验产物 |
| `deploy --dry-run` | 否 | 做只读预检；前后端不构建，官网会在本机真实构建 |
| `deploy --yes` | 是 | 构建、验签、上传、原子切换并验收 |
| `backend bootstrap --env production --yes` | 是 | 仅用于全新正式服的首个受控版本、数据库迁移和开机自启初始化 |
| `frontend deploy-package --file ... --yes` | 是 | 安全导入已有 H5 ZIP、验签、原子切换并验收 |
| `rollback --dry-run` | 否 | 检查目标 release、哈希和当前版本条件 |
| `rollback --yes` | 是 | 原子切换到指定历史版本 |
| `website prepare --yes` | 是 | 官网第一次上线时建立独立目录和 HTTP 站点 |
| `website enable-https --yes` | 是 | 官网第一次上线或证书修复时检查 DNS 并启用 HTTPS |

`npm test` 只测试部署工具本身的安全合同，不等于业务项目测试。正式发布器还会执行各源码项目自己的门禁。

## 4. 发布前检查

### 4.1 Git 状态

在要发布的源码仓库执行：

```bash
git status
git branch --show-current
git rev-parse HEAD
git rev-parse '@{upstream}'
```

必须满足：

- 没有未提交文件；
- 没有进行中的 merge/rebase；
- 分支等于部署配置要求的分支；
- `HEAD` 与 upstream commit 完全相同。

发布器会再次检查，条件不满足时会主动停止。

### 4.2 本地配置

每台开发电脑第一次使用时才创建：

```bash
cp config/frontend.test.example.env config/frontend.test.local.env
cp config/backend.test.example.env config/backend.test.local.env
cp config/frontend.production.example.env config/frontend.production.local.env
cp config/backend.production.example.env config/backend.production.local.env
cp config/website.production.example.env config/website.production.local.env
chmod 600 config/*.local.env
```

`*.local.env` 只保存：

- 源码仓库绝对路径；
- SSH 的 `user@host`、端口和私钥路径；
- 目标域名、远端受控目录和预期分支。

不要在这些文件里写登录密码、数据库 URL、AccessKey、Token 或私钥正文。它们已被 Git 忽略。

检查 SSH：

```bash
ssh-add --apple-use-keychain /Users/qinyang/.ssh/loumai_test_hexhub
ssh -o BatchMode=yes -i /Users/qinyang/.ssh/loumai_test_hexhub ubuntu@132.232.220.115 true
```

## 5. 后端发布边界

`./loumai-deploy backend deploy --yes` 会依次执行：

1. 检查 Git 分支、工作区和 upstream；
2. 执行 Ruff、测试、迁移闭环和 schema 漂移门禁；
3. 从精确 commit 打包源码并生成 SHA256 清单；
4. 在服务器创建全新的隔离虚拟环境并按固定依赖安装；
5. 在上传前检查数据库备份目录；若目录安全但仍是 `root` 所有，自动修复为 `postgres:postgres`、`0700` 并执行真实写入探针；
6. 暂停配置中的写入服务；
7. 生成并校验 PostgreSQL 备份；
8. 自动执行 `alembic upgrade` 并严格验证数据库 head 与模型结构；
9. 原子切换 `backend-current`；
10. 按反序启动 API、IM Worker 和已启用的视频 Worker，核对每个进程都运行于本次 release，再完成本机及公网健康检查。

因此后端一键发布本来就包含数据库自动迁移，不需要再登录服务器手工运行 Alembic。迁移只允许沿当前 revision 前向升级；自动化永远不会执行 downgrade 或自动恢复备份。若备份目录属于其他未知用户、是软链接或权限过宽，发布器仍会拒绝自动修改并在迁移前停止。

开启视频转码后，发布器还会拒绝缺少 `libx264`、FFmpeg 路径不受 root 控制、视频临时目录权限过宽、Worker 没有限制 CPU/内存/任务数、或功能开关与服务列表不一致的服务器。这样不会在 API 看似健康时悄悄漏掉转码 Worker。

### 5.1 为什么依赖安装有时较慢

每个后端 release 都创建独立 `.venv`，避免新旧版本共享环境导致无法回滚。下载包会保存在服务器的永久 `uv` 缓存；第一次较慢，后续通常复用缓存。不要在安装过程中断网、关闭终端或手工删除 partial 目录。

### 5.2 `.env` 为什么不会一起发布

这是安全设计，不是遗漏：代码版本和服务器密钥必须分开管理。

| 文件 | 用途 |
| --- | --- |
| `loumai-ai/.env` | 只供本地开发，不上传 |
| `/etc/loumai/backend.env` | 测试服 API/Worker 真实业务配置 |
| `/etc/loumai/sms.env` | 测试服短信等独立密钥配置 |
| `/etc/loumai/backend-release.env` | 发布器的服务、路径与用户合同 |

如果本次只改代码，直接一键发布即可。如果新增或修改了环境变量，必须先审查 `.env.example` 和代码配置字段，再单独、安全地更新服务器对应文件；代码发布不会覆盖它们。修改服务器 env 前要备份，修改后检查 systemd 实际加载的文件，并重启受影响服务。具体步骤见测试服运维手册。

发布前可以自动审计本地与测试服环境变量。默认只显示阻断、警告和环境差异：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai \
  && ./loumai-deploy backend env-audit --env test
```

需要逐项查看全部变量时使用：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai \
  && ./loumai-deploy backend env-audit --env test --all
```

审计会同时检查本地 `loumai-ai/.env`、`.env.example`、当前后端 `Settings`，以及测试服基础 env 和当前活动数据库 profile。每个异常都会分别说明“本地是什么状态、测试服是什么状态、为什么有风险、应该怎样处理”。敏感变量只显示“已配置、空值或缺失”，永远不显示或比较密码、Token、数据库连接串和密钥内容。数据库 profile 按服务真实加载顺序受控覆盖基础 env 中的 `DATABASE_URL`、`MIGRATION_DATABASE_URL`；除此之外的重复定义仍会阻断。

该命令不要求 Git 工作区干净，也不会打包、上传、修改 env、重启服务或迁移数据库。首次使用前，服务器必须安装包含 `env-audit` 动作的最新版 `backend/remote/loumai-backend-release`。

### 5.3 后端回滚

先只读检查：

```bash
./loumai-deploy backend status
./loumai-deploy backend rollback \
  --release RELEASE_ID \
  --dry-run \
  --ack-db-schema-compatible
```

确认旧代码兼容当前数据库后才正式执行：

```bash
./loumai-deploy backend rollback \
  --release RELEASE_ID \
  --yes \
  --ack-db-schema-compatible
```

后端回滚只回滚代码，不执行 `alembic downgrade`，也不会自动恢复数据库备份。数据库备份恢复可能丢数据，只能在维护窗口由负责人决定。

## 6. 前端发布边界

前端正式发布会执行：

1. 检查确定 Git commit；
2. 运行前端全量测试；
3. 用锁定的 HBuilderX/uni 工具全新构建；
4. 检查目标 API、局域网地址、本机路径、旧产物和浏览器兼容代码；
5. 生成 release 元数据和全部文件哈希；
6. 上传到唯一 staging；
7. 服务器验签、原子切换并通过公网哈希验收。

`frontend deploy-package` 跳过“从源码构建”与“源码测试”，改为执行 ZIP 专用门禁：

1. 限定普通 `.zip` 文件、文件数量和压缩前后大小；
2. 拒绝路径穿越、绝对路径、加密项、软链接、特殊文件和大小写冲突；
3. 忽略 macOS 自动产生的 `__MACOSX` 与 `.DS_Store`；
4. 拒绝 `.env`、`.git`、私钥、证书和其他隐藏敏感文件；
5. 检查 `index.html`、标题、哈希入口、目标测试 API、局域网地址和渠道存储兼容代码；
6. 生成新的 `release.json`、`SHA256SUMS` 和 ZIP 来源摘要；
7. 复用相同的服务器验签、CAS 原子切换、公网资源验收和安全回滚。

前端回滚先预演：

```bash
./loumai-deploy frontend rollback --release RELEASE_ID --dry-run
```

确认后执行：

```bash
./loumai-deploy frontend rollback --release RELEASE_ID --yes
```

`--dry-run` 会验证目标版本存在、SHA256 正确且 current 未被其他发布改变，但不会切换软链接。

## 7. 官网首次上线与日常更新

以下命令只在新服务器或重建官网站点时使用一次：

```bash
./loumai-deploy website prepare --yes
# 人工确认根域名和 www 的 DNS 已唯一指向目标服务器
./loumai-deploy website enable-https --yes
```

此后不要重复执行 `prepare`。日常只运行：

```bash
./loumai-deploy website deploy --yes
```

发布器会要求服务器已有受控官网版本且 `HTTPS=enabled`。本地网络即使返回代理生成的假 DNS 地址，也不会阻断普通内容更新；只有显式执行 `enable-https` 时才严格检查 A/AAAA 记录。

官网回滚：

```bash
./loumai-deploy website rollback --release RELEASE_ID --dry-run
./loumai-deploy website rollback --release RELEASE_ID --yes
```

官网和测试 H5 使用不同目录、不同 Nginx 虚拟主机，官网发布不会重启后端，也不会修改测试服 H5。

## 8. 常见报错怎么处理

### `工作区不干净`

回到对应源码仓库，用 `git status` 查明文件。审查、测试、提交并 push；不要为了发布盲目丢弃改动。

### `HEAD 尚未与 upstream 同步`

本地提交还没 push，或远端已有新提交。先检查：

```bash
git fetch origin
git status -sb
git log --oneline --decorate -5
```

### `服务器 helper 版本或源码指纹不匹配`

本地发布协议或 helper 源码与服务器安装版本不同。按对应详细文档更新 root-owned helper 后再执行，不要绕过版本或 SHA256 指纹检查。日常 `deploy --yes` 不会自动覆盖服务器 helper，这是为了避免普通代码发布顺带替换 root 脚本。

### `pg_dump: Peer authentication failed`

如果日志同时显示连接到了 `/var/run/postgresql/.s.PGSQL.5432`，先不要修改 `pg_hba.conf`、数据库密码或迁移账号。应核对本地与服务器 helper 指纹并安装当前 helper；旧实现可能在读取连接元数据 EOF 时把 `127.0.0.1` 覆盖为空，导致 `pg_dump` 错误退回 Unix Socket。该错误发生在迁移前时，发布器会恢复旧服务，数据库 revision 不会改变；仍需用 `backend status` 复核。

### 后端长时间显示 `uv venv` 或 `uv pip install`

通常是在创建隔离运行环境或补充依赖缓存，不代表卡死。另开终端用运维手册中的只读进度命令检查进程、缓存大小、current 和健康状态；不要同时再发起第二次发布。

### 发布失败但旧 API 仍健康

说明脚本在原子切换前停止或已经恢复旧 current。先执行 `status`，查看发布终端的第一条 `ERROR` 和服务日志，不要手工乱改软链接。

### 迁移已经执行，但新版启动失败

停止操作并保留故障现场。数据库不会自动降级，写入服务可能按安全策略保持停止；按后端详细文档进行人工处置。

### 修改了本地 `.env`，测试服却没有变化

正常现象。本地 `.env` 不属于发布产物，测试服配置位于 `/etc/loumai/`。

## 9. 安全规则

- 不把密钥、密码、数据库备份或私钥提交到 Git。
- 不在命令行 URL 中携带 PAT 或密码。
- 不手工覆盖 `current` 目录；它必须是指向受控 release 的软链接。
- 不同时启动两次发布。
- 不用 `--skip-tests` 做正式发布。
- 不删除当前版本、数据库备份或发布失败现场。
- 不用“恢复数据库”代替正常代码回滚。

## 10. 详细文档

- [测试服运维手册](docs/test-server-operations-handbook.md)
- [后端自动发布说明](docs/backend-auto-release.md)
- [H5 自动发布说明](docs/frontend-h5-auto-release.md)
- [官网自动发布说明](docs/website-auto-release.md)

修改部署脚本后至少执行：

```bash
npm test
for deployment_shell in \
  loumai-deploy \
  frontend/remote/loumai-h5-release \
  backend/remote/loumai-backend-release \
  admin-backend/remote/loumai-company-management-release \
  admin-backend/remote/install-company-management-release \
  admin-backend/remote/loumai-company-management-run \
  website/remote/workway-site-release; do
  bash -n "$deployment_shell"
done
node --check frontend/h5-release.mjs
node --check backend/backend-release.mjs
node --check backend/env-audit.mjs
node --check admin-backend/admin-backend-release.mjs
node --check website/site-release.mjs
git diff --check
```
