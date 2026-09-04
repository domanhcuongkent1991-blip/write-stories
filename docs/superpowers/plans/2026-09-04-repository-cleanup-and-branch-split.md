# Repository Cleanup and Branch Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a clean, traceable operational branch while preserving upstream parity, WIP, qualification evidence, and recoverable Git history.

**Architecture:** Treat `master` as an upstream mirror and `main` as the operational/test branch. Perform non-destructive inventory and classification first, move only generated local artifacts, preserve superseded documentation as archive candidates, and never rewrite evidence-bearing history during this pass.

**Tech Stack:** Git worktrees, PowerShell, pnpm workspace, Vitest, TypeScript, Gitleaks, OSV Scanner.

---

### Task 1: Capture the pre-cleanup baseline

**Files:**
- Read-only: all Git refs and worktrees
- Create: `REPOSITORY-CLEANUP-MAP.md`

- [x] **Step 1: Record refs, worktrees, untracked files, and unreachable objects**

Run from `C:\tmp\CodexScratch\2026-09-01-inkos-promotion-hardening`:

```powershell
git status --short --branch
git worktree list --porcelain
git branch -a -vv
git fsck --full --unreachable --no-reflogs
```

Expected baseline: hardening branch at `cd6594497feb2600d80cd4584b352994fd8809d3`, local `master` 93 commits ahead of `origin/master`, and the listed WIP files remain untracked.

- [x] **Step 2: Review the classification map before removing anything**

The map must distinguish production source, tests, active plans/specs, superseded plans/specs, evidence, generated reports, tool caches, WIP, ignored dependencies, and unreachable commits. No item is deleted solely because it is old or large.

### Task 2: Isolate generated local artifacts

**Files:**
- Modify: `.gitignore`
- Move: the three root-level `osv-*.json` outputs into the durable archive at `C:\Users\Admin\Documents\Codex\InkOS\repository-cleanup\2026-09-04\`
- Preserve: `.codex/tools/bin/gitleaks.exe` and `.codex/tools/bin/osv-scanner.exe`

- [x] **Step 1: Add narrow ignore rules**

Add `.codex/` and the exact generated root-level OSV report pattern `osv-*.json` to `.gitignore`; do not ignore source manifests such as `osv-scanner.toml`.

- [x] **Step 2: Move, do not delete, generated reports**

The `.codex` ACL does not allow creating a subdirectory from this sandbox. Move only `osv-build-postcommit-manager.json`, `osv-post-parser.json`, and `osv-runtime-precommit.json` out of the worktree, preserve them in `C:\Users\Admin\Documents\Codex\InkOS\repository-cleanup\2026-09-04\`, and verify SHA-256 before and after the move. The intermediate staging directory at `D:\InkOS\inkos-cleanup-evidence-20260904\` retains six hash-matched duplicates because Windows denied their removal; it is not the canonical archive and requires a later elevated cleanup checkpoint.

- [x] **Step 3: Verify no WIP or evidence path was touched**

Run `git status --short --untracked-files=all` and compare the result with the cleanup map. The tool binaries and all qualification evidence outside the repository must remain intact.

### Task 3: Verify the cleaned worktree

**Files:**
- Read-only: package manifests, lockfile, tests, security configuration

- [x] **Step 1: Check whitespace and tracked-path integrity**

Run `git diff --check` and `git ls-files | Measure-Object -Line`; expected result is no whitespace error and no unexpected tracked-file deletion.

- [x] **Step 2: Run project verification**

Run `npm run test`, `npm run typecheck`, `npm run build`, and the project-local secret/dependency scans. Record exit codes and counts in the cleanup map.

- [x] **Step 3: Stop on any regression**

If a check fails, retain the generated artifacts and WIP, document the failure, and do not create `main` or normalize `master`.

### Task 4: Create the branch topology after cleanup

**Files:**
- Git refs only; no source rewrite

- [x] **Step 1: Archive current refs before branch movement**

Create recoverable archive refs for the existing local `master` and hardening candidate. Do not delete the hardening branch.

- [x] **Step 2: Create `main` from the verified cleanup commit**

`main` must point at the verified operational candidate, including hardening changes. Existing evidence must continue to reference the exact candidate SHA that produced it.

- [x] **Step 3: Normalize `master` to `origin/master`**

Only after WIP checks and archive refs succeed, make local `master` equal to `origin/master`. Use fast-forward-only updates thereafter; never merge `main` into `master`.

- [x] **Step 4: Document the ongoing update flow**

Keep the branch contract in `REPOSITORY-CLEANUP-MAP.md` and update it whenever the topology changes.
