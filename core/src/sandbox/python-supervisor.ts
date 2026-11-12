// Runs as the sandbox agent. The worker owns a separate process group while the
// supervisor keeps the Windows pipe and reaps orphaned descendants.
export const PYTHON_SUPERVISOR = String.raw`
import ctypes, json, os, select, signal, subprocess, sys, time

if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), "cannot supervise Python descendants")

stopping = False
def stop(_signal, _frame):
    global stopping
    stopping = True

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGHUP, stop)
owner = sys.argv[2]
worker = subprocess.Popen([sys.executable, "-I", "-u", "-c", sys.argv[1]],
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          start_new_session=True, env={**os.environ, "DF_PYTHON_KERNEL_OWNER": owner})
def control(kind, **fields):
    print(json.dumps({"kind": kind, "owner": owner, **fields}), file=sys.stderr, flush=True)

buffer = b""
try:
    with open(f"/proc/{worker.pid}/stat") as stat:
        start = stat.read().rsplit(")", 1)[1].split()[19]
    control("kernel_group", pid=worker.pid, start=start)
    worker_out = worker.stdout.fileno()
    while not stopping:
        exited = os.waitid(os.P_PID, worker.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        readable, _, _ = select.select([0, worker_out], [], [], 0 if exited else 0.05)
        if worker_out in readable:
            output = os.read(worker_out, 65536)
            if not output:
                break
            sys.stdout.buffer.write(output)
            sys.stdout.buffer.flush()
        elif exited:
            break
        if 0 not in readable:
            continue
        data = os.read(0, 65536)
        if not data:
            break
        buffer += data
        while b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            if line == b"interrupt":
                os.kill(worker.pid, signal.SIGINT)
            else:
                worker.stdin.write(line + b"\n")
                worker.stdin.flush()
except (BrokenPipeError, ProcessLookupError):
    pass
finally:
    # Keep the group leader unreaped until after killpg, so its ID cannot be reused.
    try:
        os.killpg(worker.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    worker.wait()
    # The subreaper adopts descendants, including children that changed process group.
    children = f"/proc/self/task/{os.getpid()}/children"
    while True:
        with open(children) as file:
            for child in file.read().split():
                try:
                    os.kill(int(child), signal.SIGKILL)
                except ProcessLookupError:
                    pass
        try:
            if os.waitpid(-1, os.WNOHANG)[0] == 0:
                time.sleep(0.01)
        except ChildProcessError:
            break
    control("cleanup_done")
`;

// Fallback runs as the same sandbox user, but never trusts a numeric PID alone.
// pidfd_send_signal keeps a verified match bound to the process even if its PID is reused.
export const PYTHON_FALLBACK_CLEANUP = String.raw`
import os, signal, sys, time

owner, group, first_start = sys.argv[1:]
group = int(group)
first_start = int(first_start)
marker = b"DF_PYTHON_KERNEL_OWNER=" + owner.encode("ascii")
deadline = time.monotonic() + 4

def stat_fields(path):
    with open(path + "/stat") as stat:
        return stat.read().rsplit(")", 1)[1].split()

def tagged(path):
    with open(path + "/environ", "rb") as env:
        return marker in env.read().split(b"\0")

def group_verified():
    if group <= 1:
        return False
    path = f"/proc/{group}"
    try:
        fields = stat_fields(path)
        return (fields[0] not in ("Z", "X") and int(fields[19]) == first_start
                and int(fields[2]) == int(fields[3]) == group and tagged(path))
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        return False

while time.monotonic() < deadline:
    live = False
    with os.scandir("/proc") as proc:
        entries = sorted((entry for entry in proc if entry.name.isdecimal()), key=lambda entry: int(entry.name) == group)
    # Keep the verified group leader until last so members that cleared their environment can be checked.
    for entry in entries:
        try:
            fd = os.pidfd_open(int(entry.name))
        except ProcessLookupError:
            continue
        try:
            fields = stat_fields(entry.path)
            start = int(fields[19])
            if fields[0] in ("Z", "X") or start < first_start:
                continue
            if int(entry.name) == group and (start != first_start or int(fields[2]) != group or int(fields[3]) != group):
                continue
            in_group = int(fields[2]) == int(fields[3]) == group and group_verified()
            if not in_group and not tagged(entry.path):
                continue
            signal.pidfd_send_signal(fd, signal.SIGKILL)
            live = True
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            pass
        finally:
            os.close(fd)
    if not live:
        sys.exit(0)
    time.sleep(0.025)
sys.exit(1)
`;
