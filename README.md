# 楼脉独立部署工具

这个目录集中管理楼脉测试服的前端 H5 和后端 API 发布。源码仓库仍然独立：

- 前端：`../qiye-qianduan`
- 后端：`../loumai-ai`
- 部署工具：当前 `deploy--loumai`

部署工具不会读取源码仓库里的旧构建产物。正式发布只接受工作区干净、已经推送到 upstream 的确定 Git commit。

当前测试服状态：前端服务器 helper 已安装，下面的前端 `status` 和 dry-run 可直接使用；后端本地配置已经准备好，但服务器端 root 固定运行时、bootstrap 版本和 helper 仍需按 `docs/backend-auto-release.md` 做一次性安装。当前 `loumai-ai` 还有未提交业务改动，因此后端发布器会主动拒绝发布，这是预期保护。

## 目录

```text
deploy--loumai/
├── loumai-deploy                 # 统一命令入口
├── frontend/                     # H5 本地发布器与服务器 helper
├── backend/                      # API 本地发布器、依赖锁与服务器 helper
├── config/                       # 本地配置模板；*.local.env 不进 Git
├── docs/                         # 前后端详细安装与发布说明
├── tests/                        # 部署工具安全测试
└── dist/                         # 构建包和日志；不进 Git
```

## 首次使用

```bash
cd /Users/qinyang/Desktop/zuling/deploy--loumai

# 新机器首次配置时才复制；当前这台 Mac 已经配置完成。
cp config/frontend.test.example.env config/frontend.test.local.env
cp config/backend.test.example.env config/backend.test.local.env
chmod 600 config/*.local.env

ssh-add --apple-use-keychain /Users/qinyang/.ssh/loumai_test_hexhub
npm test
```

本机已经配置过的 `*.local.env` 只保存仓库路径、服务器地址和 SSH 私钥路径，不保存密码、Token 或私钥内容。

## 前端发布

先做只读预演：

```bash
npm run frontend:deploy:test -- --dry-run
```

正式构建、上传并原子切换：

```bash
npm run frontend:deploy:test -- --yes
```

查看与回滚：

```bash
npm run frontend:status
npm run frontend:rollback -- --release RELEASE_ID --yes
```

前端正式发布会执行独立部署测试、前端全量测试、HBuilderX 全新构建、目标 API 与敏感路径检查、双重哈希校验、服务器原子软链切换和公网资源验收。

## 后端发布

后端工作区必须先提交并推送，且 Alembic 只有一个 head。只读预演：

```bash
npm run backend:deploy:test -- --dry-run
```

正式发布：

```bash
npm run backend:deploy:test -- --yes
```

查看状态：

```bash
npm run backend:status
```

只回滚应用代码时，必须人工确认旧代码兼容当前数据库结构：

```bash
npm run backend:rollback -- \
  --release RELEASE_ID \
  --yes \
  --ack-db-schema-compatible
```

后端正式发布会在切换前执行代码门禁、精确 commit 打包、哈希验签、固定依赖安装、停止配置中的写入服务、PostgreSQL 备份、Alembic 迁移与 schema 校验，然后原子切换并做本机和公网健康检查。

## 数据库安全边界

- 自动发布绝不执行 `alembic downgrade`。
- 应用代码回滚不会回滚数据库。
- 发布前备份和发布故障现场都要保留。
- 如果迁移后新版无法启动，脚本会停止并明确要求人工处置，不会假装数据库已经安全恢复。
- 恢复数据库备份可能丢失发布后的数据，只能由负责人在维护窗口显式执行。

## 统一入口

不使用 npm 时也可以：

```bash
./loumai-deploy frontend status
./loumai-deploy frontend deploy --env test --dry-run
./loumai-deploy backend status
./loumai-deploy backend deploy --dry-run
```

更详细的服务器 helper 安装、sudoers 权限和故障处理见：

- `docs/frontend-h5-auto-release.md`
- `docs/backend-auto-release.md`
