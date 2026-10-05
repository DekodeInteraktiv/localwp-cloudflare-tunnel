/**
 * Real tunnel through Cloudflare to a throwaway local server (no Local or WordPress needed).
 *
 * Set CF_TUNNEL=1 to run it (CI does); it needs network access and cloudflared, which it downloads if missing.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const { findCloudflared, installCloudflared } = require('../../lib/cloudflared');
const { startTunnel, waitForDns } = require('../../lib/tunnel');

const DOMAIN = 'example.local';

test('serves a local site through a quick tunnel and rewrites web-server redirects', { skip: !process.env.CF_TUNNEL, timeout: 180000 }, async () => {
	// Mimics nginx: a trailing-slash redirect built from the Host header and local port.
	const server = http.createServer((req, res) => {
		if (req.url === '/wp-admin') {
			res.writeHead(301, { Location: `http://${req.headers.host}:${server.address().port}/wp-admin/` });
			res.end();
			return;
		}

		res.writeHead(200, { 'Content-Type': 'text/plain' });
		res.end(`host=${req.headers.host} ray=${req.headers['cf-ray'] ? 'yes' : 'no'}`);
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

	const managedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-managed-'));
	const bin = findCloudflared(managedDir)?.path || (await installCloudflared(managedDir)).path;
	const tunnel = await startTunnel(bin, server.address().port, DOMAIN, () => {});

	try {
		const host = new URL(tunnel.url).host;
		const ips = await waitForDns(host, 90000);
		const lookup = (hostname, options, callback) =>
			options.all ? callback(null, ips.map((address) => ({ address, family: 4 }))) : callback(null, ips[0], 4);

		const request = async (route) => {
			for (let i = 0; i < 20; i++) {
				const res = await new Promise((resolve, reject) => {
					https
						.get(`${tunnel.url}${route}`, { lookup }, (r) => {
							let body = '';
							r.on('data', (chunk) => (body += chunk));
							r.on('end', () => resolve({ status: r.statusCode, location: r.headers.location, body }));
						})
						.on('error', reject);
				}).catch(() => null);

				if (res && res.status !== 502 && res.status !== 530) {
					return res;
				}

				await new Promise((resolve) => setTimeout(resolve, 2000));
			}

			throw new Error(`No response from ${route}`);
		};

		const home = await request('/');
		assert.strictEqual(home.status, 200);
		assert.strictEqual(home.body, `host=${DOMAIN} ray=yes`, 'proxy sets Host to the site domain; Cloudflare adds CF-Ray');

		const admin = await request('/wp-admin');
		assert.strictEqual(admin.status, 301);
		assert.strictEqual(admin.location, `${tunnel.url}/wp-admin/`);
	} finally {
		tunnel.proc.kill();
		server.close();
		fs.rmSync(managedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
	}
});
