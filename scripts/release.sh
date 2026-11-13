#!/bin/sh
# Builds an offline release tarball: image archives + compose file + docs.
# Run on a machine with internet access, then copy release/lorebook-<version>.tar.gz to the VM.
set -eu
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
OUT=release/lorebook-$VERSION
rm -rf "$OUT" && mkdir -p "$OUT/deploy/nginx" "$OUT/images"

[ "${SKIP_BUILD:-}" = 1 ] || docker build -t "lorebook-app:$VERSION" .
for img in postgres:16.16-bookworm nginx:1.30.6-alpine; do docker pull "$img"; done

docker save "lorebook-app:$VERSION" | gzip > "$OUT/images/lorebook-app.tar.gz"
docker save postgres:16.16-bookworm nginx:1.30.6-alpine | gzip > "$OUT/images/base.tar.gz"

cp docker-compose.yml "$OUT/"
sed "s/^LOREBOOK_VERSION=.*/LOREBOOK_VERSION=$VERSION/" .env.example > "$OUT/.env.example"
cp deploy/nginx/lorebook.conf "$OUT/deploy/nginx/"
cp INSTALL.md UPGRADE.md "$OUT/"
# The VM never builds, so drop the build: line from the shipped compose file.
sed -i '/^    build: \.$/d' "$OUT/docker-compose.yml"

tar -C release -czf "release/lorebook-$VERSION.tar.gz" "lorebook-$VERSION"
echo "Built release/lorebook-$VERSION.tar.gz"
