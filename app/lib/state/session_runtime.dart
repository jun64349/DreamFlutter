import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:pi_rpc/pi_rpc.dart';

import 'preferences.dart';

enum ConnectionStatus {
  /// Launching Pi or switching sessions.
  starting,
  ready,

  /// Pi exited unexpectedly; [SessionRuntime.statusDetail] has its stderr.
  crashed,

  /// Node.js or the pinned Pi runtime could not be found.
  missingRuntime,
}

typedef ConfigResolver = PiLaunchConfig? Function(String workingDirectory, List<String> extraArgs);
typedef ClientLauncher = Future<PiRpcClient> Function(PiLaunchConfig config);

/// One Pi process and the session it is showing: transcript, model and
/// thinking selection, stats. Several runtimes can live side by side, so a
/// session keeps running in the background while the user works in another.
class SessionRuntime extends ChangeNotifier {
  SessionRuntime({
    required this.workspace,
    required this.preferences,
    required this.resolveConfig,
    required this.launch,
    required this.onToast,
    this.onSettled,
    this.onAttention,
    this.launchArgs = const [],
    DateTime Function()? clock,
  }) : _clock = clock ?? DateTime.now,
       lastActivity = (clock ?? DateTime.now)();

  /// The agent's working directory; fixed for the lifetime of the process.
  final String workspace;

  /// Extra CLI arguments for every launch (e.g. the project-trust decision).
  final List<String> launchArgs;
  final Preferences preferences;
  final ConfigResolver resolveConfig;
  final ClientLauncher launch;
  final DateTime Function() _clock;
  final void Function(String message) onToast;

  /// Called after every run settles (used for unread markers and list refresh).
  final void Function(SessionRuntime runtime)? onSettled;

  /// Called when an extension dialog needs the user's answer.
  final void Function(SessionRuntime runtime, ExtensionUiRequest request)? onAttention;

  PiRpcClient? _client;
  StreamSubscription<PiEvent>? _eventSub;
  StreamSubscription<ExtensionUiRequest>? _uiSub;
  Timer? _notifyTimer;
  var _disposed = false;

  final transcript = Transcript();
  ConnectionStatus status = ConnectionStatus.starting;
  String statusDetail = '';
  SessionState? state;
  List<PiModel> models = const [];
  List<String> thinkingLevels = const [];
  SessionStats stats = SessionStats.empty;

  /// Extension commands, prompt templates and skills, runnable as `/name`.
  List<SlashCommand> commands = const [];

  /// Extension dialogs waiting for an answer, oldest first.
  final List<ExtensionUiRequest> pendingDialogs = [];

  /// Status texts and widget lines published by extensions, by key.
  final Map<String, String> extensionStatuses = {};
  final Map<String, List<String>> extensionWidgets = {};

  /// Text an extension (or a fork) asked to place in the input box. The
  /// composer consumes it when [editorTextRevision] changes.
  String editorText = '';
  int editorTextRevision = 0;

  /// True while a manual compaction requested from the GUI is in progress.
  bool isCompacting = false;

  /// Why the last manual compaction failed, in plain words (null if it worked).
  String? lastCompactionError;

  /// Last time this session did or received something; drives idle cleanup.
  DateTime lastActivity;

  bool get isRunning => transcript.isRunning;
  bool get isReady => status == ConnectionStatus.ready;
  bool get isDisposed => _disposed;

  /// Session file path. Pi assigns it when the session is created, before the
  /// file is first written.
  String? get sessionPath => state?.sessionFile;

  /// A session nobody has typed into yet.
  bool get isPristine => transcript.items.isEmpty && !isRunning;

  PiModel? get model => state?.model;
  String get thinkingLevel => state?.thinkingLevel ?? 'off';

  String get title {
    final name = state?.sessionName;
    if (name != null && name.trim().isNotEmpty) return name;
    final firstUser = transcript.items.whereType<UserItem>().firstOrNull;
    return firstUser == null ? '新会话' : firstUser.text.replaceAll(RegExp(r'\s+'), ' ').trim();
  }

