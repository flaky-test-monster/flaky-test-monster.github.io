#!/usr/bin/env bash
# Builds the static frontend into _site for GitHub Pages. Pages serves the site under a
# sub-path (/flakifier/, /flakifier/pr-preview/pr-N/), which is why index.html links its
# assets relatively. There is no backend there: the camera and the monster scan work,
# while Flakify and the recent list need `npm start`.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf _site
mkdir -p _site
cp -R public _site/public
cp public/index.html _site/index.html
touch _site/.nojekyll
