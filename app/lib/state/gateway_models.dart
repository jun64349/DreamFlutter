import 'package:pi_rpc/pi_rpc.dart';

import 'backend.dart' show asJsonMap;
import 'work_models.dart' show jsonRows;

/// The model gateway as the core reports it (docs/v0.2-gateway.md).

/// Provider id the model groups are listed under.
const groupProvider = 'dreamflutter';

const channelKindNames = {'payg': '按量付费', 'plan': '编程套餐', 'relay': '中转站'};

/// Why a channel or key cannot take requests right now.
class Unavailable {
  Unavailable.fromJson(Json json)
    : kind = json['kind'] as String? ?? 'other',
      message = json['message'] as String? ?? '',
      until = (json['until'] as num?) == null ? null : DateTime.fromMillisecondsSinceEpoch((json['until'] as num).toInt());

  final String kind;
  final String message;
  final DateTime? until;

  static const _labels = {
    'rate_limit': '限流',
    'quota': '额度用完',
    'balance': '余额不足',
    'auth': 'Key 无效',
    'server': '服务器出错',
    'network': '连接失败',
    'other': '出错',
    'disabled': '已停用',
    'no_key': '没有可用的 Key',
    'missing': '找不到这个渠道或模型',
  };

  /// "额度用完，16:20 恢复"
  String describe() {
    final label = _labels[kind] ?? kind;
    final at = until;
    if (at == null) return label;
    final today = DateTime.now();
    final sameDay = at.year == today.year && at.month == today.month && at.day == today.day;
    String two(int n) => n.toString().padLeft(2, '0');
    return '$label，${sameDay ? '' : '${at.month}月${at.day}日 '}${two(at.hour)}:${two(at.minute)} 恢复';
  }

  /// Comes back by itself (a rest), as opposed to waiting for the user.
  bool get resting => until != null;
}

class ChannelKey {
  ChannelKey.fromJson(Json json)
    : id = json['id'] as String,
      label = json['label'] as String? ?? '',
      enabled = json['enabled'] != false,
      hint = json['hint'] as String? ?? '',
      unavailable = json['unavailable'] is Map ? Unavailable.fromJson(asJsonMap(json['unavailable'])) : null;

  final String id;
  final String label;
  final bool enabled;
  final String hint;
  final Unavailable? unavailable;
}

class GatewayChannel {
  GatewayChannel.fromJson(Json json)
    : id = json['id'] as String,
      source = json['source'] as String? ?? 'df',
      provider = json['provider'] as String? ?? '',
      name = json['name'] as String? ?? '',
      platform = json['platform'] as String?,
      kind = json['kind'] as String? ?? 'relay',
      api = json['api'] as String? ?? 'openai-completions',
      baseUrl = json['baseUrl'] as String? ?? '',
      models = jsonRows(json['models']),
      authHeader = json['authHeader'] == true,
      enabled = json['enabled'] != false,
      topUp = (json['topUp'] as num?)?.toDouble(),
      lowBalance = (json['lowBalance'] as num?)?.toDouble(),
      keys = jsonRows(json['keys']).map(ChannelKey.fromJson).toList(),
      unavailable = json['unavailable'] is Map ? Unavailable.fromJson(asJsonMap(json['unavailable'])) : null;

  final String id;

  /// "df": added in DreamFlutter; "pi": a provider from Pi's own configuration.
  final String source;
  final String provider;
  final String name;
  final String? platform;
  final String kind;
  final String api;
  final String baseUrl;
  final List<Json> models;
  final bool authHeader;
  final bool enabled;
  final double? topUp;
  final double? lowBalance;
  final List<ChannelKey> keys;
  final Unavailable? unavailable;

  bool get fromPi => source == 'pi';
  List<String> get modelIds => [for (final m in models) m['id'] as String];
}

class GroupEntry {
  GroupEntry({required this.channel, required this.model, this.priority = 0, this.weight = 0});

  GroupEntry.fromJson(Json json)
    : channel = json['channel'] as String,
      model = json['model'] as String,
      priority = (json['priority'] as num?)?.toInt() ?? 0,
      weight = (json['weight'] as num?)?.toDouble() ?? 0;

