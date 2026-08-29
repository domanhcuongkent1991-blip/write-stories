# Vietnamese writing last-known-good record

This record identifies the qualified experiment snapshot. It is not a stable promotion, tag, deployment, or approval to use a real model.

```text
sourceCommit: 532bcc54b854b45fafb44e12e774407a3e6e8d99
upstreamBaseCommit: 5da9fad03d65882adc030dc0043da8e8bc197dbd
stableCustomizationTip: be780dfda3d8f2091857fc1822e19f424653e087
viPatchBase: be780dfda3d8f2091857fc1822e19f424653e087
contractVersion: vi-writing-v1
countingMode: vi_wordlike_tokens_v1
defaultChapterLength: 2000
worktree: D:\InkOS\write-stories-vi-1.8.0
sandboxRoot: C:\Users\Admin\Documents\Codex\InkOS\vi-writing-sandbox
launcherCommand: $env:INKOS_AGENT_LLM_STUB='1'; & 'D:\InkOS\write-stories-vi-1.8.0\scripts\start-studio-vi-lan.ps1' -ProjectRoot 'C:\Users\Admin\Documents\Codex\InkOS\vi-writing-sandbox' -StableProjectRoot 'E:\viet-truyen' -WebHost '192.168.1.5' -WebPort 4568 -ApiPort 4570
webHost: 192.168.1.5
webPort: 4568
apiPort: 4570
targetedTestResult: PASS — planned Core 119 tests and Studio 283 tests; post-gate Core 134/134 and Studio server 178/178; Core/Studio typecheck and build PASS; i18n errors 0; scoped E2E 5/5 PASS; diff-check PASS
zhSmoke: PASS — stub create foundation, chapter 1, audit, revise, index/manifest reload; legacy zh counter/headings preserved
enSmoke: PASS — stub create foundation, chapter 1, audit, revise, index/manifest reload; legacy en counter/headings preserved
viManualSamples: PASS — sandbox book ban-ghi-thu-nghiem-vi-01133111; two canonical chapters without duplicates; audit/revise and interrupted-task recovery exercised; manifest/telemetry language vi; counter vi_wordlike_tokens_v1; chapter/truth/runtime/index aligned; real RMX3081 Android 13 phone could operate the LAN UI at 1080x2400 without horizontal overflow after the qualified fixes
knownLimitations: Qualification used the deterministic stub only. Its sample chapter was 107/2000 tokens and remained audit-failed, so prose quality and a paid real-model run are not qualified. Trusted LAN intentionally has no authentication and must be enabled only while supervised. The retained pre-fix session transcript contains historical Chinese tool-summary messages; sourceCommit fixes new messages but does not rewrite history. Only one real phone/browser combination was checked. Stable was not promoted and E:\viet-truyen was not modified.
rollbackCommit: 532bcc54b854b45fafb44e12e774407a3e6e8d99
```

The customization stack is `5da9fad03d65882adc030dc0043da8e8bc197dbd..be780dfda3d8f2091857fc1822e19f424653e087` (27 commits). The Vietnamese writing stack is `be780dfda3d8f2091857fc1822e19f424653e087..532bcc54b854b45fafb44e12e774407a3e6e8d99`. Future candidates must replay and qualify these stacks separately in that order.

Rollback means stopping the experiment and returning its code to `rollbackCommit` while preserving the sandbox for diagnosis. Do not reset stable, delete a book, remove a `.inkos-file-txn-*` directory, or change the LKG pointer without owner approval.
