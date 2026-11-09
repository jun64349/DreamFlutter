# 周报输入与实际命令

输入是UTF-8 JSON；可读 `examples/week.json` 看完整**合成**样例，不能拿样例数字冒充用户的成绩。格式如下：

```json
{
  "title": "周报标题",
  "period": "明确日期范围",
  "theme": "press",
  "summary": ["基于记录的一句话结论"],
  "achievements": [{"title": "已完成的事", "detail": "结果和限制", "evidence": "原记录出处"}],
  "metrics": [{"name": "完成项", "value": "3项", "numericValue": 3, "unit": "项", "note": "统计口径和来源"}],
  "risks": [{"title": "问题", "detail": "实际影响", "owner": "待确认", "action": "待确认"}],
  "nextWeek": [{"task": "下一步", "owner": "待确认", "due": "待确认"}],
  "sources": ["记录/文件及日期"],
  "missing": ["需要用户补充什么"]
}
```

必填title、period、非空summary，以及至少一项achievements或metrics；没有材料先问用户，不生成假成绩。每个列表最多100项、输入最多2MiB，超限先分组整理。其他缺省不凭空补事实，负责人/日期为空会显示待确认。来源只显示为文字，不自动读取或联网打开。

- theme：press（默认）、tufte、vignelli、knuth、shannon、bodoni、bayer、sottsass、freddie、andy、fuller。
- value是显示文字；numericValue仅在已经核对的真实数值需要画图时提供，不能从“约3万”擅自猜值。只有单位明确且相同的非负数可共用柱图；零值保留，其他情况只用表。图上最多10项并明确标注，表保留全部。
- 正文/标题/出处全作文字转义，不支持把输入当HTML、脚本、外链图片或卡片工具声明。需要特殊视觉时再明确需求，不能把任意源文档脚本执行出来。

先确认输出位置，再以**绝对路径并正确引用空格**运行。以下尖括号是需替换的位置，不是原样执行：

```powershell
& '<应用目录>\runtime\node.exe' '<技能绝对目录>\scripts\render-report.mjs' --input '<工作区>\周报输入.json' --out '<用户所选目录>\本周周报.html'
```

开发环境/已有Node的环境可用：

```sh
node "/absolute/skill/scripts/render-report.mjs" --input "/absolute/workspace/report.json" --out "/absolute/output/report.html"
```

发布版技能目录为 `<应用目录>/core/assets/skills/showcard-pro`，由此向上四层即可定位应用根；先检查随包Node存在，不通过下载补齐。CLI输出两份真实路径、字节数和networkUsed=false；它拒绝覆盖已有文件，换新文件名后再运行。非零退出或写入不全时如实报告具体错误，不把缓存或旧文件当新交付。

完成后读取 `.card.html` 的实际全文，将同一HTML作为 `show_card` 参数，而不是只口头说“展示了卡片”。完整 `.html` 作为文件链接交付，别把100KB完整报告/组件库塞进工具参数。实际调用失败可保留已生成文件并说明；不编造card_id。更新既有卡片先read_card，不创建额外权限。
