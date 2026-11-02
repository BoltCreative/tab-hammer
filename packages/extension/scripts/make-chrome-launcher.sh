#!/usr/bin/env bash
# Builds "Google Chrome silent debugger.app": a tiny launcher that starts Chrome with
# --silent-debugger-extension-api, which hides Chrome's "started debugging this browser" infobar
# (see README.md's "Hiding Chrome's debugging banner" section for why Tab Hammer needs that flag
# and the trade-offs of using it).
#
# We don't commit a compiled .app to the repo (binary, and macOS quarantines/re-signs it
# unpredictably when copied around). Instead this script builds one locally, on demand, with
# osacompile, an AppleScript applet whose only job is to relaunch Chrome with the flag.
#
# Usage: make-chrome-launcher.sh [destination-dir] [--force]
#   destination-dir  Where to write the .app (default: "$HOME/Applications").
#   --force          Overwrite an existing app at that destination.
set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  echo "make-chrome-launcher.sh only runs on macOS." >&2
  exit 1
fi

dest_dir=""
force=0
for arg in "$@"; do
  if [[ "$arg" == "--force" ]]; then
    force=1
  else
    dest_dir="$arg"
  fi
done
dest_dir="${dest_dir:-$HOME/Applications}"

app_name="Google Chrome silent debugger.app"
app_path="$dest_dir/$app_name"
chrome_icns="/Applications/Google Chrome.app/Contents/Resources/app.icns"

if [[ -e "$app_path" && "$force" -ne 1 ]]; then
  echo "$app_path already exists. Re-run with --force to overwrite it." >&2
  exit 1
fi

mkdir -p "$dest_dir"
rm -rf "$app_path"

osacompile -o "$app_path" -e 'do shell script "open -a \"Google Chrome\" --args --silent-debugger-extension-api"'

# osacompile's applet ships its own generic icon. Swap in Chrome's icon so the launcher is
# recognizable in the Dock and Finder.
if [[ -f "$chrome_icns" ]]; then
  cp "$chrome_icns" "$app_path/Contents/Resources/applet.icns"
  # Newer osacompile applets reference their icon via CFBundleIconName, pointing at an entry in
  # Assets.car (a compiled asset catalog) rather than the CFBundleIconFile .icns directly. Left in
  # place, that takes priority and the swapped-in .icns above never shows. Removing both falls
  # back to CFBundleIconFile, which is applet.icns.
  /usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$app_path/Contents/Info.plist" >/dev/null 2>&1 || true
  rm -f "$app_path/Contents/Resources/Assets.car"
fi

# Editing the bundle's contents invalidates its signature; ad hoc re-sign so macOS (Gatekeeper,
# and the Dock) is happy to run it.
codesign --force --deep -s - "$app_path"

echo "Built $app_path"
