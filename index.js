#!/usr/bin/env node
/**
 * http-response-cache — Record and replay HTTP responses locally
 * Zero external dependencies. Pure Node.js ES modules.
 */

import http from 'http'
import https from 'https'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { URL } from 'url'

// ─── ANSI Colors ──────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
}

function colorize(color, text) {
  return `${color}${text}${C.reset}`
}

// ─── Logging ──────────────────────────────────────────────────────────────────
function log(mode, method, urlPath, status, extra = '') {
  const modeColor = {
    RECORD: C.magenta,
    REPLAY: C.cyan,
    PROXY: C.blue,
    HIT: C.green,
    MISS: C.yellow,
    ERROR: C.red,
  }
  const statusColor = status >= 500 ? C.red : status >= 400 ? C.yellow : C.green
  const ts = new Date().toISOString().substring(11, 19)
  console.log(
    `${C.dim}${ts}${C.reset} ${colorize(modeColor[mode] || C.white, mode.padEnd(6))} ` +
    `${C.bold}${method.padEnd(7)}${C.reset} ${urlPath.substring(0, 60).padEnd(60)} ` +
    `${colorize(statusColor, String(status))} ${C.dim}${extra}${C.reset}`
  )
}

function redactAuthHeader(value) {
  if (!value) return value
  return value.substring(0, 8) + '...[REDACTED]'
}

function safeHeaders(headers) {
  const safe = { ...headers }
  if (safe.authorization) safe.authorization = redactAuthHeader(safe.authorization)
  if (safe.Authorization) safe.Authorization = redactAuthHeader(safe.Authorization)
  return safe
}

// ─── Cache Key ────────────────────────────────────────────────────────────────
function buildCacheKey(method, urlPath, query, body, ignoreHeaders) {
  const sortedQuery = Object.entries(query)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  const bodyHash = crypto.createHash('md5').update(body || '').digest('hex')
  const raw = `${method}:${urlPath}:${sortedQuery}:${bodyHash}`
  return crypto.createHash('md5').update(raw).digest('hex')
}

// ─── Cache Dir ────────────────────────────────────────────────────────────────
function getCacheDir(opts) {
  const dir = path.resolve(opts.cacheDir || '.cache')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function cachePath(cacheDir, key, method) {
  return path.join(cacheDir, `${method.toLowerCase()}-${key}.json`)
}

function readCache(filePath) {
  if (!fs.existsSync(filePath)) return null
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (data.ttl && data.cachedAt) {
      const age = (Date.now() - new Date(data.cachedAt).getTime()) / 1000
      if (age > data.ttl) {
        fs.unlinkSync(filePath)
        return null
      }
    }
    return data
  } catch {
    return null
  }
}

function writeCache(filePath, entry) {
  fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf8')
}

// ─── HTTP Forward ─────────────────────────────────────────────────────────────
function forwardRequest(targetUrl, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl)
    const isHttps = target.protocol === 'https:'
    const lib = isHttps ? https : http
    const options = {
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: path,
      method: method,
      headers: {
        ...headers,
        host: target.hostname,
      },
    }
    const req = lib.request(options, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks)
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: rawBody.toString('base64'),
          bodyEncoding: 'base64',
        })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

// ─── Parse Request Body ───────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

// ─── Parse Query Params ───────────────────────────────────────────────────────
function parseQuery(urlPath) {
  const idx = urlPath.indexOf('?')
  if (idx === -1) return { path: urlPath, query: {} }
  const qstr = urlPath.substring(idx + 1)
  const query = {}
  for (const part of qstr.split('&')) {
    const [k, v] = part.split('=')
    if (k) query[decodeURIComponent(k)] = decodeURIComponent(v || '')
  }
  return { path: urlPath.substring(0, idx), query }
}

// ─── Send Response ────────────────────────────────────────────────────────────
function sendResponse(res, cached) {
  const r = cached.response
  const safeResHeaders = { ...r.headers }
  delete safeResHeaders['transfer-encoding']
  delete safeResHeaders['content-encoding']
  res.writeHead(r.status, safeResHeaders)
  const body = r.bodyEncoding === 'base64'
    ? Buffer.from(r.body, 'base64')
    : Buffer.from(r.body || '')
  res.end(body)
}

