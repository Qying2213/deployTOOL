# 管理后台前端 ZIP 一键发布到测试服

本文说明测试服；默认命令与已上线测试站保持不变。正式服使用独立配置、helper 和正式 ZIP，不会沿用本页的自动测试站安装流程，见 [管理后台前后端正式服一键发布](admin-production-release.md)。

更新时间：2026-08-28

## 1. 直接复制的发布命令

在秦洋的 **Mac 终端**执行，不是在服务器终端或数据库 SQL 窗口：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai && ./loumai-deploy admin-frontend deploy-package --file /Users/qinyang/Desktop/gongweiyoufang-admin-20260827-test.zip --yes
```

发布的是桌面上的管理后台前端压缩包，不会重新构建本地旧版前端。以后收到新包，只需要把 `--file` 后面的文件名换成实际的绝对路径。

上线成功后访问：[管理后台测试站](https://admin-test.yinlizhangyu.com/#/login)。

**首次执行前还需要 DNS：**在阿里云 `yinlizhangyu.com` 的解析设置中添加 **A 记录**，主机记录填 `admin-test`，记录值填 `132.232.220.115`，线路默认、状态启用。该主机记录不要设置 AAAA，也不要修改现有 `test`、`api` 或官网记录。

2026-08-28 10:52（北京时间）已完成首次真实部署，版本为 `20260828T025218Z-a6474b5047`；服务器状态 `DNS_READY=true`、`INITIALIZED=true`。首页、发布文件哈希、HTTPS 和后台未登录保护均验收通过。后续继续使用上面的同一条命令即可，正常发布复用证书，不需要再次申请。

## 2. 这条命令会做什么

1. 运行管理后台发布专项测试，验证 ZIP 路径、软链接、敏感文件、主入口和资源引用。
2. 在临时目录生成部署副本，原 ZIP 不变。把包内已知旧测试 API 地址 `https://test.yinlizhangyu.com/admin-api/api/v1` 规范化为同源 `/admin-api/api/v1`；拒绝其他后台 API 目标。
3. 删除副本内预压缩的 `.gz/.br`，避免浏览器拿到仍含旧 API 地址的压缩文件；Nginx 动态 gzip。记录原 ZIP SHA256、适配次数及最终文件 SHA256。
4. 通过严格 SSH 主机指纹校验检查测试服务器、管理后台后端健康和 DNS。
5. **首次发布**自动建立独立 Nginx 站点，使用 Let’s Encrypt 签发 HTTPS 证书，并安装仅续期该证书的定时器。证书账户邮箱为 `602491730@qq.com`；不要仅依赖邮箱提醒，应检查续期任务状态。
6. 上传新版本、校验哈希，再原子切换当前版本。服务器验证首页、发布清单和入口资源；验证失败自动恢复之前的版本指向。首次发布没有旧版本时恢复为未发布状态。
7. 日常发布复用现有证书和站点，不需要反复初始化。helper 指纹不一致时停止，请先使用 `prepare --yes` 显式升级。
8. 初始化 reload 后，在 20 秒等待窗口内重试只读 HTTPS 验收；每次请求最多 3 秒，最后一次在途探测可能略超出窗口。必须同时通过域名证书验证、后台健康状态 UP、未登录接口返回 401 才算就绪。不会使用 `curl -k` 或 `--insecure`，不会在等待期间重复签发证书；持续失败仍回退配置。

初始化失败时会恢复本工具修改前的配置；备份在服务器 `/var/backups/loumai-admin-frontend/prepare-*/`。已申请的证书会保留供重试，不会撤销。

## 3. 与其他系统的边界

| 项目 | 管理后台前端使用的位置 |
| --- | --- |
| SSH 目标 | `ubuntu@132.232.220.115` |
| 独立域名 | `admin-test.yinlizhangyu.com` |
| 当前静态文件 | `/srv/loumai-admin-frontend/frontend-current` |
| 历史版本 | `/srv/loumai-admin-frontend/frontend-releases/` |
| 独立 helper | `/usr/local/sbin/loumai-admin-frontend-release` |
| 独立配置 | `/etc/loumai/admin-frontend-release.env` |
| 独立 Nginx 站点 | `/etc/nginx/sites-available/loumai-admin-test` |
| 后台 API | 同源 `/admin-api/api/v1` → `127.0.0.1:8100/api/v1` |

- 不覆盖业务 H5 的 `/srv/loumai-h5` 和现有 helper；不部署官网或正式服。
- 不修改后端源码、后端 env、管理员账号、密码或数据库。
- 不执行数据库迁移或清空，也不重启业务后端和管理后台后端。
- 首次初始化及显式 `prepare` 会执行 `nginx -t` 后平滑 reload Nginx，原有站点配置不变。
- 后台 API 仍要求管理员 Bearer Token，登录有独立限流。新站点仅允许同源浏览器请求；经过同源检查后用回环 Host 转发给后台，不需要扩大后端 CORS 白名单。
- 现有后台账号仍可使用。独立域名不会继承旧域名的浏览器登录缓存，需要重新登录。

不要把后台 ZIP 传给 `frontend deploy-package`，那是业务 H5。不要把它传给 `admin-backend deploy`，那是后台 Python 服务。

## 4. 校验、预演和状态

