# Cập nhật bản địa hoá tiếng Việt

Tài liệu này giữ cho lớp giao diện tiếng Việt không làm thay đổi ngôn ngữ sáng tác, dữ liệu người dùng hoặc giao thức của InkOS khi đồng bộ phiên bản upstream.

## Bất biến bắt buộc

1. `origin` là fork của chủ sở hữu; `upstream` là `https://github.com/Narcooo/inkos.git`.
2. Luôn xin phép trước khi chạy `git fetch --tags upstream`, vì lệnh này tải dữ liệu từ xa.
3. Chỉ merge đúng tag hoặc commit upstream đã được duyệt trên một nhánh cô lập có tên `update/upstream-*`.
4. Không bao giờ sao chép file từ reference 1.7.2 đang dirty trong quá trình cập nhật.
5. Chạy `pnpm check:i18n`; mọi khác biệt source lock đều bắt buộc phải được rà soát bản dịch trước khi cập nhật lock.
6. Chạy đầy đủ typecheck, test, build và package gate trước khi tích hợp.
7. Giữ tag `vi-lkg-*` trước đó cho đến khi phiên bản mới đã qua toàn bộ qualification.
8. Rollback là chuyển deployment hoặc bản cài đặt về commit/tag LKG trước đó; không reset hay xoá checkout của người dùng.

## Trình tự qualification

Chạy tuần tự, không chạy đồng thời các full suite:

```powershell
pnpm check:i18n
pnpm --filter @actalk/inkos-studio typecheck
pnpm --filter @actalk/inkos typecheck
pnpm --filter @actalk/inkos-studio run test -- --maxWorkers=1 --minWorkers=1
pnpm --filter @actalk/inkos run test -- --maxWorkers=1 --minWorkers=1
pnpm build
pnpm test
pnpm verify:publish-manifests
pnpm verify:i18n-package
pnpm --filter @actalk/inkos-studio test:e2e
```

Không cập nhật `scripts/i18n-source-lock.json` chỉ để làm CI xanh. Chỉ dùng `--write-lock` sau khi người duyệt đã đối chiếu mọi thay đổi source và xác nhận bản dịch tương ứng vẫn đúng. Không push, merge hay tạo tag LKG nếu chưa có quyền riêng cho hành động đó.
