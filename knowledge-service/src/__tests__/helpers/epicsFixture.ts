/**
 * Shared hermetic EPICS.yaml fixture for dependency-resolver style tests.
 *
 * Writes a small, well-formed epic graph to a temp file and points
 * process.env.EPICS_PATH at it. Modules that read EPICS_PATH lazily
 * (e.g. pipeline/dependencyResolver) pick it up on first use.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

export const FIXTURE_EPICS = {
  epics: [
    {
      id: 'EPIC-KERNEL-STABLE',
      name: 'Kernel Stabilization',
      status: 'done',
      depends_on: [],
    },
    {
      id: 'EPIC-IDENTITY-V1',
      name: 'Identity Service V1',
      status: 'active',
      depends_on: [],
    },
    {
      id: 'EPIC-CUTTING-Q3',
      name: 'Cutting Module Q3',
      status: 'pending',
      depends_on: ['EPIC-KERNEL-STABLE', 'EPIC-IDENTITY-V1'],
      parallel_with: ['EPIC-PORTAL-V2'],
    },
    {
      id: 'EPIC-PORTAL-V2',
      name: 'Customer Portal V2',
      status: 'pending',
      depends_on: ['EPIC-CUTTING-Q3'],
    },
  ],
};

/**
 * Create the fixture file and set EPICS_PATH. Returns the fixture path.
 */
export function setupEpicsFixture(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const epicsPath = path.join(dir, 'EPICS.yaml');
  fs.writeFileSync(epicsPath, yaml.dump(FIXTURE_EPICS), 'utf-8');
  process.env.EPICS_PATH = epicsPath;
  return epicsPath;
}

/**
 * Remove the fixture file/dir and unset EPICS_PATH.
 */
export function teardownEpicsFixture(epicsPath: string): void {
  delete process.env.EPICS_PATH;
  fs.rmSync(path.dirname(epicsPath), { recursive: true, force: true });
}
