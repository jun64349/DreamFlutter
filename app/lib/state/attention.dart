import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'backend.dart';

List<Json> _rows(Object? value) => value is List ? value.whereType<Map>().map((r)=>r.cast<String,dynamic>()).toList() : [];

class AttentionState extends ChangeNotifier {
  AttentionState(this.backend, {this.onCountChanged}) {
    _events = backend.events.listen((event) {
      if (event['event'] == 'attention.action') {
        final receipt = asJsonMap(event['receipt']);
        receipts['${receipt['id']}'] = receipt;
        if (receipt['status']=='failed') error='${receipt['error'] ?? '没能处理，请重试。'}';
        _clock(); notifyListeners();
      }
      if (event['event'] == 'attention.changed') {
        final counts = asJsonMap(event['counts']);
        if (counts['total'] is num) { total = (counts['total'] as num).toInt(); available = true; onCountChanged?.call(); }
        unawaited(refresh());
      }
    });
    scheduleMicrotask(refresh);
  }
  final AgentBackend backend;
  final VoidCallback? onCountChanged;
  StreamSubscription<Json>? _events;
  Timer? _timer;
  bool _disposed = false, _again = false, loading = false, available = false;
  String? error;
  int total = 0;
  List<Json> now = [], later = [];
  final receipts = <String, Json>{};
  final busy = <String>{};
  Future<void>? _refresh;
  Iterable<Json> get undoable => receipts.values.where((r) => r['status'] == 'pending' && remaining(r) > 0 && r['undoable'] == true);
  int remaining(Json r) => ((r['undoUntil'] as num?)?.toInt() ?? 0) - DateTime.now().millisecondsSinceEpoch;
  Set<String> get hidden => receipts.values.where((r) => r['status'] == 'pending' || r['status'] == 'applied').map((r) => '${r['itemId']}').toSet();
  Future<void> refresh() {
    if (_disposed) return Future.value();
    if (_refresh != null) { _again = true; return _refresh!; }
    return _refresh = _load().whenComplete(() { _refresh = null; if (_again && !_disposed) { _again = false; unawaited(refresh()); } });
  }
  Future<void> _load() async {
    loading = true;
    try {
      final result = asJsonMap(await backend.call('attention.list'));
      final counts = asJsonMap(result['counts']);
      if (_disposed || counts['total'] is! num) return;
      available = true; total = (counts['total'] as num).toInt();
      now = _rows(result['now']); later = _rows(result['later']);
      if(error=='没能读取等你处理，请重试。')error=null;
      final pending=_rows(result['pending']);
      final pendingIds=pending.map((r)=>r['id']).toSet();
      for(final old in receipts.values.where((r)=>r['status']=='pending'&&!pendingIds.contains(r['id'])).toList()){
        try{final current=asJsonMap(await backend.call('attention.receipt',{'id':old['id']}));if(_disposed)return;receipts['${old['id']}']=current;if(current['status']=='failed')error='${current['error']??'没能处理，请重试。'}';}catch(_){if(_disposed)return;receipts['${old['id']}']={...old,'status':'failed'};error='没能确认处理结果，请刷新后查看。';}
      }
      for (final r in pending) { receipts['${r['id']}'] = r; }
      onCountChanged?.call(); _clock();
    } catch (e) { if (!_disposed) error = '没能读取等你处理，请重试。'; }
    finally { if (!_disposed) { loading = false; notifyListeners(); } }
  }
  void _clock() {
    if (_timer != null || _disposed || undoable.isEmpty) return;
    _timer = Timer.periodic(const Duration(milliseconds: 200), (_) {
      if (_disposed) return;
      notifyListeners();
      if (undoable.isEmpty) { _timer?.cancel(); _timer = null; unawaited(refresh()); }
    });
  }
  Future<Json?> resolve(Json item, String action, [String? answer]) async {
    final id = '${item['id']}';
    if (!busy.add(id)) return null;
    error = null; notifyListeners();
    try {
      final r = asJsonMap(await backend.call('attention.resolve', {'id': id, 'action': action, if (answer != null) 'response': {'value': answer}}, const Duration(minutes: 10)));
      if (_disposed) return r;
      receipts['${r['id']}'] = r;
      if (r['status'] == 'failed') error = '${r['error'] ?? '没能处理，请重试。'}';
      _clock(); return r;
    } catch (e) { if (!_disposed) error = '没能处理，请重试。'; return null; }
    finally { busy.remove(id); if (!_disposed) { notifyListeners(); unawaited(refresh()); } }
  }
  Future<void> undo(Json receipt) async {
    try {
      final r = asJsonMap(await backend.call('attention.undo', {'id': receipt['id']}));
      if (_disposed) return;
      receipts['${r['id']}'] = r; error = null;
    } catch (_) { if (!_disposed) error = '这次处理已生效，可以到对应页面修改。'; }
    if (!_disposed) { notifyListeners(); await refresh(); }
  }
  @override
  void dispose() { _disposed = true; _events?.cancel(); _timer?.cancel(); super.dispose(); }
}
