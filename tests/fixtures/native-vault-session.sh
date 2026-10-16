#!/bin/sh
# Supports: SPEC-SES-001/CA-06; a private ephemeral Secret Service without a password or personal collection.
set -eu
repository=${WC_NATIVE_REPOSITORY:?Native repository required}
resources=${WC_NATIVE_RESOURCES_DIR:?Native resources required}
temporary=${WC_NATIVE_PROOF_DIR:?Owned proof directory required}
case "$resources" in /*) ;; *) exit 1 ;; esac
case "$temporary" in /tmp/whitecode-vault-proof-??????) ;; *) exit 1 ;; esac
if [ "${1:-}" != inside ]; then
  mkdir -p "$temporary/vault-home" "$temporary/vault-runtime"
  chmod 700 "$temporary/vault-home" "$temporary/vault-runtime"
  export HOME="$temporary/vault-home" XDG_RUNTIME_DIR="$temporary/vault-runtime"
  export XDG_DATA_HOME="$HOME/data" XDG_CONFIG_HOME="$HOME/config"
  export LD_LIBRARY_PATH="$resources/vault/usr/lib/x86_64-linux-gnu"
  export PATH="$resources/vault/usr/bin:/usr/bin:/bin"
  exec dbus-run-session -- /bin/sh "$repository/tests/fixtures/native-vault-session.sh" inside "${1:-probe}"
fi
gnome-keyring-daemon --foreground --components=secrets --control-directory "$XDG_RUNTIME_DIR/control" > "$temporary/vault-daemon.log" 2>&1 &
daemon_pid=$!
trap 'kill "$daemon_pid" 2>/dev/null || true; wait "$daemon_pid" 2>/dev/null || true' EXIT HUP INT TERM
attempt=0
until gdbus call --session --dest org.freedesktop.secrets --object-path /org/freedesktop/secrets --method org.freedesktop.Secret.Service.ReadAlias session > "$temporary/vault-ready.txt" 2>/dev/null; do
  attempt=$((attempt + 1)); [ "$attempt" -lt 50 ] || { cat "$temporary/vault-daemon.log"; exit 1; }; sleep 0.1
done
cat "$temporary/vault-ready.txt"
gdbus call --session --dest org.freedesktop.secrets --object-path /org/freedesktop/secrets --method org.freedesktop.Secret.Service.SetAlias default /org/freedesktop/secrets/collection/session
if [ "${2:-}" = owner ]; then
  "${WC_NATIVE_BUN:?Native Bun required}" "$repository/tests/fixtures/native-vault-probe.ts" owner
  exit
fi
printf '%s' ephemeral-probe-value | timeout 10 secret-tool store --label='Ephemeral test item' service whitecode-native60-probe account fixture
value=$(timeout 10 secret-tool lookup service whitecode-native60-probe account fixture)
[ "$value" = ephemeral-probe-value ]
timeout 10 secret-tool clear service whitecode-native60-probe account fixture
printf '%s\n' 'Native ephemeral Secret Service store/read/remove passed without login or password.'
