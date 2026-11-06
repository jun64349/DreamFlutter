# 开发规范与踩坑

开发前先读这份。每一条都是真实出过的问题，后面写了是哪次发现的。新踩的坑加在对应的节里。
测试清单见 [testing/scenarios.md](testing/scenarios.md)，交接和历史见 [HANDOFF.md](HANDOFF.md)。

开发前同时读 [v1.0.0 收敛说明](v1.0-convergence.md)：用户已确认现有计划基本满足需求；完成既定范围、必要修复与验收，新增增强项留到 1.x，不擅自扩大或削减 v1.0.0 范围。

## 一、窗口（Flutter）

### 1. 被 IndexedStack 留着的页面还活着

导航（工作台 / 蝶君 / 任务 / 记忆 / 技能）和蝶君的「交流 / 工作」都用 IndexedStack：没显示的页面不画、不接收点击，但**仍在树里、仍在布局、仍在收全局事件**。

- 拖放：`DropTarget` 收整个窗口的拖放，不管自己在不在屏幕上 → 工作台拖进的图片也进了蝶君的输入框（v0.3.2 实测）。拖放区一律 `enable: ... && showsOnScreen(context)`（`ui/common.dart`）。
- 同理要小心：`HardwareKeyboard` 处理器、控制器的广播流（`fileDrops`、`mentionRequests`）、定时器。加之前问一句：这个页面藏在后面时还会响应吗？
- 两个 `AgentController`（工作台和蝶君）共用一个后台连接，事件要按控制器分开处理。
- 测试：`find.byType(...)` 默认跳过不在屏幕上的组件，要测隐藏页面时用 `skipOffstage: false`。

### 2. 界面缩放用的是 Transform，Flutter 的部分坐标换算不认

`AppZoom` 按「尺寸 ÷ 缩放」布局、再整体放大绘制。Flutter 自己的**滚动列表选区**（`_ScrollableSelectionContainerDelegate`）把没缩放的滚动偏移加到缩放后的坐标上：缩放 110%、往下滚 2000 像素就错 200 像素，拖第一段选中第三段，偏得多了干脆选不上（v0.3.2 实测）。

- 对话列表的做法：`SelectionContainer.disabled` 包住 `ListView`，每一行用 `SelectionRegistrarScope` 直接登记到外面的 `SelectionArea`（`chat_view.dart`）。**以后在滚动列表里放可选文字都照这样做**。
- 任何拿 `globalPosition` 和滚动偏移做加减的代码，都要在缩放 ≠ 100% 时测。
- 测试默认缩放 100%、对话很短，这类问题全都测不出来：选字、点击位置、弹出菜单位置的测试要加「缩放 125% + 长对话」的组合（`chat_reading_test.dart`）。

### 3. 修饰键会卡住

截图工具（QQ / 微信的 Ctrl+Alt+A、Win+Shift+S）在按键按下时抢走键盘，Flutter 收不到「松开」，`HardwareKeyboard` 就一直以为 Ctrl 还按着：滚轮变成缩放、列表不滚（v0.3.2 实测，点一下才恢复）。

- 判断 Ctrl / Shift 一律用 `HeldKeys.control` / `HeldKeys.shift`（`ui/keys.dart`，会问 Windows 实际按键状态）。不要再直接用 `HardwareKeyboard.instance.isControlPressed`。
- 集成测试里要把 `HeldKeys.askWindows = false`（测试按的键 Windows 不知道）。

### 4. 流式输出时每个字都重建整个对话

- `build` 里不做重活：不解码图片、不解析大文本、不新建 `ImageProvider` / 控制器。
- 图片用 `memoryImageOf(base64)`（`ui/common.dart`）拿同一个 `MemoryImage`，并加 `gaplessPlayback: true`。每次 `Image.memory(base64Decode(...))` 是新图片，会重新解码、空白一帧 → 生成时图片明暗闪（v0.3.2 实测）。

### 5. 跟随到底部：用户的操作永远优先

