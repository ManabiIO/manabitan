import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
// Infrastructure-only negative control: no dictionary import or native timing.
if (process.argv[2] === 'payload') {
    globalThis.retainedPayload = Buffer.alloc(64 * 1024 * 1024, 0x5a);
    process.stdout.write(JSON.stringify({role: 'descendant', pid: process.pid, ppid: process.ppid, rss: process.memoryUsage().rss, allocatedBytes: globalThis.retainedPayload.byteLength}) + '\n');
    setTimeout(() => process.exit(0), 4000);
} else {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'payload'], {stdio: ['ignore', 'inherit', 'inherit']});
    process.stdout.write(JSON.stringify({role: 'leader', pid: process.pid, childPid: child.pid, rss: process.memoryUsage().rss}) + '\n');
    child.on('exit', () => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
}
