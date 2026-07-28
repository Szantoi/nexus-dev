/**
 * hermeticEnv.ts — globális vitest setup (TASK-DP-007, worktree-kapu).
 *
 * A hermetikus suite NEM írhat a repóba. Több modul (config/paths.ts →
 * pipeline/epicRouter, task-message-box/store, workflowDb, telegram store)
 * IMPORT-időben számol DATA_DIR/TERMINALS_PATH alapú útvonalat, és ha egy
 * teszt env-felülbírálás nélkül importálja őket, a valódi
 * `knowledge-service/data/` alá és a valódi `terminals/` fába ír (a
 * worktree-kapu élesben pontosan ezt fogta meg: 4 runtime DB + 2 inbox-fájl).
 *
 * Ez a setup minden workerben a tesztmodulok betöltése ELŐTT fut, és tmp-re
 * irányítja a két gyökér-env-et. A tesztek, amelyek maguk állítanak be
 * specifikusabb env-et (pl. WORKFLOW_DB, EPICS_PATH) vagy sajátot a kettőből,
 * változatlanul működnek: a saját beállításuk konkrétabb, vagy egyszerűen
 * felülírja ezt (a setup csak akkor ír, ha a hívó környezet nem adott értéket
 * — CI-ben és lokális `npm test`-ben ez a helyzet).
 *
 * FIGYELEM: ezt a fájlt a vitest.config.ts `setupFiles` hivatkozza; ne
 * importálj ide src-modult (a cél épp az, hogy ELŐTTÜK fusson).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Workerenként egyszer: a process-cache-elt env-érték megakadályozza a
// tesztfájlonkénti újra-mkdtemp-et ugyanabban a workerben. Csak az ÍRÓ
// gyökereket irányítjuk át — az olvasó utak (EPICS_PATH, KNOWLEDGE_BASE_PATH,
// PROJECTS_DIR) a valós repóra maradnak, azokat a tesztek fixture-env-vel
// kezelik.
if (!process.env.NEXUS_TEST_SCRATCH) {
  process.env.NEXUS_TEST_SCRATCH = mkdtempSync(join(tmpdir(), 'nexus-test-'));
}
const scratch = process.env.NEXUS_TEST_SCRATCH;
const defaults: Record<string, string> = {
  DATA_DIR: join(scratch, 'data'),
  LOGS_DIR: join(scratch, 'logs'),
  GOALS_DIR: join(scratch, 'goals'),
  IDEAS_DIR: join(scratch, 'ideas'),
  QUEUE_DIR: join(scratch, 'queue'),
  CONDUCTOR_STATE_DIR: join(scratch, 'conductor-state'),
  IDEA_SCAN_PROJECT_PATH: join(scratch, 'tasks-new'),
  AUTONOMOUS_DEV_FOCUS_FILE: join(scratch, 'tasks-new', 'PROJECT_STATUS.md'),
  NIGHTWATCH_STATE_FILE: join(scratch, 'nightwatch-state'),
};
for (const [key, value] of Object.entries(defaults)) {
  if (!process.env[key]) process.env[key] = value;
}
// A terminals-fa két elfogadott env-kulcsa közül bármelyik beállítottsága
// felülbírálásnak számít.
if (!process.env.TERMINALS_PATH && !process.env.TERMINALS_DIR) {
  process.env.TERMINALS_PATH = join(scratch, 'terminals');
}
