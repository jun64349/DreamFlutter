/// Records Pi writes to stdout in RPC mode (see Pi docs: rpc.md, json.md,
/// rpc-extension-ui.md): command responses, session events, and extension UI
/// requests.
library;

import 'json.dart';
import 'messages.dart';

sealed class PiRecord {
  const PiRecord(this.raw);
  final Json raw;

  static PiRecord fromJson(Json json) {
    final type = json['type'];
    if (type == 'response') return RpcResponse.fromJson(json);
    if (type == 'extension_ui_request') return ExtensionUiRequest.fromJson(json);
    return PiEvent.fromJson(json);
  }
}

/// A line on stdout that was not valid JSON. Kept so the client can log it
/// without tearing down the stream.
class MalformedRecord extends PiRecord {
  const MalformedRecord(this.line, this.error) : super(const {});
  final String line;
  final Object error;
}

class RpcResponse extends PiRecord {
  const RpcResponse({
    required this.id,
    required this.command,
    required this.success,
    required this.data,
    required this.error,
    required Json raw,
  }) : super(raw);

  factory RpcResponse.fromJson(Json json) => RpcResponse(
    id: asString(json['id']),
    command: asString(json['command']) ?? '',
    success: asBool(json['success']),
    data: json['data'],
    error: asString(json['error']),
    raw: json,
  );

  final String? id;
  final String command;
  final bool success;
  final Object? data;
  final String? error;
}

// ---------------------------------------------------------------------------
// Session events
// ---------------------------------------------------------------------------

sealed class PiEvent extends PiRecord {
  const PiEvent(super.raw);

  String get type => asString(raw['type']) ?? '';

  static PiEvent fromJson(Json json) {
    Json obj(String key) => asJson(json[key]);
    return switch (json['type']) {
      'agent_start' => AgentStartEvent(json),
      'agent_end' => AgentEndEvent(json, willRetry: asBool(json['willRetry'])),
      'agent_settled' => AgentSettledEvent(json, aborted: asBool(json['aborted'])),
      'turn_start' => TurnStartEvent(json),
      'turn_end' => TurnEndEvent(json),
      'message_start' => MessageStartEvent(json, AgentMessage.fromJson(obj('message'))),
      'message_update' => MessageUpdateEvent(
        json,
        AssistantDelta.fromJson(obj('assistantMessageEvent')),
        Usage.fromJson(obj('usage')),
      ),
      'message_end' => MessageEndEvent(json, AgentMessage.fromJson(obj('message'))),
      'tool_execution_start' => ToolExecutionStartEvent(
        json,
        toolCallId: asString(json['toolCallId']) ?? '',
        toolName: asString(json['toolName']) ?? '',
        args: obj('args'),
      ),
      'tool_execution_update' => ToolExecutionUpdateEvent(
        json,
        toolCallId: asString(json['toolCallId']) ?? '',
        partialContent: ContentBlock.listFrom(obj('partialResult')['content']),
      ),
      'tool_execution_end' => ToolExecutionEndEvent(
        json,
        toolCallId: asString(json['toolCallId']) ?? '',
        toolName: asString(json['toolName']) ?? '',
        content: ContentBlock.listFrom(obj('result')['content']),
        details: asJson(obj('result')['details']),
        isError: asBool(json['isError']),
        durationMs: json['durationMs'] is num ? asInt(json['durationMs']) : null,
      ),
      'queue_update' => QueueUpdateEvent(
        json,
        steering: asStringList(json['steering']),
        followUp: asStringList(json['followUp']),
      ),
      'compaction_start' => CompactionStartEvent(json, reason: asString(json['reason']) ?? ''),
      'compaction_end' => CompactionEndEvent(
        json,
        reason: asString(json['reason']) ?? '',
        aborted: asBool(json['aborted']),
        errorMessage: asString(json['errorMessage']),
        tokensBefore: asInt(obj('result')['tokensBefore']),
        succeeded: json['result'] is Map,
      ),
      'auto_retry_start' => AutoRetryStartEvent(
        json,
        attempt: asInt(json['attempt']),
        maxAttempts: asInt(json['maxAttempts']),
        delayMs: asInt(json['delayMs']),
        errorMessage: asString(json['errorMessage']) ?? '',
      ),
      'auto_retry_end' => AutoRetryEndEvent(
        json,
        success: asBool(json['success']),
        finalError: asString(json['finalError']),
      ),
      'session_info_changed' => SessionInfoChangedEvent(json, name: asString(json['name'])),
      'thinking_level_changed' => ThinkingLevelChangedEvent(json, level: asString(json['level']) ?? ''),
      'extension_error' => ExtensionErrorEvent(
        json,
        extensionPath: asString(json['extensionPath']) ?? '',
        error: asString(json['error']) ?? '',
      ),
      _ => UnknownEvent(json),
    };
  }
}

