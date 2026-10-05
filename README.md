# Cloudflare Tunnel for Local

Share a Local site on a public `https://*.trycloudflare.com` URL using a [Cloudflare Quick Tunnel](https://try.cloudflare.com/). No Cloudflare account needed.

## Install

1. Download `localwp-cloudflare-tunnel.tgz` from the [latest release](https://github.com/DekodeInteraktiv/localwp-cloudflare-tunnel/releases/latest).
2. In Local, open **Add-ons → Installed → Install from disk** and pick the `.tgz`.
3. Enable **Cloudflare Tunnel** and restart Local.

You don't need to install `cloudflared` yourself. If it isn't installed, the add-on downloads the official macOS build from [Cloudflare's GitHub releases](https://github.com/cloudflare/cloudflared/releases) the first time you click **Enable**. It checks the SHA-256 checksum that GitHub publishes for the file and stores the binary in `~/Library/Application Support/Local/cloudflared/`. That copy is checked for updates once a week. A `cloudflared` from Homebrew or on your `PATH` is used first if present.

### From source

```sh
git clone git@github.com:DekodeInteraktiv/localwp-cloudflare-tunnel.git
cd localwp-cloudflare-tunnel
npm install && npm run build
ln -s "$PWD" ~/Library/Application\ Support/Local/addons/localwp-cloudflare-tunnel
```

Enable **Cloudflare Tunnel** under Local → Add-ons, then restart Local.

## Releasing

Publish a GitHub release with a tag like `v0.2.0`. The release workflow builds the add-on, sets `package.json` to the tag's version and attaches `localwp-cloudflare-tunnel.tgz` to the release. Run `npm run dist` to build the same file locally.

## Usage

Start the site. The add-on replaces Local's **Live Link** toggle in the site footer with a **Cloudflare Tunnel** toggle. Click **Enable**, then **Copy** to grab the URL, and **Disable** when you're done. The tunnel also stops when the site stops or Local quits.

Local has no hook for its Live Link slot. The add-on registers in the header's official `SiteInfo_Top_TopRight` hook. It then moves itself into the footer in front of Local's toggle (found by its unhashed `TID_Live_Link_Toggle__Trigger_Content` class) and hides Local's toggle. If a future Local version changes that markup, the toggle stays in the header next to Start/Stop and Local's own Live Link comes back.

While the tunnel runs, the add-on drops `zz-local-cloudflare-tunnel.php` into the site's mu-plugins directory. It only acts on requests that come through Cloudflare. For those requests it rewrites `home`/`siteurl`, redirects and hardcoded `http://site.local` URLs to the tunnel URL. The file is removed when the tunnel stops.

cloudflared connects to a small proxy inside the add-on rather than straight to nginx/Apache. Web-server redirects, such as the trailing-slash redirect `/wp-admin` → `/wp-admin/`, are built from the local host and port and never reach PHP. The proxy rewrites their `Location` header to the tunnel URL.

## Quick Tunnel limits

- New random hostname every start
- 200 in-flight requests max (then `429`)
- No Server-Sent Events
- No uptime guarantee; for testing and sharing, not production

## Test

Create and start a Local site named `cf-tunnel-test`, then:

```sh
npm test            # or: npm run build && node test/e2e.js <site-name>
```

## License

[MIT](LICENSE) © Dekode Interaktiv
