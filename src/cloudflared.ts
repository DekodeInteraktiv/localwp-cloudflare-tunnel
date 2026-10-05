// Finds cloudflared, or downloads the official build from GitHub into a directory the add-on manages.
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';

const RELEASES_API = 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest';
const UPDATE_INTERVAL = 7 * 24 * 60 * 60 * 1000;
const MAX_REDIRECTS = 5;

export interface Cloudflared {
	path: string;
	source: 'system' | 'managed';
}

export interface Platform {
	platform: NodeJS.Platform;
	arch: string;
	env: NodeJS.ProcessEnv;
}

interface Manifest {
	version: string;
	checkedAt: number;
}

const current = (): Platform => ({ platform: process.platform, arch: process.arch, env: process.env });

// path.win32 keeps Windows paths correct when tests run on macOS/Linux.
const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);

export const binaryName = (platform: NodeJS.Platform) => (platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');

const managedBinary = (dir: string, platform = process.platform) => pathFor(platform).join(dir, binaryName(platform));
const manifestFile = (dir: string) => path.join(dir, 'manifest.json');

const readManifest = (dir: string): Manifest | null => {
	try {
		return JSON.parse(fs.readFileSync(manifestFile(dir), 'utf8'));
	} catch {
		return null;
	}
};

/**
 * Where package managers and installers put cloudflared, checked before PATH.
 *
 * Electron apps launched from Finder don't inherit the shell PATH, so Homebrew must be listed explicitly.
 */
export const systemCandidates = ({ platform, env }: Platform): string[] => {
	const p = pathFor(platform);
	const name = binaryName(platform);

	if (platform === 'darwin') {
		return ['/opt/homebrew/bin', '/usr/local/bin'].map(dir => p.join(dir, name));
	}

	if (platform === 'win32') {
		return [
			env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),
			env.ProgramFiles && p.join(env.ProgramFiles, 'cloudflared'),
			env['ProgramFiles(x86)'] && p.join(env['ProgramFiles(x86)'], 'cloudflared'),
		]
			.filter(Boolean)
			.map(dir => p.join(dir as string, name));
	}

	return ['/usr/local/bin', '/usr/bin', env.HOME && p.join(env.HOME, '.local', 'bin')]
		.filter(Boolean)
		.map(dir => p.join(dir as string, name));
};

const pathCandidates = ({ platform, env }: Platform): string[] => {
	const p = pathFor(platform);
	const delimiter = platform === 'win32' ? ';' : ':';
	const value = env.PATH || env.Path || '';

	return value
		.split(delimiter)
		.filter(Boolean)
		.map(dir => p.join(dir, binaryName(platform)));
};

/**
 * A system install (package manager, installer or PATH) wins; otherwise the copy this add-on downloaded.
 */
export const findCloudflared = (
	managedDir?: string,
	target: Platform = current(),
	exists: (file: string) => boolean = fs.existsSync
): Cloudflared | null => {
	for (const candidate of [...systemCandidates(target), ...pathCandidates(target)]) {
		if (exists(candidate)) {
			return { path: candidate, source: 'system' };
		}
	}

	if (managedDir && exists(managedBinary(managedDir, target.platform))) {
		return { path: managedBinary(managedDir, target.platform), source: 'managed' };
	}

	return null;
};

/**
 * The release asset for a platform. Only the macOS builds are archives; the others are plain binaries.
 */
export const assetFor = ({ platform, arch }: Pick<Platform, 'platform' | 'arch'>): { name: string; archive: boolean } => {
	if (platform === 'darwin') {
		return { name: `cloudflared-darwin-${arch === 'arm64' ? 'arm64' : 'amd64'}.tgz`, archive: true };
	}

	if (platform === 'win32') {
		// Windows on ARM runs the amd64 build under emulation; there is no native arm64 build.
		return { name: `cloudflared-windows-${arch === 'ia32' ? '386' : 'amd64'}.exe`, archive: false };
	}

	if (platform === 'linux') {
		const linuxArch = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }[arch];

		if (!linuxArch) {
			throw new Error(`No cloudflared build for linux/${arch}. Install cloudflared manually.`);
		}

		return { name: `cloudflared-linux-${linuxArch}`, archive: false };
	}

	throw new Error(`No cloudflared build for ${platform}. Install cloudflared manually.`);
};

