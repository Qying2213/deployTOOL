# 后端自动发布与安全回滚

## 目标与边界

`backend/backend-release.mjs` 将后端代码门禁、确定版本打包、上传验签、数据库备份、Alembic 升级、原子切换和健康检查串成一条可审计的发布链路。源码仓库和部署工具彼此独立，执行命令时所在目录不会改变被打包的项目。

本文主体保留测试服接管与 local/cloud 切换说明。全新业务正式服不要复用其中写死的测试路径、用户或手工 bootstrap；正式服请使用 [`production-server-deployment.md`](production-server-deployment.md) 和 `backend bootstrap --env production`。

这套工具有意保留以下安全边界：

- 只发布工作区干净、当前分支正确且已经与 upstream 完全同步的 Git commit；
- Alembic 必须只有一个 head，并且当前数据库 revision 必须是新版本 head 的祖先；
- 正式发布不能跳过 Ruff、影子库迁移校验和后端全量测试；
- 服务器停止所有已配置的 API、Worker 和定时写任务后，才允许备份及迁移；
- 自动化永远不执行 `alembic downgrade`，也不自动恢复 PostgreSQL 备份；
- 一旦数据库迁移已经尝试而后续失败，所有 writer 保持停止，等待人工前向修复或明确的备份恢复决策；
- `rollback` 只切换应用代码，不改变数据库，必须由操作者确认旧代码兼容当前数据库结构。

恢复数据库可能丢失发布后产生的数据，不属于一键发布或一键回滚能力。

## 文件说明

- `backend/backend-release.mjs`：本机发布入口；
- `backend/runtime-constraints.test.txt`：测试服 Python 运行时精确版本约束；
- `backend/remote/loumai-backend-release`：服务器 root 受限激活器；
- `backend/remote/loumai-backend-release.env.example`：服务器端配置模板；
- `config/backend.test.example.env`：本机配置模板；
- `tests/backend-release.test.mjs`：后端发布安全契约测试；
- `dist/backend-releases/<release_id>/`：本地版本包，不进入 Git。

`release_id` 由 UTC 构建时间和 Git 短提交组成，例如 `20260810T123456Z-b9f28ae12`。每个版本都带有 `release.json`、逐文件 `SHA256SUMS` 和上传归档哈希。

## 发布前环境变量审计

本地发布器提供独立、只读的环境审计，不要求 Git 工作区干净：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai
./loumai-deploy backend env-audit --env test
./loumai-deploy backend env-audit --env test --all
```

默认命令只显示异常和差异，`--all` 逐项显示当前后端 `Settings`、`.env.example` 以及部署运行变量白名单中的完整变量集合。远端 helper 只返回变量名、`SET/EMPTY` 状态、公开白名单配置值和脱敏后的校验错误类型；敏感值、哈希和 Pydantic 输入值均不会离开服务器。

启用双数据库 profile 时，审计按 systemd 的实际加载顺序读取基础 env 和当前活动 profile。只有 profile 文件最后覆盖基础文件中的 `DATABASE_URL`、`MIGRATION_DATABASE_URL`，且每个变量恰好各出现两次时，才视为受控路由而不报重复；其他变量重复、同一文件内重复或三次以上定义仍然阻断。这样既支持本地库/云库切换，也不会放宽普通配置的重复定义检查。

审计不会同步配置。测试服 env 仍由 root 管理，修改时必须先备份、人工编辑、重新审计，再重启受影响的服务。远端动作合同为：

```text
loumai-backend-release env-audit test
ENV_AUDIT_PROTOCOL=1
```

协议解析采用严格字段白名单；本地客户端会拒绝远端公开任何不在非敏感比较白名单中的变量值。

## 一次性服务器准备

以下示例按当前测试服的 SSH 用户 `ubuntu`、服务用户 `ubuntu`、独立构建用户 `loumai-build` 和 `loumai-api.service` 编写。执行前先在维护窗口核对实际环境：

```bash
ssh -i /Users/qinyang/.ssh/loumai_test_hexhub ubuntu@132.232.220.115
sudo systemctl cat loumai-api.service
sudo systemctl status loumai-api.service --no-pager
readlink -f /srv/loumai/backend-current
```

不要照抄或覆盖未知的 systemd 参数；后面迁移服务路径时，应保留当前的启动参数、环境文件、重启策略和资源限制。

### 0. 创建独立构建用户

依赖安装可能执行第三方构建脚本，不能使用 SSH 发布用户、应用服务用户或 root。先创建一个无登录权限的专用用户：

```bash
if ! id loumai-build >/dev/null 2>&1; then
  sudo useradd --system --create-home \
    --home-dir /var/lib/loumai-build \
    --shell /usr/sbin/nologin \
    loumai-build
fi
sudo install -d -m 0750 -o loumai-build -g loumai-build /var/lib/loumai-build
```

`loumai-build` 必须使用非 root、且与 `LOUMAI_BACKEND_DEPLOY_USER`、`LOUMAI_BACKEND_SERVICE_USER` 不同的真实 UID。服务器激活器还会验证其 HOME 归本人所有、不可被组或其他用户写入，并使用 `nologin` 禁止交互登录。它只在 root 私有版本目录里获得本次构建副本和 `.venv` 的临时写权限；完成后虚拟环境会重新收归 root 只读。

### 1. 准备 root 固定的 Python 与 uv

服务器激活器会拒绝使用可被普通用户替换的 Python 或 uv。可将测试服现有的已验证运行时复制到 root 管理目录：

```bash
sudo install -d -m 0755 -o root -g root /opt/loumai-runtime/bin
sudo install -d -m 0755 -o root -g root /opt/loumai-runtime/python
sudo install -m 0755 -o root -g root \
  /home/ubuntu/.local/bin/uv \
  /opt/loumai-runtime/bin/uv
