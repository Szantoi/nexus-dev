#!/usr/bin/env node
/**
 * scripts/deploy/test/mock-health-server.mjs — hermetikus mock health-endpoint
 * a deploy-scriptek tesztjeihez. NEM része az éles deploynak.
 *
 * Működés:
 *   - 127.0.0.1-en, véletlen szabad porton figyel; a tényleges portot a
 *     portfájlba írja (a teszt-harness onnan olvassa ki).
 *   - Minden GET /health kérésnél beolvassa az állapotfájlt:
 *       "ok"  → 200 {"status":"ok"}
 *       bármi más / hiányzó fájl → 500 {"status":"fail"}
 *   - Az állapotfájlt a tesztek (és a mock service-start parancs) írják, így
 *     szimulálható az egészséges/beteg release deploy és rollback közben.
 *
 * Használat: node mock-health-server.mjs <állapotfájl> <portfájl>
 */
import http from 'node:http';
import fs from 'node:fs';

const [stateFile, portFile] = process.argv.slice(2);
if (!stateFile || !portFile) {
  console.error('Használat: mock-health-server.mjs <állapotfájl> <portfájl>');
  process.exit(2);
}

const server = http.createServer((req, res) => {
  let state = 'fail';
  try {
    state = fs.readFileSync(stateFile, 'utf8').trim();
  } catch {
    /* hiányzó állapotfájl = beteg szolgáltatás */
  }
  if (state === 'ok') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":"ok","source":"mock-health-server"}');
  } else {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"status":"fail","source":"mock-health-server"}');
  }
});

server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
