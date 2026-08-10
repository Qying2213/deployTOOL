# 后端自动发布与安全回滚

## 目标与边界

`backend/backend-release.mjs` 将后端代码门禁、确定版本打包、上传验签、数据库备份、Alembic 升级、原子切换和健康检查串成一条可审计的发布链路。源码仓库和部署工具彼此独立，执行命令时所在目录不会改变被打包的项目。

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
LOUMAI_BACKEND_SERVICES="loumai-api.service"
LOUMAI_BACKEND_TIMERS=""
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
rm -f /tmp/loumai-backend-release /tmp/backend-release.env
```

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
sudo -u loumai-build env \
  HOME=/var/lib/loumai-build \
  UV_CACHE_DIR=/srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/.bootstrap-runtime/cache \
  UV_LINK_MODE=copy \
  /opt/loumai-runtime/bin/uv venv \
  --python /opt/loumai-runtime/python/cpython-3.12.13-linux-x86_64-gnu/bin/python3.12 \
  --seed \
  /srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/backend/.venv
sudo -u loumai-build env \
  HOME=/var/lib/loumai-build \
  UV_CACHE_DIR=/srv/loumai-backend/backend-releases/20260807T000000Z-b9f28ae000/.bootstrap-runtime/cache \
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

如果以后增加 Worker 或定时任务，必须先把相应 `.service` 和 `.timer` 全部加入 `LOUMAI_BACKEND_SERVICES` / `LOUMAI_BACKEND_TIMERS`，再允许发布。漏配 writer 会破坏“迁移期间无并发写入”的前提。

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
sudo -n /usr/local/sbin/loumai-backend-release preflight
sudo -n /usr/local/sbin/loumai-backend-release status
```

激活器只接受 `version / preflight / prepare / abort / status / activate / rollback`，并再次校验参数、root 所有权、上传路径、归档成员、逐文件哈希、当前软链接和数据库 revision。不要给 SSH 用户通用 root shell 或任意 `systemctl` 权限。

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
9. 停止所有已配置 writer；若需要迁移，先执行可读取验证的 PostgreSQL custom-format 备份；
10. 运行 Alembic upgrade 和严格 schema 校验；
11. 用临时软链接和 `mv -Tf` 原子替换 `backend-current`；
12. 启动 API，通过本机及公网健康检查，并确认 systemd 主进程工作目录确实是新版本；
13. 最后恢复已配置的定时任务并删除本次 staging。

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
- `远端 helper 版本不一致`：重新安装同一目录中的服务器 helper，不能混用新旧协议；
- `uv/Python 必须归 root 所有`：修正服务器固定运行时路径和所有权，不能指向用户目录；
- `环境文件不能被组或其他用户写入`：修正 `/etc/loumai/*.env` owner 和 mode；
- `backend-current 已被其他发布修改` 或 `数据库 revision 已被其他发布修改`：并发状态已变化，从新的 `status / dry-run` 重新开始；
- `新版本健康检查失败`：先判断迁移是否已尝试，再按对应故障路径处理；
- SSH 主机指纹或私钥错误：先用相同用户、端口和 identity 手工执行 BatchMode SSH 验证。

历史版本、虚拟环境和数据库备份不会由发布命令自动删除。磁盘清理由单独、经过保留策略审批的维护任务完成，不能在发布失败处理中顺手清理证据。
