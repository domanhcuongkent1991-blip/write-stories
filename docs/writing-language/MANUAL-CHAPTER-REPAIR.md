# Quy trình người dùng tự sửa chương

App có sẵn hai con đường để người dùng can thiệp vào chương đã viết. Chọn đúng con đường theo loại sửa, nếu không truth files (`story/pending_hooks.md`, `current_state.md`, `chapter_summaries.md`) sẽ lệch với văn bản và các chương sau đọc state sai.

## Con đường 1 — sửa sự kiện/tình tiết: `inkos revise`

Dùng khi cần thay đổi nội dung câu chuyện (thêm/bớt cảnh, đổi diễn biến, bổ sung payoff của hook).

```bash
inkos revise <book-id> <chapter> --instruction "mô tả thay đổi muốn có"
```

- `reviseDraft` tái tạo memo/intent qua pipeline governed, viết lại văn bản, và **re-settle toàn bộ truth files** (summaries, hook ledger, current_state) từ nội dung mới. Đây là con đường an toàn về ngữ nghĩa: sửa payoff của một hook ở chương N sẽ được ledger ghi nhận, chương N+1 đọc đúng state.
- Revision chỉ được chấp nhận khi qua shared candidate gate (score >= 85, không verified blocker, state settled hợp lệ, độ dài trong hard band). Nếu revision bị từ chối, chương gốc được giữ nguyên.

## Con đường 2 — sửa câu chữ/văn phong: edit file + audit + approve

Dùng khi chỉ sửa câu chữ, chính tả, nhịp văn — không đổi sự kiện.

```bash
# 1. Sửa trực tiếp file văn bản
edit chapters/0008_*.md
# 2. Audit lại chương đã sửa
inkos audit <book-id> <chapter>
# 3. Nếu đạt, duyệt để commit state
inkos review approve <book-id> <chapter>
```

- `inkos audit` chạy auditor trên văn bản hiện tại (phase manual, không tự revise).
- `inkos review approve` chuyển phase manual → ready; settlement truth files được cập nhật từ nội dung đã duyệt.
- **CẢNH BÁO:** chỉ sửa file `.md` mà KHÔNG chạy `audit` + `review approve` sẽ để lại truth files ở trạng thái cũ — AI các chương sau đọc state sai (đã ghi nhận ca thật: `currentState.chapter=3` trong khi `manifest.lastAppliedChapter=2`). Không bao giờ bỏ qua bước 2-3.

## Khi nào dùng con đường nào

| Loại sửa | Con đường | Vì sao |
|---|---|---|
| Đổi sự kiện, thêm/bớt cảnh, bổ sung payoff hook | `revise --instruction` | Cần re-settle ledger + state |
| Sửa câu chữ, chính tả, văn phong | edit + `audit` + `review approve` | Văn bản đổi nhưng state không đổi |
| Chương fail gate do memo sai (thiếu hook đến hạn) | `revise --instruction "payoff <hookID>..."` | Lỗi ở tầng kế hoạch, revise tái lập memo |

## Kiểm tra sức khỏe sau khi sửa

```bash
inkos doctor
```

Hai check liên quan: **Outline Depth** (outline phủ đủ targetChapters) và **Hook Payoff Drift** (không hook nào quá hạn payoff mà chưa resolve). Nếu `Hook Payoff Drift` báo đỏ: dùng `revise --instruction` để trả nợ hook, hoặc sửa lời hứa payoff trong ledger một cách có chủ đích (kèm carry-over rõ ràng) — không để trôi ngầm.
