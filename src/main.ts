// https://getflywheel.github.io/local-addon-api/modules/_local_main_.html
import { getServiceContainer, SiteData } from '@getflywheel/local/main';
import * as path from 'path';
import {
	findCloudflared,
	findWpCorePaths,
	getHttpPort,
	installMuPlugin,
	removeMuPlugin,
	startTunnel,
	Tunnel,
	waitForDns,
} from './tunnel';

const ServiceContainer = getServiceContainer();

type Status = 'stopped' | 'starting' | 'running' | 'error';

interface TunnelState {
	status: Status;
	url?: string;
	error?: string;
}

const tunnels = new Map<string, Tunnel & { muPluginDir: string }>();
const states = new Map<string, TunnelState>();

const normalizeSitePath = (sitePath: string) => sitePath.replace(/^~/, process.env.HOME || '');

export default function (context) {
	const { electron, hooks } = context;
	const { localLogger, sendIPCEvent, addIpcAsyncListener, wpCli, siteProcessManager } =
		ServiceContainer.cradle as any;

	const log = (message: string) => localLogger?.log('info', `[cloudflare-tunnel] ${message}`);

	const setState = (siteId: string, state: TunnelState) => {
		states.set(siteId, state);
		sendIPCEvent('cf-tunnel:status', siteId, state);
	};

	const getState = (siteId: string): TunnelState => states.get(siteId) || { status: 'stopped' };

	/**
	 * Resolve WPMU_PLUGIN_DIR so Project Base layouts (core in app/public/wp) work too.
	 */
	const getMuPluginDir = async (site: any): Promise<string> => {
		const publicDir = path.join(normalizeSitePath(site.path), 'app', 'public');

		// Local passes --path=app/public; a later --path overrides it when core lives in a subfolder.
		for (const corePath of findWpCorePaths(publicDir)) {
			const args = corePath === publicDir ? [] : [`--path=${corePath}`];

			try {
				const dir = (await wpCli.run(site, [...args, 'eval', 'echo WPMU_PLUGIN_DIR;'], { skipPlugins: true, skipThemes: true }))?.trim();

				if (dir && path.isAbsolute(dir)) {
					return dir;
				}
			} catch (error) {
				log(`Could not resolve WPMU_PLUGIN_DIR for ${site.id} in ${corePath}: ${error}`);
			}
		}

		return path.join(publicDir, 'wp-content', 'mu-plugins');
	};

	const stop = (siteId: string) => {
		const tunnel = tunnels.get(siteId);

		if (tunnel) {
			tunnels.delete(siteId);
			tunnel.proc.kill();
			removeMuPlugin(tunnel.muPluginDir);
			log(`Stopped tunnel for ${siteId}`);
		}

		setState(siteId, { status: 'stopped' });
		return getState(siteId);
	};

	const start = async (siteId: string) => {
		if (tunnels.has(siteId)) {
			return getState(siteId);
		}

		const site = SiteData.getSite(siteId);
		const bin = findCloudflared();
		const port = getHttpPort(site);

		if (!bin) {
			setState(siteId, { status: 'error', error: 'cloudflared not found. Run: brew install cloudflared' });
			return getState(siteId);
		}

		if (siteProcessManager.getSiteStatus(site) !== 'running' || !port) {
			setState(siteId, { status: 'error', error: 'Start the site first.' });
			return getState(siteId);
		}

		setState(siteId, { status: 'starting' });

		try {
			const muPluginDir = await getMuPluginDir(site);
			const tunnel = await startTunnel(bin, port, site.domain, (code, output) => {
				// Process died on its own (network drop, killed externally).
				if (tunnels.get(siteId)?.proc === tunnel.proc) {
					tunnels.delete(siteId);
					removeMuPlugin(muPluginDir);
					log(`cloudflared exited (${code}) for ${siteId}: ${output.slice(-500)}`);
					setState(siteId, { status: 'error', error: `cloudflared exited with code ${code}` });
				}
			});

			installMuPlugin(muPluginDir, tunnel.url, site.domain);
			tunnels.set(siteId, { ...tunnel, muPluginDir });

			try {
				await waitForDns(new URL(tunnel.url).host);
			} catch (error) {
				log(String(error));
			}

			// Stopped while waiting for DNS.
			if (tunnels.get(siteId)?.proc !== tunnel.proc) {
				return getState(siteId);
			}

			log(`Started ${tunnel.url} -> 127.0.0.1:${port} for ${siteId}`);
			setState(siteId, { status: 'running', url: tunnel.url });
		} catch (error) {
			log(`Failed to start tunnel for ${siteId}: ${error}`);
			setState(siteId, { status: 'error', error: String(error?.message || error) });
		}

		return getState(siteId);
	};

	addIpcAsyncListener('cf-tunnel:start', start);
	addIpcAsyncListener('cf-tunnel:stop', stop);
	addIpcAsyncListener('cf-tunnel:get-status', (siteId: string) => ({
		...getState(siteId),
		hasBinary: !!findCloudflared(),
	}));

	hooks.addAction('siteStopped', (site: any) => {
		if (tunnels.has(site.id)) {
			stop(site.id);
		}
	});

	electron.app.on('before-quit', () => {
		for (const siteId of Array.from(tunnels.keys())) {
			stop(siteId);
		}
	});
}
