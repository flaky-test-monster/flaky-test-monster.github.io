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
# The music page needs no backend. Its online vote does need a Supabase project: the workflows
# pass the repository variables SUPABASE_URL, SUPABASE_ANON_KEY and, optionally,
# TURNSTILE_SITE_KEY, which go into the page's meta tags. All three are public by design.
# Without them the votes go by email.
for name in SUPABASE_URL SUPABASE_ANON_KEY TURNSTILE_SITE_KEY; do
  if [[ ! ${!name:-} =~ ^[A-Za-z0-9._:/-]*$ ]]; then
    echo "build-pages.sh: unexpected characters in $name" >&2
    exit 1
  fi
done
meta() { printf 's#<meta name="%s" content="">#<meta name="%s" content="%s">#;' "$1" "$1" "$2"; }
sed "$(meta flaky-supabase-url "${SUPABASE_URL:-}")$(meta flaky-supabase-key "${SUPABASE_ANON_KEY:-}")$(meta flaky-captcha-sitekey "${TURNSTILE_SITE_KEY:-}")" \
  public/music.html \
  | npx --yes "$HTML_MINIFIER" --collapse-whitespace --conservative-collapse --remove-comments \
    --minify-css true > _site/music.html
touch _site/.nojekyll
