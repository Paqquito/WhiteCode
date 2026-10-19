"""Private native tmux bench; the model provider is scripted, all product processes are real."""
import json, os, pathlib, signal, subprocess, sys, tempfile, time

bun, source = sys.argv[1:3]
bench = pathlib.Path(tempfile.mkdtemp(prefix="tp51-", dir="/var/tmp"))
os.environ["TMPDIR"] = str(bench)
os.environ["OPENAI_API_KEY"] = "fixture-server-key-never-real"
os.environ["ANTHROPIC_API_KEY"] = "fixture-another-server-key-never-real"
socket = str(bench / "tmux.sock")
descriptor = str(bench / "workspace.json")
fixture = str(pathlib.Path(source) / "tests/fixtures/team-panel-leader.ts")
subprocess.run([bun, "--no-env-file", fixture, "init", descriptor], cwd=source, check=True, capture_output=True)
ws = json.loads(pathlib.Path(descriptor).read_text())
root = pathlib.Path(ws["root"])
(pathlib.Path(ws["project"]) / ".env").write_text("OPENAI_API_KEY=fixture-env-file-key-never-real\n")

def tmux(*args):
    result = subprocess.run(["tmux", "-S", socket, "-f", "/dev/null", *args], cwd=str(bench), text=True, capture_output=True)
    if result.returncode: raise RuntimeError(result.stderr)
    return result.stdout.strip()

def wait(predicate, seconds=25):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        value = predicate()
        if value: return value
        time.sleep(.1)
    raise RuntimeError("Native team bench timed out: " + str(root))

def command(mode):
    import shlex
    return "exec " + " ".join(map(shlex.quote, [bun, "--no-env-file", fixture, mode, descriptor]))

