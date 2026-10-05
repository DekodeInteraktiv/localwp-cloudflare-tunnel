import path from 'path';
import TunnelToggle from './TunnelToggle';

export default function (context) {
	const { React, hooks } = context;

	hooks.addContent('stylesheets', () => (
		<link rel="stylesheet" key="cloudflare-tunnel-styles" href={path.resolve(__dirname, '../style.css')} />
	));

	/**
	 * Header, next to Start/Stop. TunnelToggle moves itself into Local's Live Link slot in the footer when it can.
	 */
	hooks.addContent('SiteInfo_Top_TopRight', (site, siteStatus) => (
		<TunnelToggle key="cloudflare-tunnel" site={site} siteStatus={siteStatus} />
	));
}
