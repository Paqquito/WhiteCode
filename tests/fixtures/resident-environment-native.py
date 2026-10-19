"""Private real HTTPS/WSS service, PTY client, detached supervisor and real product children."""
import errno, fcntl, json, os, pathlib, pty, re, select, signal, ssl, struct, subprocess, sys, tempfile, termios, time, urllib.request, urllib.error, uuid

program = pathlib.Path(sys.argv[1]).resolve()
root = pathlib.Path(tempfile.mkdtemp(prefix="re51-", dir="/var/tmp"))
env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "TERM": "xterm-256color", "HOME": str(root / "home"), "BENCH_ROOT": str(root)}
subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(root / "key.pem"), "-out", str(root / "cert.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], cwd=root, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
service = subprocess.Popen([str(program), "bench-service", str(root)], cwd=root, env=env, stdout=(root / "service.stdout").open("wb"), stderr=(root / "service.stderr").open("wb"))
clients = []
def wait(sample, seconds=20):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        result = sample()
        if result: return result
        time.sleep(.05)
    raise RuntimeError("Native environment deadline: " + str(root))
def run(args):
    return subprocess.run([str(program), *args], cwd=root / "project", env=env, capture_output=True, text=True, timeout=30)
def pty_client():
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 55, 180, 0, 0))
    proc = subprocess.Popen([str(program)], cwd=root / "project", env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave); output = bytearray(); clients.append((proc, master, output))
    def text():
        if select.select([master], [], [], .03)[0]:
            try: output.extend(os.read(master, 65536))
            except OSError as error:
                if error.errno != errno.EIO: raise
        return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output.decode(errors="replace"))
    def word(value):
        try: wait(lambda: value in text())
        except Exception: raise RuntimeError(value + " absent: " + text()[-6000:] + "\n" + str(root))
    def send(value):
        for char in value:
            if char == "\r": time.sleep(.3)
            os.write(master, char.encode()); text(); time.sleep(.015)
    word("Votre message"); time.sleep(.2)
    (root / f"tty-before-raw-{proc.pid}.json").write_text(json.dumps(termios.tcgetattr(master)[:4]))
    return proc, word, send

