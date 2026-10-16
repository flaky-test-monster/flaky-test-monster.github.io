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
find public -maxdepth 1 -type f ! -name '*.html' -exec cp {} _site/public/ \;
# Videos and other media, also as is.
cp -R public/media _site/public/
# Each module on its own, no bundling: relative imports and the CDN imports stay as they are.
npx --yes "$ESBUILD" public/js/*.js public/css/*.css --minify --format=esm --target=es2022 \
  --outbase=public --outdir=_site/public --log-level=warning
sed 's#<html lang="en">#<html lang="en" data-backend="none">#' public/index.html \
  | npx --yes "$HTML_MINIFIER" --collapse-whitespace --conservative-collapse --remove-comments \
    --minify-css true > _site/index.html
grep -q 'data-backend="none"' _site/index.html
# The music page needs no backend. Its online vote does need a Supabase project: the workflows
# pass the repository variables SUPABASE_URL, SUPABASE_ANON_KEY and, optionally,
# TURNSTILE_SITE_KEY, which go into the pages' meta tags. All three are public by design.
# Without the first two the votes go by email; the Turnstile site key is in the pages already,
# and the variable only replaces it.
for name in SUPABASE_URL SUPABASE_ANON_KEY TURNSTILE_SITE_KEY; do
  if [[ ! ${!name:-} =~ ^[A-Za-z0-9._:/-]*$ ]]; then
    echo "build-pages.sh: unexpected characters in $name" >&2
    exit 1
  fi
done
# A value given replaces what the page has; none leaves the page as it is.
meta() { [[ -n $2 ]] && printf 's#<meta name="%s" content="[^"]*">#<meta name="%s" content="%s">#;' "$1" "$1" "$2"; }
# The admin page of the vote (music-admin.html) gets the same project.
for page in music music-admin; do
  sed "$(meta flaky-supabase-url "${SUPABASE_URL:-}")$(meta flaky-supabase-key "${SUPABASE_ANON_KEY:-}")$(meta flaky-captcha-sitekey "${TURNSTILE_SITE_KEY:-}")" \
    "public/$page.html" \
    | npx --yes "$HTML_MINIFIER" --collapse-whitespace --conservative-collapse --remove-comments \
      --minify-css true > "_site/$page.html"
done
# The about page needs no backend either.
npx --yes "$HTML_MINIFIER" --collapse-whitespace --conservative-collapse --remove-comments \
  --minify-css true public/about.html > _site/about.html
# Every link to a script or stylesheet, in the pages and in the modules' imports, carries the
# commit, so a new deploy never runs next to files the browser cached from the last one: Pages
# lets browsers keep them for ten minutes, and an old module against a new page breaks it.
VERSION=$(git rev-parse --short HEAD 2>/dev/null || date +%s)
# -i with an attached suffix is the one form both GNU sed and macOS sed read the same way.
sed -E -i.bak "s#\"((\./|public/(js|css)/)[A-Za-z0-9_-]+\.(js|css))\"#\"\1?v=$VERSION\"#g" _site/*.html _site/public/js/*.js
rm -f _site/*.bak _site/public/js/*.bak
grep -q "music-photo.js?v=$VERSION" _site/public/js/music-vote.js
grep -q "music-online.js?v=$VERSION" _site/public/js/music-scoreboard.js
grep -q "music-online.js?v=$VERSION" _site/public/js/music-admin.js
grep -q "app.js?v=$VERSION" _site/index.html
touch _site/.nojekyll
