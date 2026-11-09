import importlib.util,json,pathlib,tempfile,unittest,zipfile,subprocess
from unittest.mock import patch,Mock
ROOT=pathlib.Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('convert_office',ROOT/'core/assets/office/convert_office.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class ConverterTests(unittest.TestCase):
 def setUp(self):
  self.work=tempfile.TemporaryDirectory(prefix='df-t78-converter-');self.dir=pathlib.Path(self.work.name);self.source=self.dir/'中文 [source].docx';self.source.write_bytes(b'original');self.output=self.dir/'new.docx'
 def tearDown(self):self.work.cleanup()
 def test_sandbox_absence_is_explicit(self):
  r=m.convert(self.source,self.output,environment='linux');self.assertFalse(r['ok']);self.assertEqual(r['code'],'not_available');self.assertEqual(r['reason'],'本机没有可用的转换程序')
 def test_missing_office_is_explicit_on_workbench(self):
  child=Mock();child.communicate.return_value=(b'{"ok":false,"code":"not_available"}\n',b'')
  with patch.object(m.subprocess,'Popen',return_value=child):r=m._worker({'mode':'probe'},5)
  self.assertEqual(r['reason'],'本机没有可用的转换程序')
 def test_worker_start_failure_is_explicit(self):
  with patch.object(m.subprocess,'Popen',side_effect=OSError('synthetic unavailable')):r=m._worker({'mode':'probe'},5)
  self.assertEqual(r['code'],'not_available');self.assertEqual(r['reason'],'本机没有可用的转换程序')
 def test_timeout_only_cleans_recorded_owned_process(self):
  owned=b'{"event":"owned-process","pid":123,"ticks":"456","process":"WINWORD"}\n'
  child=Mock();child.communicate.side_effect=[subprocess.TimeoutExpired('synthetic',5,output=owned),(owned,b'')]
  with patch.object(m.subprocess,'Popen',return_value=child),patch.object(m.subprocess,'run',return_value=Mock(returncode=0)) as cleanup:r=m._worker({'mode':'convert'},5)
  child.kill.assert_called_once();self.assertEqual(r['code'],'timeout');self.assertEqual(r['cleanupWarnings'],[])
  request=json.loads(cleanup.call_args.kwargs['input']);self.assertEqual(request,{'mode':'cleanup','pid':123,'ticks':'456','process':'WINWORD'});self.assertIn('-ExecutionPolicy',cleanup.call_args.args[0])
 def test_timeout_cleanup_failure_is_reported_without_traceback(self):
  owned=b'{"event":"owned-process","pid":123,"ticks":"456","process":"WINWORD"}\n'
  child=Mock();child.communicate.side_effect=[subprocess.TimeoutExpired('synthetic',5,output=owned),(owned,b'')]
  with patch.object(m.subprocess,'Popen',return_value=child),patch.object(m.subprocess,'run',side_effect=subprocess.TimeoutExpired('cleanup',10)):r=m._worker({'mode':'convert'},5)
  self.assertEqual(r['code'],'timeout');self.assertTrue(r['cleanupWarnings'])
 def test_refuses_existing_output_without_starting_office(self):
  self.output.write_bytes(b'keep')
  with patch.object(m,'_worker') as worker:r=m.convert(self.source,self.output,environment='win32')
  worker.assert_not_called();self.assertEqual(r['code'],'invalid_input');self.assertEqual(self.output.read_bytes(),b'keep');self.assertEqual(self.source.read_bytes(),b'original')
 def test_refuses_wrong_extension(self):
  with patch.object(m,'_worker') as worker:r=m.convert(self.source,self.dir/'wrong.xlsx',environment='win32')
  worker.assert_not_called();self.assertEqual(r['code'],'invalid_input')
 def test_success_is_verified_and_source_preserved(self):
  def worker(req,timeout):
   with zipfile.ZipFile(req['output'],'w') as z:z.writestr('word/document.xml','<document/>')
   return {'ok':True,'code':'exported'}
  with patch.object(m,'_worker',side_effect=worker):r=m.convert(self.source,self.output,environment='win32')
  self.assertTrue(r['ok']);m.verify_output(self.output);self.assertEqual(self.source.read_bytes(),b'original');self.assertEqual(list(self.dir.glob('.*.t78-*')),[])
 def test_fake_success_with_wrong_file_type_is_rejected(self):
  def worker(req,timeout):pathlib.Path(req['output']).write_bytes(b'not zip');return {'ok':True,'code':'exported'}
  with patch.object(m,'_worker',side_effect=worker):r=m.convert(self.source,self.output,environment='win32')
  self.assertFalse(r['ok']);self.assertFalse(self.output.exists());self.assertEqual(list(self.dir.glob('.*.t78-*')),[])
 def test_failed_conversion_removes_only_staging_file(self):
  def worker(req,timeout):pathlib.Path(req['output']).write_bytes(b'partial');return {'ok':False,'code':'conversion_failed','reason':'synthetic'}
  with patch.object(m,'_worker',side_effect=worker):r=m.convert(self.source,self.output,environment='win32')
  self.assertFalse(r['ok']);self.assertFalse(self.output.exists());self.assertEqual(self.source.read_bytes(),b'original');self.assertEqual(list(self.dir.glob('.*.t78-*')),[])
 @unittest.skipUnless(__import__('sys').platform=='win32','Windows exclusive rename semantics')
 def test_racing_output_is_not_overwritten(self):
  def worker(req,timeout):
   with zipfile.ZipFile(req['output'],'w') as z:z.writestr('word/document.xml','<document/>')
   self.output.write_bytes(b'other writer');return {'ok':True,'code':'exported'}
  with patch.object(m,'_worker',side_effect=worker):r=m.convert(self.source,self.output,environment='win32')
  self.assertFalse(r['ok']);self.assertEqual(self.output.read_bytes(),b'other writer')

if __name__=='__main__':unittest.main(verbosity=2)
