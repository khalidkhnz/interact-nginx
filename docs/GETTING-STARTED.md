# Getting started with interact-nginx

interact-nginx gives you a browser UI for the nginx on your own machine. Its main job is turning a local dev server into a real HTTPS domain:

```
http://localhost:3000   →   https://app.local.test
```

It writes the nginx config, issues a trusted certificate, adds the hosts entry and reloads nginx, so you don't have to edit any of those by hand.

---

## 1. Prerequisites

| | macOS | Linux (Debian/Ubuntu) | Windows |
| --- | --- | --- | --- |
| Node.js 20+ | `brew install node` | [nodejs.org](https://nodejs.org) or `nvm` | [nodejs.org](https://nodejs.org) |
| nginx | `brew install nginx` | `sudo apt install nginx` | zip from [nginx.org](https://nginx.org/en/download.html), unzip to `C:\nginx` |
| mkcert | `brew install mkcert` | `sudo apt install mkcert` | `choco install mkcert` |

mkcert is optional up front. If it's missing, the **Doctor** tab has an "Install mkcert" button that downloads the official binary.

Check you're ready:

```bash
node -v      # v20 or newer
nginx -v
```

## 2. Install

**From npm** (once it's published):

```bash
npx interact-nginx          # run without installing
# or
npm install -g interact-nginx
```

**From source** (works today):

```bash
git clone https://github.com/khalidkhnz/interact-nginx.git
cd interact-nginx
npm install
npm run build
npm link                    # puts `interact-nginx` and `inx` on your PATH
```

To update a source install, run `git pull && npm install && npm run build`. The link picks up the new build automatically.

## 3. Start the UI

```bash
interact-nginx
```

The terminal prints a URL like `http://127.0.0.1:7878/?t=…` and opens it in your browser. The `?t=` part is your access token, so use that link the first time. After that, the same browser remembers the token.

Options:

```bash
interact-nginx --port 9000      # different UI port
interact-nginx --no-open        # don't open the browser
```

Stopping the UI with Ctrl+C doesn't stop nginx. Your proxies keep working.

## 4. Add your first proxy

1. Start your app as usual, e.g. `npm run dev` on port 3000.
2. In the UI, under **Proxies**, fill in:
   - **Domain:** `app.local.test`
   - **Upstream:** `3000` (or `http://localhost:3000`)
   - **Extra names** (optional): other domains served by the same app
3. Click **Save & apply**.
4. Approve the OS password prompt. It appears because the hosts file is owned by the system.
5. If nginx isn't running yet, click **Start** in the header.
6. Open `https://app.local.test`. You should get a green padlock.

The toggle on each proxy turns it on or off. Click **Apply changes** in the banner afterwards for the change to take effect.

> **Tip:** pick a domain you control, or one ending in `.test`, which is reserved and never resolves on the public internet. If you use a real company domain (e.g. `localhost.mycompany.com` so cookies work), it only resolves to your machine on **your** computer.

## 5. Already have proxies in nginx.conf? Import them

Open the **Import** tab. interact-nginx scans `nginx.conf` for HTTPS `server` blocks that use `proxy_pass` and lists them.

- Expand **"Blocks that will be removed from nginx.conf"** to see exactly what will be cut.
- Click **Import & edit nginx.conf**. A backup is saved next to the file first (`nginx.conf.inx-<timestamp>.bak`).
- Your existing certificate files are reused.

If you skip this step and add the same domain in the UI, the old block in `nginx.conf` wins and the UI warns you about the duplicate.

## 6. Other tabs

- **Logs:** live tail of nginx's `error.log` and `access.log`, plus a separate access/error log for every proxy. It has filter, pause and clear controls.
- **Doctor:** checks the nginx binary, config, mkcert, certificate trust, ports 80/443, and whether each app is actually listening. Problems come with a fix button.
- **Header buttons:** start, stop, reload and test the nginx config (`nginx -t`).

## 7. Command line

The UI isn't required. Everything is also available as commands:

```bash
interact-nginx ls                                   # list proxies
interact-nginx add app.local.test 3000 --apply      # add + apply in one go
interact-nginx add api.local.test 8080 --alias admin.local.test --no-websocket
interact-nginx rm app.local.test --apply
interact-nginx apply                                # apply pending changes
interact-nginx doctor                               # health check
```

`inx` is a shorter alias. For example: `inx add shop.local.test 5173 --apply`.

## 8. What it changes on your machine

| What | Where |
| --- | --- |
| Your proxy list | `~/.interact-nginx/state.json` |
| Certificates | `~/.interact-nginx/certs/` |
| Per-proxy logs | `~/.interact-nginx/logs/` |
| nginx config | `inx-*.conf` files in the folder your `nginx.conf` already includes (Homebrew: `/opt/homebrew/etc/nginx/servers/`, Debian: `/etc/nginx/conf.d/`) |
| Hosts entries | A block in `/etc/hosts` between `# >>> interact-nginx` and `# <<< interact-nginx` markers. Nothing outside it is touched. |

Every apply is checked with `nginx -t` first. If the check fails, all file changes are rolled back and nginx keeps running the old config.

**When will I see a password prompt?**
- When the list of domains changes, because the hosts file has to be updated.
- When trusting the local certificate authority (once).
- On Linux, or whenever nginx runs as root: when writing config or reloading nginx.

Each apply asks at most once.

## 9. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Browser says the certificate isn't trusted | In **Doctor**, click **Trust CA**, then restart the browser. On Firefox, install `nss` too (`brew install nss`) and trust again. |
| `502 Bad Gateway` | Your app isn't running on the upstream port. The proxy row shows **down** when nothing is listening. |
| Domain doesn't resolve | Make sure you clicked **Apply** and approved the password prompt. Check with `ping app.local.test`. |
| nginx won't start | Another program is using port 80 or 443 (Doctor shows which). Stop it, or check the **nginx error.log** in Logs. |
| "This tab isn't authorized" | Open the link printed in the terminal; it includes the token. |
| Changes in the UI do nothing | Look for the **Apply changes** banner. Saving alone doesn't touch nginx. |

## 10. Uninstall

1. Delete your proxies in the UI (or with `interact-nginx rm <domain>`), then **Apply**. This removes the nginx files and the hosts block.
2. Remove the CLI:
   ```bash
   npm uninstall -g interact-nginx     # npm install
   # or, in the cloned folder:
   npm unlink -g interact-nginx
   ```
3. Remove the app data: `rm -rf ~/.interact-nginx`
4. Optional: remove the local certificate authority with `mkcert -uninstall`.

---

Found a bug or using Linux/Windows? Please open an issue at https://github.com/khalidkhnz/interact-nginx/issues. Those platforms haven't been tested much yet.
