// Implements: SPEC-INS-001 (native shell bootstrap, no runtime dependency, integrity before execution).
// Supports: E-156 (bootstrap receipt, one-time verified executable delegates atomic installation to itself).
import type { Identity } from "../identity/identity";
export function bootstrapScript(identity: Identity, shell: "powershell" | "sh"): string {
  const service=identity.get('SERVICE_DOWNLOADS').replace(/\/$/,''), cli=identity.get('PRODUCT_CLI');
  if (!/^https:\/\//.test(service) || /[\s"'`$\\]/.test(service)) throw new Error('Adresse de distribution invalide pour un script.');
  if (shell==='powershell') return `param([ValidatePattern('^(stable|latest|[0-9]+\\.[0-9]+\\.[0-9]+)$')][string]$Target = 'stable')
$ErrorActionPreference = 'Stop'
$service = '${service}'
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($architecture -notin @('x64','arm64')) { throw 'Plateforme non prise en charge' }
if ($Target -match '^[0-9]+' -and [int]($Target.Split('.')[0]) -ge 900000) { throw 'Version réservée ; utilisez stable ou latest' }
$platform = 'windows-' + $architecture
$manifest = Invoke-RestMethod -Uri ($service + '/v1/' + $Target + '.json') -TimeoutSec 10 -MaximumRedirection 0
$artifact = $manifest.artifacts.$platform
if ($manifest.schemaVersion -ne 1 -or $manifest.version -notmatch '^[0-9]+\\.[0-9]+\\.[0-9]+$' -or [int]($manifest.version.Split('.')[0]) -ge 900000 -or $artifact.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $artifact.size -lt 1 -or $artifact.size -gt 536870912) { throw 'Manifeste invalide' }
if ($Target -notin @('stable','latest') -and $Target -ne $manifest.version) { throw 'Version publiée différente' }
$address = [Uri]::new([Uri]($service + '/'), [string]$artifact.url)
if ($address.Scheme -ne 'https' -or $address.Authority -ne ([Uri]$service).Authority -or $address.UserInfo -or $address.Query -or $address.Fragment) { throw 'Origine de téléchargement refusée' }
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('${cli}-install-' + [Guid]::NewGuid().ToString())
[IO.Directory]::CreateDirectory($temporary) | Out-Null
$binary = Join-Path $temporary '${cli}.exe'
try {
  Invoke-WebRequest -Uri $address -OutFile $binary -TimeoutSec 60 -MaximumRedirection 0
  if ((Get-Item -LiteralPath $binary).Length -ne $artifact.size -or (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $artifact.sha256) { throw 'Empreinte invalide ; installation annulée' }
  if ($artifact.signature -eq 'platform' -and (Get-AuthenticodeSignature -LiteralPath $binary).Status -ne 'Valid') { throw 'Signature invalide' }
  & $binary installation update --version $manifest.version
  if ($LASTEXITCODE -ne 0) { throw 'Installation native impossible' }
} finally {
  $resolved = [IO.Path]::GetFullPath($temporary)
  $prefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\\') + '\\'
  if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Dossier temporaire inattendu' }
  Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
}
`;
  return `#!/bin/sh
set -eu
target="\${1:-stable}"
case "$target" in stable|latest) ;; *) printf '%s' "$target" | LC_ALL=C grep -Eq '^[0-9]+\\.[0-9]+\\.[0-9]+$' || { echo 'Cible invalide' >&2; exit 1; }; [ "\${target%%.*}" -lt 900000 ] || { echo 'Version réservée' >&2; exit 1; } ;; esac
service='${service}'
case "$(uname -s)" in Darwin) os=macos ;; Linux) os=linux ;; *) echo 'Plateforme non prise en charge' >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo 'Architecture non prise en charge' >&2; exit 1 ;; esac
platform="$os-$arch"
if [ "$os" = linux ]; then platform="$platform-glibc"; for loader in /lib/ld-musl-*.so.1; do if [ -f "$loader" ]; then platform="$os-$arch-musl"; break; fi; done; fi
temporary=$(mktemp -d)
trap 'rm -f "$temporary/index" "$temporary/${cli}"; rmdir "$temporary" 2>/dev/null || true' EXIT HUP INT TERM
umask 077
if [ -n "\${${identity.get('ENV_PREFIX')}EXTRA_CA_CERTS:-}" ]; then set -- --cacert "$${identity.get('ENV_PREFIX')}EXTRA_CA_CERTS"; else set --; fi
curl --fail --silent --show-error --proto '=https' --max-time 10 --max-filesize 8192 "$@" "$service/v1/$target-$platform.txt" -o "$temporary/index"
[ "$(wc -c < "$temporary/index")" -le 8192 ] || { echo 'Manifeste trop volumineux' >&2; exit 1; }
version=$(sed -n '1p' "$temporary/index"); digest=$(sed -n '2p' "$temporary/index"); size=$(sed -n '3p' "$temporary/index"); artifact=$(sed -n '4p' "$temporary/index")
[ "$(wc -l < "$temporary/index")" -eq 4 ] || { echo 'Manifeste invalide' >&2; exit 1; }
printf '%s' "$version" | LC_ALL=C grep -Eq '^[0-9]+\\.[0-9]+\\.[0-9]+$' && [ "\${version%%.*}" -lt 900000 ] || { echo 'Version invalide' >&2; exit 1; }
case "$target" in stable|latest) ;; *) [ "$version" = "$target" ] || { echo 'Version publiée différente' >&2; exit 1; } ;; esac
printf '%s' "$digest" | LC_ALL=C grep -Eq '^[a-f0-9]{64}$' || { echo 'Empreinte invalide' >&2; exit 1; }
printf '%s' "$size" | LC_ALL=C grep -Eq '^[0-9]{1,9}$' && [ "$size" -gt 0 ] && [ "$size" -le 536870912 ] || { echo 'Taille invalide' >&2; exit 1; }
case "$artifact" in "$service"/*) ;; *) echo 'Origine refusée' >&2; exit 1 ;; esac
case "$artifact" in *'?'*|*'#'*|*'@'*|*' '*|*'\\'*|*'/../'*) echo 'Adresse refusée' >&2; exit 1 ;; esac
curl --fail --silent --show-error --proto '=https' --max-time 60 --max-filesize "$size" "$@" "$artifact" -o "$temporary/${cli}"
[ "$(wc -c < "$temporary/${cli}")" -eq "$size" ] || { echo 'Taille incorrecte' >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$temporary/${cli}" | cut -d' ' -f1); else actual=$(shasum -a 256 "$temporary/${cli}" | cut -d' ' -f1); fi
[ "$actual" = "$digest" ] || { echo 'Empreinte invalide ; installation annulée' >&2; exit 1; }
chmod 700 "$temporary/${cli}"
"$temporary/${cli}" installation update --version "$version"
`;
}
