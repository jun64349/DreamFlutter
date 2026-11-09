# 分块汇总和中文图表

```python
import pandas as pd
totals = None
rows = 0
for chunk in pd.read_csv(input_path, dtype={'编号':'string'}, chunksize=50000):
    # 列名、缺失处理与筛选条件按本次材料调整；不要复制示例后忽略真实 schema。
    values = pd.to_numeric(chunk['数量'], errors='raise')
    part = chunk.assign(数量=values).groupby('项目', dropna=False)['数量'].sum()
    totals = part if totals is None else totals.add(part, fill_value=0)
    rows += len(chunk)
summary = totals.rename('数量').reset_index()
summary.to_csv(summary_path, index=False, encoding='utf-8-sig')
assert int(pd.read_csv(input_path, usecols=['数量'])['数量'].sum()) == int(summary['数量'].sum())
```

上面的独立核对适用于小样；全量很大时用另一遍分块累加校验，不再全量读入。CSV 中存在小数时不要套用 int 截断；按材料精度比较或使用 Decimal，不能为了让断言通过损失数值。

```python
import matplotlib
matplotlib.use('Agg')
from matplotlib import pyplot as plt
fig, ax = plt.subplots(figsize=(8, 4.5), layout='constrained')
ax.bar(summary['项目'].astype(str), summary['数量'], color='#267e69')
ax.set_title('按实际材料填写的中文标题')
ax.set_ylabel('数量（单位按材料）')
fig.savefig(chart_path, dpi=150)
plt.close(fig)
```

已随包文泉驿微米黑，通常无需改系统字体或下载字体。若出现缺字，核对 `font_manager.findfont(...)` 和 glyph 覆盖，并报告问题；不能把方框图当中文标签通过。
