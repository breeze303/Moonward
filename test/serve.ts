import { startMock, startSite } from './support.ts'

const upstream = await startMock()
const site = await startSite(upstream.url, { staticFiles: true, port: Number(process.env.BROWSER_TEST_PORT || '4178') })
console.log(`Browser fixture ready on ${site.origin}`)
for (const name of ['SIGINT', 'SIGTERM'] as const) process.once(name, () => {
  void site.shutdown().then(() => upstream.close()).then(() => process.exit(0), () => process.exit(1))
})
