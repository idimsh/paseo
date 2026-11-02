// Modified in idimsh/paseo: PC-2
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { execCommand } from "../../utils/spawn.js";
import type { ProcessTerminator, TreeKillTarget } from "../../utils/tree-kill.js";
import { currentBootId } from "../pid-lock.js";

/**
 * Windows PowerShell by its install path. Process identity must not depend on the caller's
 * PATH: a daemon or terminal worker can run with a PATH that does not reach System32.
 */
export function windowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(
    env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

const MANAGED_PROCESS_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;
const MANAGED_PROCESS_FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;
const MANAGED_PROCESS_EXIT_POLL_INTERVAL_MS = 50;
const MANAGED_PROCESS_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
// `ps -o lstart` emits a fixed-width 24-char ctime stamp, e.g. "Sat Jun 20 10:30:40 2026".
const POSIX_LSTART_WIDTH = 24;

const ManagedProcessRecordSchema = z.object({
  id: z.string().min(1),
  owner: z.object({
    provider: z.string().min(1),
    kind: z.string().min(1),
  }),
  pid: z.number().int().positive(),
  command: z.string().min(1),
  args: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()).default({}),
  identity: z.object({
    commandLine: z.string().nullable(),
    startedAt: z.string().nullable(),
  }),
  createdAt: z.string().min(1),
});

const WindowsProcessSnapshotSchema = z.object({
  ProcessId: z.number().int().positive(),
  CommandLine: z.string().nullable().optional(),
  CreationDate: z.string().nullable().optional(),
});

export interface ManagedProcessSnapshot {
  pid: number;
  commandLine: string | null;
  startedAt: string | null;
  /** Linux: what `ps -o lstart` printed, matched against records written before PC-2. */
  legacyStartedAt?: string | null;
}

export type ManagedProcessInspection =
  | { status: "alive"; snapshot: ManagedProcessSnapshot }
  | { status: "not-found" }
  | { status: "error"; error: unknown };

export interface ManagedProcessTable {
  inspect(pid: number): Promise<ManagedProcessInspection>;
}

