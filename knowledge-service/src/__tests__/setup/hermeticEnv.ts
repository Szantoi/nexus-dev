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
// tesztfájlonkénti újra-mkdtemp-et ugyanabban a workerben.
if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'nexus-test-data-'));
}
if (!process.env.TERMINALS_PATH && !process.env.TERMINALS_DIR) {
  process.env.TERMINALS_PATH = mkdtempSync(join(tmpdir(), 'nexus-test-terminals-'));
}