sudo cp -a \
  /home/ubuntu/.local/share/uv/python/cpython-3.12.13-linux-x86_64-gnu \
  /opt/loumai-runtime/python/
sudo chown -R root:root /opt/loumai-runtime
sudo chmod -R go-w /opt/loumai-runtime
sudo test ! -L /opt/loumai-runtime/bin/uv
sudo test ! -L /opt/loumai-runtime/python/cpython-3.12.13-linux-x86_64-gnu/bin/python3.12
sudo stat -c '%U %G %a %n' \
  /opt/loumai-runtime/bin/uv \
  /opt/loumai-runtime/python/cpython-3.12.13-linux-x86_64-gnu/bin/python3.12
```

若服务器上的版本或路径不同，应先确认应用支持的 Python 版本，再调整服务器配置。不要把 `LOUMAI_BACKEND_UV_BIN` 或 `LOUMAI_BACKEND_BASE_PYTHON` 指向普通用户可写的 `/home/...` 路径。

### 2. 准备版本、暂存和备份目录

```bash
sudo install -d -m 0755 -o root -g root /etc/loumai
sudo install -d -m 0755 -o root -g root /srv/loumai-backend
sudo install -d -m 0755 -o root -g root /srv/loumai-backend/backend-releases
sudo install -d -m 0755 -o root -g root /srv/loumai-backend/incoming
sudo install -d -m 0700 -o postgres -g postgres /var/backups/loumai
```

`incoming` 自身保持 root 所有。每次执行 `prepare` 时，激活器只为本次 release 创建一个 `0700` 子目录并临时交给 SSH 发布用户；最终版本目录始终由 root 管理。

### 3. 安装服务器激活器和配置

在本机独立部署目录执行：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai

scp -i /Users/qinyang/.ssh/loumai_test_hexhub \
  backend/remote/loumai-backend-release \
  ubuntu@132.232.220.115:/tmp/loumai-backend-release
scp -i /Users/qinyang/.ssh/loumai_test_hexhub \
  backend/remote/loumai-backend-release.env.example \
  ubuntu@132.232.220.115:/tmp/backend-release.env
scp -i /Users/qinyang/.ssh/loumai_test_hexhub \
  backend/remote/loumai-file-storage-cleanup.service.example \
  ubuntu@132.232.220.115:/tmp/loumai-file-storage-cleanup.service
scp -i /Users/qinyang/.ssh/loumai_test_hexhub \
  backend/remote/loumai-file-storage-cleanup.timer.example \
  ubuntu@132.232.220.115:/tmp/loumai-file-storage-cleanup.timer
```

登录服务器，先编辑 `/tmp/backend-release.env`，至少确认以下值：

```dotenv
LOUMAI_BACKEND_REMOTE_ROOT=/srv/loumai-backend
LOUMAI_BACKEND_STAGING_ROOT=/srv/loumai-backend/incoming
LOUMAI_BACKEND_DEPLOY_USER=ubuntu
LOUMAI_BACKEND_SERVICE_USER=ubuntu
LOUMAI_BACKEND_BUILD_USER=loumai-build
LOUMAI_BACKEND_CURRENT_LINK=/srv/loumai-backend/backend-current
LOUMAI_BACKEND_ENV_FILES="/etc/loumai/backend.env /etc/loumai/sms.env"
LOUMAI_BACKEND_UV_BIN=/opt/loumai-runtime/bin/uv
LOUMAI_BACKEND_BASE_PYTHON=/opt/loumai-runtime/python/cpython-3.12.13-linux-x86_64-gnu/bin/python3.12
LOUMAI_BACKEND_RUNTIME_ROOT=/opt/loumai-runtime
LOUMAI_BACKEND_DATABASE_NAME=loumai_test_server
LOUMAI_BACKEND_BACKUP_ROOT=/var/backups/loumai
# 视频 Worker 一次性安装完成前先保持两项；4.1 节完成后再改为三项。
LOUMAI_BACKEND_SERVICES="loumai-im-worker.service loumai-api.service"
LOUMAI_BACKEND_TIMERS="loumai-file-storage-cleanup.timer"
LOUMAI_BACKEND_ONESHOT_SERVICES="loumai-file-storage-cleanup.service"
LOUMAI_BACKEND_VIDEO_SERVICE=loumai-video-worker.service
LOUMAI_BACKEND_FFMPEG_BIN=/opt/loumai-runtime/ffmpeg/bin/ffmpeg
LOUMAI_BACKEND_FFPROBE_BIN=/opt/loumai-runtime/ffmpeg/bin/ffprobe
LOUMAI_BACKEND_VIDEO_TEMP_ROOT=/var/lib/loumai-video/tmp
LOUMAI_BACKEND_LOCAL_HEALTH_URL=http://127.0.0.1:8000/health
LOUMAI_BACKEND_PUBLIC_HEALTH_URL=https://test.yinlizhangyu.com/health
```

然后安装：

```bash
sudo install -m 0755 -o root -g root \
  /tmp/loumai-backend-release \
  /usr/local/sbin/loumai-backend-release
sudo install -m 0644 -o root -g root \
  /tmp/backend-release.env \
  /etc/loumai/backend-release.env
sudo install -d -m 0750 -o ubuntu -g ubuntu /srv/loumai/shared/uploads
sudo install -m 0644 -o root -g root \
  /tmp/loumai-file-storage-cleanup.service \
  /etc/systemd/system/loumai-file-storage-cleanup.service
sudo install -m 0644 -o root -g root \
  /tmp/loumai-file-storage-cleanup.timer \
  /etc/systemd/system/loumai-file-storage-cleanup.timer
sudo systemctl daemon-reload
sudo systemd-analyze verify \
  /etc/systemd/system/loumai-file-storage-cleanup.service \
  /etc/systemd/system/loumai-file-storage-cleanup.timer
sudo systemctl enable --now loumai-file-storage-cleanup.timer
rm -f \
  /tmp/loumai-backend-release \
  /tmp/backend-release.env \
  /tmp/loumai-file-storage-cleanup.service \
  /tmp/loumai-file-storage-cleanup.timer
```