export interface ManagedProcessCommandRunner {
  exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

export interface ManagedProcessOwner {
  provider: string;
  kind: string;
}

export interface ManagedProcessRecordInput {
  owner: ManagedProcessOwner;
  pid: number;
  command: string;
  args: string[];
  metadata?: Record<string, unknown>;
}

export interface ManagedProcessRecord extends ManagedProcessRecordInput {
  id: string;
  metadata: Record<string, unknown>;
  identity: {
    commandLine: string | null;
    startedAt: string | null;
  };
  createdAt: string;
}

export interface ManagedProcessReapResult {
  checked: number;
  dead: number;
  mismatched: number;
  removed: number;
  terminated: number;
  errors: Array<{ id: string; message: string }>;
}

export interface ManagedProcessRegistry {
  record(input: ManagedProcessRecordInput): Promise<ManagedProcessRecord>;
  remove(id: string): Promise<void>;
  list(): Promise<ManagedProcessRecord[]>;
  reapStale(): Promise<ManagedProcessReapResult>;
}

interface ManagedProcessRegistryOptions {
  paseoHome: string;
  processTable: ManagedProcessTable;
  terminateProcess: ProcessTerminator;
  logger: Logger;
}

export function createManagedProcessRegistry(
  options: ManagedProcessRegistryOptions,
): ManagedProcessRegistry {
  return new FileBackedManagedProcessRegistry(options);
}

/** Fields of `/proc/<pid>/stat` that process identity and the process table use. */
export interface LinuxProcStat {
  ppid: number;
  sessionId: number;
  startTicks: string;
}

export interface LinuxProcReader {
  bootId(): string | null;
  /** The contents of `/proc/<pid>/stat`; null when the process is gone. */
  readStat(pid: number): Promise<string | null>;
  listPids(): Promise<number[]>;
}

export const systemLinuxProcReader: LinuxProcReader = {
  bootId: currentBootId,
  async readStat(pid) {
    try {
      return await fs.readFile(`/proc/${pid}/stat`, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") return null;
      throw error;
    }
  },
  async listPids() {
    return (await fs.readdir("/proc")).filter((name) => /^\d+$/.test(name)).map(Number);
  },
};

/**
 * Parses `/proc/<pid>/stat`. The command name (field 2) may hold spaces and ")", so fields are
 * counted from the last ")": field n sits at index n - 3 of what follows it.
 */
export function parseLinuxProcStat(stat: string): LinuxProcStat | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ppid = fields[1];
  const sessionId = fields[3];
  const startTicks = fields[19];
  if (![ppid, sessionId, startTicks].every((field) => field !== undefined && /^\d+$/.test(field)))
    return null;
  return { ppid: Number(ppid), sessionId: Number(sessionId), startTicks: startTicks! };
}

/**
 * Linux process birth identity: start time in clock ticks since boot (stat field 22), scoped by
 * the boot ID. It is fixed for the process's lifetime. `ps -o lstart` is not: it adds the ticks
 * to the wall-clock boot instant, which drifts on WSL2, so a live worker read as a stranger.
 */
export function linuxProcessIdentity(startTicks: string, bootId: string | null): string {
  return `${LINUX_IDENTITY_PREFIX}${bootId ?? "unknown-boot"}:${startTicks}`;
}

const LINUX_IDENTITY_PREFIX = "linux-start:";

/**
 * Whether a recorded birth time names this process. A record written before PC-2 holds the
 * `ps -o lstart` string; it is matched against that string, with its old drift limit, so a
 * worker or helper started by an older build is still adopted or stopped instead of leaked.
 */
export function birthTimeMatches(
  recorded: string,
  snapshot: Pick<ManagedProcessSnapshot, "startedAt" | "legacyStartedAt">,
): boolean {
  if (snapshot.legacyStartedAt && !recorded.startsWith(LINUX_IDENTITY_PREFIX)) {
    return recorded === snapshot.legacyStartedAt;
  }
  return recorded === snapshot.startedAt;
}

export function createSystemManagedProcessTable(options?: {
  platform?: NodeJS.Platform;
  commandRunner?: ManagedProcessCommandRunner;
  linuxProc?: LinuxProcReader;
}): ManagedProcessTable {
  return new SystemManagedProcessTable({
    platform: options?.platform ?? process.platform,
    commandRunner: options?.commandRunner ?? {
      exec: execCommand,
    },
    linuxProc: options?.linuxProc ?? systemLinuxProcReader,
  });
}

class SystemManagedProcessTable implements ManagedProcessTable {
  private readonly platform: NodeJS.Platform;
  private readonly commandRunner: ManagedProcessCommandRunner;
  private readonly linuxProc: LinuxProcReader;

  constructor(options: {
    platform: NodeJS.Platform;
    commandRunner: ManagedProcessCommandRunner;
    linuxProc: LinuxProcReader;
  }) {
    this.platform = options.platform;
    this.commandRunner = options.commandRunner;
    this.linuxProc = options.linuxProc;
  }

  async inspect(pid: number): Promise<ManagedProcessInspection> {
    if (!Number.isInteger(pid) || pid <= 0) {
      return { status: "not-found" };
    }

    try {
      return this.platform === "win32"
        ? await this.inspectWindows(pid)
        : await this.inspectPosix(pid);
    } catch (error) {
      return { status: "error", error };
    }
  }

  private async inspectPosix(pid: number): Promise<ManagedProcessInspection> {
    let stdout: string;
    try {
      ({ stdout } = await this.commandRunner.exec("ps", [
        "-ww",
        "-p",
        String(pid),
        "-o",
        "lstart=",
        "-o",
        "command=",
      ]));
    } catch (error) {
      // `ps -p <pid>` exits non-zero when no process matches the pid; a numeric
      // exit code means ps ran and found nothing, distinct from ps failing to run.
      return isCommandExitFailure(error) ? { status: "not-found" } : { status: "error", error };
    }

    const line = stdout.trimEnd();
    if (!line) {
      return { status: "not-found" };
    }

    const lstart = line.slice(0, POSIX_LSTART_WIDTH).trim();
    const commandLine = line.slice(POSIX_LSTART_WIDTH).trim();
    if (this.platform === "linux") {
      const stat = await this.linuxProc.readStat(pid);
      if (stat === null) return { status: "not-found" };
      const parsed = parseLinuxProcStat(stat);
      if (!parsed) return { status: "error", error: new Error(`Unreadable /proc/${pid}/stat`) };
      return {
        status: "alive",
        snapshot: {
          pid,
          commandLine: commandLine || null,
          startedAt: linuxProcessIdentity(parsed.startTicks, this.linuxProc.bootId()),
          legacyStartedAt: lstart || null,
        },
      };
    }
    return {
      status: "alive",
      snapshot: {
        pid,
        commandLine: commandLine || null,
        startedAt: lstart || null,
      },
    };
  }

