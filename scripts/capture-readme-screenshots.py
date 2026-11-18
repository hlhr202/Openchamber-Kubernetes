"""Run only in the pinned, network-isolated Chromium container."""

import re
import struct
import subprocess
from pathlib import Path

PREVIEW = Path("/preview")
OUTPUT = Path("/output")
CHROMIUM = Path("/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell")
SCENES = {
    "explorer": ("storefront-api-canary", 'role="menu"'),
    "resource-details": ("Resource manifest", "Document loaded; no edits"),
    "terminal": ('class="xterm-rows"', "server.js", "api@storefront-api"),
    "port-forward": ("Start forwarding", "Service storefront/storefront-api"),
}


def capture(scene, *arguments):
    return subprocess.run(
        [
            CHROMIUM,
            "--headless",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--no-first-run",
            "--user-data-dir=/tmp/kubernetes-screenshot-chromium",
            "--window-size=1120,630",
            "--force-device-scale-factor=1.5",
            "--virtual-time-budget=2500",
            *arguments,
            f"{(PREVIEW / 'index.html').as_uri()}?view={scene}",
        ],
        check=True,
        capture_output=True,
        timeout=25,
    )


for scene, markers in SCENES.items():
    dom = capture(scene, "--dump-dom").stdout.decode()
    if 'data-result="ready"' not in dom or not all(marker in dom for marker in markers):
        detail = re.search(r"<body[^>]*>(.*?)</body>", dom, re.DOTALL)
        body = detail[1] if detail else dom
        raise RuntimeError(f"{scene}: preview not ready ({body[:250]}), missing {[marker for marker in markers if marker not in dom]}")
    filename = OUTPUT / f"{scene}.png"
    capture(scene, "--hide-scrollbars", "--run-all-compositor-stages-before-draw", f"--screenshot={filename}")
    data = filename.read_bytes()
    if not data.startswith(b"\x89PNG\r\n\x1a\n") or struct.unpack(">II", data[16:24]) != (1680, 945):
        raise RuntimeError(f"{filename}: unexpected PNG geometry")
    print(f"{filename.name}: 1680×945, {len(data):,} bytes", flush=True)
