# 全场景测试清单

v0.3.3 起，每个版本发布前按这份清单走一遍。目标：用户实测时不再碰到「用不了」的问题。
每一行写清楚由哪个自动测试覆盖；只能手动验证的标「手动」，发布前由 Claude 在安装包上走一遍，走不了的写进发布说明请用户试。

## 一、怎么跑

| 层 | 命令（PowerShell，先 `cd` 到目录） | 用时 | 说明 |
|---|---|---|---|
| 后台 | `cd core; npm test; npx tsc --noEmit` | 约 3 分钟 | 199 个，假模型，不联网 |
| 窗口组件 | `cd app; flutter test test` | 约 20 秒 | 95 个，假后台 |
| 协议层 | `cd packages/pi_rpc; dart test -x integration` | 约 10 秒 | |
| 场景巡检（真窗口） | `cd app; flutter test integration_test/scenarios_test.dart -d windows` | 约 1 分钟 | 假后台、真字体真窗口：阅读、选字、拖放、全部页面和主题 |
| 视觉检查 | `cd app; flutter test integration_test/look_test.dart -d windows` | 约 40 秒 | 截图在 `app/build/look_shots/`，要看一遍 |
| 卡片 | `cd app; flutter test integration_test/cards_test.dart -d windows` | 约 10 秒 | 真 WebView2 |
| 真实模型端到端 | `cd app; flutter test integration_test/e2e_test.dart -d windows` | 约 3–5 分钟 | 走用户配好的 OpenCode Go 渠道；用户的应用要先退出 |
| 沙箱（真 WSL） | `cd core; node --disable-warning=ExperimentalWarning scripts/live-sandbox.ts` | 约 1 分钟（有随附镜像） | 会建一个临时发行版，跑完删除 |

真窗口测试（`-d windows`）一个一个跑，不要同时跑两个（共用一个 exe）；跑的时候不要最小化窗口，也不要改源文件。

## 二、清单

「自动」列：`组件` = `app/test/`，`场景` = `integration_test/scenarios_test.dart`，`e2e` = `integration_test/e2e_test.dart`，`后台` = `core/test/`。

### 1. 工作台对话

| 场景 | 自动 | 备注 |
|---|---|---|
| 发消息、流式回复、停止 | e2e 1–4，组件 chat_scroll_test | |
| 生成中滚轮往上看，不被拉回底部（v0.3.2 实测） | 组件 chat_reading_test，场景 | 一格滚轮就要放开 |
| 生成中拖滚动条后点一下，不跳回底部（v0.3.2 实测） | 组件 chat_reading_test | |
| 「回到底部」按钮出现、点了跟到底 | 组件 chat_reading_test，场景 | |
| 发消息、排队消息、输入框变高时不抖 | 组件 chat_scroll_test | 逐帧检查 |
| 拖选复制：100 / 110 / 125 / 150% 缩放，长对话滚得很远（v0.3.2 实测错位） | 组件 chat_reading_test，场景 | 工作台和蝶君都测 |
| 跨两条消息拖选 | 组件 chat_reading_test | |
| 行内代码被选中时有高亮（v0.3.1 实测 3） | 手动 | 选区先画、文字后画，行内代码不能有底色 |
| 图片在生成时不闪（v0.3.2 实测） | 场景 | 每帧同一个 ImageProvider |
| 问题气泡里不出现 Pi 的「[Image: original …]」 | 场景 | |
| Shift+Enter 换行、Enter 发送 | 场景 | |
| 重新生成、版本切换、分叉、编辑 | e2e 5、9 | |
| 上下文面板、手动压缩 | e2e 6 | |
| 临时对话不保存 | e2e 13 | |
| 极简模式、计划模式 | e2e 21、22 | |
| 图片发给模型 | e2e 19 | |
| 拖文件 / 图片进对话（QQ、微信、浏览器） | 手动 | 系统拖放模拟不了 |
| Ctrl+V 粘贴图片和文件 | 手动 | |

### 2. 蝶君

