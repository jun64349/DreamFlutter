// ReActicle semantic components, compiled at release time. Runtime never installs packages.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeProvider, Article, Hero, Lead, Section, Summary, Table, ActionList, Conclusion, Raw } from 'reacticle';

const themes = ['press', 'tufte', 'vignelli', 'knuth', 'shannon', 'bodoni', 'bayer', 'sottsass', 'freddie', 'andy', 'fuller'];
const text = (value, field, required = true) => {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${field} 不能为空`);
    return '';
  }
  if (typeof value !== 'string' || value.length > 20000) throw new Error(`${field} 必须是最多20000字符的文字`);
  return value;
};
const list = (value, field) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${field} 必须是最多100项的数组`);
  return value;
};
const row = (value, field) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
  return value;
};
export function validate(input) {
  row(input, '周报');
  const theme = input.theme ?? 'press';
  if (!themes.includes(theme)) throw new Error('theme 不在已随包主题列表中');
  const report = {
    title: text(input.title, 'title'), period: text(input.period, 'period'), theme,
    subtitle: text(input.subtitle, 'subtitle', false),
    summary: list(input.summary, 'summary').map((v, i) => text(v, `summary[${i}]`)),
    achievements: list(input.achievements, 'achievements').map((v, i) => {
      row(v, `achievements[${i}]`);
      return { title: text(v.title, 'achievement.title'), detail: text(v.detail, 'achievement.detail'), evidence: text(v.evidence, 'achievement.evidence', false) };
    }),
    metrics: list(input.metrics, 'metrics').map((v, i) => {
      row(v, `metrics[${i}]`);
      if (v.numericValue !== undefined && (typeof v.numericValue !== 'number' || !Number.isFinite(v.numericValue))) throw new Error('metric.numericValue 必须是有限数字');
      return { name: text(v.name, 'metric.name'), value: text(v.value, 'metric.value'), note: text(v.note, 'metric.note', false), numericValue: v.numericValue, unit: text(v.unit, 'metric.unit', false) };
    }),
    risks: list(input.risks, 'risks').map((v, i) => {
      row(v, `risks[${i}]`);
      return { title: text(v.title, 'risk.title'), detail: text(v.detail, 'risk.detail'), owner: text(v.owner, 'risk.owner', false) || '待确认', action: text(v.action, 'risk.action', false) || '待确认' };
    }),
    nextWeek: list(input.nextWeek, 'nextWeek').map((v, i) => {
      row(v, `nextWeek[${i}]`);
      return { task: text(v.task, 'nextWeek.task'), owner: text(v.owner, 'nextWeek.owner', false) || '待确认', due: text(v.due, 'nextWeek.due', false) || '待确认', status: text(v.status, 'nextWeek.status', false) || '计划' };
    }),
    sources: list(input.sources, 'sources').map((v, i) => text(v, `sources[${i}]`)),
    missing: list(input.missing, 'missing').map((v, i) => text(v, `missing[${i}]`)),
    conclusion: text(input.conclusion, 'conclusion', false),
  };
  if (!report.summary.length || (!report.achievements.length && !report.metrics.length)) throw new Error('至少提供摘要及成果或指标；不要编造缺失记录');
  return report;
}

function MetricChart({ metrics }) {
  const points = metrics.filter(m => m.numericValue !== undefined);
  // Different units cannot share a scale; no chart is preferable to a misleading chart.
  if (!points.length || !points[0].unit || points.some(m => m.numericValue < 0) || new Set(points.map(m => m.unit)).size !== 1) return null;
  const visible = points.slice(0, 10), max = Math.max(1, ...visible.map(m => m.numericValue));
  return <Raw title={`指标对比${points.length > 10 ? '（仅图示前10项，完整数据见表）' : ''}`}>
    <svg viewBox={`0 0 640 ${visible.length * 44 + 12}`} role="img" aria-label={`本周指标，同一单位：${visible[0].unit || '记录未注明'}`}>
      {visible.map((m, i) => <g key={i} transform={`translate(0,${i * 44 + 8})`}>
        <text x="0" y="20" fill="var(--ra-color-text)" fontSize="14">{m.name.length > 12 ? `${m.name.slice(0, 12)}…` : m.name}</text>
        <rect x="188" y="3" width={Math.max(0, m.numericValue / max * 330)} height="24" rx="2" fill="var(--ra-color-accent)" />
        <text x="534" y="20" fill="var(--ra-color-muted)" fontSize="14">{m.value}</text>
      </g>)}
    </svg>
  </Raw>;
}

function Achievements({ items, compact = false }) {
  return <>{(compact ? items.slice(0, 3) : items).map((item, i) => <div className="sc-achievement" key={i}>
    <h3>{item.title}</h3><p>{item.detail}</p>
    {item.evidence && <p className="sc-source">依据：{item.evidence}</p>}
  </div>)}</>;
}

export function renderBody(input, compact = false) {
  const r = validate(input);
  return renderToStaticMarkup(<ThemeProvider theme={r.theme}><Article width={compact ? 'regular' : 'wide'} toc={false}>
    <Hero title={r.title} eyebrow="WEEKLY / 周报" subtitle={r.subtitle || r.period} meta={[{ label: '周期', value: r.period }, { label: '来源', value: r.sources.length ? `${r.sources.length}项记录` : '待补出处' }]} />
    {!compact && <Lead><p>这份周报只依据下列记录整理。已完成、风险与计划分开陈述，缺少负责人、日期或数据时保留待确认。</p></Lead>}
    <Summary title="本周要点" points={compact ? r.summary.slice(0, 3) : r.summary} />
    {!!r.achievements.length && <Section id="progress" index="01" title="完成了什么"><Achievements items={r.achievements} compact={compact} /></Section>}
    {!compact && !!r.metrics.length && <Section id="metrics" index="02" title="用数据核对进展">
      <MetricChart metrics={r.metrics} />
      <Table columns={[{ key: 'name', label: '指标' }, { key: 'value', label: '本周数值' }, { key: 'note', label: '口径 / 说明' }]} rows={r.metrics.map(m => ({ name: m.name, value: m.value, note: m.note || '未注明' }))} />
    </Section>}
    {!!r.risks.length && <Section id="risks" index={compact ? '02' : '03'} title="风险与需要协助的事">
      {(compact ? r.risks.slice(0, 2) : r.risks).map((risk, i) => <div className="sc-risk" key={i}><h3>{risk.title}</h3><p>{risk.detail}</p><p className="sc-source">负责人：{risk.owner} · 下一步：{risk.action}</p></div>)}
    </Section>}
    {!!r.nextWeek.length && <Section id="next" index={compact ? '03' : '04'} title="下一周"><ActionList items={compact ? r.nextWeek.slice(0, 3) : r.nextWeek} /></Section>}
    {!compact && <Section id="sources" index="05" title="依据与待确认">
      <ul>{r.sources.length ? r.sources.map((s, i) => <li key={i}>{s}</li>) : <li>未提供来源；请补充记录出处。</li>}</ul>
      {!!r.missing.length && <><h3>尚待确认</h3><ul>{r.missing.map((s, i) => <li key={i}>{s}</li>)}</ul></>}
    </Section>}
    {compact ? <footer className="sc-source"><p>这是展示摘要，完整内容与依据见同次交付的离线周报 HTML。</p><label><input type="checkbox" data-persist="showcard-pro.reviewed" /> 已阅（卡片中由宿主保存）</label></footer> : <Conclusion title="接下来怎么推进"><p>{r.conclusion || '按上面的计划推进；待确认事项在确认前不计为完成。'}</p></Conclusion>}
  </Article></ThemeProvider>);
}
