# 测试服四目标一键发布

更新日期：2026-09-21

## 日常只记住这一条

本机两个前端 ZIP 配置完成后，在 Mac 终端执行：

```bash
/Users/qinyang/Desktop/zuling/deploy--loumai/loumai-deploy test deploy --yes
```

这条命令只发布四个目标：

1. 主项目后端 `loumai-ai/test`；
2. 管理后台后端 `conpanyManagement/test`；
3. 业务 H5 测试 ZIP；
4. 管理后台前端测试 ZIP。

**不构建、不上传、不发布微信小程序。** 小程序继续由前端同事在微信工具中发布；这里的业务前端只是秦洋用浏览器查看的 H5 版本。

## 首次配置两个 ZIP

复制示例配置：

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai
cp config/test.example.env config/test.local.env
```

只修改两个本机绝对路径：

```dotenv
TEST_H5_PACKAGE=/Users/qinyang/Desktop/h5-test.zip
TEST_ADMIN_PACKAGE=/Users/qinyang/Desktop/admin-test.zip
```

`config/test.local.env` 已被 Git 忽略，只能保存 ZIP 路径，不能保存密码、Token、数据库 URL 或私钥内容。收到新包时，修改这两行即可。

也可以临时在命令中指定，不改配置文件：

```bash
/Users/qinyang/Desktop/zuling/deploy--loumai/loumai-deploy test deploy \
  --h5-file /Users/qinyang/Desktop/h5-test.zip \
  --admin-file /Users/qinyang/Desktop/admin-test.zip \
  --yes
```

## 预检和状态

只预检，不上传、不迁移、不重启、不切换版本：

```bash
/Users/qinyang/Desktop/zuling/deploy--loumai/loumai-deploy test deploy --dry-run
```

只查四个目标当前状态：

```bash
/Users/qinyang/Desktop/zuling/deploy--loumai/loumai-deploy test status
```

## 执行顺序

总入口先把四个目标全部预检一遍。全部通过后才按以下顺序真实发布：

```text
主项目后端
  → 管理后台后端
  → 业务 H5
  → 管理后台前端
  → 四目标状态验收
```

两个后端优先连续发布，是因为它们共享同一套 PostgreSQL schema，可以缩短数据库迁移后旧管理后台代码不兼容的时间窗口。

任一步失败都立即停止后续步骤。已成功组件不会被盲目回滚，数据库不会自动 downgrade 或恢复备份。

## 四个目标之外的内容

- 微信小程序：不在总入口中，由前端同事发布。
- 官网 `yinlizhangyu.com`：不在测试服四目标中，使用独立 `website` 命令。
- 单组件回滚：必须选择对应组件和确切 release，总入口不提供“全部猜测回滚”。

安装、回滚、单组件排错和数据库保护详细见[部署工具总览](../README.md)。
