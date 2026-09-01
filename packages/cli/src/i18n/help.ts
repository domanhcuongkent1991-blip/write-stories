import type { Argument, Command, Option } from "commander";
import type { CliLocale } from "../locale.js";

const COMMAND_HELP_VI: Readonly<Record<string, string>> = {
  inkos: "InkOS — Hệ thống sáng tác tiểu thuyết đa tác tử",
  "inkos init": "Khởi tạo một dự án InkOS mới",
  "inkos config": "Quản lý cấu hình dự án",
  "inkos book": "Quản lý sách",
  "inkos chapter": "Quản lý chương",
  "inkos write": "Viết và quản lý bản thảo chương",
  "inkos auto": "Tự động viết nhiều chương liên tiếp",
  "inkos review": "Xem xét và phê duyệt chương",
  "inkos status": "Hiển thị trạng thái dự án",
  "inkos radar": "Hiển thị radar chất lượng truyện",
  "inkos up": "Khởi động daemon InkOS",
  "inkos down": "Dừng daemon InkOS",
  "inkos doctor": "Kiểm tra cấu hình và môi trường InkOS",
  "inkos export": "Xuất sách sang định dạng phát hành",
  "inkos draft": "Tạo bản nháp chương có hướng dẫn",
  "inkos audit": "Kiểm tra chất lượng và tính liên tục của chương",
  "inkos revise": "Chỉnh sửa chương theo kết quả kiểm tra",
  "inkos agent": "Gửi yêu cầu ngôn ngữ tự nhiên cho tác tử InkOS",
  "inkos plan": "Lập kế hoạch cho chương tiếp theo",
  "inkos compose": "Tổng hợp ngữ cảnh viết chương",
  "inkos genre": "Quản lý hồ sơ thể loại",
  "inkos update": "Hiển thị hướng dẫn cập nhật InkOS",
  "inkos detect": "Phát hiện đặc điểm nội dung chương",
  "inkos style": "Phân tích và quản lý phong cách viết",
  "inkos analytics": "Phân tích dữ liệu sách",
  "inkos eval": "Đánh giá chất lượng bản thảo",
  "inkos import": "Nhập dữ liệu ngoài vào sách",
  "inkos fanfic": "Tạo và quản lý tác phẩm đồng nhân",
  "inkos short": "Tạo truyện ngắn",
  "inkos forecast": "Dự báo hướng phát triển của truyện",
  "inkos translate": "Dịch nội dung sách",
  "inkos studio": "Khởi động giao diện InkOS Studio",
  "inkos consolidate": "Hợp nhất trạng thái và bộ nhớ của sách",
  "inkos interact": "Chạy phiên sáng tác tương tác",
  "inkos tui": "Khởi động giao diện terminal tương tác",
};

const OPTION_HELP_VI: Readonly<Record<string, string>> = {
  "--json": "Xuất JSON",
  "--notify": "Gửi thông báo đến các kênh đã cấu hình khi lệnh kết thúc",
  "--force": "Bỏ qua bước xác nhận",
  "--quiet": "Ẩn thông báo tiến trình không phải JSON",
  "--lang":
    "Ngôn ngữ sáng tác: zh (tiếng Trung) hoặc en (tiếng Anh); vi (tiếng Việt thử nghiệm) chỉ dành cho workflow tiểu thuyết dài",
  "inkos init --lang": "Ngôn ngữ mặc định: zh, en hoặc vi (tiếng Việt thử nghiệm; cần opt-in)",
  "inkos config set-global --lang": "Mặc định toàn cục: zh hoặc en; vi chỉ được bật theo từng project",
  "inkos book create --lang": "Ngôn ngữ sách: zh, en hoặc vi (tiếng Việt thử nghiệm; cần opt-in)",
  "inkos book update --lang": "Ngôn ngữ sách: zh hoặc en; vi không thể migration qua lệnh update",
  "inkos genre create --lang": "Ngôn ngữ template: zh, en hoặc vi (vi dùng scaffold tiếng Anh)",
  "inkos short run --lang": "Ngôn ngữ truyện ngắn: zh (tiếng Trung) hoặc en (tiếng Anh)",
  "inkos fanfic init --lang": "Ngôn ngữ đồng nhân: zh (tiếng Trung) hoặc en (tiếng Anh)",
  "--output": "Đường dẫn tệp đầu ra",
  "--format": "Định dạng đầu ra",
  "--from": "Nguồn đầu vào",
  "--chapter": "Số chương",
  "--words": "Số từ mỗi chương",
  "--brief": "Hướng dẫn sáng tác bổ sung",
  "--service": "Ghi đè dịch vụ LLM cho lần chạy CLI này",
  "--model": "Ghi đè model LLM cho lần chạy CLI này",
  "--api-key-env": "Đọc API key LLM từ biến môi trường này cho lần chạy CLI",
  "--base-url": "Ghi đè URL cơ sở của LLM cho lần chạy CLI này",
  "--api-format": "Ghi đè định dạng API LLM cho lần chạy CLI này",
  "--stream": "Buộc dùng phản hồi LLM dạng stream cho lần chạy CLI này",
  "--no-stream": "Buộc không dùng phản hồi LLM dạng stream cho lần chạy CLI này",
};