仅在本机检查包，不连接服务器：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai && ./loumai-deploy admin-frontend check-package --file /Users/qinyang/Desktop/gongweiyoufang-admin-20260827-test.zip
```

完整只读预演（不申请证书、不上传、不改 Nginx、不切换版本）：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai && ./loumai-deploy admin-frontend deploy-package --file /Users/qinyang/Desktop/gongweiyoufang-admin-20260827-test.zip --dry-run
```

查看服务器准备情况及已发布版本：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai && ./loumai-deploy admin-frontend status
```

DNS 检查从服务器执行，以免本机代理的虚拟 DNS 地址造成误判。预演遇到 DNS 缺失会停止报错，这是保护，不是发布成功。

可选 SSH 配置模板：`deploy--loumai/config/admin-frontend.test.example.env`。默认已经使用现有测试服密钥路径，无需新建配置；有需要时复制为同目录 `admin-frontend.test.local.env`，只填 SSH 参数，不填任何密码或私钥内容。目标服务器、域名、目录被固定，不能用它投正式服。

## 5. 回滚

先运行 `status` 记录当前版本。历史版本可在服务器只读查看：

```bash
sudo ls /srv/loumai-admin-frontend/frontend-releases
```

在 Mac 终端把 `RELEASE_ID` 换成要恢复的实际历史版本号：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai
./loumai-deploy admin-frontend rollback --release RELEASE_ID --dry-run
./loumai-deploy admin-frontend rollback --release RELEASE_ID --yes
```

回滚也会核对目标版本、文件哈希和当前指向。后台前端历史版本保留，不自动删除；不会回滚后台 API 或数据库。

## 6. 常见阻塞

- **DNS 未就绪**：先添加上述 A 记录并等待解析生效。
- **证书签发失败**：检查公网 80/443 端口、DNS、CAA 和 Let’s Encrypt 限流；无需关停现有 Nginx。脚本不会自动安装/升级系统软件。
- **`curl: (60) ... certificate subject name ...`**：若本地证书 SAN 已含正确域名，而错误紧随 Nginx reload 出现，可能是新工作进程尚未接管、探测暂时读到旧站点证书。2026-08-28 已修复此竞态：有限等待 HTTPS、健康及认证验收，复用已签发证书，超时则回退。不要通过关闭证书验证来解决。Nginx reload 的工作进程切换机制见 [官方说明](https://nginx.org/en/docs/control.html#reconfiguration)。
- **`During secondary validation ... SERVFAIL looking up CAA`**：证书机构查询 DNS 出错，不是压缩包错误，也不代表一定要添加 CAA。没有 CAA 但返回 `NOERROR` 是正常情况；`DNS_READY=true` 仅说明 A/AAAA 指向正确，不代表证书验证成功。工具现在同时显示 Certbot 的标准输出和错误输出，保留具体域名、原因及配置备份位置。先检查阿里云权威 DNS/CAA/DNSSEC；若重试仍失败，将完整错误提交给 DNS 服务商，不要反复申请正式证书或关闭 HTTPS 校验。详见 [Let’s Encrypt CAA 错误说明](https://letsencrypt.org/docs/caa/#caa-errors)。
- **后台后端健康检查失败**：先检查 `loumai-company-management.service`，这条前端命令不代替后台后端部署。
- **helper 不一致**：执行 `./loumai-deploy admin-frontend prepare --yes`，然后再次发布。它只更新后台前端专属文件。
- **产物不是后台 / API 不匹配 / SourceMap / 隐藏文件**：请同事提供正确的测试构建包，不要跳过校验。
- **同名资源内容冲突**：重新构建产生新内容哈希的资源；不要手工覆盖线上同名资源，否则旧页面可能加载到不兼容代码。
- **服务器验收成功、本机二次验收失败**：工具会明确警告；检查本机代理/DNS，运行 `status` 并访问页面，不要直接认定服务器没有发布。
- **续期检查**（服务器终端）：`sudo systemctl status loumai-admin-frontend-cert-renew.timer --no-pager`；日志用 `sudo journalctl -u loumai-admin-frontend-cert-renew.service -n 50 --no-pager`。

## 7. 验证口径

本次后台发布专项测试 11/11 通过，其中包含 Python 安装与恢复测试 15/15；覆盖 Certbot 详细错误输出、SSH 备份位置保留、真实 Nginx 语法检查、旧证书短暂响应后的恢复、持续证书错误超时回退、后台健康及未登录保护。桌面实际 ZIP 校验也通过。测试不连接业务数据库。

此前部署工具全量测试为 99/100：唯一失败是旧业务 H5 源码的 `import.meta.env` 白名单检查，读取的是现有 `qiye-qianduan`，不是本次后台包。本次错误输出和 reload 时序修复重跑的是后台专项测试，没有修改该前端源码或放宽它的发布门禁；后台 ZIP 使用独立产物测试，不依赖本地业务 H5 源码。

真实部署记录：先后遇到证书机构 CAA 查询失败及 reload 后探测过早，失败配置均已还原；证书签发成功后保留并复用。修复等待逻辑后，用同一份原 ZIP 成功发布，公网首页 200、后台健康 UP、未登录 `admin-auth/me` 401，原业务测试服健康正常。浏览器已实际显示用户名、密码及登录按钮，控制台无 error。未修改数据库、后台账号或业务 H5。静态版本切换后的人工回滚演练及登录后的业务操作尚未执行，不将其表述为已验证。
