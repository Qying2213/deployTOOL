# P1-NOTIF-07-R2 通知积压保护：部署与只读验收

日期：2026-09-11。状态：134 passed、0 failed、1 原有 skipped；工具已合入 master，两环境 helper 已安装，主后端测试/正式发布及通知专项验收均通过。没有执行人工历史队列清理。

分支 `fix/P1-NOTIF-07-R2-notification-backlog-guard`，部署工具基线 `master@05fa210`；后端配套分支同名，基线 `master@057f553`。

## 1. 操作边界

本功能不改变现有 OnCalendar / Persistent、API health/ready、数据库 writer 身份验证或部署恢复标记。通知健康使用独立字段，不能把一条失败短信升级成全站停写。

新 helper 仍使用 v6 主协议，支持 activate 可选计划参数和 `notification-status`。指纹发生变化，必须遵循现有 helper 审核/同步流程，生产不能仅因版本号相同而跳过内容核验。旧后端返回 UNSUPPORTED，允许 helper 兼容预检；不得谎称旧版本已具备保护。

## 2. 只读通知状态

```bash
./loumai-deploy backend notification-status --env test
./loumai-deploy backend notification-status --env production
```

命令只读，不调用 dispatcher、发送器或服务重启；普通 `backend status` 也展示独立通知字段，但其原 DEPLOYMENT_STATE 含义和核心状态检查不变。

| 输出 | 含义 |
| --- | --- |
| NOTIFICATION_GUARD | 当前策略版本；旧后端 UNSUPPORTED，探测异常 UNKNOWN |
| NOTIFICATION_HEALTH | WAITING / RUNNING / STARTING / DEGRADED / UNKNOWN / UNSUPPORTED |
| RELEASE_ACCEPTANCE | 通知专项 PASSED / PENDING / FAILED；不覆盖核心发布状态 |
| NOTIFICATION_REPORT | 只读队列计数、完成标识、原因与开关状态；不含手机号、消息正文、令牌 |

验收读取当前不可变版本的 journald 完成信息，近 3 分钟内至少两次不同 systemd invocation 的成功完成，并确认下一次计划。短时间 RUNNING 不是停摆；一直触发而无完成记录，不能靠 LastTrigger 推进无限延长 STARTING。启动宽限按 backend-current 链接最近切换时间计算。查询有 SQL 超时，读取 systemd/journal 有单次超时，信息缺失不能当健康。

现场兼容：运行耗时与上次触发的单调时间通过 `busctl get-property` 读取 systemd D-Bus 的 uint64 微秒值；不把 `systemctl show` 的 `1month 1d ...` 文本当整数。已在测试服、正式服只读核对，并增加模拟真实输出的回归用例。

显式 `notification-status` 返回 0 表示专项通过，2 表示未通过/待完成；连接、权限或 helper 调用失败仍为非零。外部监控应同时检查退出码与结果，不能只匹配进程是否存活。

## 3. 发布前的清理计划

目标后端包含保护代码时，发布会在已校验产物安装后、开始停写前输出 `NOTIFICATION_EXPIRY_PREVIEW`。预览只读。已经有受控保护版本时使用当前版本脚本读取迁移前结构，避免候选 ORM 新字段阻塞后续迁移；首次安装本次无结构变更的保护功能才使用候选产物。若存在待清理记录却未提供计划，发布终止于停写前，当前服务照常运行。

预览显示未覆盖旧通知、非法时间或扫描超过 10,000 条时，需按其业务含义单独核对，不能自动批量标 SKIPPED。不存在“一键清空所有通知”的选项。

现场复核已确认共享 dispatcher 不消费小程序订阅渠道。该渠道历史数量单独输出在 `other_channel_old.MINI_PROGRAM_SUBSCRIBE`，只读提示、不占扫描额度，也不阻断本 dispatcher 的验收；原任务不发送、不清理。其他外部渠道的未覆盖积压仍使用上述阻断规则。

由负责人核对环境、数据库摘要、cutoff、策略和数量后，保存以下五个字段的 JSON，真实值必须来自预览：

```json
{
  "environment": "test",
  "target": "替换为预览中的64位数据库身份摘要",
  "cutoff": "替换为已核对的带时区UTC截止时间",
  "policy_version": "P1-NOTIF-07-R2-v1",
  "max_records": 10
}
```

此示例故意使用无法通过校验的占位符，不能直接执行；计划不含数据库密码。`max_records` 必须是已批准的处理上限，不能为了绕过门禁随意扩大。

在单独取得发布与数据清理授权之后，使用正式发布命令并附计划：

