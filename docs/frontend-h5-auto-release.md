# H5 自动构建与原子发布

## 目标

独立部署目录中的 `frontend/h5-release.mjs` 将测试、H5 全新构建、产物校验、上传、版本切换和线上验收合并为一条命令。它通过 `H5_FRONTEND_REPO` 定位前端源码仓库，不依赖执行命令时的当前目录。

- 不再上传历史 `unpackage/dist/build/web`；
- 发布提交、API 地址、构建器版本和产物哈希可追溯；
- 构建失败、目标 API 错误、出现局域网地址或缺少关键兼容代码时立即停止；
- 上传只进入唯一 staging，服务器校验全部 SHA256 后才切换；
- 使用临时软链接与 `mv -Tf` 原子替换 `frontend-current`；
- 线上哈希验收失败时按 compare-and-swap 规则恢复发布前版本；
- 新版本保留上一版 `/assets` 哈希文件，避免已打开页面懒加载旧 chunk 时 404。

脚本不会停止或重启后端、Worker 和定时任务，也不会删除历史 release。

## 文件

- `frontend/h5-release.mjs`：本地一键入口；
- `frontend/remote/loumai-h5-release`：服务器端受限激活器；
- `frontend/remote/loumai-h5-release.env.example`：服务器配置模板；
- `config/frontend.test.example.env`：本地配置模板；
- `tests/frontend-h5-release.test.mjs`：离线安全与产物门禁测试；
- `dist/h5-releases/`：本地版本、上传归档和构建日志目录。

## 一次性服务器安装

以下命令中的 `DEPLOY_USER` 和服务器 SSH 地址需替换为真实值。不要把密码、Token 或私钥内容写入仓库。

```bash
ssh root@SERVER 'install -d -m 0755 -o root -g root /etc/loumai'
scp frontend/remote/loumai-h5-release root@SERVER:/usr/local/sbin/loumai-h5-release
scp frontend/remote/loumai-h5-release.env.example root@SERVER:/etc/loumai/h5-release.env
```

在服务器上完成：

```bash
sudo chown root:root /usr/local/sbin/loumai-h5-release /etc/loumai/h5-release.env
sudo chmod 0755 /usr/local/sbin/loumai-h5-release
sudo chmod 0644 /etc/loumai/h5-release.env
sudo install -d -m 0755 -o root -g root /srv/loumai-h5
sudo install -d -m 0755 -o root -g root /srv/loumai-h5/frontend-releases
sudo install -d -m 0755 -o root -g root /srv/loumai-h5/incoming
```

编辑 `/etc/loumai/h5-release.env`，至少确认：

```dotenv
LOUMAI_H5_ENVIRONMENT=test
LOUMAI_H5_REMOTE_ROOT=/srv/loumai-h5
LOUMAI_H5_STAGING_ROOT=/srv/loumai-h5/incoming
LOUMAI_H5_DEPLOY_USER=DEPLOY_USER
LOUMAI_H5_PUBLIC_URL=https://test.yinlizhangyu.com
LOUMAI_H5_WEB_USER=www-data
LOUMAI_H5_NGINX_BIN=/usr/sbin/nginx
```

若 SSH 使用非 root 发布账号，在 `/etc/sudoers.d/loumai-h5-release` 只授权这个受限激活器：

```sudoers
Defaults!/usr/local/sbin/loumai-h5-release secure_path=/usr/sbin:/usr/bin:/sbin:/bin
DEPLOY_USER ALL=(root) NOPASSWD: /usr/local/sbin/loumai-h5-release *
```

然后验证：

```bash
sudo visudo -cf /etc/sudoers.d/loumai-h5-release
sudo -n /usr/local/sbin/loumai-h5-release preflight test
```

