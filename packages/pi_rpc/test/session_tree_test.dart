import 'package:pi_rpc/pi_rpc.dart';
import 'package:test/test.dart';

void main() {
  test('current branch excludes sibling and binds raw user content without changing keys', () {
    final entries=<Json>[
      {'id':'u','parentId':null,'type':'message','message':{'role':'user','timestamp':10,'content':'same text'}},
      {'id':'a','parentId':'u','type':'message','message':{'role':'assistant','timestamp':20,'content':[{'type':'text','text':'answer'}]}},
      {'id':'sibling','parentId':'u','type':'message','message':{'role':'assistant','timestamp':20,'content':[{'type':'text','text':'other'}]}},
    ];
    final branch=currentSessionBranch({'leafId':'a','tree':[for(final e in entries) {'entry':e,'children':<Json>[]} ]});
    expect(branch.map((e)=>e['id']),['u','a']);
    final transcript=Transcript()..loadHistory(branch.map((e)=>AgentMessage.fromJson(e['message'] as Json)).toList());
    final keys=transcript.items.map((e)=>e.key).toList();
    transcript.bindEntries(branch);
    expect(transcript.items.map((e)=>e.entryId),['u','a']);
    expect(transcript.items.map((e)=>e.key),keys);
  });
  test('empty branch and malformed parent cycle terminate', () {
    expect(currentSessionBranch(null),isEmpty);
    expect(currentSessionBranch({'leafId':'a','tree':[{'entry':{'id':'a','parentId':'a'},'children':[]}]}),hasLength(1));
  });
}
