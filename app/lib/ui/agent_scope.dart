import 'package:flutter/widgets.dart';

import '../state/agent_controller.dart';

/// Makes the [AgentController] available to the widget tree and rebuilds
/// dependents when it notifies.
class AgentScope extends InheritedNotifier<AgentController> {
  const AgentScope({super.key, required AgentController controller, required super.child})
    : super(notifier: controller);

  static AgentController of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<AgentScope>()!.notifier!;

  /// Reads the controller without subscribing to rebuilds (for callbacks).
  static AgentController read(BuildContext context) =>
      context.getInheritedWidgetOfExactType<AgentScope>()!.notifier!;
}