const get = (url: string, redirects = 0): Promise<Buffer> =>
	new Promise((resolve, reject) => {
		https
			.get(url, { headers: { 'User-Agent': 'localwp-cloudflare-tunnel', Accept: 'application/octet-stream, application/json' } }, res => {
				const { statusCode = 0, headers } = res;

				if (statusCode >= 300 && statusCode < 400 && headers.location) {
					res.resume();

					if (redirects >= MAX_REDIRECTS) {
						reject(new Error('Too many redirects'));
						return;
					}

					resolve(get(new URL(headers.location, url).href, redirects + 1));
					return;
				}

				if (statusCode !== 200) {
					res.resume();
					reject(new Error(`GET ${url} returned HTTP ${statusCode}`));
					return;
				}

				const chunks: Buffer[] = [];
				res.on('data', chunk => chunks.push(chunk));
				res.on('end', () => resolve(Buffer.concat(chunks)));
				res.on('error', reject);
			})
			.on('error', reject);
	});

const latestRelease = async (target: Pick<Platform, 'platform' | 'arch'>) => {
	const { name, archive } = assetFor(target);
	const release = JSON.parse((await get(RELEASES_API)).toString('utf8'));
	const asset = release.assets?.find((a: any) => a.name === name);

	if (!asset) {
		throw new Error(`No ${name} in cloudflared ${release.tag_name}`);
	}

	return {
		version: release.tag_name as string,
		url: asset.browser_download_url as string,
		digest: asset.digest as string | undefined,
		archive,
	};
};

/**
 * Downloads the latest cloudflared, verifies its SHA-256 and swaps it in atomically.
 *
 * `target` is only overridden by tests, to fetch other platforms' builds.
 */
export const installCloudflared = async (
	managedDir: string,
	target: Pick<Platform, 'platform' | 'arch'> = current()
): Promise<Cloudflared & { version: string }> => {
	const { version, url, digest, archive } = await latestRelease(target);
	const download = await get(url);

	if (!digest?.startsWith('sha256:')) {
		throw new Error('GitHub did not provide a checksum for cloudflared; refusing to install it.');
	}

	if (`sha256:${createHash('sha256').update(download).digest('hex')}` !== digest) {
		throw new Error('cloudflared download failed checksum verification.');
	}

	const name = binaryName(target.platform);
	const finalPath = path.join(managedDir, name);
	// Same directory as the target, so the final rename is atomic.
	const staged = `${finalPath}.new`;

	fs.mkdirSync(managedDir, { recursive: true });

	if (archive) {
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudflared-'));

		try {
			const archivePath = path.join(temp, 'cloudflared.tgz');
			fs.writeFileSync(archivePath, download);
			execFileSync('tar', ['-xzf', archivePath, '-C', temp]);
			fs.copyFileSync(path.join(temp, 'cloudflared'), staged);
		} finally {
			fs.rmSync(temp, { recursive: true, force: true });
		}
	} else {
		fs.writeFileSync(staged, download);
	}

	fs.chmodSync(staged, 0o755);

	// On Windows this fails while the old cloudflared.exe is running; the next update check retries.
	fs.renameSync(staged, finalPath);

	fs.writeFileSync(manifestFile(managedDir), JSON.stringify({ version, checkedAt: Date.now() } as Manifest));

	return { path: finalPath, source: 'managed', version };
};

/**
 * Refreshes the managed copy at most once a week. System installs are left to their package manager.
 *
 * Returns the new version when it updated.
 */
export const updateCloudflaredIfStale = async (managedDir: string): Promise<string | null> => {
	const manifest = readManifest(managedDir);

	if (!fs.existsSync(managedBinary(managedDir)) || (manifest && Date.now() - manifest.checkedAt < UPDATE_INTERVAL)) {
		return null;
	}

	const { version } = await latestRelease(current());

	if (manifest?.version === version) {
		fs.writeFileSync(manifestFile(managedDir), JSON.stringify({ ...manifest, checkedAt: Date.now() }));
		return null;
	}

	return (await installCloudflared(managedDir)).version;
};
