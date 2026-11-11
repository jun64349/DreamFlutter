"""Line-framed worker for one DreamFlutter Python session, launched as the WSL agent."""
import ast
import base64
import hashlib
import io
import json
import os
import reprlib
import signal
import sys
import traceback
import weakref


input_pipe = os.fdopen(os.dup(0), "rb")
protocol = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
with open(os.devnull, "rb") as devnull:
    os.dup2(devnull.fileno(), 0)
os.dup2(2, 1)
sys.stdin = io.StringIO("")
try:
    os.setsid()
except PermissionError:
    if os.getpgrp() != os.getpid():
        raise


def send(kind, **fields):
    protocol.write(json.dumps({"kind": kind, **fields}, ensure_ascii=True) + "\n")


namespace = {"__name__": "__main__"}
saved_figures = weakref.WeakKeyDictionary()
active = False
active_folder = None


def interrupt(_signum, _frame):
    if active:
        raise KeyboardInterrupt


signal.signal(signal.SIGINT, interrupt)


class Output(io.TextIOBase):
    def __init__(self):
        self.remaining = 64 * 1024

    def write(self, text):
        if self.remaining > 0:
            clipped = text[:self.remaining]
            self.remaining -= len(clipped)
            for start in range(0, len(clipped), 4096):
                send("output", text=clipped[start:start + 4096])
            if self.remaining == 0:
                send("output", text="\n[输出达到 65536 字符上限，后续已截断]\n")
        return len(text)


def preview(value):
    pandas = sys.modules.get("pandas")
    if pandas and isinstance(value, (pandas.DataFrame, pandas.Series)):
        rows = value.iloc[:8, :12] if value.ndim == 2 else value.iloc[:8]
        with pandas.option_context("display.max_colwidth", 80):
            return f"{type(value).__name__} shape={value.shape}\n{rows}"
    return reprlib.repr(value)


def send_traceback(limit):
    text = traceback.format_exc(limit=limit)
    if len(text) > 12000:
        text = text[:7000] + "\n[回溯过长，中间已截断]\n" + text[-5000:]
    for start in range(0, len(text), 4096):
        send("output", text=text[start:start + 4096])


def show_plots(folder):
    pyplot = sys.modules.get("matplotlib.pyplot")
    if not pyplot:
        return
    from PIL import Image

    for number in pyplot.get_fignums():
        figure = pyplot.figure(number)
        if not figure.axes:
            continue
        png = io.BytesIO()
        figure.savefig(png, format="png")
        original = png.getvalue()
        digest = hashlib.sha256(original).digest()
        if saved_figures.get(figure) == digest:
            continue
        saved_figures[figure] = digest
        name = f"python-{os.urandom(12).hex()}.png"
        if folder:
            os.makedirs(folder, mode=0o700, exist_ok=True)
            if os.path.realpath(folder) != folder:
                raise ValueError("Python 产物目录不能是符号链接")
            with open(os.path.join(folder, name), "xb") as file:
                file.write(original)
        image = Image.open(png)
        width, height = image.size
        image.thumbnail((1536, 1536))
        if image.size == (width, height) and len(original) <= 1024 * 1024:
            data, mime = original, "image/png"
        else:
            thumb = io.BytesIO()
            image.convert("RGB").save(thumb, "JPEG", quality=85)
            data, mime = thumb.getvalue(), "image/jpeg"
        send("figure", name=name, data=base64.b64encode(data).decode("ascii"), mime=mime)


def capture_before(action):
    def captured(*args, **kwargs):
        if active:
            show_plots(active_folder)
        return action(*args, **kwargs)
    return captured


try:
    import matplotlib.pyplot as plt
    plt.show = capture_before(plt.show)
    plt.close = capture_before(plt.close)
except ImportError:
    pass


with open("/proc/self/stat") as stat_file:
    start_time = stat_file.read().rsplit(")", 1)[1].split()[19]
send("ready", pid=os.getpid(), start=start_time)

for line in input_pipe:
    request = json.loads(line)
    output = Output()
    old_stdout, old_stderr = sys.stdout, sys.stderr
    sys.stdout = sys.stderr = output
    status = "completed"
    try:
        active = True
        active_folder = request["folder"]
        os.chdir(request["cwd"])
        parsed = ast.parse(request["code"], filename="<python>")
        last = parsed.body.pop() if parsed.body and isinstance(parsed.body[-1], ast.Expr) else None
        exec(compile(parsed, "<python>", "exec"), namespace)
        if last:
            value = eval(compile(ast.Expression(last.value), "<python>", "eval"), namespace)
            if value is not None:
                namespace["_"] = value
                print(preview(value))
        show_plots(request["folder"])
    except KeyboardInterrupt:
        status = "interrupted"
    except BaseException:
        status = "failed"
        send_traceback(16)
        try:
            show_plots(request["folder"])
        except BaseException:
            send_traceback(8)
    finally:
        active = False
        active_folder = None
        signal.signal(signal.SIGINT, interrupt)
        sys.stdout, sys.stderr = old_stdout, old_stderr
    send("done", status=status)
