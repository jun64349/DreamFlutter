import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/ui/zoom.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main(){
  test('new standard equals the accepted old +2 and 110 percent appearance',()async{
    SharedPreferences.setMockInitialValues({});
    final p=await Preferences.load();
    expect(p.textScale,1.25);expect(p.zoom,1.1);expect(zoomPercent(p.zoom),'100%');
    expect(p.paperTexture,'cotton');expect(p.paperStrength,.10);expect(p.decorativeMotion,isTrue);
  });
  test('saved appearance is not multiplied or reset during the baseline change',()async{
    for(final pair in [(1.25,1.1),(1.0,1.0),(.95,1.5)]){
      SharedPreferences.setMockInitialValues({'textScale':pair.$1,'zoom':pair.$2,'paperTexture':'grain','paperStrength':.025,'decorativeMotion':false});
      final p=await Preferences.load();
      expect(p.textScale,pair.$1);expect(p.zoom,pair.$2);
      expect(p.paperTexture,'grain');expect(p.paperStrength,.025);expect(p.decorativeMotion,isFalse);
    }
  });
}
