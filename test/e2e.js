/**
 * End-to-end test against a running Local site.
 *
 * Crawls front-end routes (with plain and pretty permalinks), every same-host link and asset
 * they reference, and logged-in wp-admin screens through a real tunnel.
 *
 * Usage: npm run build && node test/e2e.js [site-name]   (default: cf-tunnel-test)
 *        TUNNEL_URL=https://….trycloudflare.com node test/e2e.js   (reuse a tunnel started from Local's UI)
 */
const assert = require('assert');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { findCloudflared, findWpCorePaths, getHttpPort, installMuPlugin, removeMuPlugin, startTunnel, waitForDns, MU_PLUGIN_FILE } = require('../lib/tunnel');

const siteName = process.argv[2] || 'cf-tunnel-test';
const localData = path.join(os.homedir(), 'Library/Application Support/Local');
const wpCliPhar = '/Applications/Local.app/Contents/Resources/extraResources/bin/wp-cli/wp-cli.phar';
const MAX_DISCOVERED = 80;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * WP-CLI using Local's bundled PHP and the site's php.ini (for the MySQL socket).
 */
const makeWp = (site, sitePath) => {
	const phpVersion = site.services.php.version;
	const phpDir = fs.readdirSync(path.join(localData, 'lightning-services')).find((d) => d.startsWith(`php-${phpVersion}+`));
	const arch = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin';
	const php = path.join(localData, 'lightning-services', phpDir, 'bin', arch, 'bin', 'php');
	const ini = path.join(localData, 'run', site.id, 'conf', 'php', 'php.ini');
	const corePath = findWpCorePaths(path.join(sitePath, 'app/public'))[0];

	return (...args) => execFileSync(php, ['-c', ini, wpCliPhar, `--path=${corePath}`, ...args], { encoding: 'utf8' }).trim();
};

// Pinned to addresses from 1.1.1.1 so a stale OS DNS cache can't interfere.
let pinned = [];
const cookies = new Map();

const request = (url, { method = 'GET', body, headers = {} } = {}) =>
	new Promise((resolve, reject) => {
		const lookup = (hostname, options, callback) =>
			options.all ? callback(null, pinned.map((address) => ({ address, family: 4 }))) : callback(null, pinned[0], 4);
		const cookie = Array.from(cookies, ([k, v]) => `${k}=${v}`).join('; ');

		const req = https.request(url, { method, lookup, headers: { ...(cookie && { Cookie: cookie }), ...headers } }, (res) => {
			const chunks = [];

			for (const line of res.headers['set-cookie'] || []) {
				const [pair] = line.split(';');
				const [name, ...value] = pair.split('=');
				cookies.set(name.trim(), value.join('='));
			}

			res.on('data', (chunk) => chunks.push(chunk));
			res.on('end', () =>
				resolve({
					status: res.statusCode,
					location: res.headers.location || '',
					type: res.headers['content-type'] || '',
					body: Buffer.concat(chunks).toString('utf8'),
				})
			);
		});

		req.on('error', reject);
		req.end(body);
	});

// The edge can briefly return 502/530 before the tunnel connection is registered.
const fetchWithRetry = async (url, options, attempts = 15) => {
	let last;

	for (let i = 0; i < attempts; i++) {
		last = await request(url, options).catch((error) => ({ status: 0, error }));

		if (last.status && last.status !== 502 && last.status !== 530) {
			return last;
		}

		await sleep(2000);
	}

	return last;
};

const isText = (type) => /html|json|xml|css|javascript|text/.test(type);

