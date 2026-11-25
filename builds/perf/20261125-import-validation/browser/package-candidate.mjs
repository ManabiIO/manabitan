import path from 'node:path'
import fs from 'node:fs/promises'
import {build} from './candidate/dev/bin/build.js'
import {ManifestUtil} from './candidate/dev/manifest-util.js'
const root = path.dirname(new URL(import.meta.url).pathname)
const candidate = path.join(root, 'candidate')
const manifest = new ManifestUtil()
const manifestPath = path.join(candidate, 'ext/manifest.json')
try {
    await build(path.join(candidate, 'builds'), path.join(candidate, 'ext'), manifest, ['chrome'], manifestPath, false, false, '0.0.0.0')
} finally {
    await fs.writeFile(manifestPath, ManifestUtil.createManifestString(manifest.getManifest(null)).replace('$YOMITAN_VERSION', '0.0.0.0'))
}
