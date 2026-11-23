# Live sibling address-space observer candidate

This is a separate observer revision. It does not modify or reclassify any prior study or receipt. Its rule is `stable-zombie-leader-live-sibling-smaps-v1` and its receipt schema is version 3. Source and tests are frozen before new hosted measurements.

## Recovery contract

The normal leader `smaps_rollup` read remains the first and only primary attempt. Recovery is eligible only when it returns `ESRCH`, the leader is `Z`, its exact integer thread count is greater than one, and its missing executable has an explicit `ENOENT` with no other metadata read error.

The observer enumerates `/proc/PID/task` twice around one sibling read. Both complete inventories must be readable; each directory TID must match `stat` and `status`, each `Tgid` must equal the original PID, and every thread count must match the global leader count. Membership, TIDs, start times, parentage and counts must agree between inventories. The leader task must match the original leader identity and remain `Z`. Raw task `stat` and `status` text is retained in each inventory.

The lowest live nonleader TID from the first inventory is the only representative. Its `/proc/PID/task/TID/smaps_rollup` is read once with ordinary permissions. There is no retry or alternate-thread search. Both its `stat` and `status` states must be live before and after the read. Normal live scheduling transitions such as `R` to `S` do not change identity. Unknown, zombie and dead states cannot represent a live address space.

After the ordinary global process scan finishes, the leader must still have the same PID, start time, parentage, state, thread count, executable, command name, arguments and role. A successful sibling value enters the measured process list once, under the leader PID. The TID is never an additional process. The original failed leader read remains in `unavailableProcesses`; all task inventories, errors, selected path, read count and the final global confirmation remain in `addressSpaceRecoveryAttempts`.

The prior `confirmed_exited_zombie` predicate is byte-for-byte unchanged. It still excludes only a confirmed single-thread zombie and never supplies an invented PSS value. Browser plus renderer coverage, the existing global-tree stability test, permission handling and normal memory reads remain required.

## Failure scope

Every failed recovery proof rejects its sample and excludes its attempted memory value. A stable tree with an unreadable address space invalidates the entire observation. Any secondary permission error, parse error, malformed task membership or wrong TGID also invalidates the observation even if the global tree changed; the original primary `ESRCH` cannot hide a secondary denial.

An ordinary `ESRCH`/`ENOENT` disappearance or identity change during a globally changed scan rejects that sample but does not retroactively reject otherwise qualified samples. This preserves the previous observer's distinction between normal exit and denied or incomplete stable coverage. All rejected samples remain in the receipt. A failed observation has null reported PSS/private maxima.

## Linux basis and practical limit

Linux thread groups share an address space: `CLONE_THREAD` requires `CLONE_SIGHAND`, which requires `CLONE_VM`. A thread group also shares parentage. The selected task is therefore a representative of the process address space, not an additional address space to sum. See the primary [clone(2) documentation](https://man7.org/linux/man-pages/man2/clone.2.html).

[`pthread_exit(3)`](https://man7.org/linux/man-pages/man3/pthread_exit.3.html) terminates the calling thread while other threads may continue. [`proc_pid_status(5)`](https://man7.org/linux/man-pages/man5/proc_pid_status.5.html) defines Tgid, Pid and Threads. The kernel's [proc documentation](https://docs.kernel.org/filesystems/proc.html) describes `smaps_rollup` as a sum over the process mappings. The pinned kernel implementation's [`smaps_rollup_open` and `show_smaps_rollup`](https://kernel.googlesource.com/pub/scm/linux/kernel/git/torvalds/linux/+/141b164bbe186423e295b139e40e8e2d11cf1341/fs/proc/task_mmu.c) acquire the selected task's memory context and can report `ESRCH` when it is absent. These sources support the address-space interpretation; the local C witness establishes the observed task-path behavior on this host.

The [`proc_pid_task(5)` documentation](https://man7.org/linux/man-pages/man5/proc_pid_task.5.html) warns that task-directory contents may be unavailable after the main thread terminates. This implementation does not assume availability: it requires two successful complete inventories and otherwise fails closed. No permissions, mount options, process state or privileges are changed to obtain a measurement.

These are non-atomic observations. Start-time ticks and before/after membership checks detect ordinary identity reuse and churn; they cannot prove that nothing changed between reads or capture a true peak. This revision does not establish a performance or memory result for any Manabitan candidate.

## Tests and reproduction

Run with Python 3 and a C compiler supporting pthreads, as the ordinary user on Linux:

```sh
python3 -m unittest -v test_chromium_memory test_sibling_recovery
python3 -m py_compile chromium_memory.py test_chromium_memory.py test_sibling_recovery.py
```

The real C process tree includes rewritten browser/renderer titles and an arbitrarily named descendant. One case leaves an unreaped single-thread child. Another creates a surviving pthread, touches an 8 MiB private mapping, then calls `pthread_exit` in the leader. The latter must retain the leader's failed read, recover the sibling's mapping with two stable task identities, and sum it exactly once. The test prints the complete live recovery proof as JSON and cleans up its process group.

The adversarial tests cover deterministic representative selection, no retry, exact aggregation, primary eligibility, missing tasks, task replacement and start-time reuse, wrong TGID and parentage, mismatched counts, leader changes, lost global identities, absent or denied executable reads, directory/stat/status/smaps failures, malformed records and units, ordinary live state transitions, and the sample-versus-observation failure distinction. The previous single-thread exemption's counterexamples and denied-descendant test remain included.

`base-identity.json` identifies the copied files. `primary-sources.json` records the reviewed primary references. `validation.json` pins the tested files and retained test logs; `freeze-manifest.json` lists every frozen deliverable. No Chromium process or dictionary import was launched for this qualification.
