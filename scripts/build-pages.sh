#!/usr/bin/env bash
# Builds the static frontend into _site for GitHub Pages. Pages serves the site under a
# sub-path (/flakifier/, /flakifier/pr-preview/pr-N/), which is why the pages link their
# assets relatively. There is no backend there, so the app (flakifier.html) is marked
# data-backend="none": the camera, the monster scan and the in-browser 3D method work, and
# what needs `npm start` is disabled. The music page is the start page (index.html).
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
# The music page needs no backend. Its online vote does need a Supabase project: the workflows
# pass the repository variables SUPABASE_URL, SUPABASE_ANON_KEY and, optionally,
# TURNSTILE_SITE_KEY, which go into the pages' meta tags. All three are public by design.
# Without the first two the votes go by email; the Turnstile site key is in the pages already,
# and the variable only replaces it.
for name in SUPABASE_URL SUPABASE_ANON_KEY TURNSTILE_SITE_KEY SITE_URL SITE_PATH; do
  if [[ ! ${!name:-} =~ ^[A-Za-z0-9._:/-]*$ ]]; then
    echo "build-pages.sh: unexpected characters in $name" >&2
    exit 1
  fi
done
# A value given replaces what the page has; none leaves the page as it is.
meta() { [[ -n $2 ]] && printf 's#<meta name="%s" content="[^"]*">#<meta name="%s" content="%s">#;' "$1" "$1" "$2"; }
# Link previews (og:image, og:url) need absolute URLs. The pages' source has them for the
# original site (SOURCE_URL); the workflows pass SITE_URL, where this repository's Pages site
# lives (https://<owner>.github.io/<repo>/ or the repository variable SITE_URL), so a copy of
# the repository under another account links to itself. SITE_PATH is where this build goes
# under it: pr-preview.yml gives pr-preview/pr-<number>/, so a preview link unfurls with the
# preview's own image before the change reaches main.
SOURCE_URL=https://kertal.github.io/flakifier/
BUILD_URL="${SITE_URL:-$SOURCE_URL}"
BUILD_URL="${BUILD_URL%/}/${SITE_PATH:+${SITE_PATH%/}/}"
site() { [[ $BUILD_URL != "$SOURCE_URL" ]] && printf 's#%s#%s#g;' "$SOURCE_URL" "$BUILD_URL"; }
# The admin page of the vote (music-admin.html) gets the same project.
for page in music music-admin; do
  sed "$(meta flaky-supabase-url "${SUPABASE_URL:-}")$(meta flaky-supabase-key "${SUPABASE_ANON_KEY:-}")$(meta flaky-captcha-sitekey "${TURNSTILE_SITE_KEY:-}")$(site)" \
    "public/$page.html" \
    | npx --yes "$HTML_MINIFIER" --collapse-whitespace --conservative-collapse --remove-comments \
      --minify-css true > "_site/$page.html"
done
# The music page is also the start page.
cp _site/music.html _site/index.html
# The other pages get the project too, but only to count QR code scans (qr-track.js).
supabase() { printf '%s' "$(meta flaky-supabase-url "${SUPABASE_URL:-}")$(meta flaky-supabase-key "${SUPABASE_ANON_KEY:-}")"; }
sed "s#<html lang=\"en\">#<html lang=\"en\" data-backend=\"none\">#;$(supabase)" public/flakifier.html \
  | npx --yes "$HTML_MINIFIER" --collapse-whitespace --conservative-collapse --remove-comments \
    --minify-css true > _site/flakifier.html
grep -q 'data-backend="none"' _site/flakifier.html
# The about page needs no backend either.
sed "$(supabase)" public/about.html \
  | npx --yes "$HTML_MINIFIER" --collapse-whitespace --conservative-collapse --remove-comments \
    --minify-css true > _site/about.html
# So does the spooky story; its link preview points at this build, like the music page's.
sed "$(supabase)$(site)" public/spooky.html \
  | npx --yes "$HTML_MINIFIER" --collapse-whitespace --conservative-collapse --remove-comments \
    --minify-css true > _site/spooky.html
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
grep -q "app.js?v=$VERSION" _site/flakifier.html
grep -q "music-vote.js?v=$VERSION" _site/index.html
grep -q "spooky.css?v=$VERSION" _site/spooky.html
grep -q "qr-track.js?v=$VERSION" _site/about.html
grep -q "qr.js?v=$VERSION" _site/public/js/music-admin-qr.js
touch _site/.nojekyll
