# Supports: SPEC-IHM-041, SPEC-OUT-015. Only the pseudo-terminal and children created here are controlled.
import os, pty, select, signal, sys, time, fcntl, termios, struct, json

pid, terminal = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], [sys.argv[1], sys.argv[2], sys.argv[3]])
fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
collected = bytearray()
stages = []
def receive(pattern, timeout=15):
    start = len(collected)
    deadline = time.monotonic() + timeout
    while pattern not in collected[start:]:
        if time.monotonic() >= deadline:
            raise RuntimeError("PTY timeout: " + repr(pattern) + "\n" + bytes(collected[-5000:]).decode(errors="replace"))
        if select.select([terminal], [], [], 0.1)[0]:
            data = os.read(terminal, 65536)
            if not data: raise RuntimeError("PTY closed before " + repr(pattern))
            collected.extend(data)
def send(data): os.write(terminal, data)
def detach():
    # The initial pane repaint precedes completion of the client's terminal setup.
    time.sleep(0.2)
    send(b"\x02")
    time.sleep(0.05)
    send(b"d")
def interrupted(signum, frame): raise SystemExit("PTY driver interrupted")
signal.signal(signal.SIGTERM, interrupted)
try:
    receive(b"Votre message")
    send(b"Keep this conversation")
    time.sleep(0.1)
    send(b"\r")
    receive(b"CONVERSATION_KEPT")
    time.sleep(0.3)
    send(b"DRAFT_RETAINED")
    time.sleep(0.15)
    send(b"\x1b\x14")
    # Wait for the real tmux client before entering a human command.
    receive(b"project-")
    send(b"printf '\\nPANEL_NATIVE_ERROR\\nsk-fixture938471620597410000000000\\n'\r")
    receive(b"PANEL_NATIVE_ERROR\r\n")
    time.sleep(0.1)
    detach()
    receive(b"detached")
    time.sleep(0.3)
    stages.append(bytes(collected).decode(errors="replace"))
    send(b"\x1b\x14")
    receive(b"PANEL_NATIVE_ERROR")
    stages.append(bytes(collected).decode(errors="replace"))
    detach()
    receive(b"detached")
    time.sleep(0.3)
    # Submit the retained draft: losing or changing it is visible in the recorded model request.
    send(b"\r")
    receive(b"PANEL_CAPTURED")
    time.sleep(0.3)
    send(b"\x04")
    time.sleep(0.1)
    send(b"\x04")
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        result, status = os.waitpid(pid, os.WNOHANG)
        if result:
            if os.waitstatus_to_exitcode(status) != 0: raise RuntimeError("Native product process failed")
            pid = 0
            break
        if select.select([terminal], [], [], 0.05)[0]:
            try: collected.extend(os.read(terminal, 65536))
            except OSError: pass
        time.sleep(0.05)
    if pid: raise RuntimeError("Native product did not exit\n" + bytes(collected[-4000:]).decode(errors="replace"))
    with open(sys.argv[3] + ".pty.json", "w") as output: json.dump(stages, output)
finally:
    if pid:
        os.kill(pid, signal.SIGTERM)
        time.sleep(0.3)
        try: os.kill(pid, signal.SIGKILL)
        except ProcessLookupError: pass
        os.waitpid(pid, 0)
    os.close(terminal)
