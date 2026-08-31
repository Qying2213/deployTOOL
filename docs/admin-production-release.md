# 管理后台前后端正式服一键发布与启动

更新时间：2026-08-28

本文是完整维护源；`managedocx/01-一键发布/管理后台前后端正式服一键发布说明.md` 保留常用一键命令并链接本手册，避免维护两份重复安装说明。

当前完成的是发布工具、安装模板和本机测试，**不代表已在正式服务器安装或发布**。正式管理后台域名尚未由本次任务确认，所有 `admin.example.com` 都是必须替换的占位符。不要把测试 ZIP 当正式包发布。

## 1. 日常一键发布并启动

完成第 3～5 节的一次性安装后，将同事交付的**正式管理后台 ZIP**放到 `/Users/qinyang/Desktop/admin-production.zip`，在秦洋的 **Mac 终端**执行：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai && ./loumai-deploy admin deploy --env production --file /Users/qinyang/Desktop/admin-production.zip --yes
```

这就是管理后台前后端的联合一键命令。它依次执行：

1. 本机检查正式 ZIP：标题、入口资源、目标 API、路径穿越、敏感文件和哈希。
2. 核对前后端配置的 SSH 目标、端口和正式后台域名一致，检查前端服务器 helper/目录已经安装。
3. 构建并发布管理后台 Python 后端，自动启动或重启服务，成功后设置开机自启。
4. 后端健康、数据库结构和未登录保护通过后，发布 ZIP 静态前端并验证线上文件哈希。

前端是 Nginx 提供的静态站点，没有单独需要启动的 Node 进程。命令不会部署业务 H5、主业务后端或官网，不会迁移、清空或复制数据库，不创建管理员账号。

这是**顺序发布，不是前后端共同提交的原子事务**。后端失败则不会发布前端；前端失败不会自动回滚已成功的后端，应检查状态并单独恢复需要回滚的组件。发布前确认前后端接口兼容。

只读预演：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai && ./loumai-deploy admin deploy --env production --file /Users/qinyang/Desktop/admin-production.zip --dry-run
```

预演会检查配置、包、Git、部署工具专项测试和服务器状态，不构建后端、不上传、不修改 Nginx、不申请证书、不迁移或切换版本。全新后台尚未启动时，前端的 `/ready` 检查可能失败；先完成第一次后端发布，再复核前端预演，不能跳过检查。

查看前后端状态：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai && ./loumai-deploy admin status --env production
```

## 2. 只更新一个组件

仅管理后台后端（自动重启并验收）：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai && ./loumai-deploy admin-backend deploy --env production --yes
```

仅管理后台前端 ZIP：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai && ./loumai-deploy admin-frontend deploy-package --env production --file /Users/qinyang/Desktop/admin-production.zip --yes
```

仅本机检查正式 ZIP，不连接服务器：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai && ./loumai-deploy admin-frontend check-package --env production --file /Users/qinyang/Desktop/admin-production.zip
```

已有的 `admin-backend deploy --yes` 和 `admin-frontend deploy-package --file ... --yes` **仍然默认测试服**，不是正式服。正式服必须明确写 `--env production`。

## 3. 一次性填写本机配置

在 Mac 上创建两个 Git 忽略的配置文件；文件已存在时只编辑，不要用模板覆盖：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai
cp -n config/admin-backend.production.example.env config/admin-backend.production.local.env
cp -n config/admin-frontend.production.example.env config/admin-frontend.production.local.env
chmod 600 config/admin-backend.production.local.env config/admin-frontend.production.local.env
```

需要填写并核对：

- `ADMIN_BACKEND_REPO`：`/Users/qinyang/Desktop/zuling/conpanyManagement`。正式发布要求它是 Git 仓库，源码干净、分支等于配置要求、HEAD 等于本地 upstream 引用；发布前自行 fetch/push 确认远端。
- `ADMIN_BACKEND_PYTHON_BIN`：管理后台 `.venv/bin/python`，需能运行 Ruff、pytest。
- `ADMIN_BACKEND_EXPECTED_BRANCH`：准备发布的稳定分支，模板为 `master`；不要为了通过门禁随意修改。
- 前后端 `*_DEPLOY_TARGET`：同一台业务正式服的 `loumai-deploy@地址`，不能用 `ubuntu`、`root` 或测试服务器。
- `*_SSH_IDENTITY_FILE`：独立正式服私钥的绝对路径；通过可信渠道预先核验 SSH Host Key，不能关闭 `StrictHostKeyChecking`。
- `ADMIN_FRONTEND_PUBLIC_URL`：负责人确认的正式后台 HTTPS 根域名。
- `ADMIN_BACKEND_PUBLIC_URL`：同一个正式后台域名加 `/admin-api`。

只保存路径、地址和分支，不保存数据库口令、JWT、COS 密钥或私钥正文。不要把这些真实配置提交到 Git。

## 4. 一次性生成安装包（仅本机）

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai && ./loumai-deploy admin prepare --env production --yes
```

