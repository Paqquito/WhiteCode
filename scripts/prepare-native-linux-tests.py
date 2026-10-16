#!/usr/bin/env python3
# Supports: SPEC-SES-001/CA-06, SPEC-BLD-004/CA-01; isolated native fixtures, gaps E-234, E-235.
"""Prépare les logiciels de test dans /var/tmp, sans installation ni modification du système hôte."""
import hashlib
import os
import pathlib
import platform
import subprocess
import sys
import tempfile
import urllib.request

if sys.platform != "linux" or platform.machine() != "x86_64":
    raise SystemExit("Cette préparation exige Linux x86-64 avec les index APT Ubuntu et les espaces de noms utilisateur.")
root = pathlib.Path(tempfile.mkdtemp(prefix="whitecode-native-tests-", dir="/var/tmp"))
print("Préparation dans " + str(root), file=sys.stderr)


def download(url, target, digest, maximum=32 * 1024 * 1024):
    with urllib.request.urlopen(url, timeout=45) as response:
        if not response.url.startswith("https://"):
            raise RuntimeError("Redirection sans TLS refusée")
        data = response.read(maximum + 1)
    if len(data) > maximum or hashlib.sha256(data).hexdigest() != digest:
        raise RuntimeError("Taille ou empreinte incorrecte pour " + target.name)
    target.write_bytes(data)


for package in ["bubblewrap", "gnome-keyring", "libsecret-1-0", "libsecret-tools", "libgck-1-0", "libgcr-base-3-1"]:
    info = subprocess.check_output(["apt-cache", "show", package], text=True).split("\n\n")[0]
    fields = dict(line.split(": ", 1) for line in info.splitlines() if ": " in line and not line.startswith(" "))
    filename = fields["Filename"]
    if not filename.startswith("pool/") or ".." in filename:
        raise RuntimeError("Origine de paquet inattendue")
    archive = root / (package + ".deb")
    download("https://archive.ubuntu.com/ubuntu/" + filename, archive, fields["SHA256"])
    subprocess.run(["dpkg-deb", "-x", str(archive), str(root / "tools")], check=True)
    print(package + " : empreinte vérifiée, " + fields["Version"], file=sys.stderr)

archive = root / "alpine.tar.gz"
download("https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/alpine-minirootfs-3.24.2-x86_64.tar.gz", archive,
         "c5ca053cfe1d85c5b96dff8b9bc57045f7f184a30ffb6b65776409ca90388677")
alpine = root / "alpine"
alpine.mkdir()
subprocess.run(["tar", "--no-same-owner", "-xzf", str(archive), "-C", str(alpine)], check=True)
for name in ["fixture", "home/test"]:
    (alpine / name).mkdir(parents=True, exist_ok=True)
bwrap = root / "tools/usr/bin/bwrap"
subprocess.run([str(bwrap), "--unshare-all", "--share-net", "--uid", "0", "--gid", "0", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
                "--bind", str(alpine), "/", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf",
                "--clearenv", "--setenv", "PATH", "/usr/sbin:/usr/bin:/sbin:/bin", "--", "/bin/sh", "-c", "apk add --no-cache curl ca-certificates libstdc++"],
               check=True, stdout=sys.stderr)
# These aliases concern downloaded public software only, never a personal vault or account.
(root / "bubblewrap").symlink_to("tools", target_is_directory=True)
(root / "vault").symlink_to("tools", target_is_directory=True)
os.chmod(root, 0o755)
print(root)
