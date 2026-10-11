#!/usr/bin/env bash
# Builds the static frontend into _site for GitHub Pages. Pages serves the site under a
# sub-path (/flakifier/, /flakifier/pr-preview/pr-N/), which is why index.html links its
# assets relatively. There is no backend there, so the page is marked data-backend="none":
# the camera, the monster scan and the in-browser 3D method work, and what needs
# `npm start` is disabled.
# JS, CSS and HTML are minified with pinned tools fetched by npx; the app itself keeps no
# npm dependencies, and the Node server still serves public/ unminified.
set -euo pipefail
cd "$(dirname "$0")/.."

ESBUILD=esbuild@0.28.2
HTML_MINIFIER=html-minifier-terser@7.2.0

rm -rf _site
mkdir -p _site/public
# Images and anything else that is not minified, copied as is.
find public -maxdepth 1 -type f ! -name '*.js' ! -name '*.css' ! -name '*.html' -exec cp {} _site/public/ \;
# Videos and other media, also as is.
cp -R public/media _site/public/
# Each module on its own, no bundling: relative imports and the CDN imports stay as they are.
npx --yes "$ESBUILD" public/*.js public/*.css --minify --format=esm --target=es2022 \
  --outdir=_site/public --log-level=warning
sed 's#<html lang="en">#<html lang="en" data-backend="none">#' public/index.html \
  | npx --yes "$HTML_MINIFIER" --collapse-whitespace --conservative-collapse --remove-comments \
    --minify-css true > _site/index.html
grep -q 'data-backend="none"' _site/index.html
# The music page needs no backend.
npx --yes "$HTML_MINIFIER" --collapse-whitespace --conservative-collapse --remove-comments \
  --minify-css true public/music.html > _site/music.html
# Every link to a script or stylesheet, in the pages and in the modules' imports, carries the
# commit, so a new deploy never runs next to files the browser cached from the last one: Pages
# lets browsers keep them for ten minutes, and an old module against a new page breaks it.
VERSION=$(git rev-parse --short HEAD 2>/dev/null || date +%s)
sed -E -i "s#\"((\./|public/)[A-Za-z0-9_-]+\.(js|css))\"#\"\1?v=$VERSION\"#g" _site/*.html _site/public/*.js
grep -q "music-photo.js?v=$VERSION" _site/public/music-vote.js
touch _site/.nojekyll
