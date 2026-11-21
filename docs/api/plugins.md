# 插件

梦蝶 Windows V1.1.0 插件管理使用已经随程序交付的本地目录。目录同时绑定插件版本、DSH 版本及实际复用的原包版本。安装把选定的包和版本加入梦蝶的数据目录配置，由后台按该包的 `dsh.bundle` 装配清单加载 Cordis 插件。移除时解除注册并删除安装记录。包文件由软件统一更新，仍可在下次安装时使用。接口只接受这个目录中的固定 ID。

| 插件 ID | 交付包 | 上游代码和梦蝶适配 |
| --- | --- | --- |
| `usage-dashboard` | `@dreamflutter/dsh-usage-dashboard@1.0.0`，梦蝶适配 | 装配 [官方 session-stats@0.2.2-rc.5](https://github.com/deepseek-ai/deepseek-harness/tree/9c2670d3bce5275e0d1610272958121af87787bb/packages/session/session-stats) 原包（MIT），读取它注册的当前会话统计。近七天汇总复用梦蝶逐请求账本。窗口用 Flutter 显示本地数据。 |
| `window-shortcuts` | `@dreamflutter/dsh-window-shortcuts@1.0.0`，梦蝶适配 | 调用 [官方 dsh-client-shortcuts@0.2.2-rc.5 的 `./protocol`](https://github.com/deepseek-ai/deepseek-harness/blob/9c2670d3bce5275e0d1610272958121af87787bb/packages/client/shortcuts/src/protocol.ts)（MIT）校验和归一化物理键。Flutter 根据该绑定调用已有花费页面。 |
| `memory` | `dfMemory`，梦蝶内置 | 启停在后端重启后生效。使用原数据库并保留已有数据。 |

两个可安装包已用 DSH 0.2.2-rc.5 和 Cordis 4.1.0 在 Windows 后端经认证 WebSocket 验证。会话使用本机合成模型。用量报表的跨渠道汇总来自梦蝶账本。社区插件 [@feiyang666/dsh-usage-plugin](https://www.npmjs.com/package/@feiyang666/dsh-usage-plugin) 的账本和网页面板，以及 [dsh-usage-dashboard](https://github.com/nzz0991999-ai/dsh-usage-dashboard) 的 DeepSeek 平台金额和网页面板，对应各自的宿主和数据源。

## plugins.list

<!-- api:method -->

无需参数。返回 `{plugins: Plugin[]}`。

| 字段 | 含义 |
| --- | --- |
| `id`, `title`, `description` | 固定标识、名称和说明 |
| `kind` | `catalog` 为随包实测目录，`system` 为内置 |
| `packageName`, `source`, `version`, `dshVersion` | 包名、来源、目录中可安装的版本、实际运行的 DSH 版本 |
| `installed`, `installedVersion?` | 是否已有安装记录及目录插件实际安装版本 |
| `enabled`, `active` | 保存的启用状态、当前进程是否已加载 |
| `restartRequired` | 内置记忆保存的启停状态与当前进程不一致时为 `true` |

## plugins.install

<!-- api:method -->

参数 `{id}`。安装当前目录版本，新安装立即启用。已经安装同一版本时保留启停偏好。返回与列表相同的快照。

## plugins.remove

<!-- api:method -->

参数 `{id}`。当前进程卸载目录插件并删除安装记录，重复移除返回当前列表。返回与列表相同的快照。

## plugins.enable

<!-- api:method -->

参数 `{id}`。启用已安装的目录插件，立即加载。内置记忆下次重启时加载。返回与列表相同的快照。

## plugins.disable

<!-- api:method -->

参数 `{id}`。停用已安装的目录插件，立即解除其贡献，保留安装记录。内置记忆下次重启时停止加载，保留数据库。返回与列表相同的快照。

变更串行处理。目录中的未知 ID 和未安装时尝试启停返回 `not_found`，移除或安装内置记忆返回 `forbidden`。启用已安装但与当前目录不一致的版本返回 `conflict`，安装目录中的当前版本后可启用。加载或状态保存失败返回 `unavailable`。

## plugins.usage

<!-- api:method -->

返回 `{since, until, timeZone, days, session?}`。时间范围为后台本地时区从六天前零点至明天零点，起点包含、终点排除，时间戳为毫秒。按日期升序返回七条 `{date, requests, input, output, cacheRead, cacheWrite, missingUsage, amounts}`，其中 `date` 格式为 `YYYY-MM-DD`，`amounts` 按账本货币代码分开，空白日期显示零用量。

可选传 `{slotId}`。如果指定的槽里存在已打开并落盘的 DSH 会话，响应包含上游全会话统计 `session`，带有 `turns`、`steps`、`llmMs`、`toolMs`、`ttftMs`、`ttftSteps`、`decodeMs`、`decodeTokens`。未加载仪表盘时返回 `unavailable`。

## plugins.shortcuts

<!-- api:method -->

无需参数。已加载时返回 `{bindings:[{command:"spending.open", key:"KeyU", control:true, shift:true}]}`。停用和移除后返回 `{bindings:[]}`。

## plugins.changed

<!-- api:event -->

推送 `{event:"plugins.changed", id}`。保存的状态或本次加载状态实际变化时发送一次。窗口收到后重新读取插件和快捷键，重连后重新查询。
