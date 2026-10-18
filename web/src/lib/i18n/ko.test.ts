import { setLocale, t, tn, whenLocaleReady } from "./index";

beforeEach(async () => {
  setLocale("ko");
  await whenLocaleReady("ko");
});

afterEach(() => {
  setLocale("en");
});

describe("Korean operator guidance", () => {
  // Instructions must name the translated control, not the English button it replaced.
  it.each([
    ["composer.noEcho.useType", "composer.controls.type"],
    ["composer.noEcho.liveTyped", "composer.controls.type"],
    ["composer.noEcho.liveUntyped", "composer.controls.type"],
    ["composer.protocol.noticeKey", "composer.protocol.commit"],
    ["composer.protocol.unconfirmed", "composer.protocol.commit"],
    ["composer.protocol.capConfirm", "composer.protocol.commitCap"],
  ] as const)("%s names its visible control", (guidance, control) => {
    expect(t(guidance, { harness: "Claude", version: "2.1.0", count: 3 })).toContain(
      `‘${t(control)}’`,
    );
  });

  it("keeps the target host separate from the destructive-command reason", () => {
    expect(t("composer.destructive.confirmOnHost", { host: "개발 서버", reason: "파일 삭제" })).toBe(
      "실행 위치: 개발 서버. 위험한 명령: 파일 삭제. ‘전송’을 다시 눌러 확인하세요.",
    );
  });

  it("puts the machine before its starter in Korean word order", () => {
    expect(t("newPage.summary.starterMachine", { what: "Claude Code", machine: "작업용 PC" })).toBe(
      "작업용 PC에서 Claude Code",
    );
  });

  it("names the multiplexer when switching the operator's terminal pane", () => {
    expect(t("paneActions.focus.labelWithMux", { mux: "tmux" })).toBe("tmux에서 이 창으로 전환");
  });

  it.each([0, 1, 3])("describes %i blocked panes as waiting for input, not denied access", (count) => {
    expect(tn("home.tabs.blocked", count)).toBe(`${count}개 입력 대기`);
  });
});
