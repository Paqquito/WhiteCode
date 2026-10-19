#!/bin/sh
# Supports: SPEC-CMD-091 (private native proof; no system UID counter is modified).
set -eu
root=$1
case "$root" in /var/tmp/whitecode-native-tests-1mstsgkw/cmd091-proof-??????) ;; *) exit 2 ;; esac
[ -d "$root" ] && [ ! -L "$root" ]
mkdir "$root/bin" "$root/var-lib"
printf '%s\n' '{"purpose":"cmd091-native-proof"}' > "$root/ownership.json"
cp "$2" "$root/bin/proof.js"
cp "$3" "$root/bin/bun"
cp "$4" "$root/bin/product"
chown -R 0:0 "$root"
chmod 755 "$root" "$root/bin"
chmod 555 "$root/bin/bun" "$root/bin/product"
chmod 444 "$root/bin/proof.js"
mount --bind "$root/var-lib" /var/lib
mount --bind "$root" /opt
exec /opt/bin/bun --no-env-file /opt/bin/proof.js harness /opt
