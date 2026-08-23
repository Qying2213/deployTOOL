# 工位有方官网自动发布说明

## 1. 这套脚本解决什么问题

官网和测试服共用 `132.232.220.115`，但必须完全隔离：

- 测试服：`test.yinlizhangyu.com`，继续使用 `/srv/loumai-h5`。
- 官网：`yinlizhangyu.com`、`www.yinlizhangyu.com`，使用 `/srv/workway-site`。
- 官网发布不会停止 `loumai-api`、不会修改 8000/5000 端口，也不会改测试服 Nginx 配置。

脚本会执行：Git 状态门禁、全新 `npm ci`、官网构建、真实 `loumai-ui` 检查、正式域名和备案号归一化、局域网/隐藏文件/敏感文件扫描、SHA256 验签、SSH 上传、Nginx 检查、原子版本切换、失败自动恢复和测试站保护。

客户线索接口通过 `SITE_LEAD_ENDPOINT` 配置。尚未提供真实 HTTPS 接口时可以留空，但表单会明确显示提交失败，不再把数据只留在访客浏览器后仍显示成功。接口就绪后填写完整生产 URL，再重新发布即可。

## 2. 首次上线与日常发布的区别

`prepare` 和 `enable-https` 是新服务器首次接管官网时的一次性操作：先预部署 HTTP 站点，再由负责人切换 DNS，最后签发证书。

已经上线后的日常 `deploy` 只要求服务器存在受控当前版本且 `HTTPS=enabled`，不会重新检查本机 DNS、不会修改 DNS，也不会重复运行 Certbot。这样可以避免本机代理 DNS 返回合成地址时误拦正常内容更新。

## 3. 本地配置

配置文件已经放在 `config/website.production.local.env`，它被 Git 忽略，不包含服务器密码或私钥内容。新电脑可按下面创建：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai
cp config/website.production.example.env config/website.production.local.env
chmod 600 config/website.production.local.env
```

SSH 私钥应先加入系统钥匙串：

```bash
ssh-add --apple-use-keychain /Users/qinyang/.ssh/loumai_test_hexhub
```

## 4. 发布前门禁

`guanwang` 必须满足：

1. 根目录同时存在 `loumai-landlord` 和 `loumai-ui`。
2. 当前分支为 `main`。
3. 工作区没有未提交文件。
4. 本地 HEAD 与 `origin/main` 完全一致。

先检查：

```bash
cd /Users/qinyang/Desktop/zuling/guanwang
git status
git push origin main
```

当前真实 UI 接入修改若仍显示为未提交，必须先审查、提交并推送，发布器不会绕过这个保护。

## 5. 首次上线

### 第一步：预部署到 132 服务器

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai
./loumai-deploy website prepare --yes
```

这一步会安装官网专用服务器 helper、构建上传静态文件、建立独立 HTTP 虚拟主机，并在服务器本机使用 `Host: yinlizhangyu.com` 验收。它不会修改 DNS。

### 第二步：修改阿里云 DNS

在阿里云 DNS 将这两条 A 记录都改成：

```text
@      A      132.232.220.115
www    A      132.232.220.115
```

不要修改 `test` 记录。等待公共 DNS 查询确认根域和 www 都只返回 `132.232.220.115`，并且没有旧的 AAAA（IPv6）记录。

### 第三步：签发并启用 HTTPS

```bash
./loumai-deploy website enable-https --yes
```

脚本会再次检查 DNS，只有根域和 www 的 A 记录都唯一指向 132、且没有 AAAA 记录时才会申请证书。成功后还会安装 Certbot 续期后的 Nginx 自动重载钩子，并确认自动续期 timer 已启用。随后验证：

```bash
curl -I https://yinlizhangyu.com/
curl -I https://test.yinlizhangyu.com/
```

## 6. 日常一键发布

首次上线完成后：

```bash
./loumai-deploy website deploy --yes
```

只做本地构建预演、不上传：

```bash
./loumai-deploy website deploy --dry-run
```

查看线上版本：

```bash
./loumai-deploy website status
```

## 7. 回滚

先用 `status` 或服务器发布目录确认版本号，再执行：

```bash
./loumai-deploy website rollback --release 20260811T120000Z-abcdef1234 --yes
```

仅预演，不切换（会真实检查目标版本存在且全部 SHA256 有效）：

```bash
./loumai-deploy website rollback --release 20260811T120000Z-abcdef1234 --dry-run
```

回滚只切换官网静态版本，不涉及数据库。验收失败时服务器会按 current 指向自动恢复原版本。

## 8. 安全边界

- 不得把官网远端目录配置为 `/srv/loumai-h5`。
- 不得把官网域名配置成 `test.yinlizhangyu.com`。
- 不得使用 `--skip-tests` 做正式预部署或发布。
- `--dry-run` 不上传、不安装 helper、不切换版本、不申请证书。
- 日常 `deploy` 不执行 DNS 切换或证书申请；证书操作只由显式 `enable-https` 触发。
- DNS 修改不由脚本自动执行，避免误覆盖当前根域站点。
- 缺失真实 UI、包含旧 `site-embed`、局域网地址、隐藏文件、密钥/数据库备份、旧 SEO 域名或备案占位符时都会拒绝发布。
