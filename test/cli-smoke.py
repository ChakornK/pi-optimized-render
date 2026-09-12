"""Exercise the bundled Pi CLI in isolated pseudo-terminals without making model requests."""

import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
EXTENSION = Path(os.environ.get("PI_RENDER_EXTENSION", ROOT / "src/index.ts")).resolve()
ANSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b_[^\x07]*\x07")


def replay_session(directory):
    source = os.environ.get("PI_TEST_SESSION")
    if source:
        entries = [json.loads(line) for line in Path(source).read_text().splitlines() if line.strip()]
        assert entries and entries[0].get("type") == "session", "Expected a Pi session header"
        entries[0] = {**entries[0], "id": str(uuid.uuid4()), "cwd": str(ROOT)}
    else:
        entries = [{"type": "session", "version": 3, "id": str(uuid.uuid4()),
                    "timestamp": "2023-11-14T22:13:20.000Z", "cwd": str(ROOT)}]
    parent = next((entry["id"] for entry in reversed(entries[1:]) if "id" in entry), None)
    for index in range(12):
        timestamp = 1700000000000 + index * 3000
        message_id = str(uuid.uuid4())
        entries.append({"type": "message", "id": message_id, "parentId": parent,
            "timestamp": "2023-11-14T22:13:20.000Z", "message": {
                "role": "assistant", "content": [{"type": "text", "text": f"Recorded reply {index}"}],
                "api": "openai-completions", "provider": "openai", "model": "gpt-4o",
                "stopReason": "stop", "timestamp": timestamp,
                "usage": {"input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 2,
                          "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}}})
        parent = str(uuid.uuid4())
        entries.append({"type": "custom", "customType": "render-test-entry", "id": parent,
            "parentId": message_id, "timestamp": "2023-11-14T22:13:20.000Z", "data": {
                "label": f"Custom row {index}", "policy": ("cache", "live", "dynamic")[index % 3]}})
    path = Path(directory) / "fixtures" / "replay.jsonl"
    path.parent.mkdir(parents=True)
    path.write_text("".join(json.dumps(entry, separators=(",", ":")) + "\n" for entry in entries))
    return path


def exercise(mode, history=False):
    with tempfile.TemporaryDirectory(prefix="pi-render-smoke-") as agent_dir:
        ready_file = Path(agent_dir) / "ready"
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 100, 0, 0))
        env = {
            **os.environ,
            "PI_CODING_AGENT_DIR": agent_dir,
            "PI_OFFLINE": "1",
            "PI_TELEMETRY": "0",
            "TERM": "xterm-256color",
            "TZ": "UTC",
            "PI_TEST_READY_FILE": str(ready_file),
        }
        replay_args = ["--session", str(replay_session(agent_dir))] if history else ["--no-session"]
        process = subprocess.Popen([
            "node", str(CLI), "--offline", *replay_args, "--no-tools", "--no-context-files",
            "--no-extensions", "-e", str(EXTENSION), "-e", str(ROOT / "test/cli-fixture.ts"),
            "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve", "--tui-mode", mode,
        ], cwd=ROOT, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        transcript = bytearray()

        def receive(seconds, expected=None):
            deadline = time.monotonic() + seconds
            received = bytearray()
            while time.monotonic() < deadline:
                ready, _, _ = select.select([master], [], [], min(0.1, max(0, deadline - time.monotonic())))
                if not ready:
                    if process.poll() is not None:
                        break
                    continue
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not data:
                    break
                received.extend(data)
                transcript.extend(data)
                plain = ANSI.sub(b"", received).decode("utf-8", "replace")
                if expected and expected in plain:
                    return plain
            plain = ANSI.sub(b"", received).decode("utf-8", "replace")
            if expected:
                raise AssertionError(f"{mode}: missing {expected!r}; transcript output withheld")
            return plain

        def command(value, expected):
            os.write(master, (value + "\r").encode())
            return receive(30, expected)

        def wait_ready(previous=None):
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline and process.poll() is None:
                receive(0.1)
                if ready_file.exists():
                    current = ready_file.read_text()
                    if current and current != previous:
                        return current
            raise AssertionError(f"{mode}: Pi startup/reload did not become ready")

        def cache_status():
            path = Path(agent_dir) / (str(uuid.uuid4()) + ".json")
            command("/render-test-probe " + str(path), "Render probe saved " + path.name)
            report = json.loads(path.read_text())
            assert report["controller"], f"{mode}: optimizer is not active"
            if history:
                assert report["fixtureRows"] > 0, f"{mode}: custom history did not load"
                assert report["cacheableRows"] == report["retainedRows"] > 0
                assert report["dynamicRows"] == report["liveRows"] > 0
                assert report["fixtureRows"] == report["retainedRows"] + report["liveRows"]
                assert report["staleRows"] == 0, f"{mode}: stale custom rows after invalidation"
                assert report["idleCachedRenders"] == 0, f"{mode}: idle cached rows rendered"
                assert report["idleLiveRenders"] >= report["liveRows"], f"{mode}: live rows froze"
            return report

        try:
            generation = wait_ready()
            command("/render-opt status", f"Render optimization on ({mode})")
            initial = cache_status()
            if history:
                nonce = str(uuid.uuid4())
                command("/render-test-change " + nonce, "Fixture changed " + nonce)
                updated = cache_status()
                assert updated["revision"] == initial["revision"] + 1
            command("/render-opt off", "native rendering restored")
            command("/render-opt on", "Render optimization on.")
            cache_status()
            command("/render-opt clear", "Render caches cleared")
            cache_status()
            os.write(master, b"/reload\r")
            generation = wait_ready(generation)
            report = cache_status()
            os.write(master, b"/quit\r")
            receive(20)
            process.wait(timeout=5)
            assert process.returncode == 0, f"{mode}: Pi exited with {process.returncode}"
            if not history:
                plain = ANSI.sub(b"", transcript).decode("utf-8", "replace")
                assert "Render optimization unavailable" not in plain, "optimizer attachment failed"
                assert "Render optimization disabled:" not in plain, "optimizer deactivated"
            suffix = f", {report['retainedRows']} cached and {report['liveRows']} live custom rows" if history else ""
            print(f"PASS bundled CLI {mode}: attachment, status, off/on, clear, reload, shutdown{suffix}")
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            os.close(master)


if __name__ == "__main__":
    for tui_mode in ("regular", "fullscreen"):
        exercise(tui_mode, history="--history" in sys.argv)
