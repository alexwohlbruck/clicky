# Vega deployment

Clicky runs at `https://clicky.wohlbruck.dev` as the `clicky` Compose service in `/opt/clicky` on Vega, next to Jukebox. Like Jukebox it joins only the external `opt_caddy` network, and Caddy is the public entry point. It streams music from Jukebox over that network (`http://jukebox:8080`), so Jukebox's `ALLOWED_ORIGINS` doesn't need to change.

## Automatic updates

Pushing to `main` runs [the publish workflow](../.github/workflows/publish-image.yml): tests, then `ghcr.io/alexwohlbruck/clicky-2:latest`. Watchtower recreates the labeled container when that tag changes.

The package is private by default when first published. Either make it public under the repository's Packages settings, or log Vega's Docker into GHCR, so `docker compose pull` can fetch it.

## Initial deploy

```sh
sudo mkdir -p /opt/clicky && sudo chown "$USER" /opt/clicky
cd /opt/clicky
curl -fsSLO https://raw.githubusercontent.com/alexwohlbruck/clicky-2/main/deploy/compose.yml
docker compose pull
docker compose up -d
docker compose ps
```

The leaderboard lives in `/opt/clicky/data/leaderboard.json`, which the restic backups can include.

## DNS and Caddy

Add a CNAME for `clicky.wohlbruck.dev` pointing to `wohlbruck.duckdns.org` (Namecheap, like `jukebox`). Then add [Caddyfile.snippet](Caddyfile.snippet) to `/opt/caddy/Caddyfile`, validate, and reload:

```sh
docker exec caddy caddy validate --config /etc/caddy/Caddyfile
docker exec caddy caddy reload --config /etc/caddy/Caddyfile
```

Caddy proxies WebSockets without extra configuration.

## Verify

```sh
curl -fsS https://clicky.wohlbruck.dev/health
curl -fsS https://clicky.wohlbruck.dev/api/rooms
docker compose logs --tail=100 clicky
```
