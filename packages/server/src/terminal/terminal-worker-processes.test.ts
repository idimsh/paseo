// Modified in idimsh/paseo: PC-2
import { describe, expect, test } from "vitest";
import type {
  LinuxProcReader,
  ManagedProcessCommandRunner,
} from "../server/managed-processes/managed-processes.js";
import { createTerminalWorkerProcessInspector } from "./terminal-worker-processes.js";

const noCommands: ManagedProcessCommandRunner = {
  exec: async (command) => {
    throw new Error(`Unexpected command ${command}`);
  },
};

describe("terminal worker process table on Linux (PC-2)", () => {
  test("lists processes from /proc with the same identity inspect records", async () => {
    const stats: Record<number, string> = {
      1: "1 (init) S 0 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5 0 0",
      4101: "4101 (my ) (worker x) S 1 4101 4101 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 123456 0 0",
      4200: "4200 (bash) S 4101 4200 4200 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 130000 0 0",
    };
    const linuxProc: LinuxProcReader = {
      bootId: () => "boot-1",
      // 4300 is listed but exits before its stat is read.
      listPids: async () => [1, 4101, 4200, 4300],
      readStat: async (pid) => stats[pid] ?? null,
    };
    const inspector = createTerminalWorkerProcessInspector({
      platform: "linux",
      commandRunner: noCommands,
      linuxProc,
    });

    expect(await inspector.listProcesses()).toEqual([
      { pid: 1, ppid: 0, sessionId: 1, startedAt: "linux-start:boot-1:5" },
      { pid: 4101, ppid: 1, sessionId: 4101, startedAt: "linux-start:boot-1:123456" },
      { pid: 4200, ppid: 4101, sessionId: 4200, startedAt: "linux-start:boot-1:130000" },
    ]);
  });

  test("leaves out a process whose stat cannot be read instead of failing the table", async () => {
    const inspector = createTerminalWorkerProcessInspector({
      platform: "linux",
      commandRunner: noCommands,
      linuxProc: {
        bootId: () => "boot-1",
        listPids: async () => [1, 4101],
        readStat: async (pid) => {
          if (pid === 4101) throw Object.assign(new Error("denied"), { code: "EACCES" });
          return "1 (init) S 0 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5 0 0";
        },
      },
    });
    expect(await inspector.listProcesses()).toEqual([
      { pid: 1, ppid: 0, sessionId: 1, startedAt: "linux-start:boot-1:5" },
    ]);
  });

  test("fails when /proc lists no readable process", async () => {
    const inspector = createTerminalWorkerProcessInspector({
      platform: "linux",
      commandRunner: noCommands,
      linuxProc: { bootId: () => "boot-1", listPids: async () => [], readStat: async () => null },
    });
    await expect(inspector.listProcesses()).rejects.toThrow("no processes");
  });
});