// ─── RECORD MODE ─────────────────────────────────────────────────────────────
async function startRecord(opts) {
  const cacheDir = getCacheDir(opts)
  const server = http.createServer(async (req, res) => {
    const rawBody = await readBody(req)
    const { path: urlPath, query } = parseQuery(req.url)
    const key = buildCacheKey(req.method, urlPath, query, rawBody.toString(), opts.ignoreHeaders)
    const file = cachePath(cacheDir, key, req.method)
    try {
      const forward = await forwardRequest(opts.target, req.method, req.url, safeHeaders(req.headers), rawBody)
      const entry = {
        key,
        request: {
          method: req.method,
          path: urlPath,
          query,
          headers: safeHeaders(req.headers),
        },
        response: forward,
        cachedAt: new Date().toISOString(),
        ttl: opts.ttl || null,
      }
      writeCache(file, entry)
      log('RECORD', req.method, urlPath, forward.status, `saved → ${path.basename(file)}`)
      sendResponse(res, entry)
    } catch (err) {
      log('ERROR', req.method, urlPath, 502, err.message)
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Upstream error', message: err.message }))
    }
  })
  server.listen(opts.port, () => {
    console.log(`\n${colorize(C.magenta + C.bold, '● RECORD')} mode — port ${opts.port} → ${opts.target}`)
    console.log(`${C.dim}Cache dir: ${cacheDir}${C.reset}\n`)
  })
}

// ─── REPLAY MODE ─────────────────────────────────────────────────────────────
async function startReplay(opts) {
  const cacheDir = getCacheDir(opts)
  const server = http.createServer(async (req, res) => {
    const rawBody = await readBody(req)
    const { path: urlPath, query } = parseQuery(req.url)
    const key = buildCacheKey(req.method, urlPath, query, rawBody.toString(), opts.ignoreHeaders)
    const file = cachePath(cacheDir, key, req.method)
    const cached = readCache(file)
    if (cached) {
      log('REPLAY', req.method, urlPath, cached.response.status, `← ${path.basename(file)}`)
      sendResponse(res, cached)
    } else {
      log('MISS', req.method, urlPath, 404, 'cache miss')
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        error: 'Cache miss',
        message: `No cached response for ${req.method} ${urlPath}`,
        hint: 'Run in record or proxy mode first to populate the cache.',
        key,
      }))
    }
  })
  server.listen(opts.port, () => {
    console.log(`\n${colorize(C.cyan + C.bold, '● REPLAY')} mode — port ${opts.port}`)
    console.log(`${C.dim}Cache dir: ${cacheDir}${C.reset}\n`)
  })
}

// ─── PROXY MODE ──────────────────────────────────────────────────────────────
async function startProxy(opts) {
  const cacheDir = getCacheDir(opts)
  const server = http.createServer(async (req, res) => {
    const rawBody = await readBody(req)
    const { path: urlPath, query } = parseQuery(req.url)
    const key = buildCacheKey(req.method, urlPath, query, rawBody.toString(), opts.ignoreHeaders)
    const file = cachePath(cacheDir, key, req.method)
    const cached = readCache(file)
    if (cached) {
      log('HIT', req.method, urlPath, cached.response.status, `← ${path.basename(file)}`)
      sendResponse(res, cached)
    } else {
      try {
        const forward = await forwardRequest(opts.target, req.method, req.url, safeHeaders(req.headers), rawBody)
        const entry = {
          key,
          request: {
            method: req.method,
            path: urlPath,
            query,
            headers: safeHeaders(req.headers),
          },
          response: forward,
          cachedAt: new Date().toISOString(),
          ttl: opts.ttl || null,
        }
        writeCache(file, entry)
        log('PROXY', req.method, urlPath, forward.status, `saved → ${path.basename(file)}`)
        sendResponse(res, entry)
      } catch (err) {
        log('ERROR', req.method, urlPath, 502, err.message)
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'Upstream error', message: err.message }))
      }
    }
  })
  server.listen(opts.port, () => {
    console.log(`\n${colorize(C.blue + C.bold, '● PROXY')} mode — port ${opts.port} → ${opts.target}`)
    console.log(`${C.dim}Cache dir: ${cacheDir} (cache-first, fallback to upstream)${C.reset}\n`)
  })
}

