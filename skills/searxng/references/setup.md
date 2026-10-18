# Local instance setup and repair

Use this reference when the existing loopback instance is unavailable or lacks JSON output.
Installation, image pulls, container lifecycle changes, and settings edits require authorization
unless already authorized in the conversation. Read-only inspection can proceed.

## Inspect first

```bash
curl -sS --max-time 5 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8888/healthz
docker ps -a --filter name=searxng
docker port searxng
docker inspect searxng --format '{{json .Mounts}}'
```

HTTP 200 from `/healthz` confirms the service responds; it does not test JSON search or upstream
engine health. Use the mapped port with `SEARXNG_URL` or `--url`. Keep the host binding on loopback.

## Create an instance when authorized

Use an absolute host configuration directory; suggest `~/.config/searxng` if none was specified.
First check whether the directory/container exists so existing settings are preserved.
Replace `<absolute-config-dir>` before running:

```bash
mkdir -p <absolute-config-dir>
docker run -d --name searxng -p 127.0.0.1:8888:8080 \
  -v <absolute-config-dir>:/etc/searxng \
  docker.io/searxng/searxng:latest
```

The first start writes `settings.yml` with a random secret key. Preserve that key.
If a different host port is needed, change only the host side of the mapping.

## Enable JSON when authorized

In the mounted `settings.yml`, add `json` to the existing `search.formats` list, preserving all
other settings and formats. If no `search` block exists, add one. Avoid duplicate YAML keys.

```yaml
search:
  formats:
    - html
    - json
```

Apply with `docker restart searxng`, then verify from this skill's directory:

```bash
python3 scripts/searxng.py search 'random uuid'
```

This answerer query checks JSON without needing upstream web results. For engine coverage, use one
relevant search and inspect `unresponsive_engines`. A 403 can also come from access controls;
inspect its saved response before assuming a format problem.

For an existing stopped container, use `docker start searxng` when authorized.
`docker stop searxng` stops it. Do not recreate an instance just to change a search filter.
