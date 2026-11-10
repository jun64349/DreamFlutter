import 'package:dreamflutter/state/mentions.dart';
import 'package:dreamflutter/state/work_models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('mentions travel in the core\'s tags and come back as chips', () {
    final mentions = [
      const Mention(kind: MentionKind.note, title: '发布清单', content: '- 改价格'),
      const Mention(kind: MentionKind.text, title: '会议纪要', content: '周一决定延期'),
      Mention.file(r'C:\work\去年数据.xlsx'),
      Mention.file(r'C:\work\素材', folder: true),
    ];
    final text = composeWithMentions('照这个准备材料', mentions);
    expect(text, contains('<写笺 标题="发布清单">'));
    expect(text, contains('- 文件：C:\\work\\去年数据.xlsx'));
    expect(text, contains('- 文件夹：C:\\work\\素材'));
    expect(text, contains('需要时用工具读取'));

    final (clean, back) = splitMentions(text);
    expect(clean, '照这个准备材料');
    expect(back.map((m) => (m.kind, m.title)), [
      (MentionKind.note, '发布清单'),
      (MentionKind.text, '会议纪要'),
      (MentionKind.file, '去年数据.xlsx'),
      (MentionKind.folder, '素材'),
    ]);
    expect(back.first.content, '- 改价格');
  });

  test('plain messages are left alone', () {
    expect(composeWithMentions('你好', const []), '你好');
    expect(splitMentions('a <b> c'), ('a <b> c', const <Mention>[]));
  });

  test('T93 legacy note tags remain readable and serializable with current display names', () {
    const saved='按这个做\n\n<写笺 标题="旧任务">\n保留旧内容\n</写笺>';
    final (text, mentions)=splitMentions(saved);
    expect(text,'按这个做');
    expect(mentions.single.kind,MentionKind.note);
    expect(mentions.single.content,'保留旧内容');
    expect(composeWithMentions(text,mentions),saved);
    final note=TaskInfo.fromJson({'source':'note','noteId':'old-note'});
    expect(note.source,'note'); expect(note.noteId,'old-note'); expect(note.sourceLabel,'任务');
    final template=TaskInfo.fromJson({'source':'template'});
    expect(template.source,'template'); expect(template.sourceLabel,'技能');
  });
}