测试服发布门禁会核对 cleanup service/timer 已安装且 timer 持续启用；这不是仅写在模板里的可选项。它负责把取消上传和超过 24 小时仍未引用的附件推进到物理删除。

安装后分别核对本机文件和服务器已安装文件的 SHA256；两边必须完全相同：

```bash
# 本机执行
shasum -a 256 backend/remote/loumai-backend-release

# 服务器执行
sudo -n /usr/local/sbin/loumai-backend-release fingerprint
```

日常 `deploy --yes` 不会自动更新这个 root-owned helper。发布器会在任何上传、停服务或迁移之前比较两边指纹；如果本地脚本修改后忘记同步服务器，发布会明确中止。

应用环境文件由 systemd 和迁移进程读取，可以包含数据库凭据；它们不属于部署工具配置，必须继续由 root 管理且不能被组或其他用户写入：

```bash
sudo chown root:root /etc/loumai/backend.env /etc/loumai/sms.env
sudo chmod 0640 /etc/loumai/backend.env /etc/loumai/sms.env
```

若生产连接用户没有 DDL 权限，应在受保护的应用环境文件中单独提供 `MIGRATION_DATABASE_URL`。发布器会优先用它执行迁移和 schema 校验，但业务服务仍使用 `DATABASE_URL`。

### 4. 把当前版本做成 root 只读的 bootstrap 版本

新软链接不能继续穿透到普通用户可写的 `/srv/loumai`。先在维护窗口停止 API，把当前代码复制到受控版本目录，并用上一步固定的 Python/uv 重建虚拟环境。下面的目录只针对当前测试服 commit `b9f28ae`；实际执行前必须重新核对：

```bash
sudo systemctl stop loumai-api.service
sudo install -d -m 0755 -o root -g root \
  /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/backend
sudo rsync -a --chown=root:root \
  --exclude='__pycache__/' \
  --exclude='*.pyc' \
  /srv/loumai/backend-current/app \
  /srv/loumai/backend-current/alembic \
  /srv/loumai/backend-current/scripts \
  /srv/loumai/backend-current/pyproject.toml \
  /srv/loumai/backend-current/alembic.ini \
  /srv/loumai/backend-current/runtime-constraints.txt \
  /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/backend/
sudo chown -hR root:root \
  /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/backend
sudo chmod -R go-w \
  /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/backend

sudo tee \
  /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/backend/release.json \
  >/dev/null <<'JSON'
{
  "schema_version": 1,
  "release_id": "20260807T000000Z-b9f28ae000",
  "commit": "b9f28aeae522007aee6ce36c729e449a1a5b9ce5",
  "branch": "master",
  "built_at": "2026-08-07T00:00:00Z",
  "artifact_db_head": "20260806_0071",
  "database_rollback_policy": "NO_AUTOMATIC_DOWNGRADE_OR_RESTORE",
  "tool": {"bootstrap": "manual-server-takeover"}
}
JSON
(
  cd /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/backend
  sudo find . -type f ! -name SHA256SUMS -printf '%P\0' \
    | sort -z \
    | sudo xargs -0 sha256sum \
    | sudo tee SHA256SUMS >/dev/null
)
sudo chown root:root \
  /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/backend/release.json \
  /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/backend/SHA256SUMS
sudo chmod 0644 \
  /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/backend/release.json \
  /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/backend/SHA256SUMS

sudo install -d -m 0700 -o loumai-build -g loumai-build \
  /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/.bootstrap-runtime \
  /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/.bootstrap-runtime/source
sudo cp -a --no-preserve=ownership \
  /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/backend/. \
  /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/.bootstrap-runtime/source/
sudo chown -hR loumai-build:loumai-build \
  /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/.bootstrap-runtime/source
sudo install -d -m 0700 -o loumai-build -g loumai-build \
  /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/backend/.venv
sudo install -d -m 0700 -o loumai-build -g loumai-build \
  /var/lib/loumai-build/.cache/uv
sudo -u loumai-build env --chdir=/var/lib/loumai-build \
  HOME=/var/lib/loumai-build \
  UV_CACHE_DIR=/var/lib/loumai-build/.cache/uv \
  UV_LINK_MODE=copy \
  /opt/loumai-runtime/bin/uv venv \
  --python /opt/loumai-runtime/python/cpython-3.12.13-linux-x86_64-gnu/bin/python3.12 \
  --seed \
  /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/backend/.venv
sudo -u loumai-build env --chdir=/var/lib/loumai-build \
  HOME=/var/lib/loumai-build \
  UV_CACHE_DIR=/var/lib/loumai-build/.cache/uv \
  UV_LINK_MODE=copy \
  /opt/loumai-runtime/bin/uv pip install \
  --python /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/backend/.venv/bin/python \
  setuptools==84.0.0
sudo -u loumai-build env --chdir=/var/lib/loumai-build \
  HOME=/var/lib/loumai-build \
  UV_CACHE_DIR=/var/lib/loumai-build/.cache/uv \
  UV_LINK_MODE=copy \
  /opt/loumai-runtime/bin/uv pip install \
  --python /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/backend/.venv/bin/python \
  --no-build-isolation \
  --constraint /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/backend/runtime-constraints.txt \
  /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/.bootstrap-runtime/source
sudo rm -rf -- \
  /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/.bootstrap-runtime
sudo chown -hR root:root \
  /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/backend/.venv
sudo chmod -R a+rX,go-w \
  /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/backend/.venv
sudo -u ubuntu \
  /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/backend/.venv/bin/python \
  -c 'import sys; raise SystemExit(0 if sys.prefix else 1)'

sudo ln -s \
  /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/backend \
  /srv/loumai-backend/backend-current
readlink -f /srv/loumai-backend/backend-current
```

