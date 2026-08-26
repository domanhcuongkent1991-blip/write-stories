import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BASELINE_1_8_KEYS,
  BASE_STRINGS,
  findPlaceholderMismatches,
  formatLocalizedString,
  getPlaceholderNames,
  translateString,
  type StringKey,
} from "./catalog";
import { VI_CATALOG } from "./vi-catalog";

afterEach(() => {
  vi.doUnmock("./vi-catalog");
  vi.resetModules();
});

describe("Studio localization catalog", () => {
  it("translates stable keys without changing the base catalog", () => {
    expect(translateString("nav.books", "vi")).toBe("Sách");
    expect(translateString("nav.books", "en")).toBe("Books");
  });

  it("formats named values and preserves missing placeholders", () => {
    expect(formatLocalizedString("reader.chapterLabel", "vi", { n: 3 })).toContain("3");
    expect(formatLocalizedString("reader.chapterLabel", "en")).toContain("{n}");
  });

  it("returns sorted, unique placeholder names", () => {
    expect(getPlaceholderNames("X {path} {count} {path}")).toEqual(["count", "path"]);
  });

  it("falls back to English when a local VI fixture omits a key", async () => {
    vi.resetModules();
    vi.doMock("./vi-catalog", () => ({
      VI_CATALOG: { "nav.books": "Sách" },
    }));

    const fixtureCatalog = await import("./catalog");
    expect(fixtureCatalog.translateString("nav.newBook", "vi")).toBe("New Book");
  });

  it("provides direct Vietnamese copy for every 1.8.0 baseline key", () => {
    const missingKeys = BASELINE_1_8_KEYS
      .filter((key) => !(key in VI_CATALOG));

    expect(missingKeys).toEqual([]);
  });

  it("preserves every named placeholder in Vietnamese copy", () => {
    expect(findPlaceholderMismatches(BASE_STRINGS, VI_CATALOG)).toEqual([]);
  });

  it("covers baseline action feedback that was previously hard-coded", () => {
    expect(VI_CATALOG).toMatchObject({
      "truth.saveFailed": "Không thể lưu tệp dữ kiện",
      "dash.writeFailed": "Không thể viết chương tiếp theo",
      "reader.saveFailed": "Không thể lưu chương",
      "reader.approveFailed": "Không thể duyệt chương",
      "reader.rejectFailed": "Không thể từ chối chương",
      "book.auditFailed": "Không thể kiểm tra sách",
      "book.exportFailed": "Không thể xuất sách",
      "genre.copiedToProject": "Đã sao chép {id} vào genres/ của dự án",
      "genre.createFailed": "Không thể tạo thể loại",
      "genre.updateFailed": "Không thể cập nhật thể loại",
      "genre.deleteFailed": "Không thể xóa thể loại",
    });
  });

  it("provides direct Vietnamese copy for Book Detail and first-run chrome", () => {
    expect(VI_CATALOG).toMatchObject({
      "book.rewriteBriefPrompt": "Tùy chọn: nhập yêu cầu bổ sung chỉ áp dụng cho lần viết lại này. Để trống để dùng trọng tâm hiện có.",
      "book.reviseBriefPrompt": "Tùy chọn: nhập yêu cầu bổ sung chỉ áp dụng cho lần chỉnh sửa này. Để trống để dùng trọng tâm hiện có.",
      "book.syncBriefPrompt": "Tùy chọn: nhập hướng dẫn bổ sung để diễn giải nội dung chương đã chỉnh sửa. Để trống để đồng bộ trực tiếp từ văn bản.",
      "book.consolidateComplete": "Đã hợp nhất {archived} bản tóm tắt tập và giữ lại {retained} bản tóm tắt chương gần nhất.",
      "book.foundationFeedbackPrompt": "Nhập phản hồi để chỉnh sửa nền tảng. Thao tác này viết lại nền tảng của sách, không sửa trực tiếp nội dung chương.",
      "book.foundationRevised": "Đã chỉnh sửa nền tảng.",
      "book.planContextPrompt": "Tùy chọn: nhập ngữ cảnh bổ sung để lập kế hoạch cho chương tiếp theo.",
      "book.planComplete": "Đã lập kế hoạch chương {chapter}: {title}",
      "book.composeContextPrompt": "Tùy chọn: nhập ngữ cảnh bổ sung để soạn chương tiếp theo.",
      "book.composeComplete": "Đã soạn chương {chapter}: {title}",
      "book.stateRepaired": "Đã sửa trạng thái chương {chapter}.",
      "book.syncEditedChapter": "Đồng bộ dữ kiện/trạng thái từ chương đã chỉnh sửa",
      "languageSelector.interfaceLanguage": "Ngôn ngữ giao diện",
      "languageSelector.chineseTitle": "Sáng tác bằng tiếng Trung",
      "languageSelector.chineseGenres": "Huyền huyễn · Tiên hiệp · Đô thị · Kinh dị · Tổng hợp",
      "languageSelector.chinesePlatforms": "Fanqie Novel · Qidian · Faloo",
      "languageSelector.englishTitle": "Sáng tác bằng tiếng Anh",
      "languageSelector.englishGenres": "LitRPG · Thăng cấp · Kỳ ảo lãng mạn · Khoa học viễn tưởng · Dị giới",
      "languageSelector.englishPlatforms": "Royal Road · Kindle Unlimited · Scribble Hub",
      "languageSelector.footer": "Có thể thay đổi trong phần Cài đặt",
    });
  });
});
