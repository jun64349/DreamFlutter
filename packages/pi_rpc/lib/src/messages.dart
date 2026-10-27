/// Pi transcript values (see Pi docs: message-types.md).
library;

import 'dart:convert';

import 'json.dart';

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

sealed class ContentBlock {
  const ContentBlock();

  static ContentBlock fromJson(Json json) => switch (json['type']) {
    'text' => TextBlock(asString(json['text']) ?? ''),
    'thinking' => ThinkingBlock(asString(json['thinking']) ?? '', redacted: asBool(json['redacted'])),
    'toolCall' => ToolCallBlock(
      id: asString(json['id']) ?? '',
      name: asString(json['name']) ?? '',
      arguments: asJson(json['arguments']),
    ),
    'image' => ImageBlock(data: asString(json['data']) ?? '', mimeType: asString(json['mimeType']) ?? ''),
    _ => UnknownBlock(json),
  };

  /// User content may be a plain string or a list of blocks.
  static List<ContentBlock> listFrom(Object? content) {
    if (content is String) return content.isEmpty ? const [] : [TextBlock(content)];
    return asJsonList(content).map(ContentBlock.fromJson).toList();
  }
}

class TextBlock extends ContentBlock {
  const TextBlock(this.text);
  final String text;
}

class ThinkingBlock extends ContentBlock {
  const ThinkingBlock(this.thinking, {this.redacted = false});
  final String thinking;
  final bool redacted;
}

class ToolCallBlock extends ContentBlock {
  const ToolCallBlock({required this.id, required this.name, required this.arguments});
  final String id;
  final String name;
  final Json arguments;
}

class ImageBlock extends ContentBlock {
  const ImageBlock({required this.data, required this.mimeType});
  final String data;
  final String mimeType;

  Json toJson() => {'type': 'image', 'data': data, 'mimeType': mimeType};
}

class UnknownBlock extends ContentBlock {
  const UnknownBlock(this.raw);
  final Json raw;
}

/// Concatenated text of all [TextBlock]s.
String textOf(Iterable<ContentBlock> blocks) => blocks.whereType<TextBlock>().map((b) => b.text).join();

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

class Usage {
  const Usage({
    this.input = 0,
    this.output = 0,
    this.cacheRead = 0,
    this.cacheWrite = 0,
    this.totalTokens = 0,
    this.costTotal = 0,
  });

  factory Usage.fromJson(Json json) => Usage(
    input: asInt(json['input']),
    output: asInt(json['output']),
    cacheRead: asInt(json['cacheRead']),
    cacheWrite: asInt(json['cacheWrite']),
    totalTokens: asInt(json['totalTokens']),
    costTotal: asDouble(asJson(json['cost'])['total']),
  );

  final int input;
  final int output;
  final int cacheRead;
  final int cacheWrite;
  final int totalTokens;
  final double costTotal;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

sealed class AgentMessage {
  const AgentMessage({required this.timestamp, required this.raw});

  /// Unix milliseconds.
  final int timestamp;
  final Json raw;

  String get role;

  static AgentMessage fromJson(Json json) {
    final ts = asInt(json['timestamp']);
    return switch (json['role']) {
      'system' => SystemMessage(timestamp: ts, raw: json),
      'user' => UserMessage(content: ContentBlock.listFrom(json['content']), timestamp: ts, raw: json),
      'assistant' => AssistantMessage(
        content: ContentBlock.listFrom(json['content']),
        provider: asString(json['provider']) ?? '',
        model: asString(json['model']) ?? '',
        usage: Usage.fromJson(asJson(json['usage'])),
        stopReason: asString(json['stopReason']) ?? 'stop',
        errorMessage: asString(json['errorMessage']),
        timestamp: ts,
        raw: json,
      ),
      'toolResult' => ToolResultMessage(
        toolCallId: asString(json['toolCallId']) ?? '',
        toolName: asString(json['toolName']) ?? '',
        content: ContentBlock.listFrom(json['content']),
        isError: asBool(json['isError']),
        durationMs: json['durationMs'] is num ? asInt(json['durationMs']) : null,
        timestamp: ts,
        raw: json,
      ),
      'bashExecution' => BashExecutionMessage(
        command: asString(json['command']) ?? '',
        output: asString(json['output']) ?? '',
        exitCode: json['exitCode'] is num ? asInt(json['exitCode']) : null,
        cancelled: asBool(json['cancelled']),
        timestamp: ts,
        raw: json,
      ),
      'custom' => CustomMessage(
        customType: asString(json['customType']) ?? '',
        content: ContentBlock.listFrom(json['content']),
        display: asBool(json['display'], true),
        timestamp: ts,
        raw: json,
      ),
      'compactionSummary' || 'branchSummary' => SummaryMessage(
        role: json['role'] as String,
        summary: asString(json['summary']) ?? '',
        timestamp: ts,
        raw: json,
      ),
      _ => UnknownMessage(timestamp: ts, raw: json),
    };
  }
}

/// Carries prompt sections and tool declarations. Never shown in the chat.
class SystemMessage extends AgentMessage {
  const SystemMessage({required super.timestamp, required super.raw});
  @override
  String get role => 'system';
}

class UserMessage extends AgentMessage {
  const UserMessage({required this.content, required super.timestamp, required super.raw});
  final List<ContentBlock> content;
  @override
  String get role => 'user';
  String get text => textOf(content);
}

class AssistantMessage extends AgentMessage {
  const AssistantMessage({
    required this.content,
    required this.provider,
    required this.model,
    required this.usage,
    required this.stopReason,
    required this.errorMessage,
    required super.timestamp,
    required super.raw,
  });

  final List<ContentBlock> content;
  final String provider;
  final String model;
  final Usage usage;

  /// pending | stop | length | toolUse | error | aborted | deferred
  final String stopReason;
  final String? errorMessage;

  @override
  String get role => 'assistant';
}

class ToolResultMessage extends AgentMessage {
  const ToolResultMessage({
    required this.toolCallId,
    required this.toolName,
    required this.content,
    required this.isError,
    required this.durationMs,
    required super.timestamp,
    required super.raw,
  });

  final String toolCallId;
  final String toolName;
  final List<ContentBlock> content;
  final bool isError;
  final int? durationMs;

  @override
  String get role => 'toolResult';
}

class BashExecutionMessage extends AgentMessage {
  const BashExecutionMessage({
    required this.command,
    required this.output,
    required this.exitCode,
    required this.cancelled,
    required super.timestamp,
    required super.raw,
  });

  final String command;
  final String output;
  final int? exitCode;
  final bool cancelled;

  @override
  String get role => 'bashExecution';
}

class CustomMessage extends AgentMessage {
  const CustomMessage({
    required this.customType,
    required this.content,
    required this.display,
    required super.timestamp,
    required super.raw,
  });

  final String customType;
  final List<ContentBlock> content;
  final bool display;

  @override
  String get role => 'custom';
}

/// `compactionSummary` or `branchSummary`.
class SummaryMessage extends AgentMessage {
  const SummaryMessage({required this.role, required this.summary, required super.timestamp, required super.raw});

  @override
  final String role;
  final String summary;
}

/// A role this client does not know (extensions can add roles).
class UnknownMessage extends AgentMessage {
  const UnknownMessage({required super.timestamp, required super.raw});
  @override
  String get role => asString(raw['role']) ?? 'unknown';
}

/// Pretty-prints tool arguments for display.
String formatArguments(Json arguments) => const JsonEncoder.withIndent('  ').convert(arguments);
