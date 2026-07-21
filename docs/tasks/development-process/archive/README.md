# Archív — lezárt fejlesztésifolyamat-taskok

Ide csak bizonyítékkal lezárt `TASK-DP-*` fájl kerülhet.

Archiválási szabály:

1. A frontmatter `status` értéke `done`.
2. A task végén teljes `Implementáció (YYYY-MM-DD)` szakasz és valid
   `execution_evidence` található.
3. Minden elfogadási és kilépési feltétel PASS, vagy a fennmaradó eltéréshez
   elfogadott follow-up task tartozik, amely nem sérti a program kilépési
   feltételét.
4. A reviewer nem azonos az implementálóval, és döntése géppel olvasható.
5. A hivatkozott commit, CI, review és szükség esetén release-bizonyíték
   elérhető és ugyanarra a forrásverzióra mutat.
6. A task, `EPICS.yaml`, `state.md`, `todo.md`, `MEMORY.md` és kapcsolódó
   dokumentáció konzisztens.
7. Az archiválást a coordinator végzi; a készítő saját taskját nem mozgathatja.

Archiváláskor a program README taskhivatkozását `archive/` előtaggal és `done`
jelzéssel kell frissíteni.
