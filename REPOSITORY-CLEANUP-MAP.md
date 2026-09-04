# InkOS repository cleanup map

Date of scan: 2026-09-04 (Asia/Ho_Chi_Minh)

This is a traceability map for the cleanup and branch split. It is intentionally conservative: a file or commit is not disposable merely because it is old, large, generated, or superseded. Items marked `KEEP` must remain available until the related qualification/evidence work is closed.

## Baseline

| Item | Observed value |
| --- | --- |
| Worktree under review | `C:\tmp\CodexScratch\2026-09-01-inkos-promotion-hardening` |
| Current branch | `hardening/vi-stable-promotion-20260901` |
| Current candidate | `cd6594497feb2600d80cd4584b352994fd8809d3` (`fix(qualification): allow local internal test endpoint`) |
| Local `master` | `ba5758b954c54f55ca32ec5adb5800aaa0ce5d5a` |
| `origin/master` | `5da9fad03d65882adc030dc0043da8e8bc197dbd` |
| Divergence | local `master` is 93 commits ahead of `origin/master`; current candidate is 120 commits ahead |
| Local/remote `main` | absent; GitHub currently exposes only `master` |
| Tracked files | 1,002 |
| Unreachable commits | 5; do not garbage-collect during cleanup |

## Worktree and generated-file classification

