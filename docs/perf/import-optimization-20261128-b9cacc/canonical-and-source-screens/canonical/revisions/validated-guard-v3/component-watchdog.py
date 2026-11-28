"""Run one frozen canonical component stage with independent resource sampling."""
import argparse
import hashlib
import json
import os
import pathlib
import signal
import subprocess
import time
import traceback

parser=argparse.ArgumentParser()
parser.add_argument("mode", choices=["acquire","replay"])
parser.add_argument("registration", type=pathlib.Path)
parser.add_argument("registration_sha256")
parser.add_argument("output", type=pathlib.Path)
parser.add_argument("--guard-report", required=True, type=pathlib.Path)
args=parser.parse_args()
digest=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert digest(args.registration)==args.registration_sha256
reg=json.loads(args.registration.read_text())
assert args.output.resolve().is_relative_to(pathlib.Path(reg['temporaryRoot']).resolve()), 'Only our registered temporary root'
assert digest(pathlib.Path(__file__))==reg["watchdog"]["sha256"]
assert digest(pathlib.Path(reg["harness"]["path"]))==reg["harness"]["sha256"]
assert not args.guard_report.exists(), "Never overwrite a prior guard receipt"
args.guard_report.parent.mkdir(parents=True, exist_ok=True)
args.output.parent.mkdir(parents=True, exist_ok=True)

def available_bytes():
    for line in pathlib.Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):return int(line.split()[1])*1024
    raise RuntimeError("MemAvailable unavailable")

def cpu_ticks():
    numbers=list(map(int,pathlib.Path("/proc/stat").read_text().splitlines()[0].split()[1:9]))
    return {"total":sum(numbers),"idle":numbers[3]+numbers[4]}

def file_bytes():
    root=pathlib.Path(reg['temporaryRoot'])
    if not root.exists():return 0
    total=0
    for p in root.rglob('*'):
        try:
            if p.is_file():total+=p.stat().st_size
        except FileNotFoundError:pass # A finished child may remove its raw source file.
    return total

def read_process(pid):
    line=pathlib.Path(f'/proc/{pid}/stat').read_text()
    boundary=line.rfind(') ')
    if boundary<0 or int(line.split('(',1)[0])!=pid:raise RuntimeError('Malformed process identity')
    fields=line[boundary+2:].split()
    return {'pid':pid,'state':fields[0],'ppid':int(fields[1]),'pgrp':int(fields[2]),
            'session':int(fields[3]),'starttime':int(fields[19]),
            'rssBytes':max(0,int(fields[21]))*os.sysconf('SC_PAGE_SIZE')}

def visible_processes():
    result={}
    for entry in pathlib.Path('/proc').iterdir():
        if not entry.name.isdigit():continue
        pid=int(entry.name)
        try:result[pid]=read_process(pid)
        except FileNotFoundError:pass # Already exited before its atomic stat snapshot.
    return result

owner_identity=None
observed_identities={}
root_sample_count=0
def own_group(processes):
    if proc is None:return {}
    current=processes.get(proc.pid)
    if current is not None:
        if owner_identity is None or current['starttime']!=owner_identity['starttime']:
            raise RuntimeError('Launched PID identity changed; refusing to signal or sample it')
        if current['pgrp']!=proc.pid or current['session']!=proc.pid:
            raise RuntimeError('Launched process escaped its registered group/session')
    owned={pid:value for pid,value in processes.items() if value['pgrp']==proc.pid}
    descendants={proc.pid}
    while True:
        found={pid for pid,value in processes.items() if value['ppid'] in descendants}
        if found<=descendants:break
        descendants|=found
    for pid in descendants:
        if pid in processes:owned[pid]=processes[pid]
    for pid,value in owned.items():
        if value['pgrp']!=proc.pid or value['session']!=proc.pid:
            raise RuntimeError('Owned descendant is outside the registered process group; refusing an incomplete sample')
        if owner_identity is None or value['starttime']<owner_identity['starttime']:
            raise RuntimeError('Process group includes an unverified identity')
        previous=observed_identities.get(pid)
        if previous is not None and previous['starttime']!=value['starttime']:
            raise RuntimeError('Observed owned PID was reused')
        observed_identities[pid]={key:value[key] for key in ['pid','ppid','pgrp','session','starttime']}
    return owned