| 场景 | 自动 | 备注 |
|---|---|---|
| 没有沙箱时只显示建立沙箱 | 组件 work_pages_test | |
| 「交流」「工作」切换，写笺交给蝶君 | 组件 work_pages_test，e2e 16（无沙箱） | |
| 拖进蝶君的文件只到蝶君，工作台的只到工作台（v0.3.2 实测串了） | 组件 work_pages_test，场景 | 隐藏页面的拖放区不接收 |
| 蝶君对话里滚动、选字（同工作台） | 场景 | |
| 真沙箱里跑 Python、出图、outbox、保存到本机 | 手动 + `live-sandbox.ts` | 要用户的模型 |
| 沙箱联网 / 离线切换 | `live-sandbox.ts` | |

### 3. 记忆

| 场景 | 自动 | 备注 |
|---|---|---|
| 「记住…」直接保存，推断的进待确认 | 后台 memory.test，e2e 14 | |
| 换个说法的重复不再加（v0.3.2 实测） | 后台 memory.test | 更完整的说法变成「修改」建议 |
| 不把 Agent 的名字当成用户的（「用户叫蝶君」） | 后台 memory.test（提示词） | 真实模型行为要手动看 |
| 接受修改建议、保留历史 | 后台 memory.test | |
| 临时对话不读不写 | 后台 memory.test | |

### 4. 全局操作

| 场景 | 自动 | 备注 |
|---|---|---|
| Ctrl+滚轮、Ctrl+加减号缩放，Ctrl+0 恢复 | 组件 chat_and_zoom_test，e2e 20 | |
| 截图工具抢走按键后 Ctrl 不再卡住（v0.3.2 实测） | 手动 | 按 Ctrl+Alt+A 或 Win+Shift+S 截图后，回到应用滚轮应该是滚动 |
| 小窗口 + 150% 缩放，左侧导航不溢出 | 场景 | v0.3.3 场景巡检发现并修好 |
| 每个页面、每个设置分类、每个名画主题都能打开 | 场景 | 有任何报错（溢出、异常）测试就失败 |
| 外观弹窗 | 场景 | |

### 5. 任务、定时、技能、仪表盘

| 场景 | 自动 | 备注 |
|---|---|---|
| 收件箱批准、上限卡片 | 组件 work_pages_test | |
| 定时任务新建、批准、立即运行、绑定会话 | 组件 work_pages_test，e2e 17 | |
| 模板 | e2e 15 | |
| 渠道、模型组自动换渠道 | e2e 11、23 | |
| 仪表盘有表头（v0.3.1 实测 10） | 场景（打开） | 表头内容手动看一眼 |

### 6. 数据、备份、安装包

| 场景 | 自动 | 备注 |
|---|---|---|
| 备份导出 / 导入 / 撤销 | 后台 backup.test，组件 backup_panel_test | |
| 备份页一行说明 + 两个按钮，选项折叠（v0.3.1 实测 8） | 组件 backup_panel_test | |
| 第一次启动搬旧数据 | 后台 backup.test | 真实环境要用户试 |
| 安装包在没有开发环境的地方启动、建沙箱、对话 | 手动 | 每个版本发布前打包试一次 |

## 三、手动清单（发布前在安装包上走一遍）

1. 双击 `dist\DreamFlutter\app\dreamflutter.exe`，第一次启动正常。
2. 工作台：发一条会长的消息，生成中滚轮往上看，再点「回到底部」。
3. 缩放到 125%，在一条长回复里拖选第一段，粘贴出来核对。
4. 用截图工具（Ctrl+Alt+A 或 Win+Shift+S）截一张图，回到应用，滚轮应该滚动而不是缩放。
5. 从资源管理器拖一张图到工作台；切到蝶君，输入框里不该有这张图。
6. 选中含行内代码的一段，行内代码也有选中底色。
7. 蝶君：交给它一个用 Python 画图的任务，outbox 里出图，保存到本机。
8. 记忆页：没有意思重复的两条。
