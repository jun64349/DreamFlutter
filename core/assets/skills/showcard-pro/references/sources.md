# 来源、封装边界与离线使用

## 三个来源的角色

1. **Showcard**：应用已有的1.0卡片宿主，使用现有 `show_card` 展示和 `read_card` 更新，不新增权限或绑定。这里生成的摘要是静态HTML加原生 `data-persist` 已阅勾选；不声明文件、网络或执行能力。
2. **beautiful-article**：[Garden Skills](https://github.com/ConardLi/garden-skills/tree/2b9a89340b70f632d31c0f1c69fce94a7912423e/skills/beautiful-article)，版本0.1.0，MIT。58个上游文件在 `vendor/beautiful-article/` 原样保存，另加根许可证；逐原始Git blob摘要在任务证据。沿用“先材料、后编排、语义章节、主题约束、检查真实文件”的方法。完整长文主题/检查点说明可按需读取其references，不把整套正文注入系统提示词。
3. **rearticle 链接**：`https://rearticle.mmh1.top/` 实际是 **ReActicle** 的文档/演示站。网站指向开源 [ConardLi/reacticle](https://github.com/ConardLi/reacticle)，是React语义组件协议，不是必须上传记录的在线转换服务。随包使用 npm `reacticle@0.2.6` 的真实组件生成结构，不调用站点API，不需要账号，不在使用时联网装包。

当前站点公开阅读无需登录；未发现托管生成API或必需账号流程，不据此推断不存在其他未公开服务。访问站点本身有外部字体/统计请求，所以**离线交付不嵌入网页、iframe或站点脚本**。需要在线示例时仅列出处，不传用户正文。用户要求联网/账号方式时先说明实际服务与要发送的内容，等待明确决定。

## 默认离线路径

`scripts/render-report.mjs` 使用已编译的 `vendor/renderer.mjs`，React18 SSR + ReActicle语义组件，生成：

- 完整 `<所选文件名>.html`：章节、数据表、同单位图、风险、行动和出处，离线打开、浏览器打印；无客户端React、无远程图片或网页字体。
- `<所选文件名>.card.html`：约数KB的展示摘要，用于实际 `show_card`。缩略会明确注明完整文件另附，不能把它当全部材料。

运行需要Node22（工作台使用应用随包 `runtime/node.exe`；开发环境也可用兼容的Node）。不需要npm、Bash或Chromium来生成HTML。实际查看仍需要本机浏览器/WebView。蝶君环境若没有Node，明确说明当前环境缺少运行时，不擅自安装或读取宿主文件；可在用户选择工作台后处理其授权材料。PDF不是本技能默认产物，不把浏览器“打印为PDF”冒充已经导出的PDF。

上游 `vendor/beautiful-article/scripts/scaffold.sh` **会 npm install / 安装 latest reacticle**，其 `html-to-pdf.sh` 另需浏览器；`extract_to_markdown.py` 高保真提取可选MarkItDown。它们原样保存为来源，不是默认执行命令，不用来偷偷安装依赖。用户明确要求完整上游工程或在线依赖时，先解释新增下载、网络与运行环境，再等待决定。

## 许可与版本

- `THIRD-PARTY.json` 和 `licenses/` 包含本封装的来源、版本及许可条款；相关条目进入包的总第三方清单。
- ReActicle的npm包和本次检查的Git树没有独立LICENSE文件，README的LICENSE链接404；其package.json明确声明MIT、author为ConardLi，README同样声明MIT。本封装保留原package/README，并在 `licenses/reacticle-MIT.txt` 说明此事实，附MIT标准条款，不虚构上游版权行。
- React、ReactDOM及所含依赖保留各自原LICENSE。ReActicle CSS删除嵌入字体的 `@font-face` 后随包，改用系统字体；原组件JS保留，编译元数据记原/改后摘要。
- 开发复建使用 `development/package-lock.json`、Node22、`npm ci --ignore-scripts --no-audit --no-fund`，再 `node development/build.mjs <该隔离目录的node_modules>`。下载仅发生在开发复建，不发生在用户生成周报时；应用核心依赖未改。