如果任一步失败，先保持服务停止并排查，不要让新软链接指向一个未完成的虚拟环境。
bootstrap 版本也生成了 `release.json` 和源码 `SHA256SUMS`，因此首次新版本发布后，它仍可作为“仅应用代码回滚”的候选；`.venv` 是后加的 root 只读、服务用户可读执行的运行时，不纳入源码清单。

随后用 `sudo systemctl edit --full loumai-api.service` 将该单元中旧的 `/srv/loumai/backend-current` 路径替换为 `/srv/loumai-backend/backend-current`。只替换版本入口路径，保留原有的 Uvicorn 参数、环境文件、重启策略和资源限制。完成后：

```bash
sudo systemctl daemon-reload
sudo systemctl restart loumai-api.service
sudo systemctl is-active loumai-api.service
curl -fsS http://127.0.0.1:8000/health
curl -fsS https://test.yinlizhangyu.com/health
```

`LOUMAI_BACKEND_SERVICES` 按“停止写入”的顺序配置；发布器按相反顺序启动。因此视频 Worker、IM Worker、API 的固定顺序必须保持为：

```dotenv
LOUMAI_BACKEND_SERVICES="loumai-video-worker.service loumai-im-worker.service loumai-api.service"
```

如果以后增加 Worker 或定时任务，必须先把相应 `.service` 和 `.timer` 全部加入 `LOUMAI_BACKEND_SERVICES` / `LOUMAI_BACKEND_TIMERS`，再允许发布。漏配 writer 会破坏“迁移期间无并发写入”的前提。

### 4.1 P1-MEDIA-02 视频 Worker 一次性安装

视频转码不能运行在 Uvicorn API 进程中。测试服使用独立的单并发 systemd Worker；安装完成前，`/etc/loumai/backend.env` 必须保持：

```dotenv
VIDEO_TRANSCODE_ENABLED=false
```

#### 固定 FFmpeg/ffprobe

先取得已经过来源、SHA256 和许可证审查的 Linux x86_64 FFmpeg/ffprobe 二进制。所选构建必须包含 `libx264`；包含该编码器的构建通常受 GPL 约束，上线前需由公司确认使用及分发方式。不要让发布器从未知 URL 自动下载，也不要把二进制放进普通用户目录。

把审核后的两个文件先上传为 `/tmp/ffmpeg`、`/tmp/ffprobe`，然后在服务器执行。`<审核记录中的 SHA256>` 必须替换成真实固定值，不能跳过：

```bash
set -e

echo '<ffmpeg审核SHA256>  /tmp/ffmpeg' | sha256sum -c --strict
echo '<ffprobe审核SHA256>  /tmp/ffprobe' | sha256sum -c --strict

sudo install -d -m 0755 -o root -g root /opt/loumai-runtime/ffmpeg/bin
sudo install -m 0755 -o root -g root /tmp/ffmpeg /opt/loumai-runtime/ffmpeg/bin/ffmpeg
sudo install -m 0755 -o root -g root /tmp/ffprobe /opt/loumai-runtime/ffmpeg/bin/ffprobe
rm -f /tmp/ffmpeg /tmp/ffprobe

/opt/loumai-runtime/ffmpeg/bin/ffmpeg -version
/opt/loumai-runtime/ffmpeg/bin/ffmpeg -hide_banner -encoders 2>&1 | grep -E '(^|[[:space:]])libx264([[:space:]]|$)'
/opt/loumai-runtime/ffmpeg/bin/ffprobe -version
sudo find /opt/loumai-runtime/ffmpeg -maxdepth 2 -ls
```

任何一条检查失败都不要开启视频功能。更新二进制时使用新审核哈希并在维护窗口重新执行完整验收，不允许普通发布用户覆盖它。

#### 安装临时目录与 systemd 单元

从本机部署仓库上传模板：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai
scp -i /Users/qinyang/.ssh/loumai_test_hexhub \
  backend/remote/loumai-video-worker.service.example \
  ubuntu@132.232.220.115:/tmp/loumai-video-worker.service
```

在服务器执行：

```bash
set -e

sudo install -d -m 0700 -o ubuntu -g ubuntu /var/lib/loumai-video/tmp
sudo install -m 0644 -o root -g root \
  /tmp/loumai-video-worker.service \
  /etc/systemd/system/loumai-video-worker.service
rm -f /tmp/loumai-video-worker.service

sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/loumai-video-worker.service
```

模板固定了单独进程、只读系统、仅放行 `/var/lib/loumai-video/tmp` 写入，以及 `MemoryMax=1200M`、`CPUQuota=150%`、`TasksMax=96`。Worker 代码自身仍必须保持单并发和 FFmpeg 单线程；资源限制只是最后一道防线。

#### 写入测试服真实环境并启用

先备份 `/etc/loumai/backend.env`，用 root 编辑并补齐以下配置。密钥只写服务器，不能复制到 Git 或部署工具本地配置：

```dotenv
VIDEO_TRANSCODE_ENABLED=true
VIDEO_TRANSCODE_FFMPEG_PATH=/opt/loumai-runtime/ffmpeg/bin/ffmpeg
VIDEO_TRANSCODE_FFPROBE_PATH=/opt/loumai-runtime/ffmpeg/bin/ffprobe
VIDEO_TRANSCODE_TEMP_ROOT=/var/lib/loumai-video/tmp
VIDEO_TRANSCODE_MAX_CONCURRENCY=1
VIDEO_TRANSCODE_THREADS=1
VIDEO_TRANSCODE_MAX_DURATION_SECONDS=600
VIDEO_TRANSCODE_JOB_TIMEOUT_SECONDS=1800
VIDEO_TRANSCODE_LOCK_TIMEOUT_SECONDS=2100
VIDEO_TRANSCODE_MAX_ATTEMPTS=3
VIDEO_TRANSCODE_POLL_SECONDS=2
VIDEO_TRANSCODE_WORKER_ID=test-video-worker-01
VIDEO_TRANSCODE_MAX_INPUT_EDGE=3840
VIDEO_TRANSCODE_MAX_INPUT_PIXELS=8294400
VIDEO_TRANSCODE_MAX_OUTPUT_LONG_EDGE=1920
VIDEO_TRANSCODE_MAX_OUTPUT_SHORT_EDGE=1080
VIDEO_TRANSCODE_MAX_OUTPUT_PIXELS=2073600
VIDEO_TRANSCODE_MAX_FPS=30
VIDEO_TRANSCODE_CRF=23
VIDEO_TRANSCODE_PRESET=veryfast
VIDEO_DIRECT_DOWNLOAD_ENABLED=false
VIDEO_MEDIA_TICKET_SECRET_KEY=<独立生成的至少32字符随机密钥，不能复用JWT_SECRET_KEY>
VIDEO_MEDIA_TICKET_TTL_SECONDS=1800
VIDEO_SIGNED_URL_TTL_SECONDS=1800
```

同时把 `/etc/loumai/backend-release.env` 改为本节前述三个服务和固定 FFmpeg 路径。完成后再启用：

```bash
set -e

sudo chown root:root /etc/loumai/backend.env /etc/loumai/backend-release.env
sudo chmod 0640 /etc/loumai/backend.env
sudo chmod 0644 /etc/loumai/backend-release.env
sudo -n /usr/local/sbin/loumai-backend-release preflight local
sudo systemctl restart loumai-api.service
sudo systemctl restart loumai-im-worker.service
curl -fsS http://127.0.0.1:8000/health
sudo systemctl enable --now loumai-video-worker.service
systemctl is-active loumai-api.service
systemctl is-active loumai-im-worker.service
systemctl is-active loumai-video-worker.service
sudo -n /usr/local/sbin/loumai-backend-release status active
```

`preflight` 会拒绝以下错误状态：功能开关和服务列表不一致、FFmpeg/ffprobe 不在 root 受控运行时、缺少 libx264、临时目录不是服务用户私有 `0700`、应用路径与发布器路径不同、并发/线程不为 1、systemd 未配置 CPU/内存/任务数限制。

#### 日常监控

```bash
systemctl is-active loumai-video-worker.service
sudo journalctl -u loumai-video-worker.service -n 100 --no-pager
systemctl show loumai-video-worker.service \
  -p MainPID -p MemoryCurrent -p MemoryPeak -p CPUUsageNSec -p TasksCurrent --no-pager
sudo du -sh /var/lib/loumai-video/tmp
sudo -u postgres psql loumai_test_server -c \
  "SELECT status, count(*) FROM attachment_video_transcodes GROUP BY status ORDER BY status;"
sudo -u postgres psql loumai_test_server -c \
  "SELECT id, source_attachment_id, attempt_count, failure_code, updated_at FROM attachment_video_transcodes WHERE status = 'FAILED' ORDER BY updated_at DESC LIMIT 20;"
```

必须告警的条件：Worker 非 `active`、`FAILED` 连续增长、`PROCESSING` 超过 `VIDEO_TRANSCODE_LOCK_TIMEOUT_SECONDS`、临时目录持续增长、systemd 发生 OOM/资源限制终止。监控只记录任务 ID、状态、耗时和错误码，禁止记录 media ticket、COS 签名 URL、AccessKey 或原视频完整本地路径。

#### Nginx 禁止记录 media_ticket

媒体播放 URL 的 `media_ticket` 是短时凭证，不能出现在 access log 或 Referer 字段。把 [`backend/remote/nginx-no-media-ticket-log.conf.example`](../backend/remote/nginx-no-media-ticket-log.conf.example) 中的 `log_format` 放到 Nginx `http {}`，把 `access_log` 放到 `test.yinlizhangyu.com` 的 `server {}`。该格式只记录 `$uri`，不记录原始请求、查询参数或 Referer。

修改前先备份配置，修改后执行：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Nginx 的 error log 和应用访问日志不受 `log_format` 控制。当前接口不能把 ticket 写进异常文本；如果现有 Uvicorn access log 会打印完整查询串，应在 API 服务中关闭 access log 或接入经过测试的脱敏过滤器后再开放媒体 ticket。验收时使用专门的测试 ticket，播放一次后检查 Nginx access/error、`journalctl -u loumai-api.service` 和监控平台，四处都不能检索到原值。测试 ticket 不要粘贴进工单或聊天。

#### 回填与回滚边界

新上传链路验收通过后才回填旧 MOV，先只读预演：

```bash
cd /srv/loumai-backend/backend-current
sudo -u ubuntu .venv/bin/python scripts/backfill_video_transcodes.py --dry-run
sudo -u ubuntu .venv/bin/python scripts/backfill_video_transcodes.py --apply --limit 10
```

回填只创建幂等任务，不直接覆盖原附件。先观察 10 条到 `READY`，确认 COS 派生 MP4、Range 播放、时长/旋转和封面均正确，再分批扩大。失败任务保留原 MOV 和错误码，不删除源文件。

关闭功能的安全顺序是：先执行 `sudo systemctl disable --now loumai-video-worker.service`，确认 Worker 为 `inactive/disabled`，再把 `VIDEO_TRANSCODE_ENABLED=false` 并从 `LOUMAI_BACKEND_SERVICES` 移除视频服务，随后重启 API/IM 并执行 `preflight`。发布器会同时检查配置列表、实际运行状态和开机启用状态，遗留 Worker 不会被静默放过。数据库迁移不自动 downgrade；不要回滚到不包含视频脚本的旧 release 后仍让视频 Worker 运行。已经生成的派生对象先保留，确认无引用后再单独清理。

### 5. 最小 sudo 授权

创建 `/etc/sudoers.d/loumai-backend-release`：

```sudoers
Defaults!/usr/local/sbin/loumai-backend-release secure_path=/usr/sbin:/usr/bin:/sbin:/bin
ubuntu ALL=(root) NOPASSWD: /usr/local/sbin/loumai-backend-release *
```

验证配置和只读预检：

```bash
sudo chmod 0440 /etc/sudoers.d/loumai-backend-release
sudo visudo -cf /etc/sudoers.d/loumai-backend-release
sudo -n /usr/local/sbin/loumai-backend-release preflight local
sudo -n /usr/local/sbin/loumai-backend-release status active
```

激活器只接受 `version / fingerprint / preflight / env-audit / prepare / abort / status / activate / rollback`，并再次校验参数、root 所有权、上传路径、归档成员、逐文件哈希、当前软链接和数据库 revision。不要给 SSH 用户通用 root shell 或任意 `systemctl` 权限。

## 本机配置

在独立部署目录执行：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai
cp config/backend.test.example.env config/backend.test.local.env
chmod 600 config/backend.test.local.env
```