```bash
./loumai-deploy backend deploy --env test --notification-expiry-plan /absolute/path/approved-plan.json --yes
```

测试服若按既有流程发布 cloud profile，使用同样参数的 `deploy-cloud`；生产使用 `deploy --env production`。仍遵守独立功能分支先 test 验收再 master，不合并整个 test 到 master。

执行顺序：核验产物及目标 → 只读预览并校验计划 → 既有受控停写 → 数据库备份（无 schema 迁移也执行）→ 按固定 cutoff 收口 → 复查 remaining_expired → 核心激活和健康/writer 检查 → 恢复原 timer → 解除原恢复 trap → 被动通知专项验收。

清理只修改精确白名单中 PENDING 的过期投递，并写逐条及批次审计；通知主表和业务状态不改。备份引用采用 release_id，关联本次生成的备份及校验文件。裸维护脚本只验证引用格式，不生成或验证实际备份，生产优先使用此受控发布路径。

扫描不完整、目标不符、数量超上限、锁定或时间预算导致仍有剩余，均不能报告清理完成。清理重复执行不恢复终态；cutoff 不随循环时间自动推进。

首次发布前没有已上线的安全回退版本。若已经开始清理后核心激活失败，不能自动恢复无时效保护的旧消费者；保留既有受控恢复标记，使用包含保护代码的前向修复版本。部署脚本不执行自动数据库恢复。这一事故恢复边界必须在测试服演练；不是运行中通知 DEGRADED 的处理动作。

## 4. 激活与通知验收分开

核心激活成功后，CLI 最多被动采样 19 次，间隔 10 秒；每次远端探测耗时另计。不额外启动任何一次 dispatcher，不制造测试事件。

通知专项失败或观察期内证据不足时，CLI 返回 2，并明确“核心版本已激活、服务保持运行、通知专项待处理”。不会自动执行 rollback、停止 API、停止其他 timer，也不会重新发起已完成的发布。应先运行只读 status 定位，不要把退出码 2 当作新版本尚未运行而反复 deploy。

读取 journal 只允许明确白名单的运行元数据进入普通输出。主进程退出码 0 不能掩盖子任务数据库错误、发送失败、非法时间或业务短信 UNKNOWN。正常业务恢复后可以依其既有规则发送新通知；维护步骤本身永不发送。

## 5. 回退与监控

当前版本具备防护后，回退或发布到缺少防护的版本在停服务前被拒绝。应准备保留防护且数据库兼容的前向修复版本。历史 SKIPPED 和审计不还原成 PENDING。

只读命令可由已有外部监控采样，但当前尚未指定告警平台或收件配置。需外部独立配置周期采样、连续异常阈值、同一故障去重及恢复通知，并演练整机不可达。不得把此命令已存在写成自动告警已经接通，不用受监控的业务短信队列给自身报警。

禁止用 `TENCENT_IM_PUSH_ENABLED=false` 暂停真实队列：当前实现会走 mock 成功并可能将消息写成 SENT。普通短信问题也不应停共享 dispatcher，因为它还处理预约等业务。

## 6. 验证与尚未验收事项

本地 `npm test` 包含计划校验、旧版本兼容、防护降级拒绝、预览拒绝边界、剩余锁定任务、备份/清理/启动顺序及健康验收与恢复 trap 隔离。主后端测试使用隔离 PostgreSQL 和假发送器。

已完成两环境 helper 安装、timer/journal 现场核对、真实队列只读预览、正式备份校验和真实发布后的两周期被动验收。当前真实队列很小，不能据此声称大规模积压压力已实测；首次失败前向修复经过模拟合同测试，未对共享服务器注入故障；独立告警尚未接入。


## 7. 本次发布证据

- 工具功能提交 `23efbf6`，master 集成 `ee94440`；helper SHA256 `73afead4fafc7845794995ef79938fa706f65233499571058ec6129f69f43993`，两环境一致。
- 测试服 release `20260911T035044Z-482264e4db`；正式服 release `20260911T035511Z-840067bdcb`。核心 HEALTHY、writer verified、通知专项 PASSED。
- 两环境安装 helper 时只切换 helper 文件，保留原文件备份；真实业务切换通过既有 backend deploy 流程完成。正式业务 env 哈希未变。
- 无受保护积压，未传 notification-expiry-plan，未做人工清理或测试发送。正式库另行使用既有备份函数、独立备份身份完成备份及校验。
- [完整发布验收](../../managedocx/01-一键发布/P1-NOTIF-07-R2通知积压保护测试与正式发布验收_20260911.md)。