激活器只接受 `version / fingerprint / preflight / prepare / abort / status / activate / check-release / rollback`，并对 release ID、提交、归档与文件哈希、路径、并发锁和当前软链接执行二次校验。`check-release` 只读验证回滚目标，供 `rollback --dry-run` 使用。
`/etc/loumai`、`LOUMAI_H5_REMOTE_ROOT`、`frontend-releases` 和 `incoming` 均必须由 root 持有且不可被发布账号写入；Nginx 的 H5 `root` 应指向 `/srv/loumai-h5/frontend-current`。发布前由激活器在 `incoming` 中只为本次 release 创建一个临时子目录并暂时授权给 SSH 发布账号；本地只上传单个 `frontend.tar`，激活器先按本地 SHA256 复制到 root 私有目录，再解包、逐文件验签和安装。最终线上文件只归 root 所有，失败时 `abort` 清理本次 staging。

## 本地配置

```bash
cp config/frontend.test.example.env config/frontend.test.local.env
chmod 600 config/frontend.test.local.env
```

填写：

- `H5_FRONTEND_REPO`：前端 Git 仓库的绝对路径，例如 `/Users/name/work/qiye-qianduan`；
- `H5_DEPLOY_TARGET`：SSH alias 或 `用户@服务器`；
- `H5_SSH_IDENTITY_FILE`：可选，只写私钥路径，不写私钥内容；
- `H5_REMOTE_STAGING_ROOT`：必须与服务器配置一致；
- `H5_EXPECTED_BRANCH`：测试包当前固定为 `feat/test-api-import`；
- HBuilderX、内置 Node 和 uni 编译器版本。

`config/frontend.test.local.env` 必须被独立部署目录的 `.gitignore` 忽略，不得提交。脚本还会拒绝变量名含 `SECRET / PASSWORD / TOKEN / PRIVATE_KEY / ACCESS_KEY` 的配置。私钥本体继续保存在 `~/.ssh`，这里只保存私钥路径。

## 一键发布

以下三种入口等价；文档后续使用最直接的 Node 命令展示：

```bash
./loumai-deploy frontend deploy --env test --dry-run
npm run frontend:deploy:test -- --dry-run
node frontend/h5-release.mjs deploy --env test --dry-run
```

独立专项测试：

```bash
node --test tests/frontend-h5-release.test.mjs
```

首次先做只读演练：

```bash
node frontend/h5-release.mjs deploy --env test --dry-run
```

正式发布：

```bash
node frontend/h5-release.mjs deploy --env test --yes
```

## 发布前端同事交付的 ZIP

前端同事已经完成 H5 构建、只交付 `web.zip` 时，不要执行普通 `deploy`，因为普通命令会重新构建本机源码。先验证压缩包：

```bash
./loumai-deploy frontend deploy-package \
  --file /绝对路径/web.zip \
  --env test \
  --dry-run
```

验证通过后，一键正式发布：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai \
  && ./loumai-deploy frontend deploy-package \
    --file /绝对路径/web.zip \
    --env test \
    --yes
```

ZIP 只允许以下两种结构：

```text
web.zip
├── index.html
└── assets/
```

或：

```text
web.zip
└── web/
    ├── index.html
    └── assets/
