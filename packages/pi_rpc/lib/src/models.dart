/// Typed payloads of RPC command responses (see Pi docs: rpc-commands.md).
library;

import 'json.dart';

class PiModel {
  const PiModel({
    required this.provider,
    required this.id,
    required this.name,
    required this.reasoning,
    required this.contextWindow,
    required this.supportsImages,
  });

  factory PiModel.fromJson(Json json) => PiModel(
    provider: asString(json['provider']) ?? '',
    id: asString(json['id']) ?? '',
    name: asString(json['name']) ?? asString(json['id']) ?? '',
    reasoning: asBool(json['reasoning']),
    contextWindow: asInt(json['contextWindow']),
    supportsImages: asStringList(json['input']).contains('image'),
  );

  final String provider;
  final String id;
  final String name;
  final bool reasoning;
  final int contextWindow;
  final bool supportsImages;

  /// `provider/id`, unique across providers.
  String get key => '$provider/$id';

  @override
  bool operator ==(Object other) => other is PiModel && other.key == key;

  @override
  int get hashCode => key.hashCode;
}

class SessionState {
  const SessionState({
    required this.model,
    required this.thinkingLevel,
    required this.isStreaming,
    required this.isCompacting,
    required this.sessionId,
    required this.sessionFile,
    required this.sessionName,
    required this.messageCount,
    required this.pendingMessageCount,
    this.autoCompactionEnabled = true,
  });

  factory SessionState.fromJson(Json json) => SessionState(
    model: json['model'] is Map ? PiModel.fromJson(asJson(json['model'])) : null,
    thinkingLevel: asString(json['thinkingLevel']) ?? 'off',
    isStreaming: asBool(json['isStreaming']),
    isCompacting: asBool(json['isCompacting']),
    sessionId: asString(json['sessionId']) ?? '',
    sessionFile: asString(json['sessionFile']),
    sessionName: asString(json['sessionName']),
    messageCount: asInt(json['messageCount']),
    pendingMessageCount: asInt(json['pendingMessageCount']),
    autoCompactionEnabled: asBool(json['autoCompactionEnabled'], true),
  );

  final PiModel? model;
  final String thinkingLevel;
  final bool isStreaming;
  final bool isCompacting;
  final String sessionId;

  /// Absent for in-memory (`--no-session`) sessions.
  final String? sessionFile;
  final String? sessionName;
  final int messageCount;
  final int pendingMessageCount;
  final bool autoCompactionEnabled;
}

class SessionStats {
  const SessionStats({
    required this.totalTokens,
    required this.cost,
    required this.contextTokens,
    required this.contextWindow,
    required this.contextPercent,
    this.contextKnown = true,
    this.inputTokens = 0,
    this.outputTokens = 0,
    this.cacheReadTokens = 0,
    this.cacheWriteTokens = 0,
    this.userMessages = 0,
    this.assistantMessages = 0,
    this.toolCalls = 0,
    this.totalMessages = 0,
  });

  factory SessionStats.fromJson(Json json) {
    final context = asJson(json['contextUsage']);
    final tokens = asJson(json['tokens']);
    return SessionStats(
      totalTokens: asInt(tokens['total']),
      inputTokens: asInt(tokens['input']),
      outputTokens: asInt(tokens['output']),
      cacheReadTokens: asInt(tokens['cacheRead']),
      cacheWriteTokens: asInt(tokens['cacheWrite']),
      cost: asDouble(json['cost']),
      contextTokens: asInt(context['tokens']),
      contextWindow: asInt(context['contextWindow']),
      contextPercent: asDouble(context['percent']),
      // Null right after compaction until the next response reports usage.
      contextKnown: context['tokens'] is num,
      userMessages: asInt(json['userMessages']),
      assistantMessages: asInt(json['assistantMessages']),
      toolCalls: asInt(json['toolCalls']),
      totalMessages: asInt(json['totalMessages']),
    );
  }

  static const empty = SessionStats(totalTokens: 0, cost: 0, contextTokens: 0, contextWindow: 0, contextPercent: 0);

  final int totalTokens;
  final int inputTokens;
  final int outputTokens;
  final int cacheReadTokens;
  final int cacheWriteTokens;
  final int userMessages;
  final int assistantMessages;
  final int toolCalls;
  final int totalMessages;
  final bool contextKnown;
  final double cost;
  final int contextTokens;
  final int contextWindow;

  /// 0–100.
  final double contextPercent;
}

/// An extension command, prompt template, or skill runnable via `/name`.
class SlashCommand {
  const SlashCommand({required this.name, required this.description, required this.source});

  factory SlashCommand.fromJson(Json json) => SlashCommand(
    name: asString(json['name']) ?? '',
    description: asString(json['description']) ?? '',
    source: asString(json['source']) ?? '',
  );

  final String name;
  final String description;

  /// extension | prompt | skill
  final String source;
}

/// What happened to a submitted prompt.
enum PromptDisposition {
  /// A run started.
  started,

  /// Queued behind the current run (steer / follow-up).
  queued,

  /// Consumed by an extension command; no run started.
  handled,
  unknown;

  static PromptDisposition parse(Object? value) => switch (value) {
    'started' => started,
    'queued' => queued,
    'handled' => handled,
    _ => unknown,
  };
}

/// Result of a manual `compact`.
class CompactionResult {
  const CompactionResult({required this.tokensBefore, required this.estimatedTokensAfter});

  factory CompactionResult.fromJson(Json json) => CompactionResult(
    tokensBefore: asInt(json['tokensBefore']),
    estimatedTokensAfter: asInt(json['estimatedTokensAfter']),
  );

  final int tokensBefore;
  final int estimatedTokensAfter;
}

/// A user message on the active branch that a new session can fork from.
class ForkPoint {
  const ForkPoint({required this.entryId, required this.text});

  factory ForkPoint.fromJson(Json json) =>
      ForkPoint(entryId: asString(json['entryId']) ?? '', text: asString(json['text']) ?? '');

  final String entryId;
  final String text;
}
