# Upgrading Lorebook (offline)

1. On a connected machine, get the new `lorebook-<version>.tar.gz` and copy it to the VM.
2. Take a database dump first (automatic pre-upgrade dumps arrive in a later milestone):

   ```sh
   cd /opt/lorebook
   docker compose exec -T postgres pg_dump -U lorebook -Fc lorebook > pre-upgrade-$(date +%Y%m%d%H%M).dump
   ```

3. Unpack the new release over the old one (your `.env` is not overwritten, because the tarball
   only contains `.env.example`), and load the images:

   ```sh
   tar -xzf lorebook-<version>.tar.gz -C /opt/lorebook --strip-components=1
   docker load -i images/base.tar.gz
   docker load -i images/lorebook-app.tar.gz
   ```

4. Set `LOREBOOK_VERSION` in `.env` to the new version, then restart:

   ```sh
   docker compose up -d
   docker compose logs -f app
   ```

   Migrations run automatically on start.

## Notes for specific versions

- **Milestone 3 (search):** the migration enables the `pg_trgm` and `unaccent` extensions. Both ship
  inside the postgres image, so nothing is downloaded. After the upgrade, existing pages and text
  attachments are indexed in the background (a few minutes for thousands of pages); search results
  fill in as that runs. Existing pages get a review date from their template's interval, counted from
  their last update, so some older runbooks may show up as needing review straight away. To re-check
  old content for secrets, run `docker compose exec app lorebook rescan-secrets` or use **Rescan
  everything** under Admin.

## Rolling back

If the new version fails to start, set `LOREBOOK_VERSION` back to the previous version. If its
migrations already ran, restore the pre-upgrade dump before starting the old version:

```sh
docker compose stop app
docker compose exec -T postgres pg_restore -U lorebook -d lorebook --clean --if-exists < pre-upgrade-<timestamp>.dump
docker compose up -d
```