def process_tree():
    global root_sample_count
    processes=visible_processes()
    if proc.pid not in processes and proc.poll() is None:
        raise RuntimeError('Launched process is live but unreadable in the watchdog namespace')
    owned=own_group(processes)
    watchdog=processes.get(os.getpid())
    if watchdog is None:raise RuntimeError('Watchdog identity is unreadable')
    members={**owned,os.getpid():watchdog}
    if proc.pid in owned and owned[proc.pid]['rssBytes']>0:root_sample_count+=1
    return sum(value['rssBytes'] for value in members.values()),sorted(members),{str(pid):value['rssBytes'] for pid,value in members.items()}

report={"schemaVersion":1,"mode":args.mode,"status":"preflight","registrationSha256":args.registration_sha256,
        "harnessSha256":reg["harness"]["sha256"],"watchdogSha256":reg["watchdog"]["sha256"],
        "limits":reg["limits"],"sampleIntervalSeconds":0.05,
        "scope":"Atomic /proc stat RSS for explicit launched PID, all owned process-group members/descendants, and watchdog; host aggregate counters do not expose every other user's job",
        "samples":[]}
def persist():
    args.guard_report.write_text(json.dumps(report,indent=2)+"\n")

start_cpu=cpu_ticks()
start_wall=time.monotonic()
time.sleep(3)
end_cpu=cpu_ticks()
ticks=end_cpu["total"]-start_cpu["total"]
busy=1-(end_cpu["idle"]-start_cpu["idle"])/ticks
free=os.statvfs(args.output.parent)
report["preflight"]={"MemAvailableBytes":available_bytes(),"temporaryFilesystemFreeBytes":free.f_bavail*free.f_frsize,
    "retainedTemporaryBytes":file_bytes(),
    "aggregateCpuBusyFraction":busy,"cpuSampleSeconds":time.monotonic()-start_wall,
    "loadavg":pathlib.Path("/proc/loadavg").read_text().strip(),
    "affinity":sorted(os.sched_getaffinity(0)),"logicalCpuCount":os.cpu_count()}
for target,key in [("/proc/pressure/cpu","cpuPressure"),("/sys/fs/cgroup/cpu.max","cgroupCpuMax")]:
    try:report["preflight"][key]=pathlib.Path(target).read_text().strip()
    except (FileNotFoundError,PermissionError):report["preflight"][key]=None
failures=[]
if report["preflight"]["MemAvailableBytes"]<reg["limits"]["minimumAvailableBytes"]:failures.append("MemAvailable below registered threshold")
if report["preflight"]["temporaryFilesystemFreeBytes"]<reg["limits"]["minimumTemporaryFreeBytes"]:failures.append("Temporary filesystem space below threshold")
if report["preflight"]["retainedTemporaryBytes"]>reg["limits"]["maxTemporaryBytes"]:failures.append("Previously retained temporary bytes exceed combined cap")
if args.mode=="replay" and busy>reg["limits"]["maximumPreflightCpuBusyFraction"]:failures.append("Aggregate CPU preflight is not quiet")
if failures:
    report.update(status="preflight-blocked",failures=failures)
    persist()
    print(json.dumps({key:report[key] for key in ["status","failures","preflight"]}))
    raise SystemExit(2)

cmd=[reg["nodeExecutable"],reg["harness"]["path"],args.mode,str(args.registration.resolve()),
     args.registration_sha256,str(args.output.resolve())]
report["command"]=cmd
report["status"]="running"
persist()
env=os.environ.copy()
env["NODE_OPTIONS"]="--max-old-space-size=768"
env["NODE_DISABLE_COMPILE_CACHE"]="1"
env["MANABITAN_CANONICAL_PREEXISTING_BYTES"]=str(file_bytes())
log=args.guard_report.with_suffix(".child.log")
started=time.monotonic()
maximum_rss=0
maximum_bytes=file_bytes()
reason=None
proc=None
returncode=None
def terminate_owned(child):
    members=own_group(visible_processes())
    live={pid:value for pid,value in members.items() if value['state'] not in ['Z','X']}
    if not live:
        child.wait()
        return
    # Membership, session and starttime were checked immediately above. Never
    # send a signal to a PID or group outside this launched session.
    try:os.killpg(child.pid,signal.SIGTERM)
    except ProcessLookupError:pass
    deadline=time.monotonic()+5
    while time.monotonic()<deadline:
        child.poll()
        live={pid:value for pid,value in own_group(visible_processes()).items() if value['state'] not in ['Z','X']}
        if not live:break
        time.sleep(0.05)
    if live:
        try:os.killpg(child.pid,signal.SIGKILL)
        except ProcessLookupError:pass
    child.wait(timeout=5)
    if any(value['state'] not in ['Z','X'] for value in own_group(visible_processes()).values()):
        raise RuntimeError('Owned process group still has live members after cleanup')