测试服本机配置示例：

```dotenv
BACKEND_REPO=/Users/qinyang/Desktop/zuling/loumai-ai
BACKEND_PYTHON_BIN=/Users/qinyang/Desktop/zuling/loumai-ai/.venv311/bin/python
BACKEND_RUNTIME_CONSTRAINTS=/Users/qinyang/Desktop/zuling/deploy--loumai/backend/runtime-constraints.test.txt
BACKEND_EXPECTED_BRANCH=master
BACKEND_REQUIRE_UPSTREAM_MATCH=true

BACKEND_DEPLOY_TARGET=ubuntu@132.232.220.115
BACKEND_SSH_PORT=22
BACKEND_SSH_IDENTITY_FILE=/Users/qinyang/.ssh/loumai_test_hexhub
BACKEND_PUBLIC_URL=https://test.yinlizhangyu.com
BACKEND_REMOTE_STAGING_ROOT=/srv/loumai-backend/incoming
BACKEND_REMOTE_HELPER=/usr/local/sbin/loumai-backend-release
BACKEND_REMOTE_USE_SUDO=true
```

这里只能保存路径、地址和开关。不要写密码、Token、私钥内容或数据库 URL；脚本会拒绝变量名包含 `SECRET / PASSWORD / TOKEN / PRIVATE_KEY / ACCESS_KEY` 的配置。`config/*.local.env` 已被 `.gitignore` 忽略。

若私钥带口令，开机或钥匙串失效后先执行：

```bash
ssh-add --apple-use-keychain /Users/qinyang/.ssh/loumai_test_hexhub
ssh -o BatchMode=yes -i /Users/qinyang/.ssh/loumai_test_hexhub ubuntu@132.232.220.115 true
```

工具启用了 `StrictHostKeyChecking=yes`，第一次连接前必须通过可信渠道核对并写入服务器主机指纹。

## 发布前检查

先验证部署工具本身：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai
node --check backend/backend-release.mjs
bash -n backend/remote/loumai-backend-release
node --test tests/backend-release.test.mjs
```

再确认业务仓库：

```bash
cd /Users/qinyang/Desktop/zuling/loumai-ai
git status --short --branch
git branch --show-current
git rev-parse HEAD
git rev-parse '@{upstream}'
```

正式发布要求：

- 当前分支等于 `BACKEND_EXPECTED_BRANCH`；
- 没有未提交或未跟踪文件，也没有进行中的 merge、rebase 或 cherry-pick；
- `HEAD` 与 `@{upstream}` 完全相同，即代码已经提交并推送；
- 本地 `.venv311` 可运行 Ruff、Alembic、影子库脚本和 pytest；
- `backend/runtime-constraints.test.txt` 与已验证的目标运行时一致。

当前后端仓库若还有未提交的业务改动，发布器拒绝运行是正常保护行为。应先完成代码审查、测试、提交和推送，不能通过临时关闭检查绕过。

## 测试服双数据库发布

发布器保留原有本地 PostgreSQL 发布方式，并新增腾讯云 PostgreSQL 发布方式。两条命令发布相同的后端代码，区别仅在于本次发布选择的数据库档位。

| 命令 | 数据库档位 | 实际数据库地址 |
| --- | --- | --- |
| `backend deploy` | `local` | 测试服本机 `127.0.0.1:5432` |
| `backend deploy-cloud` | `cloud` | 腾讯云 PostgreSQL `172.27.0.3:5432` |

原有命令保持不变：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai && ./loumai-deploy backend deploy --yes
```

新增的云数据库一键发布命令：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai && ./loumai-deploy backend deploy-cloud --yes
```

对应的只读预演：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai && ./loumai-deploy backend deploy-cloud --dry-run
```

查看活动数据库或单独检查云数据库：

```bash
./loumai-deploy backend status
./loumai-deploy backend status --database-profile cloud
```

两套数据库是相互独立的数据集。`deploy-cloud` 不会把测试服本地 PostgreSQL 的数据复制到腾讯云 PostgreSQL，也不会自动合并数据；需要迁移旧数据时必须另行制定数据迁移和核对方案。

腾讯云 PostgreSQL 若是尚未创建任何楼脉业务表的全新空库，状态命令会显示 `DB_REVISION=base`。这是受支持的首次发布起点：第一次执行 `deploy-cloud --yes` 时，发布器会先备份空库，再由 Alembic 从 `base` 前向迁移到产物声明的唯一 head，完成结构校验后才切换四个 writer。若数据库已经包含业务表却没有 `public.alembic_version`，发布器会拒绝自动迁移，防止把来历不明的既有结构误判成空库。

