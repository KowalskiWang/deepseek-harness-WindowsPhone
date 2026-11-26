#!/bin/sh
# Build, sign and verify the DSH Mobile APPX (Windows Phone 8.1 / Windows 10 Mobile).
#   sh scripts/package-appx.sh            (production build first)
#   APPX_REVISION=7 sh scripts/package-appx.sh   (package version 0.2.3.7: test builds that install over each other)
# Requires: Node 18+, OpenSSL 3 (Homebrew openssl@3), appx-util (tools/bin/appx or $APPX_UTIL).
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
OPENSSL=${OPENSSL:-/opt/homebrew/opt/openssl@3/bin/openssl}
[ -x "$OPENSSL" ] || OPENSSL=openssl
APPX=${APPX_UTIL:-$ROOT/tools/bin/appx}
if [ ! -x "$APPX" ]; then
  echo "appx-util not found. Build it: git clone https://github.com/OSInside/appx-util && cd appx-util && mkdir Build && cd Build && cmake .. -DOPENSSL_ROOT_DIR=/opt/homebrew/opt/openssl@3 && make, then set APPX_UTIL=…/Build/appx" >&2
  exit 1
fi

VERSION=$(node -p "require('./package.json').version")
APPX_VERSION="$VERSION.${APPX_REVISION:-0}"
PUBLISHER=$(sed -n 's/.*Publisher="\([^"]*\)".*/\1/p' appx/AppxManifest.xml | head -1)
echo "== building web + appx layout ($APPX_VERSION, publisher $PUBLISHER)"
node scripts/build.mjs
node scripts/check-es5.mjs

# ---- signing material (kept out of the package; reuse it so updates install over older builds)
mkdir -p signing
if [ ! -f signing/dsh-mobile.pfx ]; then
  echo "== creating self-signed code-signing certificate ($PUBLISHER)"
  CN=$(echo "$PUBLISHER" | sed 's/^CN=//')
  "$OPENSSL" req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout signing/dsh-mobile.key.pem -out signing/dsh-mobile.cert.pem -subj "/CN=$CN" \
    -addext "basicConstraints=critical,CA:FALSE" -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=codeSigning" 2>/dev/null
  "$OPENSSL" pkcs12 -export -out signing/dsh-mobile.pfx -inkey signing/dsh-mobile.key.pem \
    -in signing/dsh-mobile.cert.pem -passout pass: -name "DSH Mobile"
  "$OPENSSL" x509 -in signing/dsh-mobile.cert.pem -outform der -out signing/dsh-mobile.cer
  chmod 600 signing/dsh-mobile.key.pem signing/dsh-mobile.pfx
fi

# ---- file mapping without macOS metadata (._* AppleDouble files on exFAT, .DS_Store)
MAP=$(mktemp)
echo "[Files]" > "$MAP"
(cd dist/appx && find . -type f ! -name '._*' ! -name '.DS_Store' | sed 's#^\./##' | sort) | while read -r f; do
  # appx-util takes "/"-separated package paths (ZIP part names); it writes "\" into the block map itself
  printf '"%s" "%s"\n' "$ROOT/dist/appx/$f" "$f" >> "$MAP"
done
COUNT=$(($(wc -l < "$MAP") - 1))

mkdir -p dist/package
OUT="dist/package/DSHMobile_${APPX_VERSION}_neutral.appx"
rm -f "$OUT"
echo "== packing $COUNT files → $OUT"
"$APPX" -9 -o "$OUT" -c signing/dsh-mobile.pfx -f "$MAP"
rm -f "$MAP"
cp signing/dsh-mobile.cer dist/package/DSHMobile.cer
cp docs/INSTALL.md dist/package/INSTALL.md 2>/dev/null || true

echo "== verifying package"
unzip -l "$OUT" | awk 'NR>3 {print $4}' | grep -E '^(AppxManifest.xml|AppxBlockMap.xml|AppxSignature.p7x|\[Content_Types\].xml|index.html|js\\?/?app.js)$' || true
if unzip -l "$OUT" | grep -q '\._'; then echo "ERROR: package contains ._ files" >&2; exit 1; fi
TMP=$(mktemp -d)
unzip -q -o "$OUT" AppxSignature.p7x -d "$TMP"
# AppxSignature.p7x = "PKCX" magic + DER PKCS#7 SignedData
tail -c +5 "$TMP/AppxSignature.p7x" > "$TMP/sig.der"
"$OPENSSL" pkcs7 -inform der -in "$TMP/sig.der" -print_certs -noout | sed -n 's/^subject=/  signer: /p'
rm -rf "$TMP"
ls -la dist/package
echo "done."