try:
    tmux("new-session", "-d", "-s", "owned-team-bench", "-x", "200", "-y", "60", command("create"))
    tmux("set-environment", "-g", "OPENAI_API_KEY", "fixture-global-server-key-never-real")
    leader = tmux("display-message", "-p", "-t", "owned-team-bench:0.0", "#{pane_id}")
    leader_pid = int(tmux("display-message", "-p", "-t", leader, "#{pane_pid}"))
    wait(lambda: (root / "worker-idle").exists())
    state_file = next(pathlib.Path(ws["configHome"]).glob("teams/leader-*.json"))
    state = json.loads(state_file.read_text()); assert len(state["panels"]) == 1
    member = state["panels"][0]; assert member["sequence"] == 1 and member["delivered"] == 0
    worker_pane = member["pane"]
    registration = json.loads((pathlib.Path(state["folder"]) / (member["peer"] + ".json")).read_text())
    worker_pid = registration["pid"]; assert worker_pid != leader_pid
    worker_environment = pathlib.Path(f"/proc/{worker_pid}/environ").read_bytes()
    assert set(item.split(b"=", 1)[0] for item in worker_environment.split(b"\0") if item) == {b"TERM", b"LANG"}
    panes_before = tmux("list-panes", "-a", "-F", "#{pane_id}").splitlines(); assert worker_pane in panes_before
    capture = tmux("capture-pane", "-p", "-t", worker_pane); assert "compte rendu conservé" in capture
    requests = [json.loads(line) for line in (root / "model-requests.jsonl").read_text().splitlines()]
    child = [r for r in requests if r.get("purpose") == "subagent"]
    assert len(child) == 4 and "ALLOWED_TEAM_WITNESS" in json.dumps(child[-1])
    assert "DENIED_TEAM_SECRET" not in json.dumps(child)
    assert "Denied by the rule" in json.dumps(child[-1])
    os.kill(leader_pid, signal.SIGKILL)
    wait(lambda: not pathlib.Path("/proc/" + str(leader_pid)).exists())
    os.kill(worker_pid, 0)
    assert worker_pane in tmux("list-panes", "-a", "-F", "#{pane_id}").splitlines()
    new_leader = tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", worker_pane, command("resume"))
    wait(lambda: (root / "reattached").exists())
    os.kill(worker_pid, 0)
    wait(lambda: json.loads(state_file.read_text())["panels"][0]["delivered"] == 1)
    resumed = json.loads(state_file.read_text())
    assert len(resumed["panels"]) == 1 and resumed["panels"][0]["peer"] == member["peer"]
    assert resumed["panels"][0]["delivered"] == 1
    assert len(tmux("list-panes", "-a", "-F", "#{pane_id}").splitlines()) == 2
    transcript = "\n".join(p.read_text() for p in pathlib.Path(ws["configHome"]).glob("sessions/**/*.jsonl"))
    assert "team_reconnected" in transcript and "UNREAD_TEAM_REPORT_51" in transcript
    assert "UNREAD_TEAM_MESSAGE_51" in transcript
    def resumed_request():
        requests = [json.loads(line) for line in (root / "model-requests.jsonl").read_text().splitlines()]
        return any(r.get("mode") == "resume" and "UNREAD_TEAM_MESSAGE_51" in json.dumps(r["history"]) and "UNREAD_TEAM_REPORT_51" in json.dumps(r["history"]) for r in requests)
    wait(resumed_request)
    cancel_descriptor = str(bench / "cancel-workspace.json")
    subprocess.run([bun, "--no-env-file", fixture, "init", cancel_descriptor], cwd=source, check=True, capture_output=True)
    cancel_ws = json.loads(pathlib.Path(cancel_descriptor).read_text()); cancel_root = pathlib.Path(cancel_ws["root"])
    import shlex
    cancel_command = "exec " + " ".join(map(shlex.quote, [bun, "--no-env-file", fixture, "cancel", cancel_descriptor]))
    tmux("new-session", "-d", "-s", "owned-cancel-bench", "-x", "200", "-y", "60", cancel_command)
    wait(lambda: (cancel_root / "tool-started").exists())
    cancel_state = json.loads(next(pathlib.Path(cancel_ws["configHome"]).glob("teams/leader-*.json")).read_text())
    cancel_member = cancel_state["panels"][0]
    cancel_registration = json.loads((pathlib.Path(cancel_state["folder"]) / (cancel_member["peer"] + ".json")).read_text())
    os.kill(cancel_registration["pid"], signal.SIGKILL)
    time.sleep(9)
    assert not (pathlib.Path(cancel_ws["project"]) / "late.txt").exists()
    cancel_events = (cancel_root / "cancel-events.jsonl").read_text()
    assert '"type":"tool_result"' in cancel_events and ('interrupted' in cancel_events.lower() or 'aborted' in cancel_events.lower())
    import secrets, uuid
    orphan = bench / "orphan"; orphan.mkdir(mode=0o700)
    orphan_boot = orphan / "bootstrap.json"
    orphan_boot.write_text(json.dumps({"folder": str(orphan), "token": secrets.token_hex(32), "name": "orphan", "nonce": str(uuid.uuid4()), "cwd": ws["project"], "orphanMs": 1000}))
    orphan_boot.chmod(0o600)
    preload_marker = pathlib.Path(ws["project"]) / "unexpected-preload"
    (pathlib.Path(ws["project"]) / "runtime-preload.js").write_text(f"import {{writeFileSync}} from 'node:fs'; writeFileSync({json.dumps(str(preload_marker))}, 'unexpected');")
    (pathlib.Path(ws["project"]) / "bunfig.toml").write_text('preload = ["./runtime-preload.js"]\n')
    control_probe = pathlib.Path(ws["project"]) / "env-control.js"
    control_probe.write_text("console.log(process.env.OPENAI_API_KEY === 'fixture-env-file-key-never-real');")
    control_result = subprocess.run(["/usr/bin/env", "-i", "TERM=xterm-256color", "LANG=C.UTF-8", bun, str(control_probe)], cwd=ws["project"], text=True, capture_output=True, timeout=5)
    assert control_result.returncode == 0 and control_result.stdout.strip() == "true" and preload_marker.exists()
    preload_marker.unlink()
    started = time.monotonic()
    orphan_result = subprocess.run(["/usr/bin/env", "-i", "TERM=xterm-256color", "LANG=C.UTF-8", str(pathlib.Path(source) / "build/team-worker-linux"), "__team-worker", str(orphan_boot)], cwd=ws["project"], text=True, capture_output=True, timeout=5)
    assert orphan_result.returncode == 0 and time.monotonic() - started < 4
    assert not preload_marker.exists()
    output = {"passed": True, "leaderPid": leader_pid, "workerPid": worker_pid, "newLeaderPane": new_leader, "workerPane": worker_pane, "sameWorker": True, "unreadMessageAndReportDelivered": True, "deniedReadPreserved": True, "workerDeathRevokesSuspendedTool": True, "serverAndDotenvSecretsAbsent": True, "compiledDotenvAndBunfigDisabled": True, "orphanSelfStops": True, "model": "scripted", "bench": str(bench), "workspace": str(root)}
    (bench / "result.json").write_text(json.dumps(output, indent=2)); print(json.dumps(output))
except Exception:
    for p in root.glob("*-exit.json"): print(p.name, p.read_text(), file=sys.stderr)
    for p in root.glob("*events.jsonl"): print(p.name, p.read_text()[-10000:], file=sys.stderr)
    try:
        for pane in tmux("list-panes", "-a", "-F", "#{pane_id}").splitlines(): print(pane, tmux("capture-pane", "-p", "-t", pane), file=sys.stderr)
    except Exception: pass
    raise
finally:
    subprocess.run(["tmux", "-S", socket, "kill-server"], cwd=str(bench), capture_output=True)
