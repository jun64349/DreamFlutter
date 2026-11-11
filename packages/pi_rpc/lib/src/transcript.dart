/// Folds Pi's session event stream into a display-ready transcript.
///
/// Rules (see Pi docs: json.md#reconstruct-streaming-messages):
/// - `message_update` deltas are appended per `contentIndex` for live display;
///   `*_end` deltas and `message_end` replace them with authoritative content.
/// - Tool calls live inside assistant messages; their execution state is
///   tracked separately in [Transcript.tools], keyed by tool call id, and tool
///   result messages are folded into that state instead of becoming items.
/// - Only `agent_settled` ends a run; `agent_end` may be followed by retries,
///   compaction or queued messages.
library;

import 'events.dart';
import 'json.dart';
import 'messages.dart';

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

sealed class TranscriptItem {
  TranscriptItem(this.key);

  /// Stable identity for list rendering.
  final String key;
  String? entryId;
}

class UserItem extends TranscriptItem {
  UserItem(super.key, {required this.text, this.images = const [], this.timestamp = 0});
  String text;
  int timestamp;
  List<ImageBlock> images;
}

class AssistantItem extends TranscriptItem {
  AssistantItem(super.key);

  final List<AssistantPart> parts = [];
  bool streaming = true;
  String stopReason = 'pending';
  String? errorMessage;
  String model = '';
  Usage? usage;

  /// When the message was created (ms since epoch; 0 if unknown).
  int timestamp = 0;

  /// Live timing, only known for messages streamed while the window watched:
  /// the request (turn start), the first streamed token, and the end.
  DateTime? requestedAt;
  DateTime? firstTokenAt;
  DateTime? endedAt;

  bool get aborted => stopReason == 'aborted';
  bool get failed => stopReason == 'error';
  bool get truncated => stopReason == 'length';

  Duration? get timeToFirstToken => requestedAt == null || firstTokenAt == null ? null : firstTokenAt!.difference(requestedAt!);

  Duration? get duration => requestedAt == null || endedAt == null ? null : endedAt!.difference(requestedAt!);

  /// Output tokens per second while generating.
  double? get tokensPerSecond {
    final output = usage?.output ?? 0;
    if (firstTokenAt == null || endedAt == null || output == 0) return null;
    final ms = endedAt!.difference(firstTokenAt!).inMilliseconds;
    return ms <= 0 ? null : output * 1000 / ms;
  }
}

sealed class AssistantPart {}

class TextPart extends AssistantPart {
  TextPart(this.text);
  String text;
}

class ThinkingPart extends AssistantPart {
  ThinkingPart(this.text, {this.redacted = false, this.durationMs});
  String text;
  bool redacted;

  /// How long the model thought (live messages only).
  int? durationMs;
}

/// Placeholder for a tool call; details live in [Transcript.tools].
class ToolCallPart extends AssistantPart {
  ToolCallPart(this.toolCallId);
  final String toolCallId;
}

enum NoticeKind { retry, retryFailed, compaction, compactionFailed, shell, info, extensionError }

class NoticeItem extends TranscriptItem {
  NoticeItem(super.key, this.kind, this.message, {this.detail = ''});
  final NoticeKind kind;

  /// Primary text (error message, command, ...).
  final String message;

  /// Secondary text (shell output, attempt counter, ...).
  final String detail;
}

// ---------------------------------------------------------------------------
// Tool execution state
// ---------------------------------------------------------------------------

enum ToolStatus {
  /// The model is still streaming the call's arguments.
  drafting,

  /// The call is complete but has not started executing.
  pending,
  running,
  done,
  error,

  /// The run ended before the tool finished (abort or failure).
  interrupted,
}

class ToolRun {
  ToolRun(this.id, this.name);

  final String id;
  String name;
  Json args = const {};

  /// Raw argument JSON while the model is still streaming it.
  String argsDraft = '';
  ToolStatus status = ToolStatus.drafting;
  List<ContentBlock> output = const [];
  int? durationMs;

  /// Tool-specific result data, e.g. the edit tool's unified `patch`.
  Json details = const {};

  String get outputText => textOf(output);
  bool get isActive => status == ToolStatus.drafting || status == ToolStatus.pending || status == ToolStatus.running;
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

class Transcript {
  Transcript({DateTime Function()? clock}) : _clock = clock ?? DateTime.now;

  final DateTime Function() _clock;
  final List<TranscriptItem> _items = [];
  final Map<String, ToolRun> _tools = {};
  var _nextKey = 0;
  AssistantItem? _streaming;

  /// Assistant parts indexed by `contentIndex` for the message being streamed.
  final Map<int, AssistantPart> _streamingParts = {};

