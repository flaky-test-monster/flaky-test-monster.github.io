#!/usr/bin/env bash
# Builds the static frontend into _site for GitHub Pages. Pages serves the site under a
# sub-path (/flakifier/, /flakifier/pr-preview/pr-N/), which is why index.html links its
# assets relatively. There is no backend there, so the page is marked data-backend="none":
# the camera and the monster scan work, and what needs `npm start` is disabled.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf _site
mkdir -p _site
cp -R public _site/public
sed 's#<html lang="en">#<html lang="en" data-backend="none">#' public/index.html > _site/index.html
grep -q 'data-backend="none"' _site/index.html
touch _site/.nojekyll
