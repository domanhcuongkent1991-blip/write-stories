export const VI_TUI_COPY = {
  locale: "vi",
  labels: {
    project: "Dự án",
    book: "Tác phẩm",
    depth: "Độ sâu",
    session: "Phiên",
    stage: "Giai đoạn",
    mode: "Chế độ",
    model: "Mô hình",
    error: "Lỗi",
    recent: "Gần đây",
    pending: "Chờ xác nhận",
    draft: "Bản nháp",
    ready: "Sẵn sàng",
    none: "không có",
    notConfigured: "chưa cấu hình",
    unknown: "không rõ",
  },
  modeLabels: {
    auto: "Tự động",
    semi: "Bán tự động",
    manual: "Thủ công",
  },
  composer: {
    placeholder: "Yêu cầu InkOS viết, chỉnh sửa hoặc giải thích…",
    emptyConversation: "Hãy bắt đầu bằng cách cho InkOS biết cần làm gì.",
    helper: "Enter để gửi • /new • /short • /play • /cover • /write • /confirm • /model • /depth • /help",
    submitting: "Đang xử lý…",
    failed: "Yêu cầu gần nhất thất bại",
    ready: "Sẵn sàng",
  },
  notes: {
    help: "Lệnh: /new (tạo sách), /short, /play, /cover, /write, /confirm, /cancel, /model [mô hình], /status, /clear, /depth, /quit. Hãy dùng ngôn ngữ tự nhiên cho các yêu cầu thảo luận và sáng tác khác.",
    status: (stage: string, mode: string) => `Trạng thái: ${stage} (${mode}).`,
    config: "Tính năng /config tương tác chưa có trong bảng điều khiển Ink. Hãy dùng inkos config set-global.",
    depthSet: (depthLabel: string) => `Đã đặt độ sâu suy nghĩ thành ${depthLabel}.`,
    modelCurrent: (modelLabel: string) => `Mô hình hiện tại: ${modelLabel}.`,
    modelSet: (model: string) => `Đã đặt mô hình của phiên TUI hiện tại thành ${model}.`,
    newBookGuide: "Bắt đầu một tác phẩm mới. Hãy mô tả ý tưởng — thể loại, thế giới, nhân vật chính hoặc xung đột cốt lõi. AI sẽ hướng dẫn và gọi khả năng tạo sách khi có đủ thông tin.",
    noLlmConfig: "Chưa tìm thấy cấu hình LLM.",
    setupProvider: "Hãy cấu hình nhà cung cấp API trước.",
  },
  roles: {
    user: "Bạn",
    assistant: "InkOS",
    system: "Hệ thống",
  },
  activity: {
    thinking: "Đang suy nghĩ",
    checking: "Đang kiểm tra",
    writing: "Đang viết",
    reviewing: "Đang duyệt",
    updating: "Đang cập nhật",
  },
  stageLabels: {
    completed: "Đã hoàn tất",
    failed: "Thất bại",
    blocked: "Bị chặn",
    waitingHuman: "Đang chờ quyết định của bạn",
    pausedByUser: "Đã được người dùng tạm dừng",
    readyToContinue: "Sẵn sàng tiếp tục",
  },
  depthLabels: {
    light: "Nhẹ",
    normal: "Tiêu chuẩn",
    deep: "Sâu",
  },
  agent: {
    noPendingAction: "Không có hành động nào đang chờ xác nhận.",
    invalidPendingAction: "Hành động đang chờ không còn hợp lệ. Hãy đề xuất lại.",
    pendingActionCancelled: "Đã hủy hành động đang chờ.",
    confirmTitle: "Xác nhận hành động",
    confirmSummary: "Xác nhận để tiếp tục.",
    confirmHint: "Nhập /confirm để tiếp tục hoặc /cancel để hủy.",
  },
} as const;