const ARGUMENT_HELP_VI: Readonly<Record<string, string>> = {
  "Book ID": "ID sách",
  "Book ID (auto-detected if only one book)": "ID sách (tự nhận diện nếu chỉ có một sách)",
  "Chapter number (defaults to latest)": "Số chương (mặc định là chương mới nhất)",
  "Natural language instruction": "Chỉ dẫn bằng ngôn ngữ tự nhiên",
};

const commandDescriptions = new WeakMap<Command, string>();
const optionDescriptions = new WeakMap<Option, string>();
const argumentDescriptions = new WeakMap<Argument, string>();

function commandPath(command: Command): string {
  const names: string[] = [];
  let current: Command | null = command;
  while (current) {
    names.unshift(current.name());
    current = current.parent;
  }
  return names.join(" ");
}

function semanticOptionFlag(option: Option): string {
  return option.long ?? option.short ?? option.flags;
}

function fallbackCommandDescription(path: string): string {
  return `Thực hiện lệnh ${path}`;
}

function fallbackOptionDescription(path: string, flag: string): string {
  return `Tùy chọn ${flag} cho lệnh ${path}`;
}

function fallbackArgumentDescription(path: string, name: string): string {
  return `Đối số ${name} của lệnh ${path}`;
}

export function applyCliHelpLocale(program: Command, locale: CliLocale): void {
  const visit = (command: Command): void => {
    const path = commandPath(command);
    const originalCommandDescription = commandDescriptions.get(command) ?? command.description();
    commandDescriptions.set(command, originalCommandDescription);
    command.description(locale === "vi"
      ? COMMAND_HELP_VI[path] ?? fallbackCommandDescription(path)
      : originalCommandDescription);

    for (const option of command.options) {
      const originalOptionDescription = optionDescriptions.get(option) ?? option.description;
      optionDescriptions.set(option, originalOptionDescription);
      const semanticKey = `${path} ${semanticOptionFlag(option)}`;
      option.description = locale === "vi"
        ? OPTION_HELP_VI[semanticKey]
          ?? OPTION_HELP_VI[semanticOptionFlag(option)]
          ?? fallbackOptionDescription(path, semanticOptionFlag(option))
        : originalOptionDescription;
    }

    for (const argument of command.registeredArguments) {
      const originalArgumentDescription = argumentDescriptions.get(argument) ?? argument.description;
      argumentDescriptions.set(argument, originalArgumentDescription);
      argument.description = locale === "vi"
          ? ARGUMENT_HELP_VI[`${path} ${argument.name()}`]
          ?? ARGUMENT_HELP_VI[originalArgumentDescription]
          ?? fallbackArgumentDescription(path, argument.name())
        : originalArgumentDescription;
    }

    for (const child of command.commands) visit(child);
  };

  visit(program);
}
