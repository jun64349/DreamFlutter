# 已定型的操作逻辑和体验（v0.8.3）

2026-11-11 用户实测 v0.8.3 后定：**现在的操作逻辑和体验已经不错，以后的任务不要动这些。**

## 规矩

- 下面每一条的操作方式和观感保持现状。新功能装进现有的位置，不改这些地方的交互、布局和用词。
- 只有用户明确要求改某一条时才能动。动之前先在对应的任务卡里写明“用户要求改第几条”，改完同步更新本文。
- 守着它们的测试必须一直通过。不能为了让测试通过而改测试的期望；期望要改，只能是因为用户改了要求。
- 派给 Codex 的任务（后端、测试）同样适用：后端改动不能让这些表现变样，比如列表顺序、模型组怎么切换、蝶君直接对话。
- 交付前照旧要在 1600 宽和小窗口、日夜两套下截图看一遍，确认这些没被改坏。
- **用户已批准的改动**：v0.9 在蝶君侧栏「等你处理」下面加一行「日程」（用户 2026-11-11，见 [schedule-and-patrol.md](schedule-and-patrol.md)）。第 2 条的其他表现不变。

## 清单

| # | 定型的操作和体验 | 用户原话 / 来源 | 守着它的测试 | 主要代码 |
|---|---|---|---|---|
| 1 | **蝶君就是对话**：发什么都直接给蝶君，它在回复里说明打算并开工；打招呼就正常回话；只有它真缺信息用提问时，才进「等你处理」 | 0.8.1 实测：“对话啊这等你处理是任务模块” | t87_butterfly_test「messages go straight to 蝶君」；work_pages_test「butterfly talks in the shared composer」；e2e 4.7、4.8 | `state/butterfly_tasks.dart` submit；`core/src/agent/host-text.ts` |
| 2 | **蝶君侧栏列对话**，和工作台一样；在任何页面点历史或「新对话」都会回到蝶君；对话上方没有任务头，没有「进行中 / 已完成 / 没做成」标签；右栏是「这个对话」（交付文件、定时） | 0.8.3-test.2 实测：“没做成做成啥的你放等我处理的版块里不就行了” | work_pages_test「butterfly side lists conversations that open from any page」；t87_pages_look_test 截图 | `ui/sidebar.dart`、`ui/butterfly_page.dart`、`ui/butterfly_tasks_view.dart` |
| 3 | **对话列表按最后一条消息的时间排**，打开不算；置顶在最前 | 0.8.1 实测：选中历史对话会跳到第一个 | agent_controller_test「opening a conversation does not move it in the list」；core session-index.test「orders sessions by their last message」 | `core/src/modules/session-index.ts`、`state/session_runtime.dart` |
| 4 | **设置页**：内容限宽居中，分卡片，行间细线，卡片标题前有小蝴蝶；难懂的设置放进「高级」或「开发者选项」；「归档/回收」在设置里 | 0.8.1 实测：设置左右拉开、门槛高 | v082_look_test 截图；gateway_pages_test、sandbox_panel_test（导航键） | `ui/settings_layout.dart`、`ui/settings_workspace.dart` |
| 5 | **渠道编辑页**：分卡片，底部固定「测试连接」「保存」；所有选项都存；有改动没保存就离开时会问；失败说人话 | 0.8.1 实测：没有测试保存按键、改不了已选项 | v082_look_test 截图（**还没有专门的行为测试，见 T-94**） | `ui/gateway_pages.dart` ChannelEditorPage |
| 6 | **工作区选择在侧栏**（工作台 / 蝶君下面一行） | 0.8.1 实测 | window_frame_test；e2e 4.3 | `ui/sidebar.dart` SidebarWorkspaceButton |
| 7 | **右栏「文件」**：改的和新建的合成一块，按类型配图标；点开在右栏里预览（对话会让开）；右键能用默认程序打开、打开所在文件夹、另存为、复制路径 | 0.8.1 实测 | t86_chat_look_test 截图（**还没有专门的行为测试，见 T-94**） | `ui/run_summary.dart`、`ui/artifact_widgets.dart` |
| 8 | **回复下面那一行**：模型 · 输出速度 · 用时 · 几点，不显示花费；用模型组时写实际用的「渠道 · 模型」 | 0.8.1 实测：“回复下面显示速度和时间，不要花费” | message_view_test；model_groups_test | `ui/message_widgets.dart` replyFactsShort |
| 9 | **ChatGPT 登录**：点了直接打开浏览器，登录完自动回来显示「已登录」；手动粘贴地址折叠成「登录完没有自动回来？」 | 0.8.2 实测：“不应该是直接弹出登录界面吗” | pi_oauth_policy_test；core pi-oauth-policy.test（设备 ID） | `ui/pi_compatibility_panel.dart`、`core/src/gateway/pi-migration.ts` |
| 10 | **模型组**：用户自己建，数量不限，名字叫「模型组」（不叫号池）；先换 Key 再换渠道；订阅优先；一个对话粘在一个成员上，前面的恢复后新对话从第一个开始；带图只给能看图的；换的时候对话里出一行 | 2026-11-11 用户定（[model-groups.md](model-groups.md) 第八节） | core gateway.test（模型组、额度、带图、恢复）；model_groups_test；e2e 4.13 | `core/src/gateway/`、`ui/model_group_pages.dart` |
| 11 | **模型列表**：模型组在最上面，下面按渠道分段，只列常用模型，最后一项「更多模型…」；**输入框的模型按钮写完整的「模型 · 渠道」**，有空位时不截断 | 0.8.3 实测：“名称显示要完整，不然选错了” | model_groups_test（含“不截断”）；composer_layout_test | `state/agent_controller.dart` modelSections；`ui/composer.dart` |
| 12 | **等回复时的蝴蝶**：没出字前是大蝴蝶和诗意短句；出字后收成回复开头左边的小蝴蝶，写的时候呼吸，写完留着当头像；正文不跳 | 0.8.3 实测：“不应该变小放到左侧，保持呼吸”，“留一只在开头，像和朋友聊天” | t86_chat_test「the big butterfly folds away at the first words」 | `ui/message_widgets.dart` _ReplyView、_ReplyMark |
| 13 | **快速长输出跟得上**：回复按段落画，写完的段落不重画；最后一行始终排好，滚动条不乱跳 | 0.8.3 实测：400 token/秒写一万字界面跟不上、滑块乱跳 | markdown_view_test（分段、只重画最后一段）；chat_scroll_test「keeps the list height steady」 | `ui/markdown_view.dart`、`ui/chat_view.dart` |
| 14 | **长输入折叠**：你发的消息超过 10 行，默认折叠，点「展开全文」展开、「收起」收回 | 0.8.3 实测 | t86_chat_test「a long message you sent is folded」 | `ui/message_widgets.dart` _FoldingText |
| 15 | **首页**：标题和引文居中对齐，引文出处在下一行 | 0.8.1 实测 | v082_look_test 截图 | `ui/shell_widgets.dart` |
| 16 | **花费页是图表**（近 30 天柱状、按用途和按模型的环形图，可切金额 / 次数）；**记忆页**有搜索和分组筛选、按天分卡片 | 0.8.1 实测 | v082_look_test 截图；gateway_pages_test（花费） | `ui/spending_page.dart`、`ui/mini_charts.dart`、`ui/memory_page.dart` |

第 5、7、15、16 条目前主要靠截图守着，补行为测试的任务是 T-94（派给 Codex）。