```

压缩包导入使用本机 `python3` 标准库做逐项安全解包，不调用 ZIP 中的任何脚本。门禁会限制压缩包最大 512 MiB、解压后最大 512 MiB、单文件最大 128 MiB、最多 20,000 项，并拒绝：

- `../` 路径穿越、绝对路径和 Windows 盘符路径；
- 加密 ZIP、软链接、硬件设备等特殊文件；
- 重复路径和只在大小写上不同的冲突路径；
- `.env`、`.git`、隐藏目录、私钥和证书；
- ZIP 自带的 `release.json` 或 `SHA256SUMS`；
- 非测试服 API、局域网地址、SourceMap、无哈希入口或旧存储兼容实现。

`__MACOSX` 和 `.DS_Store` 会被安全忽略。导入后发布器重新生成发布元数据与逐文件 SHA256。为了兼容现有服务器协议，`release.json.commit` 保存 ZIP SHA256 的前 40 位作为不可变产物身份，它不是 Git commit；完整摘要位于 `source.package_sha256`，来源标记为 `source.kind=external_zip`。

压缩包模式会运行部署工具自身的安全测试，但只能证明“收到的 ZIP 与线上文件完全一致”，不能证明它对应哪个源码 commit，也不会运行前端源码仓库测试。应让同事同时告知构建分支与 commit，且只接受可信来源的交付包。

流程为：

1. 要求工作区干净、无 merge/rebase，并且 HEAD 与 upstream 完全一致；
2. 要求当前分支等于 `H5_EXPECTED_BRANCH`；
3. 锁定 HBuilderX 5.14、内置 Node、uni 编译器和 Sass 版本；
4. 执行前端全量测试；
5. 直接调用 HBuilderX 内置 uni 编译器，以 `--mode test` 从 `H5_FRONTEND_REPO` 构建到独立部署目录唯一的 `dist/h5-releases/<release_id>`；
6. 校验标题、目标 HTTPS API、入口资源、SourceMap、软链接、特殊文件、本地 IP，以及渠道邀请码 H5 存储兼容链；
7. 写入 `release.json` 和 `SHA256SUMS`；
8. 上传到用户专属 staging；
9. 服务器重新验证 `SHA256SUMS` 自身哈希和全部文件哈希；
10. 在 `flock` 临界区内安装、原子切换并通过 HTTPS 下载结果复核哈希。

构建器不需要登录 HBuilderX/DCloud；脚本通过 `HX_APP_ROOT` 使用已安装的 Sass 插件。HBuilderX 自动升级后版本门禁会停止发布，需先重新编译、回归，再明确更新版本配置。
构建通过 `vite.config.mjs` 只向浏览器暴露明确白名单环境字段；shell 中遗留的 `VITE_* / VUE_APP_*` 会先清除，`.env.local` 和 `.env.<mode>.local` 会被发布门禁拒绝，产物若包含非目标 API 或本机绝对路径也会停止发布。
本地脚本与服务器激活器当前协议版本为 `4`；任一端还是旧版时，预检会在上传前直接停止。版本 4 进一步绑定部署环境、远端根目录和公网 URL；升级本地部署工具后要按“一次性服务器安装”中的 `scp/install` 步骤同步更新服务器 helper。

## 只构建、查询与回滚

```bash
node frontend/h5-release.mjs build --env test
node frontend/h5-release.mjs status
node frontend/h5-release.mjs rollback --release 20260810T123456Z-261cb03 --dry-run
node frontend/h5-release.mjs rollback --release 20260810T123456Z-261cb03 --yes
```

`build` 只生成经过验证的本地版本，不上传。回滚预演会真实检查目标 release、SHA256 和 current 的 compare-and-swap 条件，但不会切换版本；正式 `rollback` 也会保留当前版本的哈希 chunk，避免刚打开的新页面在回滚后加载资源失败。

## 缓存约束

当前 Nginx 对所有 JS、CSS、图片设置七天 `immutable`，但项目仍有 `/static/logo.png` 等非哈希路径。激活器遇到“同路径、不同内容”的非哈希静态文件会拒绝发布。长期建议调整为：

- 仅 `/assets/` 内容哈希资源使用 `immutable`；
- `/static/` 使用 `no-cache` 或短缓存并重新验证；
- `index.html` 和 `release.json` 保持 `no-cache`。

脚本采用 append-only 方式继承旧 `/assets`，不会因切换版本删除旧页面仍可能请求的 chunk。历史版本和资产清理由独立维护任务处理；前端版本仅位于 `/srv/loumai-h5/frontend-releases`，不会清理或修改后端 release。

## 常见失败

- `工作区不干净`：提交或妥善处理本地改动后重试；
- `HEAD 与 upstream 不一致`：先 `git pull --ff-only` 或推送当前提交；
- `构建器版本漂移`：不要直接放行，先完成新版本 H5 全量回归；
- `产物包含本地或局域网地址`：检查 `.env.test` 和环境配置；
- `缺少 H5 存储兼容标记`：说明打包的仍不是当前修复源码；
- `frontend-current 已被其他发布修改`：另一发布已经抢先完成，重新从预检开始；
- `非哈希静态资源内容变化`：先改成哈希文件名或调整 Nginx 缓存策略；
- `线上校验失败`：激活器只在当前仍指向本次版本时自动回滚，不会覆盖另一并发发布。