此处 `prepare` **只生成本机安装包，不连接服务器**。终端会打印两个唯一目录：

- `dist/admin-backend-production-setup-*`：后台专属 helper、主业务后端新版 helper、systemd、环境模板、最小 sudo 规则。
- `dist/admin-frontend-production-setup-*`：前端专属 helper、发布配置、Nginx 站点和登录限流。

域名会按本机配置填入安装文件；密码仍是占位符。不要直接把 `.env.example` 当作可用生产配置。

管理员核验部署仓库改动、精确 commit、安装包哈希后，通过受控管理员通道将这些文件放到正式服务器的 `/root/loumai-admin-production-install/`。日常发布账号不会获得执行任意上传脚本、`python`、`systemctl` 或 shell 的 sudo 权限。

## 5. 正式服务器一次性安装

以下步骤只能由服务器管理员执行，不属于日常一键发布。先备份将要修改的文件，并安排变更窗口。主业务后端必须已经完成正式初始化；本工具不会初始化主业务数据库。

### 5.1 账号、目录与固定运行时

沿用正式服既有 `loumai-deploy`、`loumai-build`、`loumai-db-ca`，新增独立后台账号 `loumai-admin`。先用 `getent passwd` / `getent group` 检查，已存在时不要重复创建或改变原账号：

```bash
sudo useradd --system --home-dir /var/lib/loumai-admin --create-home --shell /usr/sbin/nologin loumai-admin
sudo usermod --append --groups loumai-db-ca loumai-admin
sudo install -d -m 0755 -o root -g root \
  /srv/loumai-company-management-production \
  /srv/loumai-company-management-production/releases \
  /srv/loumai-company-management-production/incoming \
  /srv/loumai-admin-frontend-production \
  /srv/loumai-admin-frontend-production/frontend-releases \
  /srv/loumai-admin-frontend-production/incoming \
  /var/www/loumai-admin-production-acme
```

Python 和 uv 必须是 `/opt/loumai-runtime` 下已核验的 root-owned 固定运行时。后台依赖使用独立 `admin-backend/runtime-constraints.production.txt`；初始锁定版本来自现有后台测试服约束，后续单独评审升级。依赖安装以 `loumai-build` 运行，不携带应用密钥；后台服务以 `loumai-admin` 运行。

### 5.2 独立应用配置与数据库账号

在服务器填写下列文件，全部为 `root:root 0600`：

| 文件 | 内容 |
| --- | --- |
| `/etc/loumai/company-management-production-release.env` | 正式环境、管理后台域名、固定 Python/uv 路径 |
| `/etc/loumai/company-management-production.env` | 独立后台 JWT、精确 Host/CORS、正式 COS 最小权限凭据 |
| `/etc/loumai/company-management-production-database.env` | 独立后台 DML 账号、正式库 URL、cloud profile 和数据库名 |
| `/etc/loumai/admin-frontend-production-release.env` | 正式前端域名、受控目录和部署账号，无应用密钥 |

由 DBA 为后台创建**独立的非 owner 数据库账号**，目标与主业务后端的正式 PostgreSQL 完全相同。不得复用主业务运行、迁移或备份账号；不得授予超级用户、角色管理、建库、复制、绕过 RLS、schema CREATE、数据库 CREATE/TEMP 或迁移角色成员资格。

按管理后台实际使用的业务表授予必要的 SELECT/INSERT/UPDATE/DELETE 和 sequence 权限；允许读取 `alembic_version`。同步设置迁移角色新建表的必要默认权限。不要向后台授予 DDL 权限来解决权限报错。

URL 必须使用腾讯云 PostgreSQL 证书匹配的 DNS endpoint、5432、`sslmode=verify-full` 和 `/etc/loumai/certs/tencentdb-ca.pem`。数据库名和 endpoint 必须与 `/etc/loumai/backend-release.env` 一致；密码做 URL 编码。