  // --- Lifecycle -----------------------------------------------------------

  /// Starts Pi on a new session, or on [sessionPath] to resume one.
  Future<void> start({String? sessionPath}) async {
    await _stopClient();
    transcript.clear();
    status = ConnectionStatus.starting;
    statusDetail = '';
    _notifyNow();

    final config = resolveConfig(workspace, [...launchArgs, if (sessionPath != null) ...['--session', sessionPath]]);
    if (config == null) {
      status = ConnectionStatus.missingRuntime;
      statusDetail = '找不到 Node.js 或 Pi 运行时（runtime/node_modules）。';
      _notifyNow();
      return;
    }
    try {
      final client = await launch(config);
      if (_disposed) {
        await client.dispose();
        return;
      }
      _client = client;
      _eventSub = client.events.listen(_onEvent);
      _uiSub = client.uiRequests.listen(_onUiRequest);
      client.closed.then((_) => _onClientClosed(client));

      final results = await Future.wait([client.getAvailableModels(), client.getAvailableThinkingLevels()]);
      models = results[0] as List<PiModel>;
      thinkingLevels = results[1] as List<String>;
      try {
        commands = await client.getCommands();
      } catch (_) {
        commands = const [];
      }
      if (!preferences.autoCompaction) await client.setAutoCompaction(false);
      if (sessionPath == null) {
        await _applyPreferredModel(client);
      } else {
        transcript.loadHistory(await client.getMessages());
      }
      await _refreshState(client);
      status = ConnectionStatus.ready;
    } catch (e) {
      status = ConnectionStatus.crashed;
      statusDetail = describeError(e);
    }
    _touch();
    _notifyNow();
  }

  Future<void> _applyPreferredModel(PiRpcClient client) async {
    final preferred = preferences.modelKey;
    final match = models.where((m) => m.key == preferred).firstOrNull;
    if (match != null) await client.setModel(match.provider, match.id);
    final level = preferences.thinkingLevel;
    if (level != null && thinkingLevels.contains(level)) await client.setThinkingLevel(level);
  }

  Future<void> _refreshState(PiRpcClient client) async {
    final results = await Future.wait([client.getState(), client.getSessionStats()]);
    state = results[0] as SessionState;
    stats = results[1] as SessionStats;
  }

  Future<void> _stopClient() async {
    final client = _client;
    _client = null;
    await _eventSub?.cancel();
    await _uiSub?.cancel();
    _eventSub = null;
    _uiSub = null;
    if (client != null) await client.dispose();
  }

  void _onClientClosed(PiRpcClient client) {
    if (_disposed || !identical(client, _client)) return; // intentional shutdown
    status = ConnectionStatus.crashed;
    final tail = client.stderrTail;
    statusDetail = [
      'Pi 进程意外退出（退出码 ${client.exitCode ?? '未知'}）。',
      if (tail.isNotEmpty) ...tail.skip(tail.length > 12 ? tail.length - 12 : 0),
    ].join('\n');
    transcript.apply(const AgentSettledEvent({'type': 'agent_settled', 'aborted': true}, aborted: true));
    pendingDialogs.clear();
    _notifyNow();
    onSettled?.call(this);
  }

