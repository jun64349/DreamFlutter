// Compatibility for the old T11 native entrypoint, updated to v0.8 flows.
// This command NOW uses isolated Core + scripted Faux; it never calls a paid
// model or copies production credentials. Historical T11 paid results remain
// historical evidence in docs/testing/scenarios.md, not current acceptance.
import 'e2e_test.dart' as current;
void main()=>current.main();
// Preserve the opt-in widget runner's import while T91 owns the scenarios.
void runT11Live()=>current.main();
