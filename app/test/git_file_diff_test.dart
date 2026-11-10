import 'package:dreamflutter/ui/git_file_diff.dart';
import 'package:dreamflutter/ui/message_widgets.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('file patches hide protocol headers while retaining header-like content and hunk gaps', () {
    final files=parseGitFileDiffs('diff --git a/report.md b/report.md\nindex a..b 100644\n--- a/report.md\n+++ b/report.md\n@@ -1 +1 @@\n----old text\n++++new text\n@@ -20 +20 @@\n context\n\\ No newline at end of file\ndiff --git a/new.md b/new.md\nnew file mode 100644\n--- /dev/null\n+++ b/new.md\n@@ -0,0 +1 @@\n+new file\n',['report.md','new.md']);
    expect(files.map((f)=>f.paths),[['report.md'],['new.md']]);
    expect(files.first.lines.map((l)=>l.kind),[DiffKind.removed,DiffKind.added,DiffKind.gap,DiffKind.context]);
    expect(files.first.lines.map((l)=>l.text),['---old text','+++new text','⋯','context']);
    expect(files.last.lines.single.text,'new file');
  });
  test('rename paths form one selectable file including quoted octal UTF8', () {
    final files=parseGitFileDiffs(r'''diff --git a/old.txt "b/\344\270\255\346\226\207 [x].txt"
similarity index 100%
rename from old.txt
rename to "\344\270\255\346\226\207 [x].txt"
''',['old.txt','中文 [x].txt']);
    expect(files,hasLength(1));expect(files.single.paths,['old.txt','中文 [x].txt']);expect(files.single.lines,isEmpty);
  });
  test('binary, mode-only, deleted and spaced names keep an honest readable diff', () {
    final files=parseGitFileDiffs('diff --git a/image file.bin b/image file.bin\nindex a..b\n二进制文件已更改\ndiff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\ndiff --git a/gone.md b/gone.md\ndeleted file mode 100644\n--- a/gone.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n',['image file.bin','run.sh','gone.md']);
    expect(files.map((f)=>f.paths.single),['image file.bin','run.sh','gone.md']);
    expect(files.map((f)=>f.lines.single.text),['二进制文件已更改','文件权限已更改','old']);
  });
}
