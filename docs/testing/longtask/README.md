# 长任务验收测试集

在 `core/` 运行，使用仓库要求的 Node 版本。

```powershell
node scripts/longtask/run.ts --dry-run
node scripts/longtask/run.ts --dry-run --cases L2,L3
node --test test/longtask-*.test.ts
```

空跑会为每项生成固定种子的合成素材，在隔离目录创建目标，再用合成产物和工具回执检查验收器。目标保持暂停，脚本核对 run 和请求账本都是零条，然后关闭后台服务并清理隔离目录。报告写入本目录，日期按台北时间。指定子集会在文件名中记录任务编号。

每份报告包含目标状态、停止原因、轮数、实际花费和耗时，以及各项验收的结果。L6 的预期结果是目标保留缺失项。L5、L7 的空跑用构造的时间线验证验收器，真实作业与重启要由 B 段采集证据。L3 的文件复用检查依据同一会话的 Python 调用记录。

## 确定性测试覆盖

| 设计第十七节 | 测试文件 | 对应用例 |
| --- | --- | --- |
| 多轮目标 | `goals-t99.test.ts` | `advances three times in the same session` |
| 插话优先 | `goals-t98.test.ts`、`longtask-goals.test.ts` | `drops the old intent and waits while user input remains unhandled`、`gives pending user input priority over a queued continuation` |
| 暂停期间旧审查返回 | `goals-t99.test.ts` | `discards a review returned after pause` |
| 部分产物缺失 | `goals-t99.test.ts` | `lists missing files and rejects a claimed test without a tool receipt` |
| 等待子任务 | `longtask-goals.test.ts` | `does not repeatedly review while a child is still running`、`keeps an idle goal in waiting_dependency until its tracked child ends` |
| 常驻服务 | `longtask-goals.test.ts` | `lists a live service without adding a blocking dependency` |
| 重复计划停滞 | `goals-t99.test.ts` | `asks for a different route once before stopping repeated plans` |
| 并发预算 | `goals-t98.test.ts` | `sees concurrent reservations, settles against the unchanged request ledger and preserves usage across restart` |
| 意图写入后崩溃及导入 | `goals-t98.test.ts`、`longtask-goals.test.ts` | `pauses an unclaimed intention on restart`、`imports an active goal as paused`、`keeps a cancelled goal cancelled in a staged backup import` |
| 压缩与约束纠正 | `longtask-goals.test.ts` | `uses the corrected goal constraints after a saved checkpoint` |
| 普通聊天 | `longtask-goals.test.ts` | `keeps ordinary workbench chat out of goals, events and goal-linked tasks` |
| 重复完成事件 | `longtask-goals.test.ts` | `does not create another run, review or notification for a replayed completion` |
| 修订后旧审查返回 | `goals-t99.test.ts` | `discards a review returned after revision` |
| 紧急停止 | `goals-t98.test.ts`、`goals-t99.test.ts` | `emergency drops pending intents and requires clear and explicit resume`、`emergency stops both live goals` |
| 重启后作业丢失 | `longtask-goals.test.ts` | `pauses a waiting goal with a reason after restart loses its job` |

## B 段试跑

经授权后，从 `core/` 指定已配置 OpenCode Go 的数据目录。

```powershell
node scripts/longtask/run.ts --live --source-data "<现有测试版数据目录>"
```

脚本只读来源数据库，通过 `copy-channels.ts` 复制加密渠道凭据到隔离目录。蝶君用独立临时 WSL，脚本采集真实 run、请求账本、会话工具回执和状态转移。L5 在作业开始后插话，L7 在阶段一交付后暂停并重启。报告每项结束后写入。

一轮上限 $3，单目标上限 $0.50。真实请求前按目录价格、输入上界和最多 4096 输出 token 预留，缺最终用量的请求保留预留额。报告分列预算计入和供应商实际返回的金额。[首次真实试跑](2026-11-11-deepseek-v4.1-flash.md)。
