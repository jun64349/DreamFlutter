"""Locate the shared, application-shipped Office helper; copied skills use the bundled Python location."""
import json, pathlib, runpy, sys
if sys.platform != 'win32':
    print(json.dumps({'ok': False, 'code': 'not_available', 'reason': '本机没有可用的转换程序', 'detail': '蝶君/Linux 沙箱没有 Microsoft Office'}, ensure_ascii=True))
    raise SystemExit(2)
roots = [pathlib.Path(__file__).resolve().parents[3] / 'office', pathlib.Path(sys.executable).resolve().parents[2] / 'assets/office']
helper = next((root / 'convert_office.py' for root in roots if (root / 'convert_office.py').is_file()), None)
if helper is None:
    print(json.dumps({'ok': False, 'code': 'helper_missing', 'reason': '随包 Office 转换辅助缺失，请检查应用安装'}, ensure_ascii=True))
    raise SystemExit(2)
runpy.run_path(str(helper), run_name='__main__')