  /// When the current turn's request went out, and when each streamed
  /// thinking part started.
  DateTime? _turnStartedAt;
  final Map<int, DateTime> _thinkingStartedAt = {};

  /// Incremented on every change, so listeners can cheaply detect updates.
  int revision = 0;

  /// True from `agent_start` until `agent_settled`.
  bool isRunning = false;
  bool isCompacting = false;
  List<String> queuedSteering = const [];
  List<String> queuedFollowUp = const [];

  /// Usage reported by the most recent assistant response.
  Usage? lastUsage;

  List<TranscriptItem> get items => List.unmodifiable(_items);
  Map<String, ToolRun> get tools => Map.unmodifiable(_tools);
  ToolRun? tool(String id) => _tools[id];

  String _key(String prefix) => '$prefix-${_nextKey++}';

  void clear() {
    _items.clear();
    _tools.clear();
    _streaming = null;
    _streamingParts.clear();
    _thinkingStartedAt.clear();
    _turnStartedAt = null;
    isRunning = false;
    isCompacting = false;
    queuedSteering = const [];
    queuedFollowUp = const [];
    lastUsage = null;
    revision++;
  }

  /// Replaces the transcript with persisted history (e.g. from `get_messages`).
  void loadHistory(Iterable<AgentMessage> messages) {
    clear();
    for (final message in messages) {
      _addCompletedMessage(message);
    }
    for (final run in _tools.values) {
      if (run.isActive) run.status = ToolStatus.interrupted;
    }
    revision++;
  }

  /// Applies one event. Returns true if the transcript changed.
  bool apply(PiEvent event) {
    final changed = _apply(event);
    if (changed) revision++;
    return changed;
  }

  bool _apply(PiEvent event) {
    switch (event) {
      case AgentStartEvent():
        isRunning = true;
        return true;
      case AgentSettledEvent():
        _settle();
        return true;
      case MessageStartEvent(:final message):
        return _onMessageStart(message);
      case MessageUpdateEvent(:final delta, :final usage):
        return _onDelta(delta, usage);
      case MessageEndEvent(:final message):
        return _onMessageEnd(message);
      case ToolExecutionStartEvent(:final toolCallId, :final toolName, :final args):
        _toolRun(toolCallId, toolName)
          ..args = args
          ..status = ToolStatus.running;
        return true;
      case ToolExecutionUpdateEvent(:final toolCallId, :final partialContent, :final partialDetails):
        final run = _tools[toolCallId];
        if (run == null) return false;
        run.output = partialContent;
        if (partialDetails.isNotEmpty) run.details = partialDetails;
        return true;
      case ToolExecutionEndEvent(:final toolCallId, :final toolName, :final content, :final isError, :final durationMs, :final details):
        _toolRun(toolCallId, toolName)
          ..output = content
          ..status = isError ? ToolStatus.error : ToolStatus.done
          ..durationMs = durationMs
          ..details = details;
        return true;
      case QueueUpdateEvent(:final steering, :final followUp):
        queuedSteering = steering;
        queuedFollowUp = followUp;
        return true;
      case CompactionStartEvent():
        isCompacting = true;
        return true;
      case CompactionEndEvent(:final succeeded, :final aborted, :final errorMessage, :final tokensBefore, :final reason):
        isCompacting = false;
        if (succeeded) {
          _items.add(NoticeItem(_key('n'), NoticeKind.compaction, reason, detail: '$tokensBefore'));
        } else if (!aborted) {
          _items.add(NoticeItem(_key('n'), NoticeKind.compactionFailed, errorMessage ?? ''));
        }
        return true;
      case AutoRetryStartEvent(:final attempt, :final maxAttempts, :final delayMs, :final errorMessage):
        _items.add(NoticeItem(_key('n'), NoticeKind.retry, errorMessage, detail: '$attempt/$maxAttempts/$delayMs'));
        return true;
      case AutoRetryEndEvent(:final success, :final finalError):
        if (success) return false;
        _items.add(NoticeItem(_key('n'), NoticeKind.retryFailed, finalError ?? ''));
        return true;
      case ExtensionErrorEvent(:final extensionPath, :final error):
        _items.add(NoticeItem(_key('n'), NoticeKind.extensionError, error, detail: extensionPath));
        return true;
      case TurnStartEvent():
        _turnStartedAt = _clock();
        return false;
      case AgentEndEvent() ||
          TurnEndEvent() ||
          SessionInfoChangedEvent() ||
          ThinkingLevelChangedEvent() ||
          UnknownEvent():
        return false;
    }
  }

  ToolRun _toolRun(String id, String name) {
    final run = _tools.putIfAbsent(id, () => ToolRun(id, name));
    if (name.isNotEmpty) run.name = name;
    return run;
  }