  private async inspectWindows(pid: number): Promise<ManagedProcessInspection> {
    const command = [
      `$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';`,
      "if ($process) { $process | Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress }",
    ].join(" ");
    const { stdout } = await this.commandRunner.exec(windowsPowerShellPath(), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command,
    ]);
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { status: "not-found" };
    }

    const parsed = WindowsProcessSnapshotSchema.parse(JSON.parse(trimmed));
    return {
      status: "alive",
      snapshot: {
        pid,
        commandLine: parsed.CommandLine ?? null,
        startedAt: parsed.CreationDate ?? null,
      },
    };
  }
}

class FileBackedManagedProcessRegistry implements ManagedProcessRegistry {
  private readonly directory: string;
  private readonly processTable: ManagedProcessTable;
  private readonly terminateProcess: ProcessTerminator;
  private readonly logger: Logger;

  constructor(options: ManagedProcessRegistryOptions) {
    this.directory = path.join(options.paseoHome, "runtime", "managed-processes");
    this.processTable = options.processTable;
    this.terminateProcess = options.terminateProcess;
    this.logger = options.logger.child({ module: "managed-processes" });
  }

  async record(input: ManagedProcessRecordInput): Promise<ManagedProcessRecord> {
    const inspection = await this.processTable.inspect(input.pid);
    const snapshot = inspection.status === "alive" ? inspection.snapshot : null;
    const record: ManagedProcessRecord = {
      id: randomUUID(),
      owner: input.owner,
      pid: input.pid,
      command: input.command,
      args: input.args,
      metadata: input.metadata ?? {},
      identity: {
        commandLine: snapshot?.commandLine ?? null,
        startedAt: snapshot?.startedAt ?? null,
      },
      createdAt: new Date().toISOString(),
    };

    await writeJsonFileAtomic(this.recordPath(record.id), record);
    return record;
  }

  async remove(id: string): Promise<void> {
    await fs.rm(this.recordPath(id), { force: true });
  }

  async list(): Promise<ManagedProcessRecord[]> {
    const entries = await this.readEntries();
    return entries.map((entry) => entry.record);
  }

  async reapStale(): Promise<ManagedProcessReapResult> {
    const result: ManagedProcessReapResult = {
      checked: 0,
      dead: 0,
      mismatched: 0,
      removed: 0,
      terminated: 0,
      errors: [],
    };

    for (const entry of await this.readEntries()) {
      result.checked += 1;
      try {
        const inspection = await this.processTable.inspect(entry.record.pid);
        if (inspection.status === "not-found") {
          await fs.rm(entry.path, { force: true });
          result.dead += 1;
          result.removed += 1;
          continue;
        }

        if (inspection.status === "error") {
          // Inspection failed, so we cannot tell whether the helper is still
          // alive. Keep the record and retry on the next reconcile rather than
          // orphaning a live process by deleting its record without killing it.
          const message =
            inspection.error instanceof Error ? inspection.error.message : String(inspection.error);
          result.errors.push({ id: entry.record.id, message });
          this.logger.warn(
            {
              err: inspection.error,
              id: entry.record.id,
              pid: entry.record.pid,
              owner: entry.record.owner,
            },
            "Could not inspect managed helper process; leaving record for next reconcile",
          );
          continue;
        }

        const snapshot = inspection.snapshot;
        if (!processIdentityMatches(entry.record, snapshot)) {
          await fs.rm(entry.path, { force: true });
          result.mismatched += 1;
          result.removed += 1;
          continue;
        }

        await this.terminateProcess(createPidTarget(entry.record.pid), {
          gracefulTimeoutMs: MANAGED_PROCESS_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
          forceTimeoutMs: MANAGED_PROCESS_FORCE_SHUTDOWN_TIMEOUT_MS,
          onForceSignal: () => {
            this.logger.warn(
              {
                pid: entry.record.pid,
                owner: entry.record.owner,
                timeoutMs: MANAGED_PROCESS_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
              },
              "Managed helper process did not exit after SIGTERM; sending SIGKILL",
            );
          },
        });
        await fs.rm(entry.path, { force: true });
        result.terminated += 1;
        result.removed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push({ id: entry.record.id, message });
        this.logger.warn(
          { err: error, id: entry.record.id, pid: entry.record.pid, owner: entry.record.owner },
          "Failed to reap managed helper process",
        );
      }
    }

    return result;
  }

