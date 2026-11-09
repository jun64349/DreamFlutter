"""Bounded local Microsoft Office conversion, using only Python stdlib and Windows PowerShell COM."""
import argparse, json, os, pathlib, subprocess, sys, uuid, zipfile

APPS = {'.doc': 'word', '.docx': 'word', '.xls': 'excel', '.xlsx': 'excel', '.ppt': 'powerpoint', '.pptx': 'powerpoint'}
MODERN = {'word': '.docx', 'excel': '.xlsx', 'powerpoint': '.pptx'}
UNAVAILABLE = '本机没有可用的转换程序'

def result(ok, code, reason='', **fields):
    return {'ok': ok, 'code': code, **({'reason': reason} if reason else {}), **fields}

def validate_request(source, output):
    source, output = pathlib.Path(source).resolve(), pathlib.Path(output).resolve()
    if not source.is_file():
        raise ValueError('输入文件不存在')
    app = APPS.get(source.suffix.lower())
    if app is None or output.suffix.lower() not in ('.pdf', MODERN[app]):
        raise ValueError('仅支持 DOC/DOCX、XLS/XLSX、PPT/PPTX 转 PDF，或旧格式转对应 DOCX/XLSX/PPTX')
    if source == output or output.exists():
        raise ValueError('输出已存在或与源文件相同；请使用新路径，保留原件')
    if not output.parent.is_dir():
        raise ValueError('输出目录不存在')
    return source, output, app

def verify_output(path):
    path = pathlib.Path(path)
    if not path.is_file() or path.stat().st_size == 0:
        raise ValueError('转换程序没有生成有效输出')
    if path.suffix.lower() == '.pdf':
        with path.open('rb') as stream:
            if not stream.read(8).startswith(b'%PDF-'):
                raise ValueError('输出不是有效 PDF 文件头')
    else:
        required = {'.docx': 'word/document.xml', '.xlsx': 'xl/workbook.xml', '.pptx': 'ppt/presentation.xml'}[path.suffix.lower()]
        with zipfile.ZipFile(path) as archive:
            if required not in archive.namelist() or archive.testzip() is not None:
                raise ValueError('转换输出的 OOXML 结构/CRC 校验失败')

def _worker(request, timeout):
    windows = pathlib.Path(os.environ.get('SystemRoot', r'C:\Windows'))
    executable = windows / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    if not executable.is_file():
        return result(False, 'not_available', UNAVAILABLE, detail='Windows PowerShell 不可用')
    try:
        child = subprocess.Popen([str(executable), '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', str(pathlib.Path(__file__).with_suffix('.ps1'))],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=0x08000000)
    except OSError as error:
        return result(False, 'not_available', UNAVAILABLE, detail=str(error))
    encoded = json.dumps(request, ensure_ascii=False).encode('utf-8')
    try:
        stdout, stderr = child.communicate(encoded, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        child.kill()
        stdout, stderr = child.communicate()
        # Only a worker-verified newly created Office PID may be cleaned up, with name/start-time rechecked.
        cleanup_failures = []
        for event in _events(stdout or error.output or b''):
            if event.get('event') == 'owned-process':
                cleanup = {'mode': 'cleanup', 'pid': event['pid'], 'ticks': event['ticks'], 'process': event['process']}
                try:
                    cleaned = subprocess.run([str(executable), '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', str(pathlib.Path(__file__).with_suffix('.ps1'))],
                                             input=json.dumps(cleanup).encode('utf-8'), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, creationflags=0x08000000)
                    if cleaned.returncode:
                        cleanup_failures.append('Office 进程清理失败')
                except (OSError, subprocess.TimeoutExpired):
                    cleanup_failures.append('Office 进程清理失败或超时')
        return result(False, 'timeout', 'Office 转换超时；已停止本次执行，未覆盖源文件或既有输出', cleanupWarnings=cleanup_failures)
    events = _events(stdout)
    answer = next((event for event in reversed(events) if 'ok' in event and 'code' in event), None)
    if answer is None:
        return result(False, 'conversion_failed', 'Office 执行器没有返回有效结果', detail=stderr.decode('utf-8', errors='replace')[-1200:])
    if answer['code'] == 'not_available':
        answer['reason'] = UNAVAILABLE
    elif answer['code'] == 'office_busy':
        answer['reason'] = '对应 Microsoft Office 正在使用或不能确认独立实例；请先结束该会话后重试，不会关闭用户程序'
    elif not answer['ok']:
        answer['reason'] = 'Office 转换失败；未修改源文件，请核对文件、权限和 Office 可用性'
    return answer

def _events(raw):
    events = []
    for line in raw.decode('utf-8-sig', errors='replace').splitlines():
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                events.append(value)
        except ValueError:
            pass
    return events

def convert(source=None, output=None, *, probe=False, app=None, timeout=60, environment=None):
    environment = environment or sys.platform
    if environment != 'win32':
        return result(False, 'not_available', UNAVAILABLE, detail='蝶君/Linux 沙箱没有 Microsoft Office；本版不随包 LibreOffice')
    if probe:
        return _worker({'mode': 'probe', 'app': app}, min(timeout, 15))
    try:
        source, output, app = validate_request(source, output)
    except (ValueError, OSError, TypeError) as error:
        return result(False, 'invalid_input', str(error))
    staging = output.with_name(f'.{output.stem}.t78-{uuid.uuid4().hex}{output.suffix}')
    try:
        answer = _worker({'mode': 'convert', 'app': app, 'input': str(source), 'output': str(staging)}, timeout)
        if not answer['ok']:
            return answer
        verify_output(staging)
        # Windows rename fails if another process created the requested output in the meantime.
        os.rename(staging, output)
        return result(True, 'converted', input=str(source), output=str(output), application=app,
                      bytes=output.stat().st_size, verification='file header / OOXML structure and CRC', formulasRecalculated=False)
    except (ValueError, OSError, zipfile.BadZipFile) as error:
        return result(False, 'conversion_failed', str(error))
    finally:
        if staging.parent == output.parent and '.t78-' in staging.name:
            staging.unlink(missing_ok=True)

def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description='Local Office→PDF / legacy Office→OOXML. No OCR or formula recalculation; writes only a new output.')
    parser.add_argument('--probe', action='store_true')
    parser.add_argument('--app', choices=tuple(MODERN))
    parser.add_argument('--input'); parser.add_argument('--output')
    parser.add_argument('--timeout', type=int, default=60)
    options = parser.parse_args()
    if not options.probe and not (options.input and options.output):
        parser.error('--input and --output are required unless --probe is used')
    answer = convert(options.input, options.output, probe=options.probe, app=options.app, timeout=max(5, min(options.timeout, 120)))
    print(json.dumps(answer, ensure_ascii=False))
    return 0 if answer['ok'] else 2

if __name__ == '__main__':
    raise SystemExit(main())
