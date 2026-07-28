---
id: TASK-QC-014
title: Biome lint-warning baseline csökkentése (ratchet-leszorítás)
program: NEXUS-QUALITY
project: nexus/knowledge-service
milestone: QC-M2
epic: QC-VERIFICATION
status: ready
priority: low
depends_on: []
owner_role: backend
created: 2026-07-28
source: TASK-DP-007 scope-5 baseline-expiry audit
---

# Biome lint-warning baseline csökkentése (ratchet-leszorítás)

## Cél

A `knowledge-service/.lint-baseline.json` warning-plafonja (jelenleg 784) egy
tömbösített kivétel-lista a QC-005-kori meglévő warningokra. A TASK-DP-007
lejáratot tett rá (fail-closed: lejárt baseline buktatja a CI-t) — ez a task a
lejáratkori kötelező felülvizsgálat gazdája: a warningok érdemi csökkentése,
vagy dokumentált indoklással a lejárat megújítása.

## Jelenlegi bizonyíték

- `.lint-baseline.json`: `maxWarnings: 784`, `expires: 2026-10-18`, owner:
  backend, follow-up: ez a task.
- A warningok zöme a Biome `noExplicitAny` (≈159 `any`) és a warn-ra vett
  szabályok (`noAssignInExpressions`, `noControlCharactersInRegex`,
  `useIterableCallbackReturn`) találatai — lásd a root `todo.md` "Kisebb
  tételek" backlogját, amelynek ez a task a formalizált gazdája.
- A kapu: `scripts/lint-ratchet.mjs` (`npm run lint:ratchet`); lejárt vagy
  hiányos (owner/expires/task nélküli) baseline bukás.

## Scope

1. Warning-osztályonként haladva javítsd a Biome warningokat (kezdd a
   legnagyobb darabszámú szabállyal; `npm run lint` mutatja a bontást).
2. Minden csökkentési etap után `node ../scripts/lint-ratchet.mjs --update`
   (a plafon leszorítása a mért értékre) — a plafon emelése tilos.
3. A lejárat előtt: ha a baseline nem érte el a 0-t, újítsd meg az `expires`
   dátumot ITT dokumentált indoklással (mennyi maradt, miért, következő etap).
4. Ha egy szabály warn→error ratchetelhető (0 találat), emeld error-ra a
   `biome.json`-ban.

## Nem cél

- Tömeges automatikus `any`→`unknown` csere viselkedés-ellenőrzés nélkül.
- A ratchet-mechanizmus (lint-ratchet.mjs) átalakítása.

## Elfogadási feltételek

- [ ] A `maxWarnings` plafon mérhetően csökkent (etaponként dokumentálva),
      VAGY a lejárat dokumentált indoklással megújítva.
- [ ] `npm run lint:ratchet` zöld a leszorított plafonnal.
- [ ] 0 találatú szabályok error-ra emelve a `biome.json`-ban.
- [ ] `npm run typecheck && npm test` zöld (a warning-javítások nem törtek
      viselkedést).

## Kötelező ellenőrzés

```bash
cd knowledge-service
npm run lint            # szabályonkénti bontás
npm run lint:ratchet    # kapu a leszorított plafonnal
npm run typecheck
npm test
```

## Átadandó bizonyíték

- A baseline-diff (`maxWarnings` régi → új) etaponként.
- A javított szabály-osztályok listája darabszámmal.

## Kockázat és rollback

Alacsony: a warning-javítások tipikusan lokálisak. Kockázat a kód-viselkedés
véletlen módosítása (pl. `any` szűkítésnél) — a teljes teszt-suite zöldje a
kapu; rollback a baseline korábbi értékének visszaállítása git-ből.