后台只加载自己的应用与数据库文件，**不加载**主业务的 `backend.env`、`sms.env`、`database-active.env`，也不接收迁移/备份 URL。正式配置强制：关闭 API 文档、开启 schema 检查、使用正式 COS、独立强 JWT、仅正式后台 Host/CORS。

### 5.3 安装 helper、systemd 和最小 sudo

从已核验的安装目录安装；先备份已有主业务 helper，不能覆盖任何未知版本或现有业务配置：

```bash
sudo install -m 0755 -o root -g root /root/loumai-admin-production-install/loumai-company-management-production-release /usr/local/sbin/loumai-company-management-production-release
sudo install -m 0755 -o root -g root /root/loumai-admin-production-install/loumai-admin-frontend-production-release /usr/local/sbin/loumai-admin-frontend-production-release
sudo install -m 0755 -o root -g root /root/loumai-admin-production-install/loumai-backend-release /usr/local/sbin/loumai-backend-release
sudo install -m 0644 -o root -g root /root/loumai-admin-production-install/loumai-company-management.service /etc/systemd/system/loumai-company-management.service
sudo install -m 0440 -o root -g root /root/loumai-admin-production-install/sudoers.example /etc/sudoers.d/loumai-admin-production
sudo visudo -cf /etc/sudoers.d/loumai-admin-production
sudo systemctl daemon-reload
sudo systemctl disable --now loumai-company-management.service
```

前述四个配置文件必须已手工填好并安装；不是通过以上命令自动生成。第一次后台发布成功前保持后台服务停止。已有后台正式实例升级时，不执行“首次停止”命令，应按变更窗口处理。

主业务 helper 的协议仍为 6，但源码指纹已变化：新增正式后台独立凭据和停写保护。必须安装本次同一份已评审 helper；否则后续业务发布的指纹检查会阻断。没有修改测试服务器，测试服若要使用更新后的主业务发布器，也需显式同步经过评审的 helper，不能绕过指纹检查。

### 5.4 接入主业务数据库停写保护

管理员编辑 `/etc/loumai/backend-release.env`，在保留其他独立 writer 的前提下加入：

```dotenv
LOUMAI_BACKEND_AUXILIARY_DATABASE_SERVICES="loumai-company-management.service"
```

此项必须在后台第一次启动前完成。主业务后端发布/迁移时，会统一停止、启动和验证后台实际数据库目标；后台单独发布也持有 `/srv/loumai-backend/.backend-release.lock`，遇到主业务迁移恢复标记会拒绝启动/发布/回滚。

注册后、后台首次发布成功前，主业务 `status` 可能报告后台未运行，这是安装中的暂态；不要在此期间交叉执行主业务部署。**不能为绕过门禁把正在运行的后台从 writer 列表删除。**

### 5.5 正式域名、Nginx 和 HTTPS

为负责人确认的正式后台域名设置 DNS，指向同一台正式服务器；不要修改测试域名、API 域名和官网解析。开放必要的 HTTPS/证书验证入口，不公开 8100。

安装包中的 Nginx 模板引用 `/etc/letsencrypt/live/正式后台域名/`。管理员先用现有证书管理流程完成证书和续期配置；若还没有证书，应先配置 HTTP ACME challenge 站点，再签发证书，不能直接启用引用不存在证书的 HTTPS 站点。日常发布不会申请证书或修改 DNS。

证书准备完毕后安装独立站点及 http 级登录限流：

```bash
sudo install -m 0644 -o root -g root /root/loumai-admin-production-install/loumai-admin-production-rate-limit.conf /etc/nginx/conf.d/loumai-admin-production-rate-limit.conf
sudo install -m 0644 -o root -g root /root/loumai-admin-production-install/loumai-admin-production.conf /etc/nginx/sites-available/loumai-admin-production
sudo ln -s /etc/nginx/sites-available/loumai-admin-production /etc/nginx/sites-enabled/loumai-admin-production
sudo nginx -t
sudo systemctl reload nginx
```

已有同名文件/链接时先核验，不直接覆盖。Nginx 使用正式域名作为 Host 转发至 `127.0.0.1:8100`；后台 API 同源路径为 `/admin-api/api/v1`，登录限流独立，后端保留管理员 Bearer Token 认证，不会自动登录或绕过权限。

