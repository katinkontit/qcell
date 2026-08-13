import os
import queue
import re
import signal
import sys
import time

from jupyter_client import BlockingKernelClient

LIMIT = 30 * 1024
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
connection_file, timeout, code = sys.argv[1], float(sys.argv[2]), sys.argv[3]
kernel_pid = int(os.environ["QCELL_KERNEL_PID"])
client, busy, parts, size, truncated = None, False, [], 0, False


def add(value):
    global size, truncated
    if truncated:
        return
    data = str(value).encode("utf-8", "replace")
    room = LIMIT - size
    if len(data) > room:
        data, truncated = data[:max(0, room)], True
    parts.append(data.decode("utf-8", "ignore"))
    size += len(data)


def interrupt():
    if busy:
        try:
            os.kill(kernel_pid, signal.SIGINT)
        except (ProcessLookupError, PermissionError):
            pass


def terminate(*_):
    interrupt()
    raise KeyboardInterrupt("helper terminated")


signal.signal(signal.SIGTERM, terminate)

try:
    client = BlockingKernelClient()
    client.load_connection_file(connection_file)
    client.start_channels()
    client.wait_for_ready(timeout=timeout)
    msg_id = client.execute(
        code,
        silent=False,
        store_history=False,
        allow_stdin=False,
        stop_on_error=True,
    )
    deadline, failure = time.monotonic() + timeout, None

    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            interrupt()
            raise TimeoutError(f"kernel execution exceeded {timeout:g} seconds")
        try:
            message = client.get_iopub_msg(timeout=min(remaining, 0.25))
        except queue.Empty:
            continue
        if (message.get("parent_header") or {}).get("msg_id") != msg_id:
            continue

        kind = message.get("msg_type") or (message.get("header") or {}).get("msg_type")
        content = message.get("content") or {}
        if kind == "status":
            state = content.get("execution_state")
            busy = busy or state == "busy"
            if state == "idle":
                break
        elif kind == "stream":
            add(content.get("text", ""))
        elif kind in ("execute_result", "display_data"):
            data = content.get("data") or {}
            if "text/plain" in data:
                add(data["text/plain"] + "\n")
            for mime in sorted(set(data) - {"text/plain"}):
                add(f"[{mime} output]\n")
        elif kind == "error":
            traceback = content.get("traceback") or []
            failure = (
                "\n".join(ANSI.sub("", str(line)) for line in traceback)
                if traceback
                else f"{content.get('ename', 'PythonError')}: {content.get('evalue', '')}".rstrip()
            )

    if failure:
        raise RuntimeError(failure)
    result = "".join(parts)
    if truncated:
        marker = "\n[output truncated at 30 KB]"
        result = result.encode()[: LIMIT - len(marker.encode())].decode("utf-8", "ignore") + marker
    sys.stdout.write(result)
except BaseException as error:
    message = ANSI.sub("", str(error)).strip() or error.__class__.__name__
    sys.stderr.write(message.encode("utf-8", "replace")[:LIMIT].decode("utf-8", "ignore") + "\n")
    sys.exit(1)
finally:
    if client:
        try:
            client.stop_channels()
        except Exception:
            pass
