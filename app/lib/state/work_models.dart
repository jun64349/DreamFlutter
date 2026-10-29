import 'package:pi_rpc/pi_rpc.dart';

/// Tasks, the desk (notes, materials, artifacts) and inbox items, as the
/// core's `tasks` module returns them.

int _int(Object? v) => (v as num?)?.toInt() ?? 0;
DateTime? _time(Object? v) => v is num && v > 0 ? DateTime.fromMillisecondsSinceEpoch(v.toInt()) : null;
List<Json> jsonRows(Object? v) => v is List ? v.whereType<Map>().map((m) => m.cast<String, dynamic>()).toList() : const [];

enum TaskStatus {
  waiting('等待'),
  running('运行中'),
  needsInput('需要确认'),
  done('完成'),
  noChange('无变化'),
  failed('失败'),
  interrupted('中断');

  const TaskStatus(this.label);
  final String label;

  static TaskStatus parse(String? id) => switch (id) {
    'running' => running,
    'needs_input' => needsInput,
    'done' => done,
    'no_change' => noChange,
    'failed' => failed,
    'interrupted' => interrupted,
    _ => waiting,
  };

  bool get isActive => this == running || this == needsInput || this == waiting;
}

class TaskInfo {
  TaskInfo.fromJson(Json json)
    : id = json['id'] as String? ?? '',
      title = json['title'] as String? ?? '',
      goal = json['goal'] as String? ?? '',
      cwd = json['cwd'] as String? ?? '',
      sessionFile = json['sessionFile'] as String?,
      source = json['source'] as String? ?? 'chat',
      status = TaskStatus.parse(json['status'] as String?),
      noteId = json['noteId'] as String?,
      result = json['result'] as String?,
      error = json['error'] as String?,
      runs = _int(json['runs']),
      turns = _int(json['turns']),
      cost = (json['cost'] as num?)?.toDouble() ?? 0,
      duration = Duration(milliseconds: _int(json['durationMs'])),
      currentStep = json['currentStep'] as String?,
      createdAt = _time(json['createdAt']),
      updatedAt = _time(json['updatedAt']);

  final String id;
  final String title;
  final String goal;
  final String cwd;
  final String? sessionFile;
  final String source;
  final TaskStatus status;
  final String? noteId;
  final String? result;
  final String? error;
  final int runs;
  final int turns;
  final double cost;
  final Duration duration;
  final String? currentStep;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  String get sourceLabel => switch (source) { 'note' => '写笺', 'template' => '模板', 'schedule' => '定时', _ => '对话' };
}

class NoteInfo {
  NoteInfo.fromJson(Json json)
    : id = json['id'] as String? ?? '',
      cwd = json['cwd'] as String? ?? '',
      title = json['title'] as String? ?? '',
      content = json['content'] as String? ?? '',
      updatedAt = _time(json['updatedAt']);

  final String id;
  final String cwd;
  final String title;
  final String content;
  final DateTime? updatedAt;
}

class MaterialInfo {
  MaterialInfo.fromJson(Json json)
    : id = json['id'] as String? ?? '',
      kind = json['kind'] as String? ?? 'file',
      title = json['title'] as String? ?? '',
      path = json['path'] as String?,
      content = json['content'] as String?;

  final String id;
  final String kind;
  final String title;
  final String? path;
  final String? content;
}

class ArtifactInfo {
  ArtifactInfo.fromJson(Json json)
    : id = json['id'] as String? ?? '',
      path = json['path'] as String? ?? '',
      taskId = json['taskId'] as String?,
      noteId = json['noteId'] as String?,
      exists = json['exists'] == true,
      size = (json['size'] as num?)?.toInt(),
      updatedAt = _time(json['updatedAt']);

  final String id;
  final String path;
  final String? taskId;
  final String? noteId;
  final bool exists;
  final int? size;
  final DateTime? updatedAt;
}

/// Something waiting for the user: an approval or question from a running
/// task, a run stopped by a limit, a memory candidate, a skill proposal, or
/// an interrupted run.
class InboxItem {
  InboxItem.fromJson(Json json)
    : kind = json['kind'] as String? ?? '',
      id = json['id'] as String? ?? '',
      title = json['title'] as String? ?? '',
      body = json['body'] as String?,
      cwd = json['cwd'] as String?,
      sessionFile = json['sessionFile'] as String?,
      slotId = json['slotId'] as String?,
      createdAt = _time(json['createdAt']),
      data = (json['data'] as Map?)?.cast<String, dynamic>() ?? const {};

  final String kind;
  final String id;
  final String title;
  final String? body;
  final String? cwd;
  final String? sessionFile;
  final String? slotId;
  final DateTime? createdAt;
  final Json data;

  /// Items the user handles on the tasks page (the rest have their own pages).
  bool get isTaskItem => kind != 'memory' && kind != 'proposal';
}

/// One finished run (A5 execution trace), for the summary under a reply.
class RunInfo {
  RunInfo.fromJson(Json json)
    : id = json['id'] as String? ?? '',
      status = json['status'] as String? ?? '',
      turns = _int(json['turns']),
      toolCalls = _int(json['toolCalls']),
      toolErrors = _int(json['toolErrors']),
      cost = (json['cost'] as num?)?.toDouble() ?? 0,
      tokens = _int(json['inputTokens']) + _int(json['outputTokens']) + _int(json['cacheRead']),
      startedAt = _time(json['startedAt']),
      endedAt = _time(json['endedAt']),
      error = json['error'] as String?,
      files = [for (final f in (json['files'] as List? ?? const [])) if (f is String) f];

  final String id;
  final String status;
  final int turns;
  final int toolCalls;
  final int toolErrors;
  final double cost;
  final int tokens;
  final DateTime? startedAt;
  final DateTime? endedAt;
  final String? error;
  final List<String> files;

  Duration get duration => startedAt == null || endedAt == null ? Duration.zero : endedAt!.difference(startedAt!);
}

class RunStepInfo {
  RunStepInfo.fromJson(Json json)
    : kind = json['kind'] as String? ?? '',
      name = json['name'] as String?,
      summary = json['summary'] as String?,
      status = json['status'] as String?,
      durationMs = (json['durationMs'] as num?)?.toInt();

  final String kind;
  final String? name;
  final String? summary;
  final String? status;
  final int? durationMs;
}

String formatDuration(Duration d) {
  if (d.inSeconds < 60) return '${d.inSeconds} 秒';
  if (d.inMinutes < 60) return '${d.inMinutes} 分 ${d.inSeconds % 60} 秒';
  return '${d.inHours} 小时 ${d.inMinutes % 60} 分';
}
