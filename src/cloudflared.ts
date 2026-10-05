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

interface Manifest {
	version: string;
	checkedAt: number;
}

const managedBinary = (dir: string) => path.join(dir, 'cloudflared');
const manifestFile = (dir: string) => path.join(dir, 'manifest.json');

const readManifest = (dir: string): Manifest | null => {
	try {
		return JSON.parse(fs.readFileSync(manifestFile(dir), 'utf8'));
	} catch {
		return null;
	}
};

/**
 * A system install (Homebrew or PATH) wins; otherwise the copy this add-on downloaded.
 *
 * Electron apps launched from Finder don't inherit the shell PATH, so check Homebrew paths first.
 */
export const findCloudflared = (managedDir?: string): Cloudflared | null => {
	for (const candidate of ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared']) {
		if (fs.existsSync(candidate)) {
			return { path: candidate, source: 'system' };
		}
	}

	try {
		const found = execFileSync('/usr/bin/which', ['cloudflared'], { encoding: 'utf8' }).trim();

		if (found) {
			return { path: found, source: 'system' };
		}
	} catch {
		// Not on PATH.
	}

	if (managedDir && fs.existsSync(managedBinary(managedDir))) {
		return { path: managedBinary(managedDir), source: 'managed' };
	}

	return null;
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

const assetName = () => {
	if (process.platform !== 'darwin') {
		throw new Error(`Automatic cloudflared download only supports macOS. Install cloudflared manually.`);
	}

	return `cloudflared-darwin-${process.arch === 'arm64' ? 'arm64' : 'amd64'}.tgz`;
};

const latestRelease = async () => {
	const release = JSON.parse((await get(RELEASES_API)).toString('utf8'));
	const asset = release.assets?.find((a: any) => a.name === assetName());

	if (!asset) {
		throw new Error(`No ${assetName()} in cloudflared ${release.tag_name}`);
	}

	return { version: release.tag_name as string, url: asset.browser_download_url as string, digest: asset.digest as string | undefined };
};

/**
 * Downloads the latest cloudflared, verifies its SHA-256 and swaps it in atomically.
 */
export const installCloudflared = async (managedDir: string): Promise<Cloudflared & { version: string }> => {
	const { version, url, digest } = await latestRelease();
	const archive = await get(url);

	if (!digest?.startsWith('sha256:')) {
		throw new Error('GitHub did not provide a checksum for cloudflared; refusing to install it.');
	}

	const actual = createHash('sha256').update(archive).digest('hex');

	if (`sha256:${actual}` !== digest) {
		throw new Error('cloudflared download failed checksum verification.');
	}

	fs.mkdirSync(managedDir, { recursive: true });
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudflared-'));

	try {
		const archivePath = path.join(temp, 'cloudflared.tgz');
		fs.writeFileSync(archivePath, archive);
		execFileSync('/usr/bin/tar', ['-xzf', archivePath, '-C', temp]);

		const extracted = path.join(temp, 'cloudflared');
		fs.chmodSync(extracted, 0o755);

		// Same volume as the target, so the final rename is atomic.
		const staged = `${managedBinary(managedDir)}.new`;
		fs.copyFileSync(extracted, staged);
		fs.chmodSync(staged, 0o755);
		fs.renameSync(staged, managedBinary(managedDir));
	} finally {
		fs.rmSync(temp, { recursive: true, force: true });
	}

	fs.writeFileSync(manifestFile(managedDir), JSON.stringify({ version, checkedAt: Date.now() } as Manifest));

	return { path: managedBinary(managedDir), source: 'managed', version };
};

/**
 * Refreshes the managed copy at most once a week. System installs are left to Homebrew.
 *
 * Returns the new version when it updated.
 */
export const updateCloudflaredIfStale = async (managedDir: string): Promise<string | null> => {
	const manifest = readManifest(managedDir);

	if (!fs.existsSync(managedBinary(managedDir)) || (manifest && Date.now() - manifest.checkedAt < UPDATE_INTERVAL)) {
		return null;
	}

	const { version } = await latestRelease();

	if (manifest?.version === version) {
		fs.writeFileSync(manifestFile(managedDir), JSON.stringify({ ...manifest, checkedAt: Date.now() }));
		return null;
	}

	return (await installCloudflared(managedDir)).version;
};