// ─── LIST ─────────────────────────────────────────────────────────────────────
function listCache(opts) {
  const cacheDir = getCacheDir(opts)
  const files = fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'))
  if (files.length === 0) {
    console.log(`${C.dim}No cached responses in ${cacheDir}${C.reset}`)
    return
  }
  console.log(`\n${C.bold}Cached responses in ${cacheDir}${C.reset}\n`)
  console.log(
    `${'Method'.padEnd(8)} ${'Path'.padEnd(50)} ${'Status'.padEnd(8)} ${'Size'.padEnd(10)} ${'Cached At'.padEnd(25)} TTL`
  )
  console.log('─'.repeat(120))
  let total = 0
  for (const file of files.sort()) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(cacheDir, file), 'utf8'))
      const req = entry.request
      const res = entry.response
      const size = Buffer.byteLength(JSON.stringify(entry))
      total += size
      const isExpired = entry.ttl && entry.cachedAt
        ? (Date.now() - new Date(entry.cachedAt).getTime()) / 1000 > entry.ttl
        : false
      const ttlStr = entry.ttl ? `${entry.ttl}s${isExpired ? colorize(C.red, ' EXPIRED') : ''}` : '-'
      const statusColor = res.status >= 500 ? C.red : res.status >= 400 ? C.yellow : C.green
      console.log(
        `${C.bold}${req.method.padEnd(8)}${C.reset} ` +
        `${req.path.substring(0, 50).padEnd(50)} ` +
        `${colorize(statusColor, String(res.status).padEnd(8))} ` +
        `${(size + 'B').padEnd(10)} ` +
        `${C.dim}${entry.cachedAt.padEnd(25)}${C.reset} ` +
        `${ttlStr}`
      )
    } catch {
      console.log(`${C.dim}  ${file} (unreadable)${C.reset}`)
    }
  }
  console.log('─'.repeat(120))
  console.log(`${C.dim}${files.length} entries, ${(total / 1024).toFixed(1)} KB total${C.reset}\n`)
}

// ─── CLEAR ────────────────────────────────────────────────────────────────────
function clearCache(opts) {
  const cacheDir = getCacheDir(opts)
  const files = fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'))
  let removed = 0
  for (const file of files) {
    if (opts.filterPath) {
      const entry = JSON.parse(fs.readFileSync(path.join(cacheDir, file), 'utf8'))
      if (!entry.request.path.startsWith(opts.filterPath)) continue
    }
    fs.unlinkSync(path.join(cacheDir, file))
    removed++
  }
  console.log(`${colorize(C.green, '✓')} Removed ${removed} cache ${removed === 1 ? 'entry' : 'entries'}`)
}

// ─── EXPORT ───────────────────────────────────────────────────────────────────
function exportCache(outputFile, opts) {
  const cacheDir = getCacheDir(opts)
  const files = fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'))
  const entries = []
  for (const file of files) {
    try {
      entries.push(JSON.parse(fs.readFileSync(path.join(cacheDir, file), 'utf8')))
    } catch { /* skip unreadable */ }
  }
  const out = path.resolve(outputFile)
  fs.writeFileSync(out, JSON.stringify({ version: '1.0', exportedAt: new Date().toISOString(), entries }, null, 2))
  console.log(`${colorize(C.green, '✓')} Exported ${entries.length} entries to ${out}`)
}

// ─── IMPORT ───────────────────────────────────────────────────────────────────
function importCache(inputFile, opts) {
  const cacheDir = getCacheDir(opts)
  const inPath = path.resolve(inputFile)
  if (!fs.existsSync(inPath)) {
    console.error(`${colorize(C.red, 'Error:')} File not found: ${inPath}`)
    process.exit(1)
  }
  const data = JSON.parse(fs.readFileSync(inPath, 'utf8'))
  const entries = data.entries || (Array.isArray(data) ? data : [])
  let imported = 0
  for (const entry of entries) {
    if (!entry.key || !entry.request || !entry.response) continue
    const file = cachePath(cacheDir, entry.key, entry.request.method)
    writeCache(file, entry)
    imported++
  }
  console.log(`${colorize(C.green, '✓')} Imported ${imported} entries to ${cacheDir}`)
}

