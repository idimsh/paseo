// Modified in idimsh/paseo: PC-2
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { execCommand } from "../utils/spawn.js";
import {
  createSystemManagedProcessTable,
  type LinuxProcReader,
  linuxProcessIdentity,
  type ManagedProcessCommandRunner,
  type ManagedProcessInspection,
  parseLinuxProcStat,
  systemLinuxProcReader,
  windowsPowerShellPath,
} from "../server/managed-processes/managed-processes.js";

// Process inspection for terminal worker ownership. Birth times are compared as strings, so
// every reader must produce them the same way. On Linux both readers use
// `linuxProcessIdentity` (start ticks plus boot ID). Elsewhere they compare what
// `ps -o lstart` and Win32_Process.CreationDate print: `ps` follows LC_TIME, and the worker,
// the daemon, the supervisor and the CLI can run under different locales, so every `ps` here
// runs under LC_ALL=C.

const PS_TIMEOUT_MS = 15_000;
const POSIX_LSTART_WIDTH = 24;

export interface ProcessTableEntry {
  pid: number;
  ppid: number;
  startedAt: string;
  // POSIX session id where the platform reports one (Linux, from /proc). macOS has none.
  sessionId: number | null;
}

export interface TerminalWorkerProcessInspector {
  /** True where the process table names each process's session (Linux). */
  readonly reportsSessions: boolean;
  inspect(pid: number): Promise<ManagedProcessInspection>;
  /** One snapshot of every process, for walking descendants. Throws when it cannot be read. */
  listProcesses(): Promise<ProcessTableEntry[]>;
  /**
   * The environment a process was started with, as NAME=value entries; null when the process
   * is gone. Throws when it cannot be read. Only called where `reportsSessions` is true.
   */
  readEnvironment(pid: number): Promise<string[] | null>;
}

const WindowsProcessListSchema = z.array(
  z.object({
    ProcessId: z.number().int(),
    ParentProcessId: z.number().int().nullable().optional(),
    CreationDate: z.string().nullable().optional(),
  }),
);

function createLocaleNeutralCommandRunner(): ManagedProcessCommandRunner {
  return {
    exec: (command, args) =>
      execCommand(command, args, {
        envMode: "internal",
        envOverlay: { LC_ALL: "C" },
        timeout: PS_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      }).then(({ stdout, stderr }) => ({ stdout: String(stdout), stderr: String(stderr) })),
  };
}

export function createTerminalWorkerProcessInspector(
  options: {
    platform?: NodeJS.Platform;
    commandRunner?: ManagedProcessCommandRunner;
    linuxProc?: LinuxProcReader;
  } = {},
): TerminalWorkerProcessInspector {
  const platform = options.platform ?? process.platform;
  const commandRunner = options.commandRunner ?? createLocaleNeutralCommandRunner();
  const linuxProc = options.linuxProc ?? systemLinuxProcReader;
  const table = createSystemManagedProcessTable({ platform, commandRunner, linuxProc });
  return {
    reportsSessions: platform === "linux",
    inspect: (pid) => table.inspect(pid),
    listProcesses: () => {
      if (platform === "win32") return listWindowsProcesses(commandRunner);
      if (platform === "linux") return listLinuxProcesses(linuxProc);
      return listPosixProcesses(commandRunner);
    },
    readEnvironment: (pid) => readLinuxEnvironment(platform, pid),
  };
}

async function readLinuxEnvironment(
  platform: NodeJS.Platform,
  pid: number,
): Promise<string[] | null> {
  if (platform !== "linux") {
    throw new Error(`reading a process environment is not supported on ${platform}`);
  }
  let raw: string;
  try {
    raw = await readFile(`/proc/${pid}/environ`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return raw.split("\0").filter((entry) => entry.length > 0);
}

const PROC_STAT_READ_BATCH = 64;

async function listLinuxProcesses(linuxProc: LinuxProcReader): Promise<ProcessTableEntry[]> {
  const bootId = linuxProc.bootId();
  const pids = await linuxProc.listPids();
  const entries: ProcessTableEntry[] = [];
  for (let start = 0; start < pids.length; start += PROC_STAT_READ_BATCH) {
    const batch = pids.slice(start, start + PROC_STAT_READ_BATCH);
    // A process that exits before its read, or whose stat cannot be read, is left out, as
    // `ps -A` leaves out what it cannot see; one unreadable pid must not hide the whole table.
    const stats = await Promise.all(batch.map((pid) => linuxProc.readStat(pid).catch(() => null)));
    for (const [index, stat] of stats.entries()) {
      const parsed = stat === null ? null : parseLinuxProcStat(stat);
      if (!parsed) continue;
      entries.push({
        pid: batch[index]!,
        ppid: parsed.ppid,
        sessionId: parsed.sessionId,
        startedAt: linuxProcessIdentity(parsed.startTicks, bootId),
      });
    }
  }
  if (entries.length === 0) {
    throw new Error("/proc listed no processes");
  }
  return entries;
}

/** Non-Linux POSIX (macOS): `ps` has no session column there. */
async function listPosixProcesses(
  commandRunner: ManagedProcessCommandRunner,
): Promise<ProcessTableEntry[]> {
  const { stdout } = await commandRunner.exec("ps", [
    "-A",
    "-ww",
    "-o",
    "pid=",
    "-o",
    "ppid=",
    "-o",
    "lstart=",
  ]);
  const entries: ProcessTableEntry[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    entries.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      sessionId: null,
      startedAt: match[3].slice(0, POSIX_LSTART_WIDTH).trim(),
    });
  }
  if (entries.length === 0) {
    throw new Error("ps returned no processes");
  }
  return entries;
}

async function listWindowsProcesses(
  commandRunner: ManagedProcessCommandRunner,
): Promise<ProcessTableEntry[]> {
  const command =
    "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate) | ConvertTo-Json -Compress";
  const { stdout } = await commandRunner.exec(windowsPowerShellPath(), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    command,
  ]);
  const parsed: unknown = JSON.parse(stdout.trim());
  const rows = WindowsProcessListSchema.parse(Array.isArray(parsed) ? parsed : [parsed]);
  return rows.flatMap((row) =>
    row.CreationDate
      ? [
          {
            pid: row.ProcessId,
            ppid: row.ParentProcessId ?? 0,
            startedAt: row.CreationDate,
            sessionId: null,
          },
        ]
      : [],
  );
}

/**
 * Every process below `rootPid` in the snapshot, plus (where the platform reports sessions)
 * every member of the session `rootPid` led and everything below those members. A PTY program
 * is a session leader, and the kernel keeps its pid reserved as the session id while any member
 * lives, so the session still names a HUP-ignoring job after the shell exits and the job is
 * reparented.
 */
export function collectDescendants(
  snapshot: ProcessTableEntry[],
  rootPid: number,
): ProcessTableEntry[] {
  const childrenByParent = new Map<number, ProcessTableEntry[]>();
  for (const entry of snapshot) {
    const siblings = childrenByParent.get(entry.ppid) ?? [];
    siblings.push(entry);
    childrenByParent.set(entry.ppid, siblings);
  }
  const found = new Map<number, ProcessTableEntry>();
  const queue = [rootPid];
  for (const entry of snapshot) {
    if (entry.sessionId === rootPid && entry.pid !== rootPid) {
      found.set(entry.pid, entry);
      queue.push(entry.pid);
    }
  }
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of childrenByParent.get(parent) ?? []) {
      if (child.pid === rootPid || found.has(child.pid)) continue;
      found.set(child.pid, child);
      queue.push(child.pid);
    }
  }
  return Array.from(found.values());
}