  /// Restarts Pi on the same session (after a crash, for example).
  Future<void> restart() => start(sessionPath: sessionPath);

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _notifyTimer?.cancel();
    unawaited(_stopClient());
    super.dispose();
  }

  // --- Events --------------------------------------------------------------

  void _onEvent(PiEvent event) {
    _touch();
    final changed = transcript.apply(event);
    switch (event) {
      case AgentStartEvent():
        _notifyNow();
      case AgentSettledEvent():
        // A run that ended cannot be waiting for an answer any more.
        pendingDialogs.clear();
        _notifyNow();
        unawaited(_afterRun());
      case SessionInfoChangedEvent() || ThinkingLevelChangedEvent():
        final client = _client;
        if (client != null) unawaited(_refreshState(client).then((_) => _notifyNow(), onError: (_) {}));
      default:
        if (changed) _scheduleNotify();
    }
  }

  Future<void> _afterRun() async {
    final client = _client;
    if (client == null) return;
    try {
      await _refreshState(client);
    } catch (_) {}
    _notifyNow();
    onSettled?.call(this);
  }

  void _onUiRequest(ExtensionUiRequest request) {
    _touch();
    switch (request.method) {
      case 'select' || 'confirm' || 'input' || 'editor':
        pendingDialogs.add(request);
        onAttention?.call(this, request);
      case 'notify':
        onToast(request.message);
      case 'setStatus':
        final text = request.raw['statusText'];
        final key = request.raw['statusKey'] as String? ?? '';
        if (text is String && text.isNotEmpty) {
          extensionStatuses[key] = text;
        } else {
          extensionStatuses.remove(key);
        }
      case 'setWidget':
        final lines = request.raw['widgetLines'];
        final key = request.raw['widgetKey'] as String? ?? '';
        if (lines is List && lines.isNotEmpty) {
          extensionWidgets[key] = lines.whereType<String>().toList();
        } else {
          extensionWidgets.remove(key);
        }
      case 'set_editor_text':
        _setEditorText(request.raw['text'] as String? ?? '');
      default:
        return; // setTitle and unknown methods have no place in this UI
    }
    _notifyNow();
  }

  /// Answers an extension dialog. Pass exactly one of [value], [confirmed] or
  /// [cancelled].
  void answerDialog(ExtensionUiRequest request, {String? value, bool? confirmed, bool cancelled = false}) {
    if (!pendingDialogs.remove(request)) return;
    _client?.respondToUi(request.id, value: value, confirmed: confirmed, cancelled: cancelled);
    _touch();
    _notifyNow();
  }

  void _setEditorText(String text) {
    editorText = text;
    editorTextRevision++;
  }

  /// Coalesces streaming updates to ~25 rebuilds per second.
  void _scheduleNotify() {
    _notifyTimer ??= Timer(const Duration(milliseconds: 40), _notifyNow);
  }

  void _notifyNow() {
    _notifyTimer?.cancel();
    _notifyTimer = null;
    if (!_disposed) notifyListeners();
  }

  void _touch() => lastActivity = _clock();

  // --- Actions -------------------------------------------------------------

  /// Sends a prompt; while a run is active it steers the current run.
  Future<void> send(String text, {List<ImageBlock> images = const []}) async {
    final client = _client;
    final message = text.trim();
    if (client == null || (message.isEmpty && images.isEmpty) || !isReady) return;
    _touch();
    try {
      final disposition = await client.prompt(message, images: images, streamingBehavior: isRunning ? 'steer' : null);
      // Extension commands may change the session name, commands, etc.
      if (disposition == PromptDisposition.handled) {
        await _refreshState(client);
        _notifyNow();
      }
    } catch (e) {
      onToast('发送失败：${describeError(e)}');
    }
  }

  // --- Context -------------------------------------------------------------

  /// Summarizes older history. Returns a short result description, or null.
  Future<CompactionResult?> compact({String? instructions}) async {
    final client = _client;
    if (client == null || !isReady || isRunning || isCompacting) return null;
    isCompacting = true;
    lastCompactionError = null;
    _notifyNow();
    try {
      final result = await client.compact(customInstructions: instructions);
      transcript.loadHistory(await client.getMessages());
      await _refreshState(client);
      return result;
    } catch (e) {
      final message = describeError(e);
      lastCompactionError = message.contains('Nothing to compact')
          ? '会话内容还不多，暂时不需要压缩。'
          : message.contains('Already compacted')
          ? '已经压缩过了，后面还没有新的内容。'
          : '压缩失败：$message';
      return null;
    } finally {
      isCompacting = false;
      _touch();
      _notifyNow();
    }
  }

  Future<void> setAutoCompaction(bool enabled) async {
    final client = _client;
    if (client == null) return;
    try {
      await client.setAutoCompaction(enabled);
      await _refreshState(client);
    } catch (e) {
      onToast('设置自动压缩失败：${describeError(e)}');
    }
    _notifyNow();
  }

  // --- Branching -----------------------------------------------------------

  /// Forks a new session just before [message] and puts its text back into
  /// the input box for editing. Only valid while idle.
  Future<bool> forkFrom(UserItem message) async {
    final client = _client;
    if (client == null || !isReady || isRunning) return false;
    try {
      final points = await client.getForkMessages();
      final users = transcript.items.whereType<UserItem>().where((u) => u.text == message.text).toList();
      final occurrence = users.indexOf(message);
      final matches = points.where((point) => point.text.trim() == message.text.trim()).toList();
      if (matches.isEmpty) {
        onToast('这条消息不在当前分支上，无法分叉。');
        return false;
      }
      final point = matches[occurrence.clamp(0, matches.length - 1)];
      final text = await client.fork(point.entryId);
      if (text == null) return false;
      transcript.loadHistory(await client.getMessages());
      await _refreshState(client);
      _setEditorText(text);
      _touch();
      return true;
    } catch (e) {
      onToast('分叉失败：${describeError(e)}');
      return false;
    } finally {
      _notifyNow();
    }
  }

  /// Duplicates the current session into a new one. Only valid while idle.
  Future<bool> cloneSession() async {
    final client = _client;
    if (client == null || !isReady || isRunning) return false;
    try {
      if (!await client.clone()) return false;
      transcript.loadHistory(await client.getMessages());
      await _refreshState(client);
      _touch();
      return true;
    } catch (e) {
      onToast('复制会话失败：${describeError(e)}');
      return false;
    } finally {
      _notifyNow();
    }
  }

  Future<void> rename(String name) async {
    final client = _client;
    if (client == null) return;
    try {
      await client.setSessionName(name.trim());
      await _refreshState(client);
    } catch (e) {
      onToast('重命名失败：${describeError(e)}');
    }
    _notifyNow();
  }

  Future<void> abort() async {
    try {
      await _client?.abort();
    } catch (e) {
      onToast('停止失败：${describeError(e)}');
    }
  }

  /// Starts a fresh session in this process. Only valid while idle.
  Future<bool> newSessionInPlace() async {
    final client = _client;
    if (client == null || !isReady || isRunning) return false;
    try {
      if (!await client.newSession()) return false;
      transcript.clear();
      await _applyPreferredModel(client);
      await _refreshState(client);
      _touch();
      return true;
    } catch (e) {
      onToast('新建会话失败：${describeError(e)}');
      return false;
    } finally {
      _notifyNow();
    }
  }

  /// Switches this process to another persisted session. Only valid while idle.
  Future<bool> switchInPlace(String path) async {
    final client = _client;
    if (client == null || !isReady || isRunning) return false;
    status = ConnectionStatus.starting;
    _notifyNow();
    try {
      if (!await client.switchSession(path)) return false;
      transcript.loadHistory(await client.getMessages());
      await _refreshState(client);
      _touch();
      return true;
    } catch (e) {
      onToast('打开会话失败：${describeError(e)}');
      return false;
    } finally {
      status = ConnectionStatus.ready;
      _notifyNow();
    }
  }

  Future<void> selectModel(PiModel model) async {
    final client = _client;
    if (client == null) return;
    try {
      await client.setModel(model.provider, model.id);
      await preferences.setModelKey(model.key);
      await _refreshState(client);
    } catch (e) {
      onToast('切换模型失败：${describeError(e)}');
    }
    _notifyNow();
  }

  Future<void> selectThinkingLevel(String level) async {
    final client = _client;
    if (client == null) return;
    try {
      await client.setThinkingLevel(level);
      await preferences.setThinkingLevel(level);
      await _refreshState(client);
    } catch (e) {
      onToast('切换思考级别失败：${describeError(e)}');
    }
    _notifyNow();
  }

  static String describeError(Object error) => switch (error) {
    PiRpcException(:final message) => message,
    ProcessException(:final message) => message,
    _ => '$error',
  };
}