  bool _onMessageStart(AgentMessage message) {
    switch (message) {
      case AssistantMessage():
        final item = AssistantItem(_key('a'))
          ..model = message.model
          ..timestamp = message.timestamp
          ..requestedAt = _turnStartedAt ?? _clock();
        _turnStartedAt = null;
        _streaming = item;
        _streamingParts.clear();
        _thinkingStartedAt.clear();
        _items.add(item);
        return true;
      case UserMessage():
        _items.add(UserItem(_key('u'), text: message.text, images: message.content.whereType<ImageBlock>().toList(), timestamp: message.timestamp));
        return true;
      default:
        // Other roles are added once complete.
        return false;
    }
  }

  bool _onDelta(AssistantDelta delta, Usage usage) {
    final item = _streaming;
    if (item == null) return false;
    final index = delta.contentIndex;
    if (delta.kind != AssistantDeltaKind.other) item.firstTokenAt ??= _clock();
    switch (delta.kind) {
      case AssistantDeltaKind.textStart:
        _setPart(item, index, TextPart(''));
      case AssistantDeltaKind.textDelta:
        final part = _streamingParts[index];
        if (part is TextPart) {
          part.text += delta.delta;
        } else {
          _setPart(item, index, TextPart(delta.delta));
        }
      case AssistantDeltaKind.textEnd:
        final part = _streamingParts[index];
        if (part is TextPart && delta.content != null) part.text = delta.content!;
      case AssistantDeltaKind.thinkingStart:
        _setPart(item, index, ThinkingPart(''));
      case AssistantDeltaKind.thinkingDelta:
        final part = _streamingParts[index];
        if (part is ThinkingPart) {
          part.text += delta.delta;
        } else {
          _setPart(item, index, ThinkingPart(delta.delta));
        }
      case AssistantDeltaKind.thinkingEnd:
        final part = _streamingParts[index];
        if (part is ThinkingPart && delta.content != null) part.text = delta.content!;
        _finishThinking();
      case AssistantDeltaKind.toolCallStart:
        final id = delta.toolCallId ?? 'tool-$index-${item.key}';
        _toolRun(id, delta.toolName ?? '');
        _setPart(item, index, ToolCallPart(id));
      case AssistantDeltaKind.toolCallDelta:
        final part = _streamingParts[index];
        if (part is ToolCallPart) _tools[part.toolCallId]?.argsDraft += delta.delta;
      case AssistantDeltaKind.toolCallEnd:
        final call = delta.toolCall;
        if (call == null) return false;
        final previous = _streamingParts[index];
        if (previous is ToolCallPart && previous.toolCallId != call.id) {
          _tools.remove(previous.toolCallId);
          _setPart(item, index, ToolCallPart(call.id));
        }
        _applyToolCallBlock(call);
      case AssistantDeltaKind.other:
        return false;
    }
    if (usage.totalTokens > 0) item.usage = usage;
    return true;
  }

  void _setPart(AssistantItem item, int index, AssistantPart part) {
    // A new part ends any thinking before it that had no explicit end.
    _finishThinking(except: index);
    if (part is ThinkingPart) _thinkingStartedAt[index] = _clock();
    _streamingParts[index] = part;
    final keys = _streamingParts.keys.toList()..sort();
    item.parts
      ..clear()
      ..addAll(keys.map((k) => _streamingParts[k]!));
  }

  /// Records how long the streamed thinking parts took (all but [except]).
  void _finishThinking({int? except}) {
    final now = _clock();
    for (final index in _thinkingStartedAt.keys.where((i) => i != except).toList()) {
      final part = _streamingParts[index];
      if (part is ThinkingPart) part.durationMs ??= now.difference(_thinkingStartedAt[index]!).inMilliseconds;
      _thinkingStartedAt.remove(index);
    }
  }

  void _applyToolCallBlock(ToolCallBlock call) {
    final run = _toolRun(call.id, call.name)..args = call.arguments;
    if (run.status == ToolStatus.drafting) run.status = ToolStatus.pending;
  }

  bool _onMessageEnd(AgentMessage message) {
    switch (message) {
      case AssistantMessage():
        final item = _streaming ?? (AssistantItem(_key('a'))..parts.clear());
        if (_streaming == null) _items.add(item);
        _finishThinking();
        final keys = _streamingParts.keys.toList()..sort();
        final thinkingDurations = [
          for (final k in keys)
            if (_streamingParts[k] case ThinkingPart(:final durationMs)) durationMs,
        ];
        if (_streaming != null) item.endedAt = _clock();
        _fillAssistant(item, message, thinkingDurations: thinkingDurations);
        _streaming = null;
        _streamingParts.clear();
        return true;
      case UserMessage():
        final last = _items.isEmpty ? null : _items.last;
        if (last is UserItem) {
          last
            ..text = message.text
            ..timestamp = message.timestamp
            ..images = message.content.whereType<ImageBlock>().toList();
        } else {
          _addCompletedMessage(message);
        }
        return true;
      default:
        return _addCompletedMessage(message);
    }
  }

