import { lookup } from 'node:dns'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { isLoopback } from './config.ts'
import { HttpError } from './errors.ts'

const blocked = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) blocked.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  blocked.addSubnet(address, prefix, 'ipv6')
}
const publicV6 = new BlockList()
publicV6.addSubnet('2000::', 3, 'ipv6')

function isPublic(address: string) {
  const family = isIP(address)
  return family === 4 ? !blocked.check(address, 'ipv4')
    : family === 6 && publicV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
}

export function gatewayBaseUrl(raw: string, allowLoopback: boolean) {
  let url: URL
  try { url = new URL(raw) } catch { throw new HttpError(400, 'gateway_url') }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const local = allowLoopback && isLoopback(host)
  if (url.username || url.password || url.href.includes('?') || url.href.includes('#') ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && local)) ||
    !(local || (isIP(host) ? isPublic(host) : host.replace(/\.$/, '').includes('.')))) {
    throw new HttpError(400, 'gateway_url')
  }
  return url.href.replace(/\/+$/, '')
}

export function gatewayLookup(allowLoopback: boolean): LookupFunction {
  // Filter the addresses used by the socket, not a separate preflight DNS lookup.
  return (host, options, callback) => {
    lookup(host, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, '', 0)
      const local = allowLoopback && isLoopback(host)
      const accepted = addresses.filter(({ address }) => local ? isLoopback(address) : isPublic(address))
      if (!accepted.length) return callback(Object.assign(new Error('Gateway address blocked'), { code: 'ENOTFOUND' }), '', 0)
      if (options.all) return callback(null, accepted)
      callback(null, accepted[0].address, accepted[0].family)
    })
  }
}