  private recordPath(id: string): string {
    if (!MANAGED_PROCESS_ID_PATTERN.test(id)) {
      throw new Error(`Invalid managed process record id: ${id}`);
    }
    return path.join(this.directory, `${id}.json`);
  }

  private async readEntries(): Promise<Array<{ path: string; record: ManagedProcessRecord }>> {
    let fileNames: string[];
    try {
      fileNames = await fs.readdir(this.directory);
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    }

    const entries: Array<{ path: string; record: ManagedProcessRecord }> = [];
    for (const fileName of fileNames) {
      if (!fileName.endsWith(".json")) {
        continue;
      }
      const filePath = path.join(this.directory, fileName);
      try {
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = ManagedProcessRecordSchema.parse(JSON.parse(raw));
        entries.push({ path: filePath, record: parsed });
      } catch (error) {
        // A single corrupt or partially-written record must not abort the whole
        // reconcile and leave every other leftover un-reaped. Skip it.
        this.logger.warn(
          { err: error, file: fileName },
          "Skipping unreadable managed process record",
        );
      }
    }
    return entries;
  }
}

function processIdentityMatches(
  record: ManagedProcessRecord,
  snapshot: ManagedProcessSnapshot,
): boolean {
  if (record.identity.startedAt && snapshot.startedAt) {
    if (!birthTimeMatches(record.identity.startedAt, snapshot)) {
      return false;
    }
    return snapshot.commandLine ? commandLineMatchesRecord(record, snapshot.commandLine) : true;
  }

  if (record.identity.commandLine && snapshot.commandLine) {
    return (
      normalizeCommandLine(record.identity.commandLine) ===
      normalizeCommandLine(snapshot.commandLine)
    );
  }

  return snapshot.commandLine ? commandLineMatchesRecord(record, snapshot.commandLine) : false;
}

function commandLineMatchesRecord(record: ManagedProcessRecord, commandLine: string): boolean {
  // Require the command name and args as one contiguous run, not scattered
  // tokens. Without exact process identity (lstart), a reused PID whose command
  // line merely mentions "opencode", "serve" and the port elsewhere must not be
  // mistaken for our leftover and killed.
  const normalized = normalizeCommandLine(commandLine);
  const commandName = path.basename(record.command).toLowerCase();
  const signature = [commandName, ...record.args].map((token) => token.toLowerCase()).join(" ");
  return normalized.includes(signature);
}

function normalizeCommandLine(commandLine: string): string {
  return commandLine.replace(/\s+/g, " ").trim().toLowerCase();
}

export function createPidTarget(pid: number): TreeKillTarget {
  return {
    pid,
    exitCode: null,
    signalCode: null,
    kill(signal?: NodeJS.Signals | number) {
      process.kill(pid, signal);
      return true;
    },
    // The reaper has no ChildProcess handle for a leftover from a previous
    // daemon, so it observes exit by polling the pid. Without this, termination
    // can never see a graceful SIGTERM exit and always waits out the full
    // graceful+force window before escalating to SIGKILL.
    once(_event, listener) {
      const timer = setInterval(() => {
        if (!isProcessAlive(pid)) {
          clearInterval(timer);
          listener();
        }
      }, MANAGED_PROCESS_EXIT_POLL_INTERVAL_MS);
      timer.unref();
    },
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeErrorWithCode(error, "EPERM");
  }
}

function isCommandExitFailure(error: unknown): boolean {
  // execFile rejects with a numeric `code` (the process exit status) when the
  // command ran and exited non-zero; a string `code` (e.g. "ENOENT") means it
  // never ran.
  return typeof (error as { code?: unknown })?.code === "number";
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