### 一次性服务器配置

日常发布前，服务器只需完成一次双数据库初始化。数据库密码只保存在服务器的 root 专用文件中，不能写入 Git、部署仓库或本机发布配置。

1. 安装最新版远端 helper，确认 `version` 输出 `4`，并让本机发布器通过源码指纹校验。
2. 创建 `/etc/loumai/database-profiles/local.env` 和 `/etc/loumai/database-profiles/cloud.env`，文件必须为 `root:root`、权限 `0600`。
3. 初始化 `/etc/loumai/database-active.env`；首次沿用本地库时，它应与 `local.env` 内容一致。
4. 让 API、IM Worker、视频 Worker 和独立管理后台的 systemd unit 都在原有环境文件之后加载 `/etc/loumai/database-active.env`。
5. 在 `/etc/loumai/backend-release.env` 配置 profile 目录、活动环境文件和腾讯云数据库 Host。

profile 文件格式如下，密码位置必须替换为服务器真实密码，且不要复制到聊天、工单或提交记录：

```dotenv
# /etc/loumai/database-profiles/local.env
LOUMAI_DATABASE_PROFILE=local
LOUMAI_DATABASE_NAME=loumai_test_server
DATABASE_URL=postgresql+psycopg://loumai_app:<本地数据库密码>@127.0.0.1:5432/loumai_test_server
MIGRATION_DATABASE_URL=postgresql+psycopg://loumai_app:<本地数据库密码>@127.0.0.1:5432/loumai_test_server
```

```dotenv
# /etc/loumai/database-profiles/cloud.env
LOUMAI_DATABASE_PROFILE=cloud
LOUMAI_DATABASE_NAME=<云数据库业务库名>
DATABASE_URL=postgresql+psycopg://<云数据库用户>:<云数据库密码>@172.27.0.3:5432/<云数据库业务库名>
MIGRATION_DATABASE_URL=postgresql+psycopg://<云数据库用户>:<云数据库密码>@172.27.0.3:5432/<云数据库业务库名>
```

四个会读写业务数据库的 systemd 服务使用同一段 drop-in：

```ini
[Service]
EnvironmentFile=/etc/loumai/database-active.env
```

`/etc/loumai/backend-release.env` 增加：

```dotenv
LOUMAI_BACKEND_DATABASE_PROFILE_DIR=/etc/loumai/database-profiles
LOUMAI_BACKEND_ACTIVE_DATABASE_ENV=/etc/loumai/database-active.env
LOUMAI_BACKEND_CLOUD_DATABASE_HOST=172.27.0.3
LOUMAI_BACKEND_AUXILIARY_DATABASE_SERVICES="loumai-company-management.service"
```

修改后执行 `systemctl daemon-reload`，重启四个数据库 writer，再分别运行 `preflight local` 和 `preflight cloud`。发布器会真实连接数据库并核对实际库名；本地档位同时要求 URL 和 `inet_server_addr()` 都是回环目标，云档位要求 URL 固定指向 `172.27.0.3:5432`。腾讯云数据库可能经过代理或 NAT，`inet_server_addr()` / `inet_server_port()` 返回的是实际后端节点而非客户端入口，因此云档位不使用这两个返回值判断入口地址。

首次检查全新云库时，`preflight cloud` 返回 `DB_REVISION=base`、`DATABASE_PROFILE=cloud`、`ACTIVE_DATABASE_PROFILE=local` 属于正常状态，表示云库可连接但还没有执行首次迁移，现网仍在使用本机数据库。只有真正执行 `deploy-cloud --yes` 且全部门禁通过后，活动档位才会变为 `cloud`。

### 切换与失败保护

- 发布时先校验代码、目标数据库、环境文件和 systemd 合同，再停止 API、IM Worker、视频 Worker 和独立管理后台。
- profile 通过 root 权限临时文件和原子替换切换，四个 writer 不会混用不同数据库。管理后台仍使用自己的代码 release，发布器只协调它的停启和数据库目标。
- 目标库需要升级时，先备份目标库，再执行 Alembic 前向迁移和 schema 校验。
- 迁移前失败会自动恢复旧应用和旧数据库档位。
- 一旦迁移已经尝试，失败时 writer 保持停止，绝不自动 downgrade 或用备份覆盖数据库。
- 服务启动后，发布器会检查每个进程实际加载的 `LOUMAI_DATABASE_PROFILE`、`DATABASE_URL` 的 Host、端口和库名，防止“命令选了云库、任一进程仍连本地库”。
- 日常执行 `backend status` 也会重新验证当前活动档位的所有 writer；输出 `DATABASE_WRITERS=verified` 才表示运行中进程没有混用数据库。

## 日常命令

以下命令均从 `/Users/qinyang/Desktop/zuling/deploy--loumai` 执行。后端环境由 `config/backend.test.local.env` 决定，不需要额外的 `--env` 参数。

### 查看测试服状态

```bash
node backend/backend-release.mjs status
```

### 只读预演

```bash
node backend/backend-release.mjs deploy --dry-run
```

只读预演会检查本地 Git 分支、干净状态、upstream、唯一 Alembic head、远端 helper 协议、当前应用指向和数据库 revision，并运行 `git diff --check`。它明确不会运行全量测试、打包、上传、停止服务、备份、迁移或切换。

### 正式发布

```bash
node backend/backend-release.mjs deploy --yes
```

也可以使用统一入口：

```bash
./loumai-deploy backend deploy --dry-run
./loumai-deploy backend deploy --yes
```

正式发布会依次：

