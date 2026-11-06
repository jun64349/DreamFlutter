import 'package:pi_rpc/pi_rpc.dart';
import 'fake_backend.dart';

/// Synthetic step-8 data, shared by component checks and visual evidence.
class MemoryV05Fixture {
  MemoryV05Fixture(this.backend, this.workspace) {
    item = {'id': 'm1', 'version': 2, 'content': '项目交流用中文，修改代码后附验证结果。', 'kind': 'agreement', 'scope': 'workspace', 'workspacePath': workspace, 'workspaceId': 'w1', 'level': 2, 'retention': 'locked', 'status': 'review', 'confidence': 'user_explicit', 'updatedAt': at, 'validUntil': null};
    pending = [ {'id': 'pending-1', 'why': 'promote_global', 'reason': '适用于其他工作区，须由你决定', 'actor': 'main_agent', 'createdAt': at, 'itemId': 'm1', 'current': item, 'op': {'kind': 'edit', 'id': 'm1', 'patch': {'scope': 'global', 'content': item['content']}}} ];
    backend.settings.addAll({'memoryConfirmWrites': false, 'memoryDetail': 'standard', 'memoryWriteFrequency': 'standard', 'memoryDailyBudgetUsd': 0.2, 'memoryCapacityTokens': 40000, 'compactionThresholdPercent': 80, 'backgroundCompaction': 'auto', 'backgroundCompactionModel': 'session'});
    backend.onLaunch = (pi) {
      pi.sessionId = pi.target.sessionPath == '$workspace/side.jsonl' ? 'side-session' : 'parent-session';
      pi.messages = [
        {'role': 'user', 'content': '请记住项目交流使用中文', 'timestamp': at - 3000, 'entryId': 'question-1'},
        {'role': 'assistant', 'content': [{'type': 'text', 'text': '记住了。后续使用中文，并附上验证结果。'}], 'timestamp': at - 2000, 'entryId': 'reply-1', 'stopReason': 'stop'},
      ];
      if (pi.sessionId == 'side-session') {
        final entries = <Json>[
          {'id': 'inherited', 'parentId': null, 'type': 'message', 'message': pi.messages.first},
          {'id': 'boundary', 'parentId': 'inherited', 'type': 'custom', 'customType': 'df.inheritedHistory', 'data': {'sessionId': 'side-session', 'lastEntryId': 'inherited'}},
          {'id': 'side-question', 'parentId': 'boundary', 'type': 'message', 'message': {'role': 'user', 'content': '这段验证需要包含哪些内容？', 'timestamp': at}},
          {'id': 'side-reply', 'parentId': 'side-question', 'type': 'message', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': '列出实际命令、结果和没有覆盖的情况。'}], 'timestamp': at + 1000, 'stopReason': 'stop'}},
        ];
        pi.extraResponses['get_tree'] = {'tree': [for (final e in entries) {'entry': e, 'children': <Json>[]}], 'leafId': 'side-reply'};
      }
    };
    backend.handlers.addAll({
      'memory.list': (p) => p['status'] == 'candidate' ? pending : [item],
      'memory.items': (_) => purged ? [] : [item],
      'memory.pending': (_) => pending,
      'memory.blocks': (_) => [ {'key': 'about_me', 'title': '关于我', 'content': '偏好清楚、简洁的协作说明。', 'locked': false} ],
      'memory.item': (_) => {
        'item': item,
        'versions': [ {'version': item['version'], 'at': at, 'item': item}, {'version': 1, 'at': at - 86400000, 'item': {...item, 'version': 1, 'content': '项目交流用中文。'}} ],
        'sources': [ {'kind': 'session', 'ref': '$workspace/source.jsonl', 'excerpt': '用户明确要求项目交流用中文', 'at': at} ], 'links': [], 'log': [],
      },
      'memory.log': (p) => {
        'days': [ {'day': p['cursor'] == null ? '2026-11-06' : '2026-11-05', 'entries': p['cursor'] == null ? [entry('o1'), {...entry('o2'), 'actor': 'memory_agent', 'kind': 'status', 'inferred': true, 'reason': '按新进展整理，保留必要约束'}, {'opId': 'purge-op', 'batchId': 'purge-batch', 'kind': 'purge', 'batchKind': 'purge', 'actor': 'user', 'scope': 'global', 'level': 1, 'before': null, 'after': null, 'undoable': false}] : [entry('older', batch: 'old-batch')]} ],
        'hasMore': p['cursor'] == null, 'cursor': p['cursor'] == null ? 'next-page' : null,
      },
      'memory.undoBatch': (_) => {'undone': ['o1'], 'conflicts': [{'opId': 'o2', 'itemId': 'm2', 'reason': '之后又改过，没有覆盖'}], 'currentTask': 'next_call'},
      'memory.undo': (_) => {'undone': ['o1'], 'conflicts': [], 'currentTask': 'next_task'},
      'memory.restore': (p) { item = {...item, 'version': 3, 'content': '项目交流用中文。'}; return receipt(item, 'next_call'); },
      'memory.update': (p) { item = {...item, ...p, 'version': (item['version'] as int) + 1}; return receipt(item, 'next_call'); },
      'memory.setStatus': (p) { item = {...item, 'status': p['status'], 'version': (item['version'] as int) + 1}; return receipt(item, 'next_call'); },
      'memory.save': (p) => receipt({...item, ...p}, 'next_task'),
      'memory.acceptPending': (_) { pending = []; return receipt(item, 'next_task'); },
      'memory.rejectPending': (_) { pending = []; return {'ok': true}; },
      'memory.purge': (_) { purged = true; return {'sessions': [{'path': '$workspace/source.jsonl', 'title': '项目约定', 'exists': true}, {'path': '$workspace/missing.jsonl', 'title': '旧会话', 'exists': false}], 'notes': ['已发给模型服务商的内容无法收回', '之前的自动备份里还有这条记忆']}; },
      'memory.sessionMode': (_) => {'mode': mode},
      'memory.setSessionMode': (p) { mode = p['mode'] as String; return {'mode': mode}; },
      'memory.newTask': (_) => {'ok': true, 'note': '下一条消息开始一个新任务'},
      'memory.tasks': (_) => [ {'id': 'task-guessed', 'reason': 'guessed', 'status': 'active', 'prompt': '请记住项目交流使用中文', 'startedAt': at - 2500} ],
      'memory.continueTask': (_) => {'resumed': {'id': 'previous'}, 'dropped': {'id': 'task-guessed'}},
      'sessions.children': (_) => [ {'path': '$workspace/side.jsonl', 'cwd': workspace, 'parentSession': '$workspace/source.jsonl', 'sessionType': 'side', 'parentMissing': true, 'title': '验证细节', 'quote': '修改代码后附验证结果'}, {'path': '$workspace/fork.jsonl', 'cwd': workspace, 'sessionType': 'ordinary', 'title': '另一条思路'} ],
      'sessions.deletePreview': (_) => {'sideCount': 2, 'paths': []},
      'sessions.delete': (_) => {'deleted': [], 'sideCount': 2},
      'context.info': (_) => {'usage': {'tokens': 82000, 'percent': 41, 'contextWindow': 200000}, 'contextWindow': 200000, 'thresholdPercent': threshold ?? 80, 'ownThreshold': threshold, 'thresholdTokens': 126000, 'autoCompaction': true, 'background': {'on': background ?? false, 'ownChoice': background == null ? null : background! ? 1 : 0, 'leadPercent': 85, 'model': 'session', 'last': null}, 'compacting': false, 'checkpoints': 2},
      'context.setSession': (p) { if (p.containsKey('thresholdPercent')) threshold = p['thresholdPercent'] as int?; if (p.containsKey('background')) background = p['background'] as bool?; return {'thresholdPercent': threshold, 'background': background}; },
      'context.checkpoints': (_) => [ {'entryId': 'c1', 'summary': '早期记录：项目目标和约束。', 'firstKeptEntryId': 'q1', 'tokensBefore': 100000, 'at': '2026-11-05 16:30', 'reported': false}, {'entryId': 'c2', 'summary': '最新检查点：保留失败原因、验证结果和未完成的事项。', 'firstKeptEntryId': 'q2', 'tokensBefore': 126000, 'at': '2026-11-06 11:20', 'reported': reported} ],
      'context.original': (_) => [ {'entryId': 'q1', 'role': 'user', 'text': '保留失败原因，不把未验证写成通过。'} ],
      'context.report': (_) { reported = true; return {'id': 'report-1'}; },
      'context.regenerate': (_) => {'source': 'previous_summary', 'tokensBefore': 126000, 'estimatedTokensAfter': 32000, 'summary': '已修订的摘要'},
    });
  }
  final FakeBackend backend;
  final String workspace;
  final int at = DateTime(2026, 11, 6, 12).millisecondsSinceEpoch;
  late Json item;
  late List<Json> pending;
  bool purged = false;
  String mode = 'normal';
  int? threshold;
  bool? background;
  bool reported = false;
  Json entry(String id, {String batch = 'batch-1'}) => {'opId': id, 'batchId': batch, 'batchKind': 'user', 'kind': 'edit', 'actor': 'user', 'at': at, 'itemId': 'm1', 'after': item, 'before': {...item, 'version': 1}, 'reason': '用户纠正项目约定', 'inferred': false, 'undoable': true};
  Json receipt(Json item, String use) => {'item': item, 'applied': [{'itemId': item['id'], 'opId': 'new-op'}], 'pending': [], 'rejected': [], 'currentTask': use};
  Json claim() => {'event': 'memory.unsaved', 'sessionId': 'parent-session', 'slotId': backend.pis.first.slotId, 'runId': 'run-1', 'replyEntryId': 'reply-1', 'pendingIds': [], 'pending': false, 'claim': '记住了', 'suggestion': '项目交流用中文，修改代码后附验证结果。', 'at': at};
}
