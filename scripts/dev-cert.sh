#!/bin/sh
# Creates a self-signed certificate for trying Lorebook out. Production uses a certificate from
# the internal CA instead. Usage: scripts/dev-cert.sh [dir] [hostname]
set -eu
DIR=${1:-deploy/tls}
HOST=${2:-localhost}
mkdir -p "$DIR"
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout "$DIR/lorebook.key" -out "$DIR/lorebook.crt" \
  -subj "/CN=$HOST" -addext "subjectAltName=DNS:$HOST,DNS:localhost,IP:127.0.0.1"
chmod 644 "$DIR/lorebook.crt" "$DIR/lorebook.key"
echo "Wrote $DIR/lorebook.crt and $DIR/lorebook.key"