def interrupted(signum,_frame):
    raise RuntimeError('Watchdog received signal '+str(signum))
signal.signal(signal.SIGTERM,interrupted)
try:
    with log.open("w") as stream:
        proc=subprocess.Popen(cmd,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True,env=env)
        owner_identity=read_process(proc.pid)
        if owner_identity['pgrp']!=proc.pid or owner_identity['session']!=proc.pid:
            raise RuntimeError('Popen did not create the requested private process group/session')
        namespaces={label:os.readlink(f'/proc/{pid}/ns/pid') for label,pid in [('watchdog',os.getpid()),('launched',proc.pid)]}
        if namespaces['watchdog']!=namespaces['launched']:raise RuntimeError('Child and watchdog have different visible PID namespaces')
        report['pidNamespaces']=namespaces
        report['launchedIdentity']=owner_identity
        report["ownedPid"]=proc.pid
        next_disk=0.0
        while proc.poll() is None:
            elapsed=time.monotonic()-started
            rss,pids,rss_by_pid=process_tree()
            maximum_rss=max(maximum_rss,rss)
            if elapsed>=next_disk:
                maximum_bytes=max(maximum_bytes,file_bytes())
                next_disk=elapsed+0.5
            available=available_bytes()
            report["samples"].append({"elapsedSeconds":elapsed,"rssBytes":rss,"rssByPid":rss_by_pid,"ownedPids":pids,"temporaryBytes":maximum_bytes,"MemAvailableBytes":available})
            if rss>reg["limits"]["maxRssBytes"]:reason="Sampled owned process RSS exceeded registered limit"
            elif available<reg["limits"]["minimumRuntimeAvailableBytes"]:reason="Shared-host available memory fell below registered runtime floor"
            elif maximum_bytes>reg["limits"]["maxTemporaryBytes"]:reason="Temporary bytes exceeded registered limit"
            elif elapsed>reg["limits"]["timeoutSeconds"]:reason="Registered stage timeout"
            if reason:break
            time.sleep(0.05)
        if reason:terminate_owned(proc)
        returncode=proc.wait()
except BaseException as error:
    reason=reason or 'Watchdog exception: '+type(error).__name__+': '+str(error)
    report['watchdogException']=traceback.format_exc()
finally:
    if proc is not None:
        try:
            terminate_owned(proc)
            returncode=proc.wait()
        except BaseException as error:
            reason=reason or 'Owned process cleanup failed: '+type(error).__name__+': '+str(error)
            report['cleanupException']=traceback.format_exc()
        report['observedProcessIdentities']=list(observed_identities.values())
        report['positiveLaunchedRssSamples']=root_sample_count
        if root_sample_count==0:reason=reason or 'Launched process had no verified positive RSS sample'
    try:
        final_bytes=file_bytes()
        maximum_bytes=max(maximum_bytes,final_bytes)
        report['finalTemporaryBytes']=final_bytes
        if maximum_bytes>reg['limits']['maxTemporaryBytes']:
            reason=reason or 'Final combined temporary bytes exceeded registered limit'
        report['finalMemAvailableBytes']=available_bytes()
    except BaseException as error:
        reason=reason or 'Final resource check failed: '+type(error).__name__+': '+str(error)
report.update(status="completed" if returncode==0 and reason is None else "failed",
    exitCode=returncode,guardFailure=reason,elapsedSeconds=time.monotonic()-started,
    maxSampledRssBytes=maximum_rss,maxTemporaryBytes=maximum_bytes,
    childLog=str(log),stageValid=returncode==0 and reason is None)
persist()
print(json.dumps({key:report[key] for key in ["status","exitCode","guardFailure","elapsedSeconds","maxSampledRssBytes","maxTemporaryBytes"]}))
raise SystemExit(0 if report["status"]=="completed" else 1)