- 任何一次用户滚动（滚轮、拖动、滚动条、键盘）离开底部就立刻放开；只有真正回到底部（2 像素内）或点「回到底部」才重新跟随。
- 不要用「离底部 80 像素内就重新吸附」这种大阈值：一格滚轮约 50 像素，生成时下一帧就被拉回去，滚轮完全不能用（v0.3.2 实测）。
- 贴底在布局时做（`correctPixels`），不要在下一帧 `jumpTo`（会抖，额外测试 7）。

- 用户读的位置要稳（v0.3.3 实测「时不时往上弹」）：`ListView.builder` 会回收滚出去的行，回来时重新搭建。重新搭建时高度会变的东西（卡片先显示「正在打开…」再撑开、图片解码后才有高度、折叠状态丢了）会把下面的内容整体推走。
  - 对话列表每行包 `_AnchoredRow`：整行在视口上方时它变高变矮，列表偏移跟着补上（像浏览器的 scroll anchoring）。别的长列表有同样问题时照做。
  - 能同步拿到的就同步拿：卡片的信息和高度记在 `CardStage`（`info` / `height`），重新搭建时直接用。
  - 入场动画只给真正新出现的行（`_seen`），不要按「正在运行」一刀切：滚回来的旧行会重播动画，看起来像整个对话在刷新。
- 发消息（包括排队插话）时回到底部跟随：内容没变时列表不会重新布局，`stick = true` 不会生效，要在下一帧 `toEnd()`。

### 6. 文字和选区

- `TextStyle.backgroundColor` 会盖住选区：段落先画选区、后画文字（含背景）。可选文字里不要用文字背景色（v0.3.1 实测 3，行内代码）。
- **flutter_markdown_plus 会把它自带的默认样式和我们给的 `MarkdownStyleSheet` 合并**，我们没写的字段沿用默认值。默认的 `code` 带卡片色底色，所以「去掉 backgroundColor」等于没改：v0.3.3 以为修好了行内代码的选区，用户实测还是选不中（v0.3.3 实测第 1 条）。要明说 `backgroundColor: Colors.transparent`。测试要查**实际画出来的** span 样式（`markdown_view_test` 的「no ground」），不要只查自己写的样式表。
- Markdown 里行内元素的自定义组件（`MarkdownElementBuilder` 返回的 widget）如果不是 `Text`，会被当成段落外的单独一块：在它后面断行，也不在段落的选区里（v0.3.3 实测，文件名链接）。要嵌在句子里，就返回 `Text.rich(WidgetSpan(...))`：占位符在合并时原样保留，里面的文字照样登记到选区、复制顺序正确。不要指望 `TextSpan` 的 `onEnter` / `mouseCursor`：flutter_markdown_plus 合并相邻文字时会重建 `TextSpan`，只留下 text、style、recognizer。
- 可点的东西靠悬停效果（底色、手形光标）表明，不要再加说明气泡（用户 v0.3.3 的意见）。
- 给模型看的文字不要原样给人看：Pi 在带图消息里加的 `[Image: original …, displayed at …]` 在 `splitMentions` 里去掉了（v0.3.2 实测）。

### 7. 布局

- 每个新页面都要在「小窗口 + 150% 缩放」下不溢出：`scenarios_test.dart` 会打开所有页面、设置分类和主题，有溢出就失败（v0.3.3 由它发现左侧导航在 150% 时溢出）。
- 侧栏、导航这种「上面一组、`Spacer`、下面一组」的竖排，放不下时要能滚（`_FitOrScroll`）。
- 可拖宽的栏要按**最窄**的宽度排：0.4 的侧栏底部 5 个图标在最窄 200 时溢出，所以最窄改成 232（`Preferences.sidebarWidths`），按钮用紧凑密度。

### 8. 顶栏在导航器外面（0.4）

`AppTitleBar` 放在 `MaterialApp.builder` 里（每个页面都有、不跟界面缩放），所以它**上面没有 Navigator**：