  String channel;
  String model;
  int priority;
  double weight;

  Json toJson() => {'channel': channel, 'model': model, 'priority': priority, 'weight': weight};
}

class ModelGroup {
  ModelGroup.fromJson(Json json)
    : id = json['id'] as String,
      name = json['name'] as String? ?? '',
      entries = jsonRows(json['entries']).map(GroupEntry.fromJson).toList(),
      allowPaidOverflow = json['allowPaidOverflow'] != false;

  final String id;
  final String name;
  final List<GroupEntry> entries;
  final bool allowPaidOverflow;

  String get modelKey => '$groupProvider/$id';
}

class GatewayPlatform {
  GatewayPlatform.fromJson(Json json)
    : id = json['id'] as String,
      name = json['name'] as String? ?? '',
      kind = json['kind'] as String? ?? 'relay',
      endpoints = [for (final e in jsonRows(json['endpoints'])) (api: e['api'] as String, baseUrl: e['baseUrl'] as String)],
      models = [for (final m in json['models'] as List? ?? const []) m as String],
      canQuery = json['quota'] != null;

  final String id;
  final String name;
  final String kind;
  final List<({String api, String baseUrl})> endpoints;
  final List<String> models;
  final bool canQuery;
}

class QuotaWindow {
  QuotaWindow.fromJson(Json json)
    : label = json['label'] as String? ?? '',
      usedPercent = (json['usedPercent'] as num?)?.toDouble() ?? 0,
      resetAt = (json['resetAt'] as num?) == null ? null : DateTime.fromMillisecondsSinceEpoch((json['resetAt'] as num).toInt());

  final String label;
  final double usedPercent;
  final DateTime? resetAt;
}

/// A channel's balance or plan allowance, as last read.
class QuotaReading {
  QuotaReading.fromJson(Json json)
    : type = json['type'] as String? ?? 'error',
      amount = (json['amount'] as num?)?.toDouble(),
      currency = json['currency'] as String? ?? 'CNY',
      windows = jsonRows(json['windows']).map(QuotaWindow.fromJson).toList(),
      message = json['message'] as String? ?? '',
      checkedAt = DateTime.fromMillisecondsSinceEpoch((json['checkedAt'] as num?)?.toInt() ?? 0);

  final String type;
  final double? amount;
  final String currency;
  final List<QuotaWindow> windows;
  final String message;
  final DateTime checkedAt;
}

class ChannelStatus {
  ChannelStatus.fromJson(Json json)
    : id = json['id'] as String,
      name = json['name'] as String? ?? '',
      kind = json['kind'] as String? ?? 'relay',
      source = json['source'] as String? ?? 'df',
      unavailable = json['unavailable'] is Map ? Unavailable.fromJson(asJsonMap(json['unavailable'])) : null,
      quota = json['quota'] is Map ? QuotaReading.fromJson(asJsonMap(json['quota'])) : null,
      canQuery = json['canQuery'] == true,
      requestsToday = (asJsonMap(json['today'])['requests'] as num?)?.toInt() ?? 0,
      failuresToday = (asJsonMap(json['today'])['failures'] as num?)?.toInt() ?? 0,
      costToday = (asJsonMap(json['today'])['cost'] as num?)?.toDouble() ?? 0,
      avgFirstTokenMs = (asJsonMap(json['today'])['avgFirstTokenMs'] as num?)?.toInt(),
      requests5h = (asJsonMap(json['last5h'])['requests'] as num?)?.toInt() ?? 0,
      spent = (json['spent'] as num?)?.toDouble() ?? 0,
      remaining = (json['remaining'] as num?)?.toDouble(),
      lastError = json['lastError'] is Map ? asJsonMap(json['lastError']) : null;

  final String id;
  final String name;
  final String kind;
  final String source;
  final Unavailable? unavailable;
  final QuotaReading? quota;
  final bool canQuery;
  final int requestsToday;
  final int failuresToday;
  final double costToday;
  final int? avgFirstTokenMs;
  final int requests5h;
  final double spent;
  final double? remaining;
  final Json? lastError;
}
