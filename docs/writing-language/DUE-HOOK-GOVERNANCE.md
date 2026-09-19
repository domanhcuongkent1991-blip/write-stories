# Due-hook governance (hook đến hạn)

Bối cảnh: luna-30b ch8 — planner bỏ sót cả hai hook climax của Volume 2 (H002, H005, `pays_off_in=Chapter 8`) khỏi hook ledger của memo; writer viết đúng memo nên chương không có climax; auditor đánh fail `Payoff Dilution` + `Chapter Memo Drift` hai lần liên tiếp, bounded rewrite không cứu được vì lỗi nằm ở tầng memo. Đây là lớp lỗi mà cơ chế debt cũ (dựa trên silence: `computeRecyclableHooks`) không bắt được — hook đến hạn nhưng vừa được touch gần đây thì silence thấp, không bao giờ xuất hiện trong khối "stale hooks".

## Ba lớp phòng thủ (không đổi kiến trúc, chỉ thêm ràng buộc)

1. **Prompt — dạy trước khi sinh** (`formatDueHooks` trong `planner-context.ts`, slot `{{due_hooks}}` trong `planner-prompts.ts`): user message của planner luôn liệt kê hook có `pays_off_in` đúng chương hiện tại, kèm yêu cầu resolve bằng material-proof evidence. Template có cả bản ZH và EN.

2. **Guard — chặn khi sinh xong** (`assertFreshMemoGovernance` trong `planner.ts`): memo thiếu hook đến hạn ở cả `advance:/resolve:/defer:` → `PlannerParseError("due-hook omission: ...")`. Lỗi được đưa vào bounded correction retry (2 lần) kèm message dạy cách sửa. Guard thuần cấu trúc — chỉ đòi hook được *addressed*, không ép resolve bằng mọi giá: hook thật sự bị block vẫn được defer kèm carry-over promise, chất lượng payoff vẫn do tầng audit phán.

3. **Fallback — không im lặng khi cạn retry** (`buildFallbackMemoMarkdown`): memo fallback tự commit hook đến hạn vào `resolve:` (hoặc `advance:` nếu status không cho phép resolve, theo `getLegalHookActions`) thay vì ledger trống. Resolve preflight vẫn đánh giá evidence và strip phần không có căn cứ, nên fail-safe.

## Predicate dùng chung

`selectDuePayoffHooks(hooks, chapterNumber)` và `selectOverduePayoffHooks(hooks, chapterNumber)` trong `utils/outline-coverage.ts` — cả guard, prompt block và doctor check đều dùng chung để không lệch định nghĩa:

- Due = `extractPromisedPayoffChapter(paysOffInArc) === chapterNumber`, status chưa resolved.
- Overdue = promised `<= chapterNumber`, status chưa resolved (cho doctor, bắt nợ đã trôi qua hạn).
- Hook `deferred`/`paused` VẪN được tính — đúng ca cần quyết định. Chỉ `resolved` là terminal.
- Promise không parse được ("the end of Volume 2") = ngoài phạm vi, không bao giờ là violation.

## Doctor check

`inkos doctor` → **Hook Payoff Drift**: liệt kê sách có hook quá hạn payoff mà chưa resolve, kèm chương đến hạn. Check chỉ báo cáo (report-only) — guard ở planner ngăn nợ mới phát sinh, doctor phơi nợ cũ để sửa tay theo `MANUAL-CHAPTER-REPAIR.md`.

## Giới hạn trung thực

- Guard chỉ bắt *omission* (bỏ sót), không phán chất lượng payoff — chất lượng vẫn thuộc tầng audit (temp 0 + host severity cap từ fca4e37d).
- Nếu lời hứa payoff trong baseline vốn bất khả thi (hai hook cùng due một chương và mâu thuẫn nhau), guard sẽ đòi cả hai được address; planner có thể defer một cái kèm carry-over. Nợ defer dồn nhiều chương sẽ hiện ra ở doctor.
