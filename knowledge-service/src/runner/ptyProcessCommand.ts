/**
 * Bounded OS process-table command execution for the PTY host.
 *
 * Every native query here is time- and buffer-bounded so a hung or flooding
 * OS tool can never stall PTY cleanup past its hard deadline.
 */
import { execFile } from 'node:child_process';

const PROCESS_COMMAND_TIMEOUT_MS = 5_000;
const PROCESS_COMMAND_MAX_BUFFER = 4 * 1024 * 1024;
const CLEANUP_ERROR_MAX_LENGTH = 8_192;

/** OS-level process identity row shared by the platform table readers. */
export interface OsProcessRecord {
  pid: number;
  parentPid: number;
  creationToken: string;
  sessionId?: number;
}

export function boundedError(value: string): string {
  return value.length <= CLEANUP_ERROR_MAX_LENGTH
    ? value
    : `${value.slice(0, CLEANUP_ERROR_MAX_LENGTH)}...[truncated]`;
}

export function execFileBounded(
  file: string,
  args: readonly string[],
  stdin?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: PROCESS_COMMAND_TIMEOUT_MS,
        maxBuffer: PROCESS_COMMAND_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        const detail = stderr.trim();
        if (error || detail) {
          reject(
            new Error(
              boundedError(
                `${error?.message ?? 'Process command emitted stderr'}${detail ? `; stderr: ${detail}` : ''}`,
              ),
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

export const WINDOWS_PROCESS_TABLE_COMMAND = [
  "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process",
  "ForEach-Object { [pscustomobject]@{ ProcessId=$_.ProcessId; ParentProcessId=$_.ParentProcessId; CreationDate=$_.CreationDate.ToUniversalTime().ToString('o') } }",
  'ConvertTo-Json -Compress',
].join(' | ');

export function parseWindowsProcessTable(output: string): OsProcessRecord[] {
  if (!output.trim()) return [];
  const decoded = JSON.parse(output) as
    | { ProcessId: number; ParentProcessId: number; CreationDate: string }
    | Array<{ ProcessId: number; ParentProcessId: number; CreationDate: string }>;
  return (Array.isArray(decoded) ? decoded : [decoded]).flatMap((record) =>
    Number.isInteger(record.ProcessId) && record.CreationDate
      ? [
          {
            pid: record.ProcessId,
            parentPid: record.ParentProcessId,
            creationToken: `windows:${record.CreationDate}`,
          },
        ]
      : [],
  );
}