- 它的菜单用 `MenuAnchor`（靠 Overlay），不能用 `PopupMenuButton` / `showMenu` / `showDialog`（都要 Navigator）。Overlay 由 builder 里的 `Overlay.wrap` 提供，Tooltip 也靠它。
- 要弹对话框的操作不放在顶栏：原来顶栏「⋯」里的存成技能、模板、定时、记忆快照搬到了右栏的「常用操作」（`SessionActions`）。
- `DragToMoveArea` 只包空白处和标志，不包按钮（它带双击识别，会拖慢里面按钮的单击）。
- 菜单是键盘（Ctrl O）打开的时候焦点不在菜单里，Esc 不会自动关：顶栏的键盘处理里自己关。
- 详情（右栏）现在默认关着、可以盖在对话上：窄窗口里它会挡住输入框右边，测试里要发消息先关掉它。

### 9. Flexible 和 Expanded 放在同一行，Flexible 用不完的空间会变成行末空白

一行里同时有 `Flexible`（按内容收缩）和 `Expanded`，剩余空间按 flex 先平分；`Flexible` 用不完的那部分**不会**再分给 `Expanded`，而是留在整行最后。0.4.0 的顶栏就是这样：路径是 `Flexible`、拖动区是 `Expanded`，结果详情按钮和窗口按钮离右边缘空出一大截（用户实测；组件测试不画窗口按钮，视觉检查的截图里详情按钮也没贴边，但当时没看出来）。

- 要「内容在左、空白撑满、按钮在右」：把内容和空白合成一个 `Expanded`，里面用 `Stack`（空白铺底、内容 `Align` 在左），或者只留一个 flex 子项。
- 看截图时检查一下：靠右的按钮是不是真的贴着右边缘。

### 10. 侧边对话这类「附属会话」要自己收尾（0.4）

窗口里关掉一个对话只是不显示它，后台的会话留着，等空闲一阵才回收（`_close`）；窗口重新连上后台时，还活着的会话会被接回列表（`_attachLiveSlots`）。普通对话这样做是对的，**但侧边对话不会再被打开**：0.4 第一次在真实模型上跑侧边对话，点「结束」后它在后台还开着，窗口重开时被接成了一个没名字的对话（端到端测试 1b 撞出来）。

- 附属于某个窗口、用完就扔的会话（侧边对话）：结束时 `slot.close`（`_endSideChat`），后台的会话信息标明来历（`forkOf`），重连时跳过。
- 以后再加这类会话（比如子 Agent 的临时会话），照这样做，并在测试里查「结束后后台收到关闭」「重连时不接回」。

## 二、后台（core）

- 加表要在模块里 `core.declareBackup(...)`，有路径的列写进 `paths`，否则 `backup.test.ts` 失败。数据库迁移只能往后追加（`schema.ts`）。
- 记忆：
  - 写之前查有没有意思相近的（`nearDuplicate`）：说得更完整的变成「修改」建议，重复的不写（v0.3.2 实测：「回复要简练，少说话」和「回复要简练，别长篇大论……」同时进了记忆库）。
  - 记忆以「用户」为主语。Agent 的名字、身份不是用户的信息（v0.3.2 实测：蝶君会话里提取出「用户叫蝶君」）。
  - 提取时把全部记忆和待确认的候选给模型看，不要只给和这次对话字面相近的几条。
  - 记忆系统的整体重做在 v0.5，见 [memory-design.md](memory-design.md) 末尾「v0.3.2 实测问题」。
- 测试里要关掉自动标题和自动提取记忆（harness 已关），否则会抢走假模型预设的回复。
- 假模型错误信息里带 "rate limited" 会触发 Pi 的自动重试。
- Pi 模板没有裸写的 `${1}`，要写 `${1:-}`。

## 三、开发环境和工具