class AgentStartEvent extends PiEvent {
  const AgentStartEvent(super.raw);
}

class AgentEndEvent extends PiEvent {
  const AgentEndEvent(super.raw, {required this.willRetry});
  final bool willRetry;
}

/// Pi will not continue automatically. The only reliable "run finished" signal.
class AgentSettledEvent extends PiEvent {
  const AgentSettledEvent(super.raw, {required this.aborted});
  final bool aborted;
}

class TurnStartEvent extends PiEvent {
  const TurnStartEvent(super.raw);
}

class TurnEndEvent extends PiEvent {
  const TurnEndEvent(super.raw);
}

class MessageStartEvent extends PiEvent {
  const MessageStartEvent(super.raw, this.message);
  final AgentMessage message;
}

class MessageUpdateEvent extends PiEvent {
  const MessageUpdateEvent(super.raw, this.delta, this.usage);
  final AssistantDelta delta;
  final Usage usage;
}

/// Authoritative final message; replaces anything reconstructed from deltas.
class MessageEndEvent extends PiEvent {
  const MessageEndEvent(super.raw, this.message);
  final AgentMessage message;
}

class ToolExecutionStartEvent extends PiEvent {
  const ToolExecutionStartEvent(super.raw, {required this.toolCallId, required this.toolName, required this.args});
  final String toolCallId;
  final String toolName;
  final Json args;
}

class ToolExecutionUpdateEvent extends PiEvent {
  const ToolExecutionUpdateEvent(super.raw, {required this.toolCallId, required this.partialContent});
  final String toolCallId;

  /// Latest partial result reported by the tool (replaces earlier updates for
  /// built-in tools such as bash).
  final List<ContentBlock> partialContent;
}

class ToolExecutionEndEvent extends PiEvent {
  const ToolExecutionEndEvent(
    super.raw, {
    required this.toolCallId,
    required this.toolName,
    required this.content,
    required this.isError,
    required this.durationMs,
    this.details = const {},
  });
  final String toolCallId;
  final String toolName;
  final List<ContentBlock> content;
  final bool isError;
  final int? durationMs;

  /// Tool-specific result data (the edit tool's unified `patch`).
  final Json details;
}

class QueueUpdateEvent extends PiEvent {
  const QueueUpdateEvent(super.raw, {required this.steering, required this.followUp});
  final List<String> steering;
  final List<String> followUp;
}

class CompactionStartEvent extends PiEvent {
  const CompactionStartEvent(super.raw, {required this.reason});
  final String reason;
}

class CompactionEndEvent extends PiEvent {
  const CompactionEndEvent(
    super.raw, {
    required this.reason,
    required this.aborted,
    required this.errorMessage,
    required this.tokensBefore,
    required this.succeeded,
  });
  final String reason;
  final bool aborted;
  final String? errorMessage;
  final int tokensBefore;
  final bool succeeded;
}

class AutoRetryStartEvent extends PiEvent {
  const AutoRetryStartEvent(
    super.raw, {
    required this.attempt,
    required this.maxAttempts,
    required this.delayMs,
    required this.errorMessage,
  });
  final int attempt;
  final int maxAttempts;
  final int delayMs;
  final String errorMessage;
}

