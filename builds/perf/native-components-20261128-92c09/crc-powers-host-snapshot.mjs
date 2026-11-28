import {readFileSync, readdirSync} from 'node:fs'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

const baseline = path.resolve(process.env.MANABITAN_CRC_BASELINE_ROOT ?? 'baseline')
const {getHostEnvironment} = await import(pathToFileURL(path.join(baseline, 'dev/perf/host-environment.js')))

function readOptional(path) {
  try { return readFileSync(path, 'utf8').trim() } catch { return null }
}

export function hostSnapshot() {
  const visibleProcesses = []
  for (const pid of readdirSync('/proc').filter((entry) => /^\d+$/.test(entry))) {
    const command = readOptional(`/proc/${pid}/cmdline`)
    if (command !== null && command !== '') visibleProcesses.push({pid: Number(pid), command: command.replaceAll('\0', ' ').slice(0, 400)})
  }
  return {...getHostEnvironment(), memoryUsage: process.memoryUsage(),
    cpuPressure: readOptional('/proc/pressure/cpu'), memoryPressure: readOptional('/proc/pressure/memory'),
    procLoadAverage: readOptional('/proc/loadavg'), visibleProcesses,
    processVisibility: 'Only this exec PID namespace is visible; other host sessions may still contend for CPU or memory.'}
}
