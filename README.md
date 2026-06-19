<div align="center">

# http-response-cache

**Record real HTTP responses locally — replay them offline to cut API costs and unblock CI**

[![License: MIT](https://img.shields.io/badge/License-MIT-brightgreen?labelColor=0B0A09)](LICENSE)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?labelColor=0B0A09)](package.json)
[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen?labelColor=0B0A09)](package.json)

</div>

## Install

```bash
npx github:NickCirv/http-response-cache --help
```

Or run any command directly:

```bash
npx github:NickCirv/http-response-cache <command> [options]
```

The short alias `hcache` is available when installed globally:

```bash
npm install -g github:NickCirv/http-response-cache
hcache --help
```

## Usage

```bash
# Record: forward requests to a real API and save responses to .cache/
hcache record --port 3001 --target https://api.example.com

# Replay: serve cached responses only — no network calls
hcache replay --port 3001

# Proxy: cache-first; falls back to upstream and saves on miss
hcache proxy --port 3001 --target https://api.example.com --ttl 3600
```

| Flag | Default | Description |
|------|---------|-------------|
| `--port`, `-p` | `3001` | Port to listen on |
| `--target`, `-t` | — | Upstream API base URL (required for `record`/`proxy`) |
| `--cache-dir`, `-d` | `.cache` | Directory to store cache files |
| `--ttl <seconds>` | — | Expire entries after N seconds |
| `--ignore-headers` | `false` | Exclude request headers from cache key |
| `--path <prefix>` | — | Filter by URL path prefix (`clear` only) |

Additional commands: `list` · `clear` · `export <file>` · `import <file>`

## What it does

`http-response-cache` runs a local proxy server in one of three modes: **record** (forward + save), **replay** (serve from disk only), or **proxy** (cache-first with upstream fallback). Cache entries are deterministic JSON files keyed by `MD5(method + path + sorted-query + body-hash)`, so the same request always maps to the same file. Use `export`/`import` to bundle a fixture set for CI or share it with teammates.

## CI Example

```yaml
- name: Import API fixtures
  run: npx github:NickCirv/http-response-cache import fixtures.json

- name: Start replay server
  run: npx github:NickCirv/http-response-cache replay --port 3001 &

- name: Run tests
  run: npm test
  env:
    API_BASE_URL: http://localhost:3001
```

---
<sub>Zero dependencies · Node >=18 · MIT · by <a href="https://github.com/NickCirv">NickCirv</a></sub>
