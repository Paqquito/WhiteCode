"""Owned Linux PTY, real product contexts, scripted provider. No provider credentials."""
import errno, fcntl, json, os, pathlib, pty, re, select, signal, struct, subprocess, sys, tempfile, termios, time

program = pathlib.Path(sys.argv[1]).resolve()
bench = pathlib.Path(tempfile.mkdtemp(prefix="mb51-", dir="/var/tmp"))
results = {}

def case(mode):
    root = bench / mode
    root.mkdir()
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 180, 0, 0))
    proc = subprocess.Popen([str(program), str(root), mode], cwd=str(root), env={"PATH": "/usr/bin:/bin", "TERM": "xterm-256color", "LANG": "C.UTF-8"}, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    output = bytearray()
    def drain():
        if select.select([master], [], [], .04)[0]:
            try: output.extend(os.read(master, 65536))
            except OSError as e:
                if e.errno != errno.EIO: raise
    def text(): return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output.decode(errors="replace"))
    def wait(predicate, seconds=15):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            drain()
            if predicate(): return
            if proc.poll() is not None: raise RuntimeError(f"{mode}: premature exit {proc.returncode}: {text()[-5000:]}")
        raise RuntimeError(f"{mode}: timeout: {text()[-7000:]}")
    def send(value):
        if len(value) > 1 and not value.startswith("\x1b"):
            for char in value:
                os.write(master, char.encode()); time.sleep(.01)
        else: os.write(master, value.encode())
    def records(name):
        path = root / name
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
    def word(value): wait(lambda: value in text())
    try:
        word("Votre message")
        word("Version installée"); time.sleep(.2)
        send("first context unique\r")
        word("FIRST_WAITING")
        first_requests = records("requests.jsonl")
        assert len(first_requests) == (2 if mode == "workflow" else 1)
        first_id = first_requests[0]["id"]
        send("\x1bj"); word("Appuyer à nouveau")
        assert len(records("requests.jsonl")) == len(first_requests)
        send("\x1bj"); time.sleep(.3); drain()
        send("second context unique\r")
        if mode == "budget":
            wait(lambda: any(e["type"] == "turn_completed" and e["result"]["stopCause"] == "budget_limit" for e in records("events.jsonl")))
            assert len(records("requests.jsonl")) == 1
            assert not (root / "aborts.jsonl").exists()
            word("résultat disponible")
            results[mode] = {"pid": proc.pid, "requests": 1, "budget_refused_while_reserved": True}
        elif mode == "close":
            word("SECOND_WAITING")
            requests = records("requests.jsonl")
            assert len(requests) == 2 and requests[0]["id"] != requests[1]["id"]
            started = time.monotonic(); proc.send_signal(signal.SIGTERM)
            wait(lambda: (root / "exit.json").exists())
            assert time.monotonic() - started < 2
            assert len(records("aborts.jsonl")) == 2
            assert not (root / "project/late.txt").exists()
            results[mode] = {"pid": proc.pid, "distinct_conversations": True, "both_calls_aborted": True, "late_write_absent": True}
        else:
            word("Demandé par : conversation 2"); time.sleep(.4); send("1")
            word("SECOND_DONE")
            assert (root / "project/accepted.txt").read_text() == "ACCEPTED"
            word("Tâche s1 — session principale — conversation 1"); time.sleep(.4); send("\x1b")
            word("résultat disponible")
            assert not (root / "project/denied.txt").exists()
            assert (root / "project/shared.txt").read_text() == "PEER WRITE"
            events = records("events.jsonl")
            assert any(e["type"] == "tool_result" and e["isError"] and re.search("changed|modified", e["output"], re.I) for e in events)
            assert not (root / "aborts.jsonl").exists()
            send("\x1bk"); word("Tâches de fond — conversations"); time.sleep(.4); send("\r")
            word("Reprendre la conversation"); time.sleep(.4); send("\r")
            word("conversation 1 reprise"); send("resume first context\r"); word("FIRST_RESUMED")
            requests = records("requests.jsonl")
            assert requests[-1]["id"] == first_id
            assert "second context unique" not in json.dumps(requests[-1]["history"])
            offset = len(output)
            send("\x1bk"); time.sleep(.4); send("\x1b[B\r"); time.sleep(.4); send("\r")
            wait(lambda: "conversation 2 reprise" in output[offset:].decode(errors="replace"))
            send("resume second context\r"); word("SECOND_RESUMED")
            requests = records("requests.jsonl")
            assert requests[-1]["id"] != first_id
            assert "first context unique" not in json.dumps(requests[-1]["history"])
            results[mode] = {"pid": proc.pid, "original_conversation": first_id, "second_conversation": requests[-1]["id"], "requests": len(requests), "no_replay_or_abort": True, "permission_labelled_denial": True, "peer_write_preserved": True, "both_contexts_resumed": True}
        if proc.poll() is None: proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=8)
        assert (root / "exit.json").exists()
        results[mode]["joined_exit"] = json.loads((root / "exit.json").read_text())
    finally:
        if proc.poll() is None: proc.kill(); proc.wait(timeout=3)
        (root / "terminal.raw").write_bytes(output)
        os.close(master)

for mode in ["workflow", "budget", "close"]: case(mode)
(bench / "result.json").write_text(json.dumps(results, indent=2))
print(json.dumps({"bench": str(bench), "results": results}))
