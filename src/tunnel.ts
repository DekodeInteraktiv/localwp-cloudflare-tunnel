// Electron-free tunnel helpers, so they can be exercised from the e2e test.
import { spawn, execFileSync, ChildProcess } from 'child_process';
import { Resolver } from 'dns/promises';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as fs from 'fs';
import * as path from 'path';

export const MU_PLUGIN_FILE = 'zz-local-cloudflare-tunnel.php';

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const START_TIMEOUT = 30000;

export interface Tunnel {
	proc: ChildProcess;
	url: string;
}

/**
 * Electron apps launched from Finder don't inherit the shell PATH, so check Homebrew paths first.
 */
export const findCloudflared = (): string | null => {
	const candidates = ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'];

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	try {
		const found = execFileSync('/usr/bin/which', ['cloudflared'], { encoding: 'utf8' }).trim();
		return found || null;
	} catch {
		return null;
	}
};

/**
 * Port of the site's web server (nginx or apache), bypassing Local's router.
 */
export const getHttpPort = (site: any): number | null => {
	const services = Object.values(site?.services || {}) as any[];
	const http = services.find(service => service.role === 'http');

	return http?.ports?.HTTP?.[0] ?? null;
};

/**
 * Local proxy between cloudflared and the site's web server.
 *
 * Nginx/Apache build their own redirects (e.g. /wp-admin -> /wp-admin/) from the Host header and
 * listen port, so they point at http://site.local:10115/. PHP never runs for those, so the mu-plugin
 * can't fix them; rewrite the Location header here instead.
 */
const startProxy = (port: number, domain: string, getTunnelUrl: () => string | null): Promise<http.Server> =>
	new Promise((resolve, reject) => {
		const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const localUrl = new RegExp(`^https?://${escaped}(:\\d+)?(?=/|$)`, 'i');

		const server = http.createServer((req, res) => {
			const upstream = http.request(
				{
					host: '127.0.0.1',
					port,
					method: req.method,
					path: req.url,
					headers: { ...req.headers, host: domain },
				},
				upstreamRes => {
					const headers = { ...upstreamRes.headers };
					const tunnelUrl = getTunnelUrl();

					if (tunnelUrl && typeof headers.location === 'string') {
						headers.location = headers.location.replace(localUrl, tunnelUrl);
					}

					res.writeHead(upstreamRes.statusCode || 502, headers);
					upstreamRes.pipe(res);
				}
			);

			upstream.on('error', error => {
				res.writeHead(502, { 'Content-Type': 'text/plain' });
				res.end(`Local site unreachable: ${error.message}`);
			});

			req.pipe(upstream);
		});

		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => resolve(server));
	});

/**
 * Spawns a quick tunnel and resolves once cloudflared prints the public URL.
 */
export const startTunnel = (
	bin: string,
	port: number,
	domain: string,
	onExit: (code: number | null, log: string) => void
): Promise<Tunnel> => {
	let tunnelUrl: string | null = null;

	return startProxy(port, domain, () => tunnelUrl).then(server => new Promise((resolve, reject) => {
		const proxyPort = (server.address() as AddressInfo).port;
		const proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${proxyPort}`]);

		let log = '';
		let settled = false;

		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				proc.kill();
				reject(new Error(`Timed out waiting for tunnel URL.\n${log.slice(-1000)}`));
			}
		}, START_TIMEOUT);

		const onData = (chunk: Buffer) => {
			log = (log + chunk.toString()).slice(-10000);
			const match = !settled && log.match(URL_PATTERN);

			if (match) {
				settled = true;
				clearTimeout(timer);
				tunnelUrl = match[0];
				resolve({ proc, url: match[0] });
			}
		};

		// cloudflared logs to stderr.
		proc.stderr.on('data', onData);
		proc.stdout.on('data', onData);

		proc.on('error', error => {
			server.close();

			if (!settled) {
				settled = true;
				clearTimeout(timer);
				reject(error);
			}
		});

		proc.on('exit', code => {
			clearTimeout(timer);
			server.close();
			server.closeAllConnections?.();

			if (!settled) {
				settled = true;
				reject(new Error(`cloudflared exited with code ${code}.\n${log.slice(-1000)}`));
				return;
			}

			onExit(code, log);
		});
	}));
};

/**
 * Waits until the new hostname resolves on Cloudflare's DNS.
 *
 * Looking it up too early makes the OS cache NXDOMAIN, so the URL appears dead for a while.
 */
export const waitForDns = async (host: string, timeout = 60000): Promise<string[]> => {
	const resolver = new Resolver();
	resolver.setServers(['1.1.1.1', '1.0.0.1']);

	const deadline = Date.now() + timeout;

	while (Date.now() < deadline) {
		try {
			const addresses = await resolver.resolve4(host);

			if (addresses.length) {
				return addresses;
			}
		} catch {
			// Not published yet.
		}

		await new Promise(resolve => setTimeout(resolve, 1000));
	}

	throw new Error(`Timed out waiting for DNS for ${host}`);
};

/**
 * Directories with wp-load.php: the public dir itself, then direct subfolders (e.g. Project Base's wp/).
 */
export const findWpCorePaths = (publicDir: string): string[] => {
	const candidates = [publicDir];

	try {
		for (const entry of fs.readdirSync(publicDir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				candidates.push(path.join(publicDir, entry.name));
			}
		}
	} catch {
		// Missing public dir; nothing to find.
	}

	return candidates.filter(dir => fs.existsSync(path.join(dir, 'wp-load.php')));
};

export const installMuPlugin = (muPluginDir: string, tunnelUrl: string, domain: string): string => {
	const template = fs.readFileSync(path.join(__dirname, 'mu-plugin.php'), 'utf8');
	const contents = template
		.replace(/__TUNNEL_URL__/g, tunnelUrl)
		.replace(/__SITE_DOMAIN__/g, domain);
	const target = path.join(muPluginDir, MU_PLUGIN_FILE);

	fs.mkdirSync(muPluginDir, { recursive: true });
	fs.writeFileSync(target, contents, 'utf8');

	return target;
};

export const removeMuPlugin = (muPluginDir: string): void => {
	fs.rmSync(path.join(muPluginDir, MU_PLUGIN_FILE), { force: true });
};
