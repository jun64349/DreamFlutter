# 已定型的操作逻辑和体验（v0.8.3）

2026-11-11 用户实测 v0.8.3 后定：**现在的操作逻辑和体验已经不错，以后的任务不要动这些。**

## 规矩

- 2026-11-16 用户本轮明确追加：整套 UI 中文楷体、英文艺术衬线，过程/英文引文斜体；中英引文各 24 条按新对话随机，同一会话稳定。现有十二主题称名作主题集，常用图标与按压反馈特化；点击、保存、焦点、快捷键、输入安全矩形不变。下一主题集只做调研和可交互样稿。用户看过效果后已授权 0.12 本地提交和重新打包，不推送、不切分支。
- 下面每一条的操作方式和观感保持现状。新功能装进现有的位置，不改这些地方的交互、布局和用词。
- 只有用户明确要求改某一条时才能动。动之前先在对应的任务卡里写明“用户要求改第几条”，改完同步更新本文。
- 守着它们的测试必须一直通过。不能为了让测试通过而改测试的期望；期望要改，只能是因为用户改了要求。
- 派给 Codex 的任务（后端、测试）同样适用：后端改动不能让这些表现变样，比如列表顺序、模型组怎么切换、蝶君直接对话。
- 交付前照旧要在 1600 宽和小窗口、日夜两套下截图看一遍，确认这些没被改坏。
- **用户 2026-11-14 要求整体 UI 重做**（原话：「这些照原样不改的都要改，然后整体的 UI 设计都需要重做，对标 hanako 的来」）：所有页面的视觉和布局照 HanaAgent 的观感重做，原型在 [prototype/v1-redesign.html](prototype/v1-redesign.html)。Claude 的理解是：**下表里的操作逻辑不变**（第 1、3、9、10、12–14 条的行为，第 2 条「蝶君就是对话、侧栏列对话、对话上方没有任务头」，第 6 条工作区选择在侧栏，第 8 条回复下面那一行的内容和不显示花费，第 11 条模型按钮写完整的「模型 · 渠道」）；**观感和布局可以换**（第 4、5、7、15、16 条的样子）。新原型定稿后，守护测试里的截图要跟着重拍，行为断言不改。
- **用户已批准的改动**：v0.9 在蝶君侧栏「等你处理」下面加一行「日程」（用户 2026-11-11，见 [schedule-and-patrol.md](schedule-and-patrol.md)）。第 2 条的其他表现不变。

## 清单

2026-11-16 后续字体与主题反馈（D-28 至 D-30）：第 15 条仍居中，但引文按画作文化来源分中文《逍遥游》和国外英文斜体＋中文翻译＋出处，取代上一阶段通用书法引文。正式对话用内置楷体，整个执行过程及巡检说明斜体，原折叠、选字、复制、工具执行行为不变；仅更新用户明确改动的字形断言。上下文环增加真实比例平滑高亮，未知值不转圈，仍点击打开原上下文区。第 6 条工作区位置与模式/对话切换不动，只统一主题选中表面。

2026-11-16 用户试用 test.6 后明确补充：第 7 条文件预览/右键和第 11 条模型选择行为不变，工作台右栏改为四个默认展开、可独立收起的纵向区块；首页移除蝴蝶外圈、放大原标志并轻呼吸，输入区加宽加高，第 15 条标题/名言/出处继续居中且统一书法字体。已处理的命令/写入审批默认折叠为一条历史入口，待审批仍保留原操作和传参。对应守护在 `chat_panel_test`、`composer_layout_test`、`t92_motion_test`、`extension_dialog_test` 和 E2E 4.4/4.5。

