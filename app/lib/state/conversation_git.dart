import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

import 'agent_controller.dart';

class ConversationGitState {
  const ConversationGitState({required this.isRepository, required this.head, required this.paths, this.root, this.suggestedMessage = '', this.diff = '', this.fingerprint, this.draftReason, this.createdPaths = const {}, this.modifiedPaths = const {}});
  final bool isRepository;
  final String? head;
  final String? root;
  final List<String> paths;
  final String suggestedMessage;
  final String diff;
  final String? fingerprint;
  final String? draftReason;
  final Set<String> createdPaths;
  final Set<String> modifiedPaths;
}

abstract interface class ConversationGitBridge {
  Future<ConversationGitState> inspect(String cwd, List<String> changedPaths);
  Future<ConversationGitState> prepare(String cwd, List<String> paths);
  Future<String> diff(String cwd, String path);
  Future<String> commit(String cwd, {required List<String> paths, required String message, required String? expectedHead, String? expectedFingerprint, List<String>? expectedPaths});
}

class ConversationGitException implements Exception {
  ConversationGitException(this.message);
  final String message;
  @override
  String toString() => message;
}

class RpcConversationGitBridge implements ConversationGitBridge {
  RpcConversationGitBridge(this.agent);
  final AgentController agent;
  Json _checked(Object? value) {
    final row = asJsonMap(value);
    if (row['ok'] != true) throw ConversationGitException(row['reason'] as String? ?? '暂时无法读取Git状态，请重试。');
    return row;
  }
  @override
  Future<ConversationGitState> inspect(String cwd, List<String> changedPaths) async {
    final row = asJsonMap(await agent.backend.call('git.status', {'cwd': cwd}));
    if (row['isRepository'] != true && (row['code'] == 'not_repository' || row['code'] == 'not_installed' || row['ok'] == true)) return ConversationGitState(isRepository: false, head: null, paths: const [], draftReason: row['reason'] as String?);
    _checked(row);
    final root = row['root'] as String;
    String full(String path) => p.normalize(p.isAbsolute(path) ? path : p.join(cwd, path));
    final files = jsonRows(row['files']);
    return ConversationGitState(
      isRepository: true, root: root, head: row['head'] as String?,
      paths: [for (final file in files) if (changedPaths.any((path) => SessionStore.samePath(full(path), p.join(root, file['path'] as String)))) file['path'] as String],
      createdPaths: {for (final file in files) if (file['index'] == '?' || file['index'] == 'A') p.normalize(p.join(root, file['path'] as String))},
      modifiedPaths: {for (final file in files) if (file['index'] != '?' && file['index'] != 'A') p.normalize(p.join(root, file['path'] as String))},
    );
  }
  @override
  Future<ConversationGitState> prepare(String cwd, List<String> paths) async {
    final row = _checked(await agent.backend.call('git.prepareCommit', {'cwd': cwd, 'paths': paths}));
    return ConversationGitState(isRepository: true, root: row['root'] as String?, head: row['head'] as String?, paths: (row['paths'] as List).cast<String>(), suggestedMessage: row['suggestedMessage'] as String? ?? '', diff: row['diff'] as String? ?? '', fingerprint: row['fingerprint'] as String?, draftReason: row['draftReason'] as String?);
  }
  @override
  Future<String> diff(String cwd, String path) async {
    final status = _checked(await agent.backend.call('git.status', {'cwd': cwd}));
    final root = status['root'] as String;
    final relative = p.relative(p.isAbsolute(path) ? path : p.join(cwd, path), from: root);
    return _checked(await agent.backend.call('git.diff', {'cwd': cwd, 'paths': [relative]}))['diff'] as String? ?? '';
  }
  @override
  Future<String> commit(String cwd, {required List<String> paths, required String message, required String? expectedHead, String? expectedFingerprint, List<String>? expectedPaths}) async {
    final row = _checked(await agent.backend.call('git.commit', {'cwd': cwd, 'paths': paths, 'message': message, 'expectedHead': expectedHead, 'expectedFingerprint': ?expectedFingerprint, 'expectedPaths': ?expectedPaths}));
    if (row['head'] is! String) throw ConversationGitException('Git没有返回提交结果，请重新检查仓库状态。');
    return row['head'] as String;
  }
}

class ConversationGitAdapters {
  /// Optional test override; ordinary windows always use the real RPC bridge.
  static ConversationGitBridge? Function(AgentController agent)? resolve;
}