- **PowerShell 5.1 读写文件默认用系统编码（GBK）**：`Get-Content` / `Set-Content` 会把 UTF-8 的中文弄乱，`-Encoding utf8` 写出的又带 BOM（v0.3.3 开发时把 `common.dart` 弄坏过一次）。改源文件只用 Edit / Write 工具；必须用 PowerShell 时读写都显式 `-Encoding utf8`，写完检查没有 BOM。
- Bash 里用 heredoc / `node -e` / `sed` 写含反斜杠或 `${...}` 的代码会被吃掉（连 `<<'EOF'` 也一样：0.5 第 5 步写正则时 `\b`、`\s` 全没了，编译能过、规则却是错的）；写脚本用 Write 工具存文件再运行（放 scratchpad）。
- **Write / Edit 工具会把 `​` 这类转义直接变成真正的字符**：0.5 第 5 步的不可见字符检查写进源码后，正则里全是看不见的字符（能用，但没人看得出来）。源码里要写这类转义时，写完用脚本把看不见的字符换回 `\uXXXX`（或用 `String.fromCharCode(92)` 拼反斜杠），并用 `od -c` 看一眼。
- Bash 里没有 `python`；本机唯一的 node 是 Hermes 自带的 v22。要用 Python（比如 `scripts/brand/`）就用 `core\bin\uv.exe` 和 `core\python\` 建个临时 venv（命令在脚本开头）。
- **升级后后台第一次启动很慢**：刚复制的几千个文件第一次被 Node 读取时 Windows 会扫描，实测 11–22 秒（第二次 1–2 秒）。窗口等后台启动不能用短超时：现在是「进程活着就等，最长 2 分钟；进程退出马上报错」（`CoreLocator.waitForStart`；0.4.0 用户实测 22 秒，原来只等 20 秒）。
- **不要用 `dart format`**（这个项目不是它的格式，会大面积改旧代码）。照着旁边的代码手写。
- Bash 工具的沙箱启动不了 PowerShell：后台测试、`scripts/live-*.ts` 用 PowerShell 工具跑。
- 跑测试时不要改源文件（测试会读到半改的文件）；真窗口测试一个一个跑。
- Git Bash 调 `wsl.exe … --cd /workspace` 会被改写路径，要 `export MSYS_NO_PATHCONV=1`。
- `git push` 会卡在凭据选择窗口：用 `$env:GCM_INTERACTIVE="never"; git -c credential.helper= -c credential.helper=manager push …`（PowerShell）。
- 跑过真窗口测试（`flutter test integration_test/... -d windows`）后，`app\build\windows\x64\runner\Debug\dreamflutter.exe` 是测试程序，不能拿给用户试；给用户试的一律是安装包。
- 不要直接删改用户的安装文件夹（`E:\DreamFlutter测试版`），会被权限拦下；给用户复制命令（HANDOFF 开头有）。
- **改了界面文字或按钮位置，端到端脚本要一起改**：它按文字和悬停提示找按钮，组件测试不会提醒（0.4 改名「新建对话」、工作区按钮挪到顶栏后，脚本跑到一半找不到）。改完把 `e2e_test.dart` 里用到的所有界面文字在 `lib/` 里搜一遍。
- 真窗口测试里点刚滑出来的面板（详情）之前，先等动画走完（`pump` 几百毫秒）：动画中算出的按钮位置是错的，点了没反应，测试一直等到超时（0.4 侧边对话）。
- 测试失败第一步先确认是测试的问题还是代码的问题：例如 finder 默认跳过隐藏组件，看起来像代码没生效。改完的修复要确认「去掉修复测试会失败」。

## 四、和用户协作

- 用户不是开发者：说平实的中文，给完整、可直接复制的 PowerShell 命令（先 `cd`）。
- 不要从 Claude 的终端替用户启动应用做试用（Claude 桌面版是打包应用，会重定向数据目录）；让用户自己双击。
- 提交、打 tag、推送都等用户说。
- 用户的真实测试很贵：发布前按 [testing/scenarios.md](testing/scenarios.md) 自己先走一遍，尤其是「缩放 + 长对话 + 生成中」「两个页面同时存在」这些组合。

## 五、发布前检查

1. 后台、窗口、协议层测试全过，`npx tsc --noEmit`、`flutter analyze` 没问题。
2. 场景巡检、视觉检查（看截图）、卡片、真实模型端到端都跑过。
3. 本版改到的地方，在 [testing/scenarios.md](testing/scenarios.md) 里有对应的行；新修的 bug 有回归测试，且确认去掉修复后测试会失败。
4. 打安装包，按「手动清单」走一遍。
5. 发布说明写清楚：修了什么、没修什么、要用户试什么。