// ─── CLI Parser ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = argv.slice(2)
  const cmd = args[0]
  const opts = {
    port: 3001,
    target: null,
    cacheDir: '.cache',
    ttl: null,
    ignoreHeaders: false,
    filterPath: null,
  }
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--port' || arg === '-p') opts.port = parseInt(args[++i], 10)
    else if (arg === '--target' || arg === '-t') opts.target = args[++i]
    else if (arg === '--cache-dir' || arg === '-d') opts.cacheDir = args[++i]
    else if (arg === '--ttl') opts.ttl = parseInt(args[++i], 10)
    else if (arg === '--ignore-headers') opts.ignoreHeaders = true
    else if (arg === '--path') opts.filterPath = args[++i]
    else if (!arg.startsWith('--') && !opts._positional) opts._positional = arg
  }
  return { cmd, opts }
}

// ─── Help ─────────────────────────────────────────────────────────────────────
function printHelp() {
  console.log(`
${C.bold}http-response-cache${C.reset} ${C.dim}v1.0.0${C.reset}
Record and replay HTTP responses locally.

${C.bold}USAGE${C.reset}
  http-response-cache <command> [options]
  hcache <command> [options]

${C.bold}COMMANDS${C.reset}
  ${colorize(C.magenta, 'record')}   Forward requests to target and save responses to cache
  ${colorize(C.cyan, 'replay')}   Serve responses from cache only (no upstream requests)
  ${colorize(C.blue, 'proxy')}    Cache-first: replay if cached, forward and cache if not
  ${colorize(C.green, 'list')}     List all cached responses with metadata
  ${colorize(C.yellow, 'clear')}    Delete all or specific cached responses
  ${colorize(C.white, 'export')}   Export all cache entries to a single JSON file
  ${colorize(C.white, 'import')}   Import cache entries from a JSON file

${C.bold}OPTIONS${C.reset}
  --port, -p <n>       Port to listen on (default: 3001)
  --target, -t <url>   Upstream API base URL (required for record/proxy)
  --cache-dir, -d <p>  Cache directory (default: .cache)
  --ttl <seconds>      Cache entry TTL in seconds
  --ignore-headers     Exclude request headers from cache key
  --path <prefix>      Filter by URL path prefix (clear command only)

${C.bold}EXAMPLES${C.reset}
  ${C.dim}# Record all responses from an API${C.reset}
  hcache record --port 3001 --target https://api.example.com

  ${C.dim}# Replay cached responses offline${C.reset}
  hcache replay --port 3001

  ${C.dim}# Smart proxy: cache-first, fallback to upstream${C.reset}
  hcache proxy --port 3001 --target https://api.example.com --ttl 3600

  ${C.dim}# List what's cached${C.reset}
  hcache list

  ${C.dim}# Clear cache entries for a specific path${C.reset}
  hcache clear --path /users

  ${C.dim}# Export for sharing or CI${C.reset}
  hcache export fixtures.json

  ${C.dim}# Import in CI environment${C.reset}
  hcache import fixtures.json
`)
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const { cmd, opts } = parseArgs(process.argv)

switch (cmd) {
  case 'record':
    if (!opts.target) {
      console.error(`${colorize(C.red, 'Error:')} --target <url> is required for record mode`)
      process.exit(1)
    }
    startRecord(opts)
    break
  case 'replay':
    startReplay(opts)
    break
  case 'proxy':
    if (!opts.target) {
      console.error(`${colorize(C.red, 'Error:')} --target <url> is required for proxy mode`)
      process.exit(1)
    }
    startProxy(opts)
    break
  case 'list':
    listCache(opts)
    break
  case 'clear':
    clearCache(opts)
    break
  case 'export': {
    const outFile = opts._positional || process.argv[3]
    if (!outFile) {
      console.error(`${colorize(C.red, 'Error:')} Specify output file: hcache export <output.json>`)
      process.exit(1)
    }
    exportCache(outFile, opts)
    break
  }
  case 'import': {
    const inFile = opts._positional || process.argv[3]
    if (!inFile) {
      console.error(`${colorize(C.red, 'Error:')} Specify input file: hcache import <input.json>`)
      process.exit(1)
    }
    importCache(inFile, opts)
    break
  }
  case '--help':
  case '-h':
  case 'help':
  case undefined:
    printHelp()
    break
  default:
    console.error(`${colorize(C.red, 'Error:')} Unknown command: ${cmd}`)
    printHelp()
    process.exit(1)
}
