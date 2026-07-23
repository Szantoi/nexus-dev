/** Pure Windows process-tree selection over one bulk Win32_Process snapshot. */
export interface WindowsProcessIdentity {
  pid: number;
  parentPid: number;
  creationToken: string;
  sessionId?: number;
}

/**
 * One-process Windows cleanup script. The second CIM lookup immediately before
 * Invoke-CimMethod closes the bulk-snapshot/PID-reuse gap; raw PID termination
 * commands (Stop-Process/taskkill) are intentionally absent.
 */
export const WINDOWS_IDENTITY_SAFE_TERMINATION_COMMAND = [
  "$ErrorActionPreference='Stop'",
  '$expectedJson=[Console]::In.ReadToEnd()',
  '$expected=@($expectedJson | ConvertFrom-Json)',
  '$initial=@{}',
  "Get-CimInstance Win32_Process | ForEach-Object { $initial[[string]$_.ProcessId]='windows:'+$_.CreationDate.ToUniversalTime().ToString('o') }",
  '$failures=@()',
  "foreach ($item in $expected) { $pidValue=[int]$item.pid; $expectedToken=[string]$item.creationToken; if ($initial[[string]$pidValue] -eq $expectedToken) { $candidate=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$pidValue); if ($null -ne $candidate) { $candidateToken='windows:'+$candidate.CreationDate.ToUniversalTime().ToString('o'); if ($candidateToken -eq $expectedToken) { try { $result=Invoke-CimMethod -InputObject $candidate -MethodName Terminate; if ([int]$result.ReturnValue -ne 0) { $failures += ('PID '+$pidValue+': terminate return '+$result.ReturnValue) } } catch { $failures += ('PID '+$pidValue+': '+$_.Exception.Message) } } } } }",
  "if ($failures.Count -gt 0) { throw ($failures -join '; ') }",
].join('; ');

function sameProcess(
  current: WindowsProcessIdentity,
  expected: WindowsProcessIdentity,
): boolean {
  return current.pid === expected.pid && current.creationToken === expected.creationToken;
}

export function selectWindowsDescendants(
  records: readonly WindowsProcessIdentity[],
  root: WindowsProcessIdentity,
): WindowsProcessIdentity[] {
  const currentRoot = records.find((record) => record.pid === root.pid);
  // A recycled root PID invalidates parent links. An absent old root does not:
  // its surviving children retain ParentProcessId and can seed the saved tree.
  if (currentRoot && !sameProcess(currentRoot, root)) {
    throw new Error(
      `Windows PTY root PID ${root.pid} ownership indeterminate after identity reuse`,
    );
  }

  const allowed = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (
        record.pid !== root.pid &&
        (record.parentPid === root.pid || allowed.has(record.parentPid)) &&
        !allowed.has(record.pid)
      ) {
        allowed.add(record.pid);
        changed = true;
      }
    }
  }

  const parentByPid = new Map(records.map((record) => [record.pid, record.parentPid]));
  const byPid = new Map(records.map((record) => [record.pid, record]));
  const depth = (pid: number): number => {
    let current = pid;
    let value = 1;
    const visited = new Set<number>([pid]);
    while (parentByPid.has(current)) {
      const parent = parentByPid.get(current)!;
      if (parent === root.pid) return value;
      if (!allowed.has(parent) || visited.has(parent)) return value;
      visited.add(parent);
      current = parent;
      value++;
    }
    return value;
  };
  return [...allowed]
    .sort((left, right) => depth(right) - depth(left) || right - left)
    .flatMap((pid) => (byPid.has(pid) ? [byPid.get(pid)!] : []));
}