  void _fillAssistant(AssistantItem item, AssistantMessage message, {List<int?> thinkingDurations = const []}) {
    item
      ..streaming = false
      ..stopReason = message.stopReason
      ..errorMessage = message.errorMessage
      ..model = message.model
      ..usage = message.usage
      ..timestamp = message.timestamp;
    lastUsage = message.usage;
    item.parts.clear();
    var thinkingIndex = 0;
    for (final block in message.content) {
      switch (block) {
        case TextBlock(:final text):
          item.parts.add(TextPart(text));
        case ThinkingBlock(:final thinking, :final redacted):
          final durationMs = thinkingIndex < thinkingDurations.length ? thinkingDurations[thinkingIndex] : null;
          thinkingIndex++;
          item.parts.add(ThinkingPart(thinking, redacted: redacted, durationMs: durationMs));
        case ToolCallBlock():
          _applyToolCallBlock(block);
          item.parts.add(ToolCallPart(block.id));
        case ImageBlock() || UnknownBlock():
          break;
      }
    }
  }

  /// Adds a message that arrived complete (history, or non-streamed roles).
  bool _addCompletedMessage(AgentMessage message) {
    switch (message) {
      case UserMessage():
        _items.add(UserItem(_key('u'), text: message.text, images: message.content.whereType<ImageBlock>().toList(), timestamp: message.timestamp));
      case AssistantMessage():
        final item = AssistantItem(_key('a'));
        _items.add(item);
        _fillAssistant(item, message);
      case ToolResultMessage(:final toolCallId, :final toolName, :final content, :final isError, :final durationMs, :final details):
        final run = _toolRun(toolCallId, toolName);
        if (run.output.isEmpty || run.isActive) run.output = content;
        run
          ..status = isError ? ToolStatus.error : ToolStatus.done
          ..durationMs ??= durationMs
          ..details = details.isEmpty ? run.details : details;
      case BashExecutionMessage(:final command, :final output, :final exitCode):
        _items.add(NoticeItem(_key('n'), NoticeKind.shell, command, detail: '$output\n[exit ${exitCode ?? '?'}]'));
      case CustomMessage(:final display, :final content):
        if (!display) return false;
        _items.add(NoticeItem(_key('n'), NoticeKind.info, textOf(content)));
      case SummaryMessage(:final summary):
        _items.add(NoticeItem(_key('n'), NoticeKind.compaction, 'summary', detail: summary));
      case SystemMessage() || UnknownMessage():
        return false;
    }
    return true;
  }

  /// Binds stable backend entry ids without changing list keys or streaming
  /// state. Matching from the end also works after compaction hides history.
  void bindEntries(List<Json> branch) {
    var end = branch.length;
    for (final item in _items.reversed) {
      final role = item is UserItem ? 'user' : item is AssistantItem ? 'assistant' : null;
      if (role == null) continue;
      final stamp = item is UserItem ? item.timestamp : (item as AssistantItem).timestamp;
      for (var i = end - 1; i >= 0; i--) {
        final message = branch[i]['message'];
        if (message is! Map || message['role'] != role || message['timestamp'] != stamp) continue;
        if (item is UserItem && textOf(ContentBlock.listFrom(message['content'])) != item.text) continue;
        item.entryId = branch[i]['id'] as String?;
        // 0.8.2: a reply loaded from history has no live timing. Its message is stamped when the
        // request went out and its entry when it was saved (the end): enough for its duration.
        if (item is AssistantItem && item.requestedAt == null && item.endedAt == null && item.timestamp > 0) {
          final saved = DateTime.tryParse('${branch[i]['timestamp'] ?? ''}');
          if (saved != null && !saved.isBefore(DateTime.fromMillisecondsSinceEpoch(item.timestamp))) {
            item.requestedAt = DateTime.fromMillisecondsSinceEpoch(item.timestamp);
            item.endedAt = saved.toLocal();
          }
        }
        end = i;
        break;
      }
    }
  }

  void _settle() {
    isRunning = false;
    isCompacting = false;
    final streaming = _streaming;
    if (streaming != null) {
      streaming.streaming = false;
      if (streaming.stopReason == 'pending') streaming.stopReason = 'aborted';
    }
    _streaming = null;
    _streamingParts.clear();
    for (final run in _tools.values) {
      if (run.isActive) run.status = ToolStatus.interrupted;
    }
  }
}
