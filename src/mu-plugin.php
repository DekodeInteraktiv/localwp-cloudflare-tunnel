<?php
/**
 * Plugin Name: Local Cloudflare Tunnel
 * Description: Serves the site on its Cloudflare Quick Tunnel URL. Added and removed automatically by the Local "Cloudflare Tunnel" add-on.
 *
 * @package LocalCloudflareTunnel
 */

declare( strict_types = 1 );

namespace LocalCloudflareTunnel;

const TUNNEL_URL  = '__TUNNEL_URL__';
const SITE_DOMAIN = '__SITE_DOMAIN__';

/**
 * Whether the current request came in through the tunnel.
 *
 * Cloudflare always adds CF-Ray; direct requests to the Local site never have it.
 *
 * @return bool
 */
function is_tunnel_request(): bool {
	return ! empty( $_SERVER['HTTP_CF_RAY'] ) || ! empty( $_SERVER['HTTP_CF_CONNECTING_IP'] );
}

if ( ! is_tunnel_request() ) {
	return;
}

$_SERVER['HTTPS']       = 'on';
$_SERVER['SERVER_PORT'] = 443;
$_SERVER['HTTP_HOST']   = (string) wp_parse_url( TUNNEL_URL, PHP_URL_HOST );

/**
 * Replaces local site URLs with the tunnel URL.
 *
 * @param mixed $value Value to filter.
 * @return mixed
 */
function replace_urls( $value ) {
	if ( ! is_string( $value ) || '' === $value ) {
		return $value;
	}

	$tunnel_host = (string) wp_parse_url( TUNNEL_URL, PHP_URL_HOST );

	return str_replace(
		array(
			'https://' . SITE_DOMAIN,
			'http://' . SITE_DOMAIN,
			'https:\/\/' . SITE_DOMAIN,
			'http:\/\/' . SITE_DOMAIN,
			'//' . SITE_DOMAIN,
			'\/\/' . SITE_DOMAIN,
		),
		array(
			TUNNEL_URL,
			TUNNEL_URL,
			'https:\/\/' . $tunnel_host,
			'https:\/\/' . $tunnel_host,
			'//' . $tunnel_host,
			'\/\/' . $tunnel_host,
		),
		$value
	);
}

add_filter( 'option_home', __NAMESPACE__ . '\\replace_urls', 999 );
add_filter( 'option_siteurl', __NAMESPACE__ . '\\replace_urls', 999 );
add_filter( 'home_url', __NAMESPACE__ . '\\replace_urls', 999 );
add_filter( 'site_url', __NAMESPACE__ . '\\replace_urls', 999 );
add_filter( 'content_url', __NAMESPACE__ . '\\replace_urls', 999 );
add_filter( 'plugins_url', __NAMESPACE__ . '\\replace_urls', 999 );
add_filter( 'wp_redirect', __NAMESPACE__ . '\\replace_urls', 999 );
add_filter( 'redirect_canonical', '__return_false' );

// Catch hardcoded URLs in post content, theme output and JSON responses.
ob_start( __NAMESPACE__ . '\\replace_urls' );