try:
    wait(lambda: (root / "service.json").exists())
    initialized = subprocess.run([str(program), "bench-init", str(root)], cwd=root, env=env, capture_output=True, text=True, timeout=20)
    assert initialized.returncode == 0, initialized.stderr
    prefix = (root / "prefix.txt").read_text()
    env[prefix + "CONFIG_HOME"] = str(root / "home/config")
    env[prefix + "EXTRA_CA_CERTS"] = str(root / "cert.pem")
    port = json.loads((root / "service.json").read_text())["port"]
    context = ssl.create_default_context(cafile=str(root / "cert.pem"))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))
    def web(action, body=None, authorized=True):
        request = urllib.request.Request(f"https://localhost:{port}/web/{action}", data=None if body is None else json.dumps(body).encode(), headers={"Authorization": "Web fixture-web-capability-5137" if authorized else "Web other-account", "Content-Type": "application/json"})
        with opener.open(request, timeout=5) as response: return json.load(response)
    def state(): return web("state")
    def ack(seq, status): return next((frame for frame in state()["frames"] if frame.get("type") == "ack" and frame.get("seq") == seq and frame.get("status") == status), None)
    def permission(path):
        return next((frame for frame in reversed(state()["frames"]) if frame.get("type") == "approval" and path in json.dumps(frame.get("approval", {}))), None)
    client, word, send = pty_client()
    send("/remote-access-server start\r"); word("Service distant résident actif"); word(f"https://localhost:{port}/environments/env-1")
    endpoint_file = root / "home/config/resident-endpoint.json"
    endpoint = json.loads(endpoint_file.read_text()); daemon_pid = endpoint["pid"]
    assert daemon_pid != client.pid
    client.send_signal(signal.SIGTERM); client.wait(timeout=10)
    os.kill(daemon_pid, 0)
    second_start = run(["remote-access", "start", "--json"])
    assert second_start.returncode == 0, second_start.stderr
    duplicate = json.loads(second_start.stdout)
    assert duplicate["pid"] == daemon_pid and state()["registrations"] == 1
    try: web("create", {"id": str(uuid.uuid4()), "prompt": "wrong account"}, False); raise AssertionError("Wrong web account accepted")
    except urllib.error.HTTPError as error: assert error.code == 403
    first_id = str(uuid.uuid4())
    seq = web("create", {"id": first_id, "prompt": "native-scenario"})["seq"]
    created = wait(lambda: ack(seq, "created")); worker_pid = created["pid"]
    assert worker_pid not in [client.pid, daemon_pid]
    child_env = pathlib.Path(f"/proc/{worker_pid}/environ").read_bytes()
    for secret in [b"device_" + b"d" * 48, b"environment_" + b"e" * 48, b"fixture-company-capability-5137"]: assert secret not in child_env
    duplicate_seq = web("create", {"id": first_id, "prompt": "Must not run twice."})["seq"]
    assert wait(lambda: ack(duplicate_seq, "existing"))["pid"] == worker_pid
    denied = wait(lambda: permission("rejected.txt"))
    answer = web("answer", {"id": first_id, "requestId": denied["approval"]["id"], "answer": "deny"})["seq"]
    wait(lambda: ack(answer, "resolved"))
    stale = web("answer", {"id": first_id, "requestId": denied["approval"]["id"], "answer": "allow"})["seq"]
    wait(lambda: ack(stale, "stale"))
    accepted = wait(lambda: permission("accepted.txt"))
    web("answer", {"id": first_id, "requestId": accepted["approval"]["id"], "answer": "allow"})
    wait(lambda: (root / "project/accepted.txt").exists())
    assert not (root / "project/rejected.txt").exists()
    wait(lambda: "REMOTE_NATIVE_DONE" in json.dumps(state()["frames"]))
    assert "DENIED_NATIVE_SENTINEL" not in json.dumps(state()["frames"])
    second_id = str(uuid.uuid4())
    cap_seq = web("create", {"id": second_id, "prompt": "shell-stop"})["seq"]
    wait(lambda: ack(cap_seq, "capacity"))
    stop_seq = web("stop", {"id": first_id})["seq"]; wait(lambda: ack(stop_seq, "stopped"))
    wait(lambda: not pathlib.Path(f"/proc/{worker_pid}").exists())
    shell_seq = web("create", {"id": second_id, "prompt": "shell-stop"})["seq"]
    shell_pid = wait(lambda: ack(shell_seq, "created"))["pid"]
    shell_approval = wait(lambda: permission("run_shell"))
    web("answer", {"id": second_id, "requestId": shell_approval["approval"]["id"], "answer": "allow"})
    wait(lambda: (root / "tool-started").exists())
    stopper, stop_word, stop_send = pty_client()
    started = time.monotonic(); stop_send("/remote-access-server stop\r"); stop_word("Service distant résident arrêté")
    assert time.monotonic() - started < 8
    wait(lambda: not pathlib.Path(f"/proc/{shell_pid}").exists())
    stop_send("/remote-access-server stop\r"); stop_word("Service distant résident arrêté")
    assert state()["unregistrations"] == 1
    stopper.send_signal(signal.SIGTERM); stopper.wait(timeout=10)
    time.sleep(9); assert not (root / "project/late.txt").exists()
    assert not (root / "preload-ran").exists()
    frames = (root / "service-frames.jsonl").read_text()
    for secret in ["device_" + "d" * 48, "environment_" + "e" * 48, "fixture-company-capability-5137"]: assert secret not in frames
    def local(path, body=None):
        request = urllib.request.Request(f'http://127.0.0.1:{endpoint["port"]}{path}', data=None if body is None else json.dumps(body).encode(), headers={"Authorization": "Bearer " + endpoint["token"], "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=10) as response: return json.load(response)
    replacement = run(["remote-access", "start", "--json"])
    assert replacement.returncode == 0, replacement.stderr
    current = json.loads(replacement.stdout)
    assert current["instance"] != duplicate["instance"]
    assert local("/remote/revoke", {key: duplicate[key] for key in ["id", "instance", "binding"]}) == {"revoked": False}
    assert local("/remote")["instance"] == current["instance"] and local("/remote")["active"]
    assert local("/remote/revoke", {key: current[key] for key in ["id", "instance", "binding"]}) == {"revoked": True}
    assert not local("/remote")["active"] and state()["unregistrations"] == 2
    (root / "channel-open").unlink()
    race = run(["bench-race", str(root)])
    assert race.returncode == 2 and "Compte remplacé" in race.stderr, race.stderr
    assert (root / "client-rotated-after-open").exists()
    assert not local("/remote")["active"] and state()["unregistrations"] == 3
    stopped = run(["service", "stop", "--json"]); assert stopped.returncode == 0, stopped.stderr
    wait(lambda: not endpoint_file.exists())
    evidence = {"client_pid": client.pid, "resident_pid": daemon_pid, "first_worker_pid": worker_pid, "second_worker_pid": shell_pid, "registration_count": state()["registrations"], "unregistration_count": state()["unregistrations"], "https_web_request_created_real_child": True, "wss_authenticated_with_device": True, "client_closed_resident_survived": True, "duplicate_start_and_work_idempotent": True, "capacity_enforced": True, "denial_and_single_resolution": True, "local_read_deny_enforced": True, "allowed_write_completed": True, "child_credentials_absent": True, "late_shell_write_absent": True, "dotenv_bunfig_not_autoloaded": True, "stale_revoke_preserves_new_instance": True, "scoped_revoke_joined": True, "client_rotation_after_start_revokes_own_exposure": True, "stops_joined": True, "provider": "scripted only", "vault": "private fixture adapter; native vault contract reused"}
    (root / "result.json").write_text(json.dumps(evidence, indent=2)); print(json.dumps({"bench": str(root), "result": evidence}))
finally:
    for proc, master, output in clients:
        if proc.poll() is None: proc.send_signal(signal.SIGTERM); proc.wait(timeout=10)
        (root / f"terminal-{proc.pid}.raw").write_bytes(output); os.close(master)
    endpoint_file = root / "home/config/resident-endpoint.json"
    if endpoint_file.exists():
        endpoint = json.loads(endpoint_file.read_text()); pid = endpoint["pid"]
        path = pathlib.Path(f"/proc/{pid}/environ")
        if path.exists() and (b"BENCH_ROOT=" + str(root).encode() + b"\0") in path.read_bytes(): os.kill(pid, signal.SIGTERM)
    if service.poll() is None: service.terminate(); service.wait(timeout=5)
