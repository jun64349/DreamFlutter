import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:pi_rpc/pi_rpc.dart';

/// One authorization unit of a card (Showcard §4.6): a host, a program, a
/// tool or a folder.
class CardUnit {
  const CardUnit(this.kind, this.subject);

  factory CardUnit.fromJson(Json json) => CardUnit(json['kind'] as String? ?? '', json['subject'] as String? ?? '');

  final String kind;
  final String subject;

  String get kindLabel => switch (kind) {
    'net' => '网络访问',
    'exec' => '运行程序',
    'tool' => '使用工具',
    'dir' => '文件夹',
    _ => kind,
  };
}

class CardBindingInfo {
  const CardBindingInfo({required this.id, required this.tool, required this.label, required this.description, required this.known, required this.units});

  factory CardBindingInfo.fromJson(Json json) => CardBindingInfo(
    id: json['id'] as String? ?? '',
    tool: json['tool'] as String? ?? '',
    label: json['label'] as String? ?? '',
    description: json['description'] as String?,
    known: json['known'] != false,
    units: [for (final u in (json['units'] as List? ?? const [])) if (u is Map) CardUnit.fromJson(u.cast())],
  );

  final String id;
  final String tool;
  final String label;
  final String? description;
  final bool known;
  final List<CardUnit> units;
}

/// A card entity in the core (cards.ts `Card`).
class CardInfo {
  const CardInfo({
    required this.id,
    required this.title,
    required this.cwd,
    required this.sessionFile,
    required this.origin,
    required this.resident,
    required this.epoch,
    required this.version,
    required this.height,
    required this.snapshotAt,
    required this.updatedAt,
    required this.bindings,
    required this.preferredWidth,
    required this.hasAssets,
  });

  factory CardInfo.fromJson(Json json) => CardInfo(
    id: json['id'] as String? ?? '',
    title: json['title'] as String? ?? '卡片',
    cwd: json['cwd'] as String?,
    sessionFile: json['sessionFile'] as String?,
    origin: json['origin'] as String? ?? 'agent',
    resident: json['resident'] == true,
    epoch: (json['epoch'] as num?)?.toInt() ?? 1,
    version: (json['version'] as num?)?.toInt() ?? 1,
    height: (json['height'] as num?)?.toDouble(),
    snapshotAt: (json['snapshotAt'] as num?)?.toInt(),
    updatedAt: DateTime.fromMillisecondsSinceEpoch((json['updatedAt'] as num?)?.toInt() ?? 0),
    bindings: [for (final b in (json['bindings'] as List? ?? const [])) if (b is Map) CardBindingInfo.fromJson(b.cast())],
    preferredWidth: (json['preferredWidth'] as num?)?.toDouble(),
    hasAssets: json['hasAssets'] == true,
  );

  final String id;
  final String title;
  final String? cwd;
  final String? sessionFile;

  /// agent (shown in a conversation), pin (copied to the desk), import.
  final String origin;

  /// Lives on the desk on its own (pinned or imported).
  final bool resident;
  final int epoch;
  final int version;
  final double? height;
  final int? snapshotAt;
  final DateTime updatedAt;
  final List<CardBindingInfo> bindings;
  final double? preferredWidth;
  final bool hasAssets;
}

/// A remembered authorization of a card.
class CardGrant {
  const CardGrant(this.unit, this.scope);

  factory CardGrant.fromJson(Json json) => CardGrant(CardUnit.fromJson(json), json['scope'] as String? ?? 'session');

  final CardUnit unit;

  /// session (until the background service restarts) or always.
  final String scope;
}

/// What a card asks the user before a binding runs (cards.ts `PermissionQuestion`).
class CardQuestion {
  const CardQuestion(this.json);

  final Json json;

  CardUnit get unit => CardUnit(json['kind'] as String? ?? '', json['subject'] as String? ?? '');
  String get label => json['label'] as String? ?? '';
  String get tool => json['tool'] as String? ?? '';
  String? get description => json['description'] as String?;
  String get call => json['call'] as String? ?? '';
  bool get danger => json['danger'] == true;
  bool get imported => json['origin'] == 'import';
  int get epoch => (json['epoch'] as num?)?.toInt() ?? 0;
  String get digest => json['digest'] as String? ?? '';
}

/// Which cards run live (Showcard cards are WebViews; only a few may run at
/// once): the latest card of the conversation on screen and the one the user
/// clicked last. Every other card shows its last picture until clicked.
///
/// Cards restored from history may not call tools until the user touches
/// them (Showcard §3.2 history honesty); cards minted while this window runs
/// may ([fresh]).
class CardStage extends ChangeNotifier {
  String? _latest;
  String? _activated;
  final Set<String> _fresh = {};
  final Set<String> _touched = {};
  final Map<String, ({int stamp, Uint8List png})> _snapshots = {};

  String? get latest => _latest;
  String? get activated => _activated;

  bool isLive(String id) => id == _latest || id == _activated;

  /// The latest card of the visible conversation (from its transcript).
  void setLatest(String? id) {
    if (id == _latest) return;
    _latest = id;
    // Called while the chat builds: tell listeners afterwards.
    Future.microtask(notifyListeners);
  }

  void activate(String id) {
    if (_activated == id) return;
    _activated = id;
    _touched.add(id);
    notifyListeners();
  }

  final Map<String, int> _reloads = {};

  /// Asks every live view of [id] to load the card again (after an enlarged view closed, or on request).
  void reload(String id) {
    _reloads[id] = reloadCount(id) + 1;
    notifyListeners();
  }

  int reloadCount(String id) => _reloads[id] ?? 0;

  void markFresh(String id) => _fresh.add(id);

  void touch(String id) => _touched.add(id);

  /// May this card call tools now?
  bool armed(String id) => _fresh.contains(id) || _touched.contains(id);

  Uint8List? snapshot(String id, int stamp) {
    final hit = _snapshots[id];
    return hit != null && hit.stamp >= stamp ? hit.png : null;
  }

  void putSnapshot(String id, int stamp, Uint8List png) {
    _snapshots[id] = (stamp: stamp, png: png);
    if (_snapshots.length > 60) _snapshots.remove(_snapshots.keys.first);
  }

  void forget(String id) {
    _snapshots.remove(id);
    if (_activated == id) _activated = null;
  }
}

/// The id of the last card the agent showed in [transcript].
String? latestCardId(Transcript transcript) {
  String? id;
  for (final run in transcript.tools.values) {
    if (run.name != 'show_card') continue;
    final cardId = run.details['cardId'];
    if (cardId is String) id = cardId;
  }
  return id;
}

/// Host theme handed to cards as CSS custom properties (Showcard §1.6: the
/// names are this host's own).
Map<String, String> cardThemeVars({
  required String fg,
  required String muted,
  required String bg,
  required String surface,
  required String border,
  required String accent,
  required List<String> chart,
  required bool dark,
}) => {
  '--fg': fg,
  '--muted': muted,
  '--bg': bg,
  '--surface': surface,
  '--border': border,
  '--accent': accent,
  '--chart': chart.join(','),
  '--font-sans': "'Noto Sans SC','Microsoft YaHei UI',system-ui,sans-serif",
  '--font-serif': "'Noto Serif SC','Source Han Serif SC','SimSun',serif",
  '--color-scheme': dark ? 'dark' : 'light',
  // The reference placeholder layer reads these (placeholder-source.js).
  '--ink': fg,
  '--well': surface,
  '--rule': border,
};

String encodeMessage(Map<String, Object?> message) => jsonEncode(message);
