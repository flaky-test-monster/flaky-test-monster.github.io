#!/usr/bin/env bash
# Builds the static frontend into _site for GitHub Pages. Pages serves the site under a
# sub-path (/flakifier/, /flakifier/pr-preview/pr-N/), which is why index.html links its
# assets relatively. There is no backend there, so the page is marked data-backend="none":
# the camera, the monster scan and the in-browser pipeline (public/browser.html) work, and
# what needs `npm start` is disabled.
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
# Each module on its own, no bundling: relative imports and the CDN imports stay as they are.
npx --yes "$ESBUILD" public/*.js public/*.css --minify --format=esm --target=es2022 \
  --outdir=_site/public --log-level=warning
sed 's#<html lang="en">#<html lang="en" data-backend="none">#' public/index.html \
  | npx --yes "$HTML_MINIFIER" --collapse-whitespace --conservative-collapse --remove-comments \
    --minify-css true > _site/index.html
grep -q 'data-backend="none"' _site/index.html
# The in-browser pipeline needs no backend, so it runs on Pages as is.
npx --yes "$HTML_MINIFIER" --collapse-whitespace --conservative-collapse --remove-comments \
  --minify-css true public/browser.html > _site/public/browser.html
touch _site/.nojekyll
