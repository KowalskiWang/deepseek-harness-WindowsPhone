// Network layer over the platform HTTP client, with optional routing of HTTPS
// requests through a DSH LAN gateway.
//
// Windows Phone 8.1's TLS stack (Windows 8.1 schannel) cannot negotiate the
// ECDHE-RSA-AES-GCM suites that api.deepseek.com and most modern sites require,
// so on that OS every https:// request is relayed by the gateway running on a
// computer in the same Wi-Fi network:  https://host/path  →
//   http://<gateway>/x/<base64url(origin)>/path
import { parseUrl, joinUrl, base64UrlEncodeString } from './util.js'

export function gatewayUrlFor(gatewayBase, url) {
  const u = parseUrl(url)
  return joinUrl(gatewayBase, 'x/' + base64UrlEncodeString(u.origin) + u.pathname + u.search)
}

/**
 * @param http         platform client: request(opts) -> {status, headers, text}
 * @param getGateway   () => {url, code, route: 'off'|'https'} | null
 */
export function createNet(http, getGateway) {
  function routed(opts) {
    const gw = getGateway ? getGateway() : null
    const u = parseUrl(opts.url)
    if (!gw || !gw.url || gw.route === 'off' || !u || u.protocol !== 'https') return opts
    const headers = Object.assign({}, opts.headers)
    if (gw.code) headers['x-dsh-gateway-code'] = gw.code
    return Object.assign({}, opts, { url: gatewayUrlFor(gw.url, opts.url), headers, viaGateway: true })
  }
  return {
    request(opts) { return http.request(routed(opts)) },
    /** Fetch helper for tools: GET with text body. */
    get(url, opts) { return http.request(routed(Object.assign({ method: 'GET', url }, opts || {}))) },
    gateway() { return getGateway ? getGateway() : null },
    raw: http,
  }
}
