#!/usr/bin/env bash
# Prepare the relapse copy used by the frontend and apply our autoloader patch.
#
# relapse lives as a pristine git submodule in third_party/relapse (never
# modified). The frontend needs it under frontend/autoloader/relapse, so this
# script:
#   1. copies third_party/relapse -> frontend/autoloader/relapse (fresh copy)
#   2. prunes what the autoloader never loads: the README, the upstream dev
#      server, and every bundled payload except the kexp shellcode
#      (elfldr comes from the shared ../../shared/ dir, and the kstuff /
#      shadowmountplus / etaHEN menu payloads are not used by the autoloader)
#   3. applies patches/relapse-autoload.patch to the copy
#
# The copy is gitignored (frontend/autoloader/relapse/), so the submodule is
# never dirtied. Run after every submodule update:
#
#   git submodule update --init --recursive
#   tools/apply_relapse_patch.sh
#
# The Makefile runs this automatically before staging/serving (relapse-prepare).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT/third_party/relapse"
DEST="$ROOT/frontend/autoloader/relapse"
PATCH="$ROOT/patches/relapse-autoload.patch"

if [ ! -e "$SOURCE/.git" ]; then
    echo "Error: relapse submodule is not initialised."
    echo "Run: git submodule update --init --recursive"
    exit 1
fi

if [ ! -f "$PATCH" ]; then
    echo "Error: patch file not found: $PATCH"
    exit 1
fi

# 1. Fresh copy of the exploit root. LICENSE is kept for attribution; the
#    README and the upstream dev server (serve.py) are not needed at runtime.
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SOURCE"/. "$DEST"/
rm -rf "$DEST/.git" "$DEST/.github" "$DEST/.gitignore" "$DEST/README.md" "$DEST/serve.py"

# 2. Prune payloads/ completely: elfldr and kexp are the shared binaries
#    from frontend/autoloader/shared/ (localhost-only), and the optional
#    jailbreak menu is never loaded by the autoloader.
rm -rf "$DEST/payloads"

# 3. Turn the copy into a throwaway git repo so `git apply` can handle the
#    patch. Two commits: pristine relapse, then our autoloader patch.
SRC_HASH=$(git -C "$SOURCE" rev-parse --short HEAD)
git -C "$DEST" init -q
git -C "$DEST" config user.name "wkal"
git -C "$DEST" config user.email "wkal@localhost"
git -C "$DEST" add -A
git -C "$DEST" commit -q -m "relapse pristine (submodule $SRC_HASH)"

# 4. Apply the patch
cd "$DEST"
if git apply --check "$PATCH" 2>/dev/null; then
    git apply "$PATCH"
    git add -A
    git commit -q -m "Apply WKAL autoloader patch"
    echo "relapse: copied to $DEST and autoloader patch applied."
elif git apply --reverse --check "$PATCH" 2>/dev/null; then
    echo "relapse: autoloader patch is already applied."
else
    echo "Error: patch does not apply cleanly to $DEST."
    echo "relapse has likely changed upstream — regenerate patches/relapse-autoload.patch:"
    echo "  git -C $DEST diff HEAD~1 > $PATCH"
    exit 1
fi

# 5. Sanity check: the patched sources must carry our integration markers, the
#    bundled elfldr and kexp must be gone, the runtime offsets URL must
#    be the pinned one, and kexp must run via KXP2 without binary patching.
if ! grep -q 'const AUTOLOAD = new URLSearchParams' src/main.js \
    || ! grep -q 'const AUTOLOAD_BASE = "../payloads/";' src/main.js \
    || ! grep -q 'async function startAutoload' src/main.js \
    || ! grep -q 'await startAutoload(p, chain);' src/main.js \
    || ! grep -q 'reportAutoload(false, { why: "elfldr did not start" });' src/main.js \
    || ! grep -q 'isElfldrListening(p, chain)' src/main.js \
    || ! grep -q 'const why = "Already jailbroken.";' src/main.js \
    || ! grep -q 'window.fw_str + ".js");' src/main.js \
    || grep -qF 'fw_str}.js?v=' src/main.js \
    || ! grep -q 'const SHARED_BASE = "../shared/";' src/kexp.js \
    || ! grep -q 'const DEFAULT_ELFLDR = "elfldr-ps5.elf";' src/kexp.js \
    || ! grep -q 'const DEFAULT_KEXP = "kexp-ps5.bin";' src/kexp.js \
    || ! grep -q '0x4b585032' src/kexp.js \
    || grep -q 'patchShellcode' src/kexp.js \
    || ! grep -q 'mapElf(DEFAULT_ELFLDR, p, chain, SHARED_BASE)' src/kexp.js \
    || ! grep -q 'fetchBinary(DEFAULT_KEXP, SHARED_BASE)' src/kexp.js \
    || ! grep -q 'export async function loadAutoloadPayload' src/kexp.js \
    || ! grep -q 'export async function isElfldrListening' src/kexp.js \
    || grep -qF 'DEFAULT_ELFLDR = "elfldr-ps5-1360.elf"' src/kexp.js \
    || grep -qF 'DEFAULT_KEXP = "kexp_2026_05_25.bin"' src/kexp.js \
    || grep -qF '../../shared/' src/kexp.js \
    || grep -qF '../../payloads/' src/main.js \
    || [ ! -f LICENSE ] \
    || [ -e serve.py ] \
    || [ -d payloads ]; then
    echo "Error: relapse patch verification FAILED — integration markers missing."
    echo "patches/relapse-autoload.patch is incomplete or out of date."
    echo "Regenerate it from a patched copy and re-run."
    exit 1
fi
echo "relapse: patch verification OK (early elfldr guard, ?autoload sender,"
echo "         shared elfldr and kexp with KXP2 api-table, query-less offsets URL)."

# 6. Parse-check the patched JS in the mode the browser will use it in. A
#    `node --check foo.js` parses in CommonJS (sloppy) mode, but these are ES
#    modules (strict) — a scope collision that sloppy mode accepts still kills
#    the chain on the console. See tools/check_exploit_js.py.
"$ROOT/tools/check_exploit_js.py" "$DEST"
