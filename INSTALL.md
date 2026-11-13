# Installing Lorebook (offline)

Lorebook ships as a release tarball that contains everything needed; the VM never needs internet.

## Requirements

- Linux VM with Docker Engine and the Docker Compose plugin
- A TLS certificate and key for the Lorebook hostname, issued by the internal CA
- Disk space for the database, attachments and backups

## 1. Copy and unpack the release

On a connected machine, build or download `lorebook-<version>.tar.gz` (built with
`scripts/release.sh`), copy it to the VM, then:

```sh
sudo mkdir -p /opt/lorebook && sudo tar -xzf lorebook-<version>.tar.gz -C /opt/lorebook --strip-components=1
cd /opt/lorebook
docker load -i images/base.tar.gz
docker load -i images/lorebook-app.tar.gz
```

## 2. Certificates

Put the certificate (server certificate followed by any intermediates) and its key in
`/etc/lorebook/tls/`:

```
/etc/lorebook/tls/lorebook.crt
/etc/lorebook/tls/lorebook.key
```

To replace them later, overwrite the files and run `docker compose exec nginx nginx -s reload`.

## 3. Configure

```sh
cp .env.example .env
```

Edit `.env`: set `BASE_URL` to the URL people will use, and set `POSTGRES_PASSWORD` to a long
random value (`openssl rand -base64 32`). Keep `.env` readable only by administrators.

## 4. Start

```sh
docker compose up -d
docker compose ps          # all three services should be up; app becomes "healthy"
```

The app applies database migrations on start. If a migration fails, it refuses to start and
logs why (`docker compose logs app`).

## 5. Create the first admin

```sh
docker compose exec app lorebook create-admin
```

Sign in at `BASE_URL`, open **Admin**, create Spaces and add user accounts. Keep at least one
local admin account even after LDAP arrives, so you can sign in when the domain controllers are
unreachable.

## Health checks

- `GET /healthz`: the app process is up
- `GET /readyz`: database reachable, `/data` writable, and free space above `MIN_FREE_DISK_MB`

Logs are JSON on stdout: `docker compose logs -f app`.

## Backups (until milestone 5 adds nightly dumps)

Back up the database with:

```sh
docker compose exec -T postgres pg_dump -U lorebook -Fc lorebook > lorebook-$(date +%Y%m%d).dump
```
