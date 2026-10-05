import { ipcAsync } from '@getflywheel/local/renderer';
import React, { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { clipboard, ipcRenderer, shell } from 'electron';

// Local's Live Link toggle sits in the site footer. Its TID_ class is unhashed, unlike the CSS module classes.
const LIVE_LINK_TRIGGER = '.TID_Live_Link_Toggle__Trigger_Content';
const FOOTER = '[class*="SiteInfo_Bottom"]';
const TAKEOVER_CLASS = 'cf-tunnel-takeover';

/**
 * Mounts a host element at the start of the footer, in front of Local's Live Link toggle (hidden via CSS).
 */
const useLiveLinkSlot = () => {
	const [slot, setSlot] = useState(null);

	useLayoutEffect(() => {
		const footer = document.querySelector(LIVE_LINK_TRIGGER)?.closest(FOOTER);

		if (!footer) {
			return undefined;
		}

		const host = document.createElement('div');
		host.className = 'cf-tunnel-slot';
		footer.insertBefore(host, footer.firstChild);
		footer.classList.add(TAKEOVER_CLASS);
		setSlot(host);

		return () => {
			footer.classList.remove(TAKEOVER_CLASS);
			host.remove();
		};
	}, []);

	return slot;
};

const useTunnelState = (siteId) => {
	const [state, setState] = useState({ status: 'stopped' });

	useEffect(() => {
		let mounted = true;

		const onStatus = (event, id, next) => {
			if (mounted && id === siteId) {
				setState((prev) => ({ ...prev, ...next }));
			}
		};

		setState({ status: 'stopped' });
		ipcAsync('cf-tunnel:get-status', siteId).then((initial) => mounted && setState(initial));
		ipcRenderer.on('cf-tunnel:status', onStatus);

		return () => {
			mounted = false;
			ipcRenderer.removeListener('cf-tunnel:status', onStatus);
		};
	}, [siteId]);

	return [state, setState];
};

const TunnelToggle = ({ site, siteStatus }) => {
	const slot = useLiveLinkSlot();
	const [state, setState] = useTunnelState(site.id);
	const [copied, setCopied] = useState(false);

	const start = () => {
		setState((prev) => ({ ...prev, status: 'starting', error: undefined }));
		ipcAsync('cf-tunnel:start', site.id);
	};

	const stop = () => {
		setState((prev) => ({ ...prev, status: 'stopping' }));
		ipcAsync('cf-tunnel:stop', site.id);
	};

	const copy = () => {
		clipboard.writeText(state.url);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};

	const running = state.status === 'running';
	const busy = state.status === 'starting' || state.status === 'stopping';

	let content;

	if (state.hasBinary === false) {
		content = (
			<span className="cf-tunnel__hint" title="cloudflared is required">
				brew install cloudflared
			</span>
		);
	} else if (running) {
		content = (
			<>
				<button type="button" className="cf-tunnel__link" onClick={() => shell.openExternal(state.url)} title={state.url}>
					{new URL(state.url).host}
				</button>
				<button type="button" className="cf-tunnel__button" onClick={copy}>
					{copied ? 'Copied' : 'Copy'}
				</button>
				<button type="button" className="cf-tunnel__button" onClick={stop}>
					Disable
				</button>
			</>
		);
	} else if (busy) {
		content = <span className="cf-tunnel__hint">{state.status === 'starting' ? 'Creating tunnel…' : 'Closing tunnel…'}</span>;
	} else {
		content = (
			<>
				{state.error && (
					<span className="cf-tunnel__error" title={state.error}>
						Failed
					</span>
				)}
				<button
					type="button"
					className="cf-tunnel__button"
					onClick={start}
					disabled={siteStatus !== 'running'}
					title={siteStatus !== 'running' ? 'Start the site first' : state.error || 'Share this site on a trycloudflare.com URL'}
				>
					Enable
				</button>
			</>
		);
	}

	const toggle = (
		<div className={`cf-tunnel ${slot ? 'cf-tunnel--slot' : 'cf-tunnel--inline'}`}>
			<span className={`cf-tunnel__dot ${running ? 'cf-tunnel__dot--on' : ''}`} />
			<span className="cf-tunnel__label">Cloudflare Tunnel</span>
			{content}
		</div>
	);

	return slot ? createPortal(toggle, slot) : toggle;
};

export default TunnelToggle;
