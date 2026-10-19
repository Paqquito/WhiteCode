#!/bin/sh
# Supports: SPEC-API-029, SPEC-PLA-002 (owned native filesystem and private allocation registry).
set -eu
root=$1
case "$root" in /var/tmp/hosted-proof-??????) ;; *) exit 2 ;; esac
[ -d "$root" ] && [ ! -L "$root" ]
mkdir "$root/bin" "$root/var-lib"
cp "$2" "$root/bin/proof.js"
cp "$3" "$root/bin/bun"
cp "$4" "$root/bin/product"
chmod 755 "$root" "$root/bin"
chmod 555 "$root/bin/bun" "$root/bin/product"
chmod 444 "$root/bin/proof.js"
mount --bind "$root/var-lib" /var/lib
exec "$root/bin/bun" --no-env-file "$root/bin/proof.js" harness "$root"