class AutoRetryEndEvent extends PiEvent {
  const AutoRetryEndEvent(super.raw, {required this.success, required this.finalError});
  final bool success;
  final String? finalError;
}

class SessionInfoChangedEvent extends PiEvent {
  const SessionInfoChangedEvent(super.raw, {required this.name});
  final String? name;
}

class ThinkingLevelChangedEvent extends PiEvent {
  const ThinkingLevelChangedEvent(super.raw, {required this.level});
  final String level;
}

class ExtensionErrorEvent extends PiEvent {
  const ExtensionErrorEvent(super.raw, {required this.extensionPath, required this.error});
  final String extensionPath;
  final String error;
}

/// An event type this client does not handle yet.
class UnknownEvent extends PiEvent {
  const UnknownEvent(super.raw);
}

// ---------------------------------------------------------------------------
// Streaming deltas inside message_update
// ---------------------------------------------------------------------------

enum AssistantDeltaKind {
  textStart,
  textDelta,
  textEnd,
  thinkingStart,
  thinkingDelta,
  thinkingEnd,
  toolCallStart,
  toolCallDelta,
  toolCallEnd,
  other,
}

class AssistantDelta {
  const AssistantDelta({
    required this.kind,
    required this.contentIndex,
    this.delta = '',
    this.content,
    this.toolCallId,
    this.toolName,
    this.toolCall,
  });

  factory AssistantDelta.fromJson(Json json) {
    final kind = switch (json['type']) {
      'text_start' => AssistantDeltaKind.textStart,
      'text_delta' => AssistantDeltaKind.textDelta,
      'text_end' => AssistantDeltaKind.textEnd,
      'thinking_start' => AssistantDeltaKind.thinkingStart,
      'thinking_delta' => AssistantDeltaKind.thinkingDelta,
      'thinking_end' => AssistantDeltaKind.thinkingEnd,
      'toolcall_start' => AssistantDeltaKind.toolCallStart,
      'toolcall_delta' => AssistantDeltaKind.toolCallDelta,
      'toolcall_end' => AssistantDeltaKind.toolCallEnd,
      _ => AssistantDeltaKind.other,
    };
    final toolCallJson = json['toolCall'];
    final toolCall = toolCallJson is Map ? ContentBlock.fromJson(asJson(toolCallJson)) : null;
    return AssistantDelta(
      kind: kind,
      contentIndex: asInt(json['contentIndex']),
      delta: asString(json['delta']) ?? '',
      content: asString(json['content']),
      toolCallId: asString(json['id']),
      toolName: asString(json['toolName']),
      toolCall: toolCall is ToolCallBlock ? toolCall : null,
    );
  }

  final AssistantDeltaKind kind;
  final int contentIndex;
  final String delta;

  /// Authoritative block text on text_end / thinking_end.
  final String? content;
  final String? toolCallId;
  final String? toolName;

  /// Complete tool call on toolcall_end.
  final ToolCallBlock? toolCall;
}

// ---------------------------------------------------------------------------
// Extension UI subprotocol
// ---------------------------------------------------------------------------

/// A request from an extension. Dialog methods (select, confirm, input,
/// editor) block Pi until the client answers with the same [id]; the rest are
/// fire-and-forget notifications.
class ExtensionUiRequest extends PiRecord {
  const ExtensionUiRequest(super.raw, {required this.id, required this.method});

  factory ExtensionUiRequest.fromJson(Json json) =>
      ExtensionUiRequest(json, id: asString(json['id']) ?? '', method: asString(json['method']) ?? '');

  final String id;

  /// select | confirm | input | editor | notify | setStatus | setWidget | setTitle | set_editor_text
  final String method;

  bool get isDialog => const {'select', 'confirm', 'input', 'editor'}.contains(method);
  String get title => asString(raw['title']) ?? '';
  String get message => asString(raw['message']) ?? '';
  List<String> get options => asStringList(raw['options']);
  String? get placeholder => asString(raw['placeholder']);
  String? get prefill => asString(raw['prefill']);
  String? get notifyType => asString(raw['notifyType']);
}
