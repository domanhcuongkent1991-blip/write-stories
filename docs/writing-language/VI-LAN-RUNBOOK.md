# VI LAN runbook

Runbook này dành cho sandbox thử nghiệm viết tiếng Việt trên mạng LAN đáng tin cậy. Stable và dữ liệu thật không được phục vụ bởi launcher này.

## Phạm vi và topology

- Stable giữ nguyên checkout `D:\InkOS\write-stories`, dữ liệu `E:\viet-truyen`, Web/API `4567`/`4569`.
- `AppRoot` mặc định: `D:\InkOS\write-stories-vi-1.8.0` (experiment code).
- `ProjectRoot`: sandbox experiment `C:\Users\Admin\Documents\Codex\InkOS\vi-writing-sandbox`.
- `StableProjectRoot`: dữ liệu stable `E:\viet-truyen`; launcher chỉ dùng đường dẫn này để chặn nhầm root, không ghi vào đó.
- API chỉ bind `127.0.0.1` (mặc định cổng `4570`); trình duyệt bind `WebHost` private IPv4 (mặc định cổng `4568`). Launcher kiểm tra IP thuộc RFC1918, interface đang Up và network profile là Private.
- Không dùng `E:\viet-truyen`, không dùng stable làm `ProjectRoot`, và không mở API ra LAN.

## Khởi chạy

Quy trình qualification mặc định luôn đặt LLM stub trước khi gọi launcher, không phát sinh chi phí hay gửi dữ liệu ra ngoài:

```powershell
$env:INKOS_AGENT_LLM_STUB = '1'
& 'D:\InkOS\write-stories-vi-1.8.0\scripts\start-studio-vi-lan.ps1' `
  -ProjectRoot 'C:\Users\Admin\Documents\Codex\InkOS\vi-writing-sandbox' `
  -StableProjectRoot 'E:\viet-truyen' `
  -WebHost '192.168.1.5' `
  -WebPort 4568 `
  -ApiPort 4570
```

Thay `192.168.1.25` bằng địa chỉ IPv4 private thực sự của máy (`10/8`, `172.16/12`, hoặc `192.168/16`). Có thể truyền thêm `-WebPort` và `-ApiPort` nếu cổng mặc định bận; hai cổng phải khác nhau.

Lời xác nhận `[y/N]` có nghĩa là chủ nhân đã kiểm tra mạng LAN và các thiết bị truy cập đều đáng tin cậy. Đây chỉ là xác nhận vận hành và Origin policy chống CSRF, không phải cơ chế xác thực thiết bị. Chọn mặc định `N` nếu chưa chắc.

Real model là opt-in riêng: chỉ sau khi chủ nhân xác nhận sandbox, bỏ `INKOS_AGENT_LLM_STUB` và nạp cấu hình model/API key qua cơ chế secrets đã được phê duyệt. Real model có thể tốn phí và gửi nội dung ra nhà cung cấp; không ghi key/secret vào runbook, source hoặc log. Không mở public Internet.

## Kiểm tra sau khi khởi chạy

API phải chỉ có listener loopback:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 4570 |
  Format-Table LocalAddress,LocalPort,OwningProcess
```

Mọi dòng phải có `LocalAddress` là `127.0.0.1`. Web phải listen đúng private IP đã chọn, không phải `0.0.0.0`:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 4568 |
  Format-Table LocalAddress,LocalPort,OwningProcess
```

Đối chiếu `LocalAddress` với `-WebHost`, rồi thử truy cập `http://<WebHost>:4568` từ thiết bị LAN đã xác nhận. Nếu launcher báo IP/interface/profile không hợp lệ, dừng và sửa tham số hoặc mạng; không tự sửa firewall.

## Dừng và khôi phục

Nhấn `Ctrl+C` trong cửa sổ launcher. `start-studio-vi-lan.ps1` sẽ dừng cả API và Web trong khối cleanup. Nếu cần xử lý tiến trình còn sót, chỉ lấy PID đang giữ đúng cổng `4568`/`4570`, xác nhận đó là tiến trình experiment, rồi dừng đúng PID; không dùng lệnh kill diện rộng.

Nếu muốn rollback, dừng experiment trước, giữ nguyên stable checkout và chuyển launcher về snapshot/commit VI-LKG đã được ghi nhận trong hồ sơ qualification. Không reset hoặc xóa dữ liệu sandbox khi chưa có bản sao và chưa được chủ nhân duyệt. VI-LKG là rollback point; không cập nhật pointer hiện hành trong lúc chẩn đoán.

Khi API báo `CANONICAL_TRANSACTION_INCOMPLETE` hoặc thấy thư mục `.inkos-file-txn-*` trong book root:

1. Dừng cả hai process experiment ngay.
2. Sao chép nguyên sandbox book và nguyên thư mục `.inkos-file-txn-*` sang nơi lưu trữ chẩn đoán an toàn, giữ nguyên tên và bytes.
3. Không xóa transaction dir, không xóa backup, không rebuild hoặc ghi tiếp vào book đó.
4. Báo chủ nhân để đối chiếu canonical files và quyết định phục hồi từ VI-LKG/bản sao.

## Cập nhật upstream

Không chạy `git fetch`, không đổi stable hoặc VI-LKG, nếu chưa có mệnh lệnh rõ ràng của chủ nhân. Sau khi được phép, ghi lại commit/pointer hiện tại, tạo candidate worktree riêng, chạy lại các gate scoped và chỉ đổi launcher/LKG pointer sau khi candidate đạt qualification. Nếu candidate không đạt, tiếp tục dùng stable và VI-LKG cũ.