const extractLinks = (html, host) => {
	const links = new Set();
	const pattern = /(?:href|src)=["']([^"'#]+)["']/g;
	let match;

	while ((match = pattern.exec(html))) {
		const raw = match[1].replace(/&amp;/g, '&').replace(/&#038;/g, '&');

		try {
			const url = new URL(raw, `https://${host}/`);

			if (url.host === host && !/\/wp-login\.php\?action=logout|wp-admin\/.*action=(delete|trash)/.test(url.href)) {
				links.add(url.href);
			}
		} catch {
			// Ignore malformed URLs.
		}
	}

	return links;
};

const run = async () => {
	const sites = Object.values(JSON.parse(fs.readFileSync(path.join(localData, 'sites.json'), 'utf8')));
	const site = sites.find((s) => s.name === siteName);
	assert(site, `Site "${siteName}" not found in Local. Create and start it first.`);

	const bin = findCloudflared()?.path;
	assert(bin, 'cloudflared not found');

	const port = getHttpPort(site);
	assert(port, 'No HTTP port for site');

	const localStatus = await new Promise((resolve) =>
		http.get({ host: '127.0.0.1', port, path: '/', headers: { Host: site.domain } }, (res) => resolve(res.statusCode)).on('error', () => resolve(0))
	);
	assert(localStatus && localStatus < 500, `Site not healthy on port ${port} (${localStatus}). Is it started in Local?`);

	const sitePath = site.path.replace(/^~/, os.homedir());
	const wp = makeWp(site, sitePath);
	const muPluginDir = wp('eval', 'echo WPMU_PLUGIN_DIR;', '--skip-plugins', '--skip-themes');

	const originalPermalinks = wp('option', 'get', 'permalink_structure');
	const user = `cf-tunnel-test-${Date.now()}`;
	const password = crypto.randomBytes(16).toString('hex');
	wp('user', 'create', user, `${user}@example.com`, '--role=administrator', `--user_pass=${password}`);

	const postId = wp('post', 'list', '--post_type=post', '--post_status=publish', '--field=ID', '--posts_per_page=1').split('\n')[0];
	const year = new Date().getFullYear();

	console.log(`Starting tunnel for ${site.domain} (127.0.0.1:${port})`);
	const existing = process.env.TUNNEL_URL?.replace(/\/$/, '');
	const tunnel = existing ? { url: existing, proc: null } : await startTunnel(bin, port, site.domain, () => {});
	const host = new URL(tunnel.url).host;
	const base = tunnel.url;
	console.log(`Tunnel: ${base}`);

	const failures = [];
	let checked = 0;

	/**
	 * Checks one URL. Returns the response so callers can crawl it.
	 */
	const check = async (url, { expect = [200], options, label = url } = {}) => {
		const res = await fetchWithRetry(url, options);
		checked++;

		if (!res.status) {
			failures.push(`${label}: ${res.error?.message}`);
			return res;
		}

		const redirect = res.status >= 300 && res.status < 400;

		if (redirect && !res.location.startsWith(`https://${host}/`)) {
			failures.push(`${label}: ${res.status} redirect to ${res.location}`);
		} else if (!redirect && !expect.includes(res.status)) {
			failures.push(`${label}: HTTP ${res.status}`);
		}

		if (isText(res.type) && (res.body.includes(`//${site.domain}`) || res.body.includes(`\\/\\/${site.domain}`))) {
			failures.push(`${label}: response still references ${site.domain}`);
		}

		return res;
	};

	const crawl = async (routes, title) => {
		const before = { failures: failures.length, checked };
		const discovered = new Set();

		for (const [route, expect] of routes) {
			const res = await check(`${base}${route}`, { expect });

			if (res.type?.includes('html')) {
				extractLinks(res.body, host).forEach((link) => discovered.add(link));
			}
		}

		for (const route of routes.map(([r]) => `${base}${r}`)) {
			discovered.delete(route);
		}

		for (const link of Array.from(discovered).slice(0, MAX_DISCOVERED)) {
			await check(link, { expect: [200, 404] });
		}

		const failed = failures.length - before.failures;
		console.log(`${failed ? '✗' : '✓'} ${title}: ${checked - before.checked} URLs (${discovered.size} discovered links/assets)${failed ? `, ${failed} failed` : ''}`);
	};

	try {
		if (!existing) {
			installMuPlugin(muPluginDir, base, site.domain);
		}

		assert(fs.existsSync(path.join(muPluginDir, MU_PLUGIN_FILE)), 'mu-plugin not installed');

		pinned = await waitForDns(host);

		const frontEnd = [
			['/', [200]],
			['/?s=hello', [200]],
			[`/?p=${postId}`, [200]],
			['/?cat=1', [200]],
			['/?author=1', [200]],
			[`/?m=${year}`, [200]],
			['/?feed=rss2', [200]],
			['/?rest_route=/', [200]],
			['/?rest_route=/wp/v2/posts', [200]],
			['/?sitemap=index', [200]],
			['/wp-login.php', [200]],
			// Web-server redirects (trailing slash), which bypass PHP.
			['/wp-admin', [200]],
			['/wp-content', [200, 403, 404]],
			['/?p=999999', [404]],
		];

		wp('option', 'update', 'permalink_structure', '');
		wp('rewrite', 'flush');

		await crawl(frontEnd, 'Front end, plain permalinks');

		wp('option', 'update', 'permalink_structure', '/%postname%/');
		wp('rewrite', 'flush');

		await crawl(
			[
				...frontEnd,
				['/search/hello/', [200]],
				['/category/uncategorized/', [200]],
				['/author/admin/', [200, 404]],
				[`/${year}/`, [200]],
				['/feed/', [200]],
				['/wp-sitemap.xml', [200]],
				['/wp-json/', [200]],
				['/wp-json/wp/v2/posts', [200]],
				['/this-page-does-not-exist/', [404]],
			],
			'Front end, pretty permalinks'
		);

		// Log in through the tunnel.
		cookies.clear();
		await check(`${base}/wp-login.php`, { label: 'wp-login.php (set test cookie)' });
		const login = await request(`${base}/wp-login.php`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ log: user, pwd: password, testcookie: '1', redirect_to: `${base}/wp-admin/` }).toString(),
		});
		const loggedIn = login.status === 302 && login.location.startsWith(`https://${host}/wp-admin`);

		if (!loggedIn) {
			failures.push(`Login: HTTP ${login.status} -> ${login.location || 'no redirect'}`);
		}

		console.log(`${loggedIn ? '✓' : '✗'} Login through tunnel`);

		if (loggedIn) {
			await crawl(
				[
					['/wp-admin/', [200]],
					['/wp-admin/edit.php', [200]],
					['/wp-admin/post-new.php', [200]],
					[`/wp-admin/post.php?post=${postId}&action=edit`, [200]],
					['/wp-admin/edit.php?post_type=page', [200]],
					['/wp-admin/upload.php', [200]],
					['/wp-admin/edit-comments.php', [200]],
					['/wp-admin/themes.php', [200]],
					['/wp-admin/plugins.php', [200]],
					['/wp-admin/users.php', [200]],
					['/wp-admin/options-general.php', [200]],
					['/wp-admin/options-permalink.php', [200]],
					['/wp-admin/site-health.php', [200]],
					['/wp-admin/admin-ajax.php?action=heartbeat', [200, 400]],
				],
				'wp-admin (logged in)'
			);
		}

		// fetch() drops custom Host headers, so use http directly.
		const directBody = await new Promise((resolve, reject) => {
			http
				.get({ host: '127.0.0.1', port, path: '/', headers: { Host: site.domain } }, (res) => {
					let data = '';
					res.on('data', (chunk) => (data += chunk));
					res.on('end', () => resolve(data));
				})
				.on('error', reject);
		});
		const untouched = !directBody.includes(host) && directBody.includes(site.domain);

		if (!untouched) {
			failures.push('Direct local request was rewritten');
		}

		console.log(`${untouched ? '✓' : '✗'} Direct local requests untouched`);
	} finally {
		if (!existing) {
			tunnel.proc.kill();
			removeMuPlugin(muPluginDir);
		}

		// Each step on its own so one failure doesn't leave the others behind.
		for (const args of [['option', 'update', 'permalink_structure', originalPermalinks], ['user', 'delete', user, '--yes']]) {
			try {
				wp(...args);
			} catch (error) {
				failures.push(`Cleanup "wp ${args.join(' ')}" failed: ${error.message}`);
			}
		}
	}

	if (!existing) {
		assert(!fs.existsSync(path.join(muPluginDir, MU_PLUGIN_FILE)), 'mu-plugin not removed');
	}

	console.log(`✓ Cleaned up (${existing ? '' : 'tunnel, mu-plugin, '}permalinks, test user)`);

	if (failures.length) {
		throw new Error(`${failures.length} of ${checked} checks failed:\n  ${failures.join('\n  ')}`);
	}

	console.log(`\nAll ${checked} URLs passed.`);
};

run().catch((error) => {
	console.error(`✗ ${error.message}`);
	process.exit(1);
});