1. 锁定 clean/upstream 一致的完整 Git commit 和唯一 Alembic head；
2. 运行 `git diff --check`、Ruff check、Ruff format check；
3. 运行影子数据库迁移验证和后端全量 pytest；
4. 用 `git archive` 从锁定 commit 打包 `app / alembic / scripts / pyproject.toml / alembic.ini`；
5. 加入精确依赖约束、`release.json` 和 `SHA256SUMS`，再生成 `backend.tar`；
6. 远端在唯一 staging 中验归档哈希、成员路径、源码哈希和版本元数据；
7. 用 root 固定的 Python 与 uv 为新版本创建独立虚拟环境；
8. 以 compare-and-swap 方式确认应用指向和数据库 revision 没被并发任务改动；
9. 在上传前检查备份目录；安全的 `root` 目录会自动规范为 `postgres:postgres`、`0700`，并由 `postgres` 用户创建临时文件验证实际可写；
10. 停止所有已配置 writer；若需要迁移，先执行可读取验证的 PostgreSQL custom-format 备份；
11. 自动运行 Alembic upgrade 和严格 schema 校验；
12. 用临时软链接和 `mv -Tf` 原子替换 `backend-current`；
13. 启动 API，通过本机及公网健康检查，并确认 systemd 主进程工作目录确实是新版本；
14. 最后恢复已配置的定时任务并删除本次 staging。

`deploy --dry-run` 只报告备份目录是 `ready` 还是 `repairable`，不会修改服务器。`deploy --yes` 会在上传归档前自动处理 `repairable` 状态；如果目录是软链接、归未知用户所有或允许组/其他用户写入，则视为不安全配置并拒绝自动修复。这样既能保持一键迁移，又不会对任意服务器目录执行宽泛的 `chown`。

### 只构建本地产物

```bash
node backend/backend-release.mjs build
```

仅用于排查时可以显式跳过重型门禁：

```bash
node backend/backend-release.mjs build --skip-tests
```

带 `--skip-tests` 的 build 仍要求 Git 干净且同步，但只执行 `git diff --check`。它不上传，正式 `deploy` 也不会复用该产物；正式发布始终重新跑完整门禁和打包。

## 应用代码回滚

先查询当前应用与数据库版本：

```bash
node backend/backend-release.mjs status
```

人工检查目标版本的 `release.json`、迁移差异，以及旧 ORM/SQL 是否兼容当前数据库后，才能执行：

```bash
node backend/backend-release.mjs rollback \
  --release 20260810T123456Z-b9f28ae12 \
  --ack-db-schema-compatible \
  --yes
```

统一入口等价写法：

```bash
./loumai-deploy backend rollback \
  --release 20260810T123456Z-b9f28ae12 \
  --ack-db-schema-compatible \
  --yes
```

远端还会验证目标版本的迁移 head 是当前数据库 revision 的祖先，但这个检查不能代替业务层兼容审查。回滚流程只停服务、切换应用软链接、重新启动和健康检查；不会执行迁移、`alembic downgrade` 或数据库恢复。回滚健康检查失败时，激活器会尝试恢复回滚前的应用指向。

## 故障处理

### 迁移前失败

上传、验签、安装依赖或迁移祖先关系检查发生在停服务前，失败会保留当前线上应用。若服务已经停止但数据库尚未开始迁移，失败处理会尝试切回旧应用并恢复 API 与定时任务。

### 迁移已经尝试后失败

看到以下含义的错误时，不要手工启动旧应用：

```text
CRITICAL: 数据库迁移已经尝试；所有 writer 保持停止。
```

此时应：

1. 保存完整发布输出、`journalctl -u loumai-api.service` 和目标 release；
2. 查看输出中的 `CRITICAL_BACKUP`，用 `pg_restore --list` 再次确认备份可读取；
3. 对比当前 `alembic_version`、新版本 head 和 schema 校验错误；
4. 优先编写前向修复并在维护窗口验证；
5. 只有负责人明确接受数据丢失范围时，才由 DBA 单独执行备份恢复；
6. 修复并验证健康后，再恢复 API、Worker 和 timers。

发布工具不会替操作者猜测数据库是否能安全倒退。

## 常见报错

- `后端工作区不干净`：提交或妥善处理所有修改和未跟踪文件后再试；
- `当前提交与 upstream 不一致`：先拉取并解决差异，或推送已经确认的本地提交；
- `Alembic 必须且只能有一个 head`：合并迁移分支，不能任选一个 head 发布；
- `当前 DB revision 不是目标迁移的祖先`：数据库与代码迁移历史发生分叉，停止发布并人工处理；
- `远端 helper 版本或源码指纹不一致`：重新安装当前部署仓库中的服务器 helper；不能混用新旧协议，也不能只看相同版本号；
- `pg_dump: Peer authentication failed` 且显示 `/var/run/postgresql/.s.PGSQL.5432`：不要先改 PostgreSQL 认证规则或密码；核对 helper SHA256 并更新服务器 helper。旧读取逻辑可能把 TCP Host 覆盖为空而误走 Unix Socket；若日志明确显示“数据库未迁移，已尝试恢复旧应用”，先用 `backend status` 确认旧版本和原 revision 仍健康；
- `uv/Python 必须归 root 所有`：修正服务器固定运行时路径和所有权，不能指向用户目录；
- `环境文件不能被组或其他用户写入`：修正 `/etc/loumai/*.env` owner 和 mode；
- `backend-current 已被其他发布修改` 或 `数据库 revision 已被其他发布修改`：并发状态已变化，从新的 `status / dry-run` 重新开始；
- `新版本健康检查失败`：先判断迁移是否已尝试，再按对应故障路径处理；
- SSH 主机指纹或私钥错误：先用相同用户、端口和 identity 手工执行 BatchMode SSH 验证。

历史版本、虚拟环境和数据库备份不会由发布命令自动删除。磁盘清理由单独、经过保留策略审批的维护任务完成，不能在发布失败处理中顺手清理证据。
