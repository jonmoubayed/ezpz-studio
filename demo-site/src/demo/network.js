// The public demo may read its own static assets and browser-local files only.
export function assertDemoRequest(input, options = {}, origin) {
  const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url
  const method = (options.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase()
  const url = new URL(raw, origin)
  const localFile = url.protocol === 'blob:' && url.origin === new URL(origin).origin
  const assetPath = !/%2f|%5c/i.test(url.pathname) && /\.(?:pdf|wasm|m?js|ts|tsx|css|woff2?|ttf|png|jpe?g|webp|svg|json)$/i.test(url.pathname)
  const staticAsset = assetPath && url.origin === new URL(origin).origin &&
    ['/studio/samples/', '/studio/vendor/', '/assets/', '/node_modules/', '/src/'].some(prefix => url.pathname.startsWith(prefix))
  if (method !== 'GET' || (!localFile && !staticAsset)) {
    throw new TypeError('This is a static demo. API and provider requests are disabled.')
  }
}

export function installDemoNetwork(target) {
  const originalFetch = target.fetch.bind(target)
  target.fetch = async (input, options) => {
    assertDemoRequest(input, options, target.location.origin)
    return originalFetch(input, options)
  }
  const originalOpen = target.XMLHttpRequest.prototype.open
  target.XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    assertDemoRequest(String(url), { method }, target.location.origin)
    return originalOpen.call(this, method, url, ...rest)
  }
  // The static demo has no streaming, telemetry, or socket transport.
  target.navigator.sendBeacon = () => false
  target.WebSocket = class { constructor() { throw new TypeError('Sockets are disabled in this static demo.') } }
  target.EventSource = class { constructor() { throw new TypeError('Streams are disabled in this static demo.') } }
}