| Path or class | Classification | Action | Reason |
| --- | --- | --- | --- |
| `.codex/tools/bin/gitleaks.exe` | KEEP / reusable tool cache | Preserve and ignore locally | Previously downloaded scanner; deleting would force another download |
| `.codex/tools/bin/osv-scanner.exe` | KEEP / reusable tool cache | Preserve and ignore locally | Previously downloaded scanner; needed for later OSV scans |
| `.codex/osv-*.json` | KEEP / generated evidence inputs | Preserve under `.codex/`; never commit secrets | Redacted/local scan outputs; useful for audit and reproducibility |
| `.codex/gitleaks-current.json` | GENERATED / empty output | Keep until verification closes, then archive or remove with explicit scope | Current scan output, not source code |
| `.codex/gitleaks-evidence-current.json` | GENERATED / empty output | Keep until verification closes, then archive or remove with explicit scope | Current scan output, not source code |
| `osv-build-postcommit-manager.json` | GENERATED / root clutter | Moved to `D:\InkOS\inkos-cleanup-evidence-20260904\` with SHA-256 preserved | OSV report for the workspace lockfile |
| `osv-post-parser.json` | GENERATED / root clutter | Moved to `D:\InkOS\inkos-cleanup-evidence-20260904\` with SHA-256 preserved | OSV report for the workspace lockfile |
| `osv-runtime-precommit.json` | GENERATED / root clutter | Moved to `D:\InkOS\inkos-cleanup-evidence-20260904\` with SHA-256 preserved | OSV report for the workspace lockfile |
| `node_modules/` | IGNORED / dependency cache | Preserve; do not commit or delete in this pass | Avoid an unnecessary reinstall/download |
| `start-inkos-studio.bat` in `D:\InkOS\write-stories` | WIP / untracked | Preserve and do not stage | Belongs to another active worktree |

The `.codex` directory is ACL-protected in this environment, so no subdirectory was created and no scanner binary was moved. The three root reports were moved to the external archive above through an approved filesystem operation.

## Documentation classification

| Path/class | Classification | Decision |
| --- | --- | --- |
| `docs/localization/UPDATING-VI.md` | ACTIVE RUNBOOK | KEEP |
| `docs/writing-language/VI-LAN-RUNBOOK.md` | ACTIVE SANDBOX RUNBOOK | KEEP |
| `docs/writing-language/VI-LKG.md` | HISTORICAL LKG/evidence | KEEP; it explicitly records limitations |
| `docs/superpowers/specs/2026-09-02-three-gates-design.md` | CANONICAL PROPOSED DESIGN | KEEP until gate work is closed |
| `docs/superpowers/specs/2026-09-01-vi-hook-contract-preflight-design.md` | APPROVED DESIGN awaiting review | KEEP |
| `docs/superpowers/specs/2026-09-04-vi-planner-legal-hook-action-guidance-design.md` | CURRENT DESIGN for latest hardening | KEEP |
| `docs/superpowers/plans/2026-09-02-qualification-candidate-integrity-plan.md` | IMPLEMENTED/TRACEABILITY PLAN | KEEP for evidence lineage |
| `docs/superpowers/plans/2026-09-02-three-gate-integration-foundation.md` | IMPLEMENTED/TRACEABILITY PLAN | KEEP for evidence lineage |
| `docs/superpowers/plans/2026-09-04-vi-planner-legal-hook-action-guidance.md` | CURRENT WIP PLAN | KEEP; unchecked steps require reconciliation |
| Older repair/short-chapter/writer-length plans/specs marked `Superseded` | HISTORICAL / ARCHIVE CANDIDATE | Do not delete now; archive only after checking references and evidence |

The `selected-branch-plan.md` references in the changelog describe runtime output, not a missing source document. They are not cleanup targets.

## Unreachable Git objects

The scan found five unreachable commits. They are not automatically garbage:

- `98027e73` and `50a7b971`: duplicate-looking core pacing/hook snapshots; preserve until patch equivalence is verified.
- `d62b0534`: older Studio mobile-safe snapshot; preserve until confirmed equivalent to reachable `e04017e1`.
- `546d6be8`: abandoned intermediate legal-hook design; current reachable design is `c49f8dc8`.
- `dc815c4a`: abandoned intermediate repair/progress plan; reachable history contains later revisions.

Do not run `git gc`, reflog expiry, or object pruning as part of this cleanup.

## Branch contract after migration

- `master` must equal `origin/master` and may advance only with fast-forward-only upstream updates.
- `main` carries operational, integration, hardening, and test changes.
- `main` must never be merged back into `master`.
- Existing evidence remains immutable and keeps the exact candidate SHA that produced it.
- A provider transport failure or incomplete qualification keeps `main` in test/hold status; branch creation is not a Promotion approval.

## Next cleanup checkpoint

Before moving or deleting any historical document, inspect references and confirm that the corresponding evidence namespace and candidate SHA remain reachable. Any destructive cleanup requires a separate explicit file list and a fresh verification run.

## Verification record for this cleanup pass

| Check | Result |
| --- | --- |
| Full workspace tests | PASS: Core 215 files / 2,254 tests; Studio 79 files / 713 tests; CLI 45 files / 256 tests; command exit code 0 |
| Qualification scope tests | PASS: 22/22, exit code 0 |
| Workspace typecheck | PASS: Core, Studio client/server, CLI; exit code 0 |
| Workspace build | PASS: Core, Studio client/server, CLI; exit code 0; Vite reported existing large-chunk warnings |
| `git diff --check` | PASS: no whitespace error; Git reported the existing LF-to-CRLF checkout warning for `.gitignore` |
| Tracked-file count | 1,002 before and after the safe cleanup |
| Gitleaks Git-history scan | PASS supplemental evidence: 1,592 commits scanned, no leak found |
| Gitleaks working-tree scan | PASS supplemental evidence: approximately 36.55 MB scanned, no leak found |
| OSV lockfile scan | PASS supplemental evidence: 1,074 packages scanned, no unfiltered vulnerability returned; one esbuild advisory remains explicitly filtered by `osv-scanner.toml` |
| Framework security wrapper coverage | LIMITED: this repository does not contain `.codex/autopilot.profile.json` or the `scripts/ai-security-*.ps1` wrappers |

Security outputs and the three relocated OSV reports are stored in `D:\InkOS\inkos-cleanup-evidence-20260904\`. The project-local Gitleaks and OSV binaries remain unchanged under `.codex\tools\bin` for later reuse.

## Cleanup pass decision

The safe workspace cleanup was recorded in the independent documentation/ignore commit `c3bcbc5e`. Branch archival, `main` creation, and local `master` normalization were deferred until that commit existed and the branch-transition targets were rechecked. Document archiving, history rewriting, `git gc`, and object pruning remain deliberately out of scope.

## Branch migration result

Migration was performed after the verified cleanup commit `c3bcbc5ef8ceb263e4e74849f1bd4349e3cd8fc5`:

| Ref/worktree | Result |
| --- | --- |
| `main` | Created from the verified cleanup commit; checked out in the promotion-hardening worktree; no remote upstream assigned |
| `master` | Recreated at `5da9fad03d65882adc030dc0043da8e8bc197dbd`, exactly matching and tracking `origin/master` |
| `archive/master-local-20260904` | Preserves the former local `master` at `ba5758b954c54f55ca32ec5adb5800aaa0ce5d5a` |
| `archive/hardening-pre-main-20260904` | Preserves the verified hardening/cleanup point at `c3bcbc5ef8ceb263e4e74849f1bd4349e3cd8fc5` |
| `hardening/vi-stable-promotion-20260901` | Retained at `c3bcbc5ef8ceb263e4e74849f1bd4349e3cd8fc5`; not deleted |
| `start-inkos-studio.bat` | Remains untracked and untouched in the `master` worktree |

No branch was pushed and the GitHub default branch was not changed. Historical documents, evidence-bearing commits, unreachable objects, and scanner binaries were not deleted.

### Routine upstream update

Update the mirror first, then integrate into the operational branch:

```powershell
git -C D:\InkOS\write-stories fetch --prune origin
git -C D:\InkOS\write-stories merge --ff-only origin/master

git -C C:\tmp\CodexScratch\2026-09-01-inkos-promotion-hardening switch main
git -C C:\tmp\CodexScratch\2026-09-01-inkos-promotion-hardening merge master
```

Run tests, typecheck, build, Gitleaks, and OSV after merging `master` into `main`. Resolve any upstream conflict only on `main`; do not put local operational changes on `master`.
