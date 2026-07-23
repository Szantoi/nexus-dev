import { open } from 'node:fs/promises';

export interface LinuxProcessIdentity {
  pid: number;
  parentPid: number;
  creationToken: string;
  sessionId?: number;
}

export const LINUX_PROC_CONCURRENCY = 64;

export function parseLinuxProcessIds(value: string): number[] {
  const records: number[] = [];
  for (const line of value.trim().split(/\r?\n/)) {
    if (!line.trim()) continue;
    const pid = Number(line.trim());
    if (Number.isSafeInteger(pid) && pid > 0) records.push(pid);
  }
  return records;
}

export function parseLinuxProcessStat(
  pid: number,
  value: string,
): LinuxProcessIdentity | undefined {
  const commandEnd = value.lastIndexOf(')');
  if (commandEnd < 0) return undefined;
  const fields = value.slice(commandEnd + 1).trim().split(/\s+/);
  const parentPid = Number(fields[1]);
  const sessionId = Number(fields[3]);
  const startTime = fields[19];
  if (
    !Number.isSafeInteger(parentPid) ||
    !Number.isSafeInteger(sessionId) ||
    !startTime ||
    !/^\d+$/.test(startTime)
  ) {
    return undefined;
  }
  return {
    pid,
    parentPid,
    sessionId,
    creationToken: `linux:${startTime}`,
  };
}

export async function readLinuxProcessIdentity(
  pid: number,
): Promise<LinuxProcessIdentity | undefined> {
  const buffer = Buffer.allocUnsafe(4_096);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(`/proc/${pid}/stat`, 'r');
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return parseLinuxProcessStat(pid, buffer.toString('utf8', 0, bytesRead));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function readLinuxIdentitiesBounded(
  processIds: readonly number[],
  reader: (pid: number) => Promise<LinuxProcessIdentity | undefined> =
    readLinuxProcessIdentity,
  concurrency = LINUX_PROC_CONCURRENCY,
): Promise<LinuxProcessIdentity[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error('Linux procfs concurrency must be a positive safe integer');
  }
  const results: Array<LinuxProcessIdentity | undefined> = new Array(processIds.length);
  let nextIndex = 0;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      const index = nextIndex++;
      if (index >= processIds.length) return;
      try {
        results[index] = await reader(processIds[index]);
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, processIds.length) }, () => worker()),
  );
  if (failure !== undefined) throw failure;
  return results.flatMap((identity) => (identity ? [identity] : []));
}

function startTime(identity: LinuxProcessIdentity): bigint | undefined {
  const match = /^linux:(\d+)$/.exec(identity.creationToken);
  return match ? BigInt(match[1]) : undefined;
}

/**
 * A recycled session leader can reuse the numeric SID. Only members created
 * before the replacement leader are provably from the old session.
 */
export function selectSafeLinuxSurvivorsAfterReuse(
  records: readonly LinuxProcessIdentity[],
  root: LinuxProcessIdentity,
  replacementRoot: LinuxProcessIdentity,
): LinuxProcessIdentity[] {
  const replacementStart = startTime(replacementRoot);
  if (replacementStart === undefined || root.sessionId === undefined) return [];
  const safe = records.filter((record) => {
    const recordStart = startTime(record);
    return (
      record.pid !== root.pid &&
      record.sessionId === root.sessionId &&
      recordStart !== undefined &&
      recordStart < replacementStart
    );
  });
  const safePids = new Set(safe.map((record) => record.pid));
  const parents = new Map(safe.map((record) => [record.pid, record.parentPid]));
  const depth = (pid: number): number => {
    let current = pid;
    let value = 1;
    const visited = new Set([pid]);
    while (parents.has(current)) {
      const parent = parents.get(current)!;
      if (parent === root.pid) return value;
      if (!safePids.has(parent) || visited.has(parent)) return value;
      visited.add(parent);
      current = parent;
      value++;
    }
    return value;
  };
  return safe.sort((left, right) => depth(right.pid) - depth(left.pid) || right.pid - left.pid);
}
