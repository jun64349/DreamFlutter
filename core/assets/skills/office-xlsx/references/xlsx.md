# XLSX / CSV 片段

```python
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill, Alignment
w = Workbook()
s = w.active
s.title = '汇总'
s.append(['编号', '项目', '数量'])
s.append(['0012', '甲', 3])
s['A2'].number_format = '@'
for cell in s[1]:
    cell.font = Font(name='微软雅黑', bold=True, color='FFFFFF')
    cell.fill = PatternFill('solid', fgColor='245B52')
    cell.alignment = Alignment(vertical='center')
s.freeze_panes = 'A2'
s.auto_filter.ref = s.dimensions
for name, width in [('A', 16), ('B', 28), ('C', 12)]:
    s.column_dimensions[name].width = width
# 本来就是文本的数据，即使以 = 开头也不应执行为公式。
# s['D2'] = '=原始文本'; s['D2'].data_type = 's'
w.save(str(output_path))
r = load_workbook(str(output_path), data_only=False)
assert r['汇总']['A2'].value == '0012'
assert r['汇总']['C2'].value == 3
```

CSV→XLSX：字段明确时 `pd.read_csv(path, dtype={'编号':'string'}, encoding='utf-8-sig')`，检查 dtype/缺失和行数后 `to_excel(..., index=False)`；外部文本中可能的公式字面值需在 openpyxl 层显式设置 data_type='s'。XLSX→CSV：选择实际工作表，按文件或来源缓存读数据，`to_csv(..., index=False, encoding='utf-8-sig')`。不能依赖 pandas/openpyxl 计算 Excel 公式。

几十万行以上先用 `read_csv(..., chunksize=50000)` 做可累加的分组统计；若目标是 XLSX，注意每表 1,048,576 行的格式限制（含标题），超限时分表/分文件并说明。不要为了凑进单表静默截断。
