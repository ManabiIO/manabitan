import {chromium} from 'playwright'
import http from 'node:http'
import {readFile, writeFile} from 'node:fs/promises'
const server = http.createServer((_req, res) => {
    res.writeHead(200, {'Content-Type': 'text/html', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp'})
    res.end('<!doctype html><title>Runtime preflight</title>')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
let browser
try {
    browser = await chromium.launch({channel: 'chromium', headless: true, args: ['--no-sandbox']})
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    const runtime = await page.evaluate(async () => {
        const worker = new Worker(URL.createObjectURL(new Blob(['postMessage({deviceMemory:navigator.deviceMemory,cores:navigator.hardwareConcurrency})'], {type: 'text/javascript'})))
        const workerRuntime = await new Promise((resolve, reject) => { worker.onmessage = ({data}) => resolve(data); worker.onerror = reject })
        worker.terminate()
        return {pageMemory: navigator.deviceMemory, worker: workerRuntime, crossOriginIsolated, userAgent: navigator.userAgent}
    })
    runtime.cgroupMemoryMax = await readFile('/sys/fs/cgroup/memory.max', 'utf8').catch(() => null)
    runtime.browserVersion = browser.version()
    runtime.nativeLowMemory = runtime.pageMemory > 0 && runtime.pageMemory <= 4 && runtime.worker.deviceMemory > 0 && runtime.worker.deviceMemory <= 4
    await writeFile(process.argv[2], JSON.stringify(runtime, null, 2))
    console.log(JSON.stringify(runtime))
} finally {
    await browser?.close()
    server.close()
}