### 5.6 第一次发布顺序

回到 **Mac 终端**，先后端，后前端：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai
./loumai-deploy admin-backend deploy --env production --dry-run
./loumai-deploy admin-backend deploy --env production --yes
./loumai-deploy admin-frontend deploy-package --env production --file /Users/qinyang/Desktop/admin-production.zip --dry-run
./loumai-deploy admin-frontend deploy-package --env production --file /Users/qinyang/Desktop/admin-production.zip --yes
./loumai-deploy admin status --env production
./loumai-deploy backend status --env production
```

资源全部预装完成后，也可直接使用第 1 节的联合命令完成这次顺序发布。后台前端正式包必须使用同源 `/admin-api/api/v1`，或已确认正式后台域名下的相同 API 前缀。正式发布拒绝测试地址，不会把旧测试包偷偷转换为正式包。

## 6. 回滚与失败处理

两个组件分别保留历史版本。先读取状态记录当前版本，选定真实历史版本号，再执行预演和回滚。

后端回滚（必须人工确认兼容当前数据库结构）：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai
./loumai-deploy admin-backend rollback --env production --release RELEASE_ID --ack-db-schema-compatible --dry-run
./loumai-deploy admin-backend rollback --env production --release RELEASE_ID --ack-db-schema-compatible --yes
```

前端回滚：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai
./loumai-deploy admin-frontend rollback --env production --release RELEASE_ID --dry-run
./loumai-deploy admin-frontend rollback --env production --release RELEASE_ID --yes
```

- 后端回滚只换代码，不 downgrade/restore 数据库。候选版本在切换前检查当前 schema、数据库权限和哈希。
- 后端新版启动失败，会尝试恢复旧代码并验证健康；首次发布无旧版本时停止并禁用后台。旧版本也无法恢复时明确报 `CRITICAL`，不能当作已回滚成功。
- 前端验证失败，按当前版本条件自动恢复之前的指向；不会回滚后端。
- 主业务存在 `.migration-recovery-required` 时，必须先按主业务恢复手册处理，不得重启后台绕过停写保护。
- 上传/依赖安装中断可能留下该版本的 staging 或 release 用于排查。不会覆盖同名版本；先保留日志，核实目录后由管理员清理确切的失败版本。
- 一次性安装失败时由管理员恢复已备份的 helper、配置和 Nginx 文件；本机 `prepare` 不是自动安装/自动恢复工具。

## 7. 仅重启现有正式后台

这不是发布代码。在 **Mac 终端**使用受控重启命令：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai && ./loumai-deploy admin-backend restart --env production --yes
```

它会核对当前版本、获取共享发布锁、拒绝主业务迁移恢复状态，再检查 schema 和数据库权限并重启；失败按现有版本恢复规则处理。将 `--yes` 换成 `--dry-run` 可只检查。不应直接用 `systemctl restart` 绕过这些保护。

命令自动检查 `/admin-api/health`、`/admin-api/ready` 和未登录 `/admin-api/api/v1/admin-auth/me` 为 401。不要在正式服运行 `conpanyManagement/start_admin.sh`：该脚本不是正式 systemd 发布链。

首次安装后应确认 `systemctl is-enabled loumai-company-management.service` 为 enabled，机器重启后由 systemd 启动后台、由 Nginx 提供静态前端，无需人工再跑“启动脚本”。

## 8. 正式上线验收与当前验证范围

放行前至少核验：

- SSH、helper 指纹、production 环境、前后端隔离目录及正式域名全部匹配。
- 后台与业务后端连接同一正式数据库，后台使用独立 DML 账号，不拥有 DDL/迁移/备份凭据。
- API `health/ready` 正常，未登录接口 401，错误密码受限流保护，真实管理员登录与必要管理操作通过人工验收。
- 前端首页、刷新、静态资源、发布清单一致，无测试 API、SourceMap、环境文件和私钥。
- 主业务迁移能协调后台停写；发布/回滚演练、备份恢复演练、监控告警和证书续期检查完成。

本次仅执行本机发布器测试、隔离 helper 行为测试和管理后台业务测试；不连接正式服务器、不做真实登录或生产数据库写入。`qiye-qianduan` 原有 H5 构建环境白名单测试失败属于独立业务 H5，不靠跳过/删除该检查解决；后台前端 ZIP 发布使用自己的产物测试。
