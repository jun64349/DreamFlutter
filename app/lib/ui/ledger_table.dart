import 'dart:async';
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';
import '../state/agent_controller.dart';
import 'agent_scope.dart';
import 'settings_controls.dart' show SettingMenu;
import 'settings_workspace.dart' show modelDisplayName;

const ledgerPurposes = {'conversation': '工作台对话', 'subagent': '协作任务', 'memory': '记忆整理', 'compaction': '整理上下文', 'auto_title': '起标题', 'vision': '看图', 'web_search': '联网搜索', 'web_fetch': '网页读取', 'auxiliary': '其他小任务'};
const _sources = {'provider_actual': '供应商返回', 'provider_estimate': '供应商估算', 'price_estimate': '按价格估算', 'plan_occupancy': '套餐占用', 'missing': '缺失'};
String _date(DateTime d) => '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
String _amount(num value) => value == 0 ? '0' : value.abs() < 0.00000001 ? '$value' : value.toStringAsFixed(8).replaceFirst(RegExp(r'\.?0+$'), '');

/// Request-time money and usage, kept separate by currency and source.
class LedgerTable extends StatefulWidget {
  const LedgerTable({super.key});
  @override
  State<LedgerTable> createState() => _LedgerTableState();
}
class _LedgerTableState extends State<LedgerTable> {
  final _horizontal = ScrollController();
  final _entryHorizontal=ScrollController();
  StreamSubscription<Json>? _events;
  List<Json> _entries=[];
  AgentController? _agent;
  late DateTime _from = DateTime(DateTime.now().year, DateTime.now().month, DateTime.now().day - 29);
  late DateTime _through = DateTime(DateTime.now().year, DateTime.now().month, DateTime.now().day);
  String _period = 'day', _group = 'purpose';
  String? _zone;
  List<Json> _rows = const [];
  String? _error;
  bool _busy = false;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final agent = AgentScope.read(context);
    if (_agent == agent) return;
    _agent = agent;_events?.cancel();_events=agent.backend.events.listen((e){if(e['event']=='ledger.changed'||e['event']=='run.finished')_load();}); unawaited(_load());
  }
  @override
  void dispose() { _events?.cancel();_entryHorizontal.dispose();_horizontal.dispose(); super.dispose(); }
  Future<void> _load() async {
    if(_busy)return;
    setState(() { _busy = true; _error = null; _rows = const []; });
    try {
      final result = asJsonMap(await _agent!.backend.call('ledger.summary', {'since': _from.millisecondsSinceEpoch, 'until': DateTime(_through.year, _through.month, _through.day + 1).millisecondsSinceEpoch, 'period': _period, 'groupBy': _group}));
      final entries=jsonRows(await _agent!.backend.call('ledger.entries',{'since':_from.millisecondsSinceEpoch,'until':DateTime(_through.year,_through.month,_through.day+1).millisecondsSinceEpoch,'limit':200}));
      if (mounted) setState(() { _entries=entries;_rows = jsonRows(result['rows']); _zone = result['timeZone'] as String?; });
    } catch (error) { if (mounted) setState(() => _error = SessionRuntime.describeError(error)); }
    finally { if (mounted) setState(() => _busy = false); }
  }
  /// One control for the range (0.8.1 S.8), not two date buttons.
  Future<void> _pickRange() async {
    final range = await showDateRangePicker(context: context, initialDateRange: DateTimeRange(start: _from, end: _through), firstDate: DateTime(2000), lastDate: DateTime(2100));
    if (range == null || !mounted) return;
    setState(() { _from = range.start; _through = range.end; });
    await _load();
  }
  String _purposeFilter = '';
  String _money(Json row) {
    final amounts = asJsonMap(row['amounts']);
    return amounts.isEmpty ? '未知' : amounts.entries.map((e) => '${e.key} ${e.value is num ? _amount(e.value as num) : '未知'}').join('\n');
  }
  String _source(Json row) => asJsonMap(row['amountSources']).entries.map((e) => '${_sources[e.key] ?? e.key} ${e.value} 笔').join('\n');
  String _allowance(Json row) {
    final values = asJsonMap(row['allowance']);
    return values.isEmpty ? '未知／不适用' : values.entries.map((e) { final parts = e.key.split(':'); return '${parts.first} ${e.value is num ? _amount(e.value as num) : '未知'}\n${parts.last == 'provider' ? '供应商逐笔计量' : '按官方规则估算'}'; }).join('\n');
  }
  String _entryTime(Json row){final at=(row['requested_at'] as num?)?.toInt();if(at==null)return '未知';final date=DateTime.fromMillisecondsSinceEpoch(at);String two(int n)=>n.toString().padLeft(2,'0');return '${_date(date)} ${two(date.hour)}:${two(date.minute)}';}
  String _entryModel(Json row){if(row['model'] is! String || '${row['model']}'.isEmpty)return '—';return modelDisplayName(_agent!,'${row['provider']}/${row['model']}',fallback:{'${row['model']}':'${row['model']}'});}
  /// A plan (OpenCode Go and the like) bills nothing per request; what matters is how much of the plan it used (0.8.1 F.6).
  String _entryMoney(Json row){
    String symbol(Object? currency)=>currency=='USD'?'\$':currency=='CNY'?'¥':'${currency??''} ';
    if('${row['amount_source']}'=='plan_occupancy'){final used=row['allowance'];return used is num?'套餐 ${symbol(row['allowance_unit'])}${_amount(used)}':'套餐内';}
    if(row['amount'] is! num)return '未知';
    final source='${row['amount_source']}';
    return '${symbol(row['currency'])}${_amount(row['amount'] as num)}${source.contains('estimate')?'（估算）':''}';
  }
  Widget _cell(String value, {double? width, bool oneLine = false, bool right = false}) => width == null ? Text(value) : SizedBox(width: width, child: oneLine ? Tooltip(message: value, child: Text(value, maxLines: 1, overflow: TextOverflow.ellipsis, textAlign: right ? TextAlign.right : null, style: const TextStyle(fontFeatures: [FontFeature.tabularFigures()]))) : SelectableText(value));
  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Wrap(spacing: 12, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
        OutlinedButton.icon(key: const ValueKey('ledger-range'), onPressed: _busy ? null : _pickRange, icon: const Icon(Icons.date_range_outlined, size: 16), label: Text('${_date(_from)} – ${_date(_through)}')),
        SettingMenu<String>(key: const ValueKey('ledger-purpose'), value: _purposeFilter, choices: {'': '全部用途', for (final key in {for (final row in _entries) '${row['purpose']}'}) key: ledgerPurposes[key] ?? '其他'}, onSelected: (v) => setState(() => _purposeFilter = v)),
      ]),
      const SizedBox(height: 12),
      if (_busy) const LinearProgressIndicator(semanticsLabel: '正在查询账目'),
      if (_error != null) Text('查询失败：$_error', style: TextStyle(color: Theme.of(context).colorScheme.error)),
      if (!_busy && _error == null && _entries.isEmpty) const Text('这个时间范围内没有请求记录'),
      if (_entries.isNotEmpty) Scrollbar(controller:_entryHorizontal,thumbVisibility:true,child:SingleChildScrollView(key:const ValueKey('ledger-entries-horizontal'),controller:_entryHorizontal,scrollDirection:Axis.horizontal,child:Padding(padding:const EdgeInsets.only(bottom:16),child:DataTable(columnSpacing:16,horizontalMargin:12,
        headingRowHeight:40,columns:[for(final name in ['时间','用在哪','模型'])DataColumn(label:Text(name)),const DataColumn(label:Text('花费'),numeric:true)],
        dataRowMinHeight:40,dataRowMaxHeight:48,
        rows:[for(final row in _entries.where((r)=>_purposeFilter.isEmpty||'${r['purpose']}'==_purposeFilter))DataRow(cells:[DataCell(_cell(_entryTime(row))),DataCell(_cell(ledgerPurposes[row['purpose']]??'其他',width:90)),DataCell(_cell(_entryModel(row),width:190,oneLine:true)),DataCell(_cell(_entryMoney(row),width:140,oneLine:true,right:true))])],
      )))),
      if(_entries.length>=200)const Text('当前显示最近 200 笔，请缩小时间范围继续查看。'),
      const SizedBox(height:20),
      ExpansionTile(key:const ValueKey('ledger-advanced'),tilePadding:EdgeInsets.zero,title:const Text('高级'),children:[
        Wrap(spacing:12,runSpacing:12,children:[
        SizedBox(width: 140, child: DropdownButtonFormField<String>(initialValue: _period, isExpanded: true, decoration: const InputDecoration(labelText: '时间归组'), items: const [DropdownMenuItem(value: 'day', child: Text('按日')), DropdownMenuItem(value: 'month', child: Text('按月'))], onChanged: _busy ? null : (v) { setState(() => _period = v!); _load(); })),
        SizedBox(width: 180, child: DropdownButtonFormField<String>(initialValue: _group, isExpanded: true, decoration: const InputDecoration(labelText: '分组方式'), items: const [DropdownMenuItem(value: 'channel', child: Text('渠道')), DropdownMenuItem(value: 'model', child: Text('模型')), DropdownMenuItem(value: 'purpose', child: Text('用途')), DropdownMenuItem(value: 'workspace', child: Text('工作区')), DropdownMenuItem(value: 'session', child: Text('对话'))], onChanged: _busy ? null : (v) { setState(() => _group = v!); _load(); })),
        TextButton(onPressed: _busy ? null : _load, child: const Text('刷新账目')),
        ]),
      if (_zone != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text('归日时区：$_zone')),
      if (_rows.isNotEmpty) Scrollbar(controller: _horizontal, thumbVisibility: true, child: SingleChildScrollView(key: const ValueKey('ledger-horizontal'), controller: _horizontal, scrollDirection: Axis.horizontal, child: Padding(padding: const EdgeInsets.only(bottom: 16), child: DataTable(
        dataRowMinHeight: 56, dataRowMaxHeight: 180,
        columns: [for (final title in ['日／月', '分组', '请求数', '成功率', '输入', '输出', '缓存读', '缓存写', '推理', '金额（分币种）', '金额来源', '本机累计用量（估算）', '历史导入', '首字延迟']) DataColumn(label: Text(title))],
        rows: [for (final row in _rows.take(200)) DataRow(cells: [
          DataCell(_cell('${row['period']}')),
          DataCell(_cell(_group == 'purpose' ? ledgerPurposes[row['key']] ?? '${row['key']}' : '${row['key']}', width: 190)),
          DataCell(_cell('${row['requests']}')),
          DataCell(_cell(row['successRate'] is num ? '${((row['successRate'] as num) * 100).toStringAsFixed(1)}%\n已知 ${row['knownStatuses']}/${row['requests']}' : '未知')),
          for (final key in ['input', 'output', 'cacheRead', 'cacheWrite']) DataCell(_cell((row['tokenKnown'] as num? ?? 0) == 0 ? '未知／按次' : '${row[key]}')),
          DataCell(_cell((row['reasoningKnown'] as num? ?? 0) == 0 ? '未知' : '${row['reasoning']}')),
          DataCell(_cell(_money(row), width: 170)),
          DataCell(_cell('${_source(row)}${(row['missingUsage'] as num? ?? 0) > 0 ? '\n${row['missingUsage']} 次计量缺失' : ''}', width: 170)),
          DataCell(_cell(_allowance(row), width: 220)),
          DataCell(_cell('${row['historical']} 笔')),
          DataCell(_cell(row['ttftMs'] is num ? '${(row['ttftMs'] as num).toStringAsFixed(0)} ms\n${row['latencyCount']} 笔有读数' : '未知')),
        ])],
      )))),
      if (_rows.length > 200) Text('共 ${_rows.length} 组，当前显示前 200 组；请缩小时间范围继续核对。'),
      ]),
    ]);
  }
}