export const VI_INTERACTIVE_SETUP_COPY = {
  title: "Cấu hình LLM",
  subtitle: "Cấu hình nhà cung cấp mô hình để bắt đầu sáng tác.",
  steps: {
    provider: "Nhà cung cấp",
    baseUrl: "URL cơ sở",
    apiKey: "Khóa API",
    model: "Mô hình",
    scope: "Phạm vi lưu",
  },
  hints: {
    provider: "openai / anthropic / kkaiapi / custom (proxy tương thích OpenAI)",
    baseUrl: "Điểm cuối API của bạn",
    apiKey: "Dán khóa API của nhà cung cấp đã chọn.",
    model: "ví dụ: gpt-4o, claude-sonnet-4-20250514, deepseek-chat",
    scope: "global = mọi dự án, project = chỉ thư mục này",
  },
  defaults: {
    provider: "openai",
    baseUrl: "(mặc định)",
    scope: "[global]",
  },
  scopeChoices: {
    global: "mọi dự án",
    project: "thư mục này",
  },
  savedTo: "Đã lưu vào",
} as const;

export function buildViAutoInitMessages(projectName: string): {
  readonly initializing: string;
  readonly initialized: string;
  readonly envTemplateHeader: string;
} {
  return {
    initializing: `Đang khởi tạo dự án tại ${projectName}/ ...`,
    initialized: "Đã khởi tạo dự án",
    envTemplateHeader: "# Cấu hình LLM — chạy inkos tui để cấu hình tương tác",
  };
}

export const VI_INTENT_LABELS = {
  write_next: " VIẾT ",
  revise_chapter: " SỬA ",
  rewrite_chapter: " VIẾT LẠI ",
  update_focus: " TRỌNG TÂM ",
  explain_status: " TRẠNG THÁI ",
  explain_failure: " GỠ LỖI ",
  pause_book: " TẠM DỪNG ",
  list_books: " TÁC PHẨM ",
  select_book: " CHỌN ",
  rename_entity: " ĐỔI TÊN ",
  patch_chapter_text: " VÁ ",
  edit_truth: " SỰ THẬT ",
} as const;

export const VI_HELP_SECTIONS = [
  {
    title: "Sáng tác",
    commands: [
      ["/write", "Viết chương tiếp theo bằng toàn bộ pipeline"],
      ["/rewrite <n>", "Viết lại chương N từ đầu"],
    ],
  },
  {
    title: "Điều hướng",
    commands: [
      ["/books", "Yêu cầu agent liệt kê tác phẩm"],
      ["/status", "Hiển thị trạng thái hiện tại"],
    ],
  },
  {
    title: "Điều khiển",
    commands: [["/focus <text>", "Cập nhật trọng tâm hiện tại"]],
  },
  {
    title: "Phiên",
    commands: [
      ["/clear", "Xóa màn hình"],
      ["/help", "Hiển thị trợ giúp"],
      ["/quit", "Thoát InkOS TUI"],
    ],
  },
] as const;

export const VI_HELP_FOOTER = {
  title: "Dùng lệnh slash để thực hiện hành động:",
  examples: ['"/write" "/rewrite 3" "/pause" "/rename Lin Jin => Zhang San"'],
} as const;

export const VI_THEME_LABELS: Readonly<Record<string, string>> = {
  thinking: "Đang suy nghĩ",
  writing: "Đang viết",
  auditing: "Đang kiểm tra",
  revising: "Đang sửa",
  planning: "Đang lập kế hoạch",
  composing: "Đang tổng hợp",
  loading: "Đang tải",
};

export const VI_SLASH_COMMANDS = [
  "/new mô tả ý tưởng của bạn",
  "/short mô tả truyện ngắn",
  "/play [open|guided] mô tả phần mở đầu",
  "/cover mô tả bìa",
  "/write",
  "/confirm",
  "/cancel",
  "/model <model>",
  "/help",
  "/status",
  "/clear",
  "/depth <light|normal|deep>",
  "/quit",
  "/exit",
] as const;
