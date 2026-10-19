# interact-nginx

A local web UI for the nginx on your machine. Map `https://app.yourcompany.dev` to `http://localhost:3000` with a trusted certificate and a hosts entry in one click.

```
npx interact-nginx
```

That starts a small server on `127.0.0.1:7878` and opens the UI in your browser.

## What it does

- **Proxies.** Add, edit, enable/disable and delete `https://domain → http://localhost:port` mappings. Each one gets:
  - an nginx `server` block (TLS 1.2/1.3, WebSocket/HMR upgrade, `X-Forwarded-*`, no buffering for dev servers),
  - an optional `http → https` redirect,
  - a certificate from [mkcert](https://github.com/FiloSottile/mkcert), trusted by your browsers,
  - a `127.0.0.1 domain` line in your hosts file.
- **Safe apply.** Changes are written, checked with `nginx -t`, and rolled back automatically if the check fails. nginx is reloaded only after a passing check.
- **nginx lifecycle.** Status, start, stop, reload and config test.
- **Live logs.** Tail nginx's error/access logs and a separate access/error log per proxy.
- **Import.** Finds HTTPS reverse-proxy `server` blocks you already wrote in `nginx.conf` and moves them under management. It shows exactly which blocks it will remove and saves a backup first.
- **Doctor.** Checks the nginx binary, config, mkcert, CA trust, ports 80/443 and whether each upstream is listening.

## Requirements

- Node.js 20+
- nginx (`brew install nginx`, `sudo apt install nginx`, or the nginx.org zip on Windows)
- mkcert. If it isn't installed, the Doctor tab can download the official binary for you.

## CLI

```
interact-nginx                 # start the UI (default port 7878, --port to change, --no-open)
interact-nginx ls              # list proxies
interact-nginx add app.local.test 3000 --alias api.local.test --apply
interact-nginx rm app.local.test --apply
interact-nginx apply           # write config, certs and hosts entries, then reload nginx
interact-nginx doctor
```

`inx` is a short alias for `interact-nginx`. The upstream can be a port (`3000`), `host:port` or a full `http(s)://host:port`.

## How it works

| What | Where |
| --- | --- |
| Source of truth | `~/.interact-nginx/state.json` |
| Certificates | `~/.interact-nginx/certs/` (or the paths of imported certs) |
| Per-proxy logs | `~/.interact-nginx/logs/` |
| nginx config | `inx-*.conf` files in the directory your `nginx.conf` already includes (e.g. Homebrew's `servers/*`, Debian's `conf.d/*.conf`) |
| Hosts entries | a marked block in `/etc/hosts` (or `C:\Windows\System32\drivers\etc\hosts`). Lines outside the block are never touched. |

If `nginx.conf` doesn't include any directory, the first apply asks before adding `include interact-nginx/*.conf;` to the `http` block, and keeps a backup.

**Admin rights.** Editing the hosts file, trusting the CA, writing root-owned nginx config and signalling a root nginx all need admin rights. interact-nginx batches those steps into a single script per apply, so you get one OS password prompt (macOS dialog, Windows UAC, or polkit on Linux). On macOS nginx can bind ports 80/443 without root, so most applies only prompt when the hosts file changes.

## Security

The UI can make root-level changes, so the server:

- listens on `127.0.0.1` only,
- requires a random token (stored in `~/.interact-nginx/token`, mode 600) that's passed in the URL it opens,
- rejects requests whose `Host` or `Origin` isn't the local UI, which blocks DNS rebinding and other sites calling it,
- validates every domain, upstream and path before it reaches nginx config, the hosts file or a shell.

## Platform support

macOS (Homebrew nginx) is tested. Linux and Windows code paths exist (hosts path, polkit/UAC prompts, `conf.d` includes, `nginx.exe` handling) but haven't been verified yet. Issues and PRs are welcome.

## Development

```
npm install
npm run dev:server   # API on :7878 (restarts on change)
npm run dev:ui       # Vite on :5173, proxies /api to :7878; open http://localhost:5173/?t=$(cat ~/.interact-nginx/token)
npm test             # unit tests + a sandboxed apply test against real nginx -t and mkcert
npm run build
```

Environment overrides: `INX_HOME`, `INX_NGINX_BIN`, `INX_NGINX_CONF`, `INX_NGINX_PID`, `INX_HOSTS`, `INX_MKCERT_BIN`.

## License

MIT