| # | 定型的操作和体验 | 用户原话 / 来源 | 守着它的测试 | 主要代码 |
|---|---|---|---|---|
| 1 | **蝶君就是对话**：发什么都直接给蝶君，它在回复里说明打算并开工；打招呼就正常回话；只有它真缺信息用提问时，才进「等你处理」 | 0.8.1 实测：“对话啊这等你处理是任务模块” | t87_butterfly_test「messages go straight to 蝶君」；work_pages_test「butterfly talks in the shared composer」；e2e 4.7、4.8 | `state/butterfly_tasks.dart` submit；`core/src/agent/host-text.ts` |
| 2 | **蝶君侧栏列对话**，和工作台一样；在任何页面点历史或「新对话」都会回到蝶君；对话上方没有任务头，没有「进行中 / 已完成 / 没做成」标签；右栏是「这个对话」（交付文件、定时） | 0.8.3-test.2 实测：“没做成做成啥的你放等我处理的版块里不就行了” | work_pages_test「butterfly side lists conversations that open from any page」；t87_pages_look_test 截图 | `ui/sidebar.dart`、`ui/butterfly_page.dart`、`ui/butterfly_tasks_view.dart` |
| 3 | **对话列表按最后一条消息的时间排**，打开不算；置顶在最前 | 0.8.1 实测：选中历史对话会跳到第一个 | agent_controller_test「opening a conversation does not move it in the list」；core session-index.test「orders sessions by their last message」 | `core/src/modules/session-index.ts`、`state/session_runtime.dart` |
| 4 | **设置页**：内容限宽居中，分卡片，行间细线，卡片标题前有小蝴蝶；难懂的设置放进「高级」或「开发者选项」；「归档/回收」在设置里 | 0.8.1 实测：设置左右拉开、门槛高 | v082_look_test 截图；gateway_pages_test、sandbox_panel_test（导航键） | `ui/settings_layout.dart`、`ui/settings_workspace.dart` |
| 5 | **渠道编辑页**：分卡片，底部固定「测试连接」「保存」；所有选项都存；有改动没保存就离开时会问；失败说人话 | 0.8.1 实测：没有测试保存按键、改不了已选项 | t94_settled_test（渠道选项、返回确认、测试连接）；v082_look_test 截图 | `ui/gateway_pages.dart` ChannelEditorPage |
| 6 | **工作区选择在侧栏**（工作台 / 蝶君下面一行） | 0.8.1 实测 | window_frame_test；e2e 4.3 | `ui/sidebar.dart` SidebarWorkspaceButton |
| 7 | **右栏「文件」**：改的和新建的合成一块，按类型配图标；点开在右栏里预览（对话会让开）；右键能用默认程序打开、打开所在文件夹、另存为、复制路径 | 0.8.1 实测 | t94_settled_test（文件分组、预览、右键菜单）；t86_chat_look_test 截图 | `ui/run_summary.dart`、`ui/artifact_widgets.dart` |
| 8 | **回复下面那一行**：模型 · 输出速度 · 用时 · 几点，不显示花费；用模型组时写实际用的「渠道 · 模型」 | 0.8.1 实测：“回复下面显示速度和时间，不要花费” | message_view_test；model_groups_test | `ui/message_widgets.dart` replyFactsShort |
| 9 | **ChatGPT 登录**：点了直接打开浏览器，登录完自动回来显示「已登录」；手动粘贴地址折叠成「登录完没有自动回来？」 | 0.8.2 实测：“不应该是直接弹出登录界面吗” | pi_oauth_policy_test；core pi-oauth-policy.test（设备 ID） | `ui/pi_compatibility_panel.dart`、`core/src/gateway/pi-migration.ts` |
| 10 | **模型组**：用户自己建，数量不限，名字叫「模型组」（不叫号池）；先换 Key 再换渠道；订阅优先；一个对话粘在一个成员上，前面的恢复后新对话从第一个开始；带图只给能看图的；换的时候对话里出一行 | 2026-11-11 用户定（[model-groups.md](model-groups.md) 第八节） | core gateway.test（模型组、额度、带图、恢复）；model_groups_test；e2e 4.13 | `core/src/gateway/`、`ui/model_group_pages.dart` |
| 11 | **模型列表**：模型组在最上面，下面按渠道分段，只列常用模型，最后一项「更多模型…」；**输入框的模型按钮写完整的「模型 · 渠道」**，有空位时不截断 | 0.8.3 实测：“名称显示要完整，不然选错了” | model_groups_test（含“不截断”）；composer_layout_test | `state/agent_controller.dart` modelSections；`ui/composer.dart` |
| 12 | **等回复时的蝴蝶**：没出字前是大蝴蝶和诗意短句；出字后收成回复开头左边的小蝴蝶，写的时候呼吸，写完留着当头像；正文不跳 | 0.8.3 实测：“不应该变小放到左侧，保持呼吸”，“留一只在开头，像和朋友聊天” | t86_chat_test「the big butterfly folds away at the first words」 | `ui/message_widgets.dart` _ReplyView、_ReplyMark |
| 13 | **快速长输出跟得上**：回复按段落画，写完的段落不重画；最后一行始终排好，滚动条不乱跳 | 0.8.3 实测：400 token/秒写一万字界面跟不上、滑块乱跳 | markdown_view_test（分段、只重画最后一段）；chat_scroll_test「keeps the list height steady」 | `ui/markdown_view.dart`、`ui/chat_view.dart` |
| 14 | **长输入折叠**：你发的消息超过 10 行，默认折叠，点「展开全文」展开、「收起」收回 | 0.8.3 实测 | t86_chat_test「a long message you sent is folded」 | `ui/message_widgets.dart` _FoldingText |
| 15 | **首页**：标题和引文居中对齐，引文出处在下一行 | 0.8.1 实测 | t94_settled_test（问候和引文对齐）；v082_look_test 截图 | `ui/shell_widgets.dart` |
| 16 | **花费页是图表**（近 30 天柱状、按用途和按模型的环形图，可切金额 / 次数）；**记忆页**有搜索和分组筛选、按天分卡片 | 0.8.1 实测 | t94_settled_test（图表和悬停、记忆搜索与分组）；v082_look_test 截图；gateway_pages_test（花费） | `ui/spending_page.dart`、`ui/mini_charts.dart`、`ui/memory_page.dart` |

第 5、7、15、16 条的行为守护已由 T-94 补齐；截图守护仍须按本清单和最终验收要求执行。守护行为断言不放宽。
