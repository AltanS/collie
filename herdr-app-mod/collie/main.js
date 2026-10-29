// Collie in herdr-app: is the bridge up, on which port and version, where does the phone go, and
// a pairing code with its QR code when you ask for one. Start, Stop, Restart and Open run
// `collie start|stop|restart` and the system's browser, so the panel knows nothing about systemd
// or launchd. The decisions are in model.js; this file draws them and runs what they name.
//
// Props (optional, from the layout): { "instance": "<name>" } watches a named Collie instance
// instead of the host's default one (Linux and macOS).
// Keys: bind "collie.start", "collie.stop", "collie.restart", "collie.pair" or "collie.open".

import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { exec, props, closeOverlay, theme, settings, window as appWindow, nextCommand } from "herdr";
import {
  POLL_MS,
  BUSY_LABEL,
  actions,
  collieCommand,
  describe,
  minutesLeft,
  moduleSize,
  openCommand,
  pickInstance,
  qrRuns,
  readHealth,
  readPair,
  readStatus,
  summary,
} from "./model.js";

const MONO = () => String(settings().font_family ?? "JetBrains Mono");

export default class Collie extends View {
  init(_props, cx) {
    this.status = null;
    this.health = null;
    this.problem = null;
    this.busy = null;
    this.note = null;
    this.pairing = null;
    this.armed = false;
    this.width = 300;
    this.platform = appWindow()?.platform ?? "linux";
    const picked = pickInstance(props());
    this.instance = picked.ok ? picked.instance : null;
    if (!picked.ok) this.problem = { kind: "instance", text: picked.reason };
    this.refresh(cx);
    cx.timer.every(POLL_MS, (tick) => this.refresh(tick));
    cx.spawn(async (task) => {
      for (;;) {
        const command = await nextCommand();
        this.onCommand(command, task);
        task.notify();
      }
    });
  }

  onCommand(command, cx) {
    const can = this.can();
    if (command === "start" && can.start) this.act("start", cx);
    else if (command === "stop" && can.stop) this.act("stop", cx);
    else if (command === "restart" && can.restart) this.act("restart", cx);
    else if (command === "pair" && can.pair) this.pair(cx);
    else if (command === "open" && can.open) this.open(cx);
  }

  can() {
    return actions({ status: this.status, busy: this.busy, problem: this.problem });
  }

  /** One `collie <verb>`, or null when this platform cannot name the instance. */
  async collie(verb) {
    const cmd = collieCommand(verb, this.instance, this.platform);
    if (cmd === null) return null;
    return exec(cmd.command, cmd.args);
  }

  refresh(cx) {
    if (this.problem?.kind === "instance") return;
    // One look at a time; a look asked for during one runs again when it ends.
    if (this.loading) {
      this.again = true;
      return;
    }
    this.loading = true;
    this.again = false;
    cx.spawn(async (task) => {
      try {
        const result = await this.collie("status");
        if (result === null) {
          this.problem = { kind: "instance", text: "Named instances need Linux or macOS in this panel." };
          return;
        }
        const read = readStatus(result);
        if (!read.ok) {
          this.problem = read;
          if (read.kind === "old") this.status = null;
          return;
        }
        this.problem = null;
        this.status = read.status;
        this.health = read.status.running ? await this.readHealth(read.status.localUrl) : null;
      } catch {
        // `exec` rejects only when the program cannot start: no collie (or no env) on PATH.
        this.problem = { kind: "missing" };
        this.status = null;
        this.health = null;
      } finally {
        this.loading = false;
        task.notify();
        if (this.again) this.refresh(task);
      }
    });
  }

  async readHealth(localUrl) {
    if (!localUrl.startsWith("http://")) return null;
    try {
      const response = await fetch(`${localUrl.replace(/\/+$/, "")}/api/health`);
      return response.ok ? readHealth(await response.json()) : null;
    } catch {
      return null;
    }
  }

  act(verb, cx) {
    this.busy = verb;
    this.armed = false;
    this.note = null;
    if (verb === "stop") this.pairing = null;
    cx.notify();
    cx.spawn(async (task) => {
      try {
        const result = await this.collie(verb);
        if (result === null) return;
        const line = summary(result);
        this.note = { error: result.code !== 0, text: line || (result.code === 0 ? "Done." : `collie ${verb} failed.`) };
      } catch (err) {
        this.note = { error: true, text: String(err?.message ?? err) };
      } finally {
        this.busy = null;
        task.notify();
        this.refresh(task);
      }
    });
  }

  pair(cx) {
    this.busy = "pair";
    this.note = null;
    cx.notify();
    cx.spawn(async (task) => {
      try {
        const result = await this.collie("pair");
        if (result === null) return;
        const read = readPair(result, Date.now());
        if (!read.ok) {
          this.note = {
            error: true,
            text: read.kind === "old" ? "This Collie is too old to show a code here. Run collie update." : read.text,
          };
          return;
        }
        this.pairing = read.pairing;
        // The code dies on its own at expiry; drop it from the panel then, and keep nothing.
        const code = read.pairing.code;
        task.timer.after(Math.max(0, read.pairing.expiresAt - Date.now()), (tick) => {
          if (this.pairing?.code !== code) return;
          this.pairing = null;
          this.note = { error: false, text: "The pairing code expired. Make a new one when the phone is ready." };
          tick.notify();
        });
      } catch (err) {
        this.note = { error: true, text: String(err?.message ?? err) };
      } finally {
        this.busy = null;
        task.notify();
      }
    });
  }

  open(cx) {
    const url = this.status?.phoneUrl;
    if (!url) return;
    const cmd = openCommand(this.platform, url);
    cx.spawn(async (task) => {
      try {
        const result = await exec(cmd.command, cmd.args);
        if (result.code !== 0) this.note = { error: true, text: summary(result) || `Could not open ${url}.` };
      } catch {
        this.note = { error: true, text: `No ${cmd.command} here to open ${url}.` };
      }
      task.notify();
    });
  }

  // ── drawing ────────────────────────────────────────────────────────────────

  button(t, id, label, enabled, onClick, kind = "plain") {
    const armed = kind === "armed";
    const solid = kind === "solid";
    const bg = armed ? `${t.blocked}1a` : solid ? t.solid : t.raised;
    const fg = armed ? t.blocked : solid ? t.solid_foreground : t.foreground;
    const edge = armed ? t.blocked : solid ? t.solid : t.input;
    return h_flex()
      .id(id)
      .flex_1()
      .min_w(0)
      .h(28)
      .px(8)
      .justify_center()
      .items_center()
      .rounded(2)
      .border_1()
      .border_color(edge)
      .bg(bg)
      .text_color(fg)
      .text_size(12)
      .when(!enabled, (el) => el.opacity(0.45))
      .when(enabled, (el) =>
        el
          .cursor_pointer()
          .hover((s) => s.opacity(0.88))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            onClick(cx);
          }),
      )
      .child(div().truncate().child(label));
  }

  mark(t, kind) {
    // A shape first, a colour second (DESIGN.md §3): a filled disc runs, a ring does not.
    const box = div().size(12).flex_none().rounded(6);
    if (kind === "running") return box.bg(t.done);
    if (kind === "problem") return box.border_2().border_color(t.blocked);
    return box.border_2().border_color(t.dim);
  }

  row(t, label, value) {
    return h_flex()
      .gap(8)
      .min_w(0)
      .text_size(12)
      .child(div().w(64).flex_none().text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(value));
  }

  qr(t, rows) {
    const runs = qrRuns(rows);
    const size = moduleSize(Math.min(this.width - 32, 260), rows.length);
    // Dark on white whatever the theme: an inverted code is the one phone cameras read worst.
    return v_flex()
      .flex_none()
      .bg("#ffffff")
      .children(
        runs.map((row, r) =>
          h_flex()
            .id(`qr-${r}`)
            .h(size)
            .children(row.map((run) => div().h(size).w(run.length * size).bg(run.dark ? "#000000" : "#ffffff"))),
        ),
      );
  }

  pairingBlock(t) {
    const p = this.pairing;
    const left = minutesLeft(p.expiresAt, Date.now());
    return v_flex()
      .gap(10)
      .p(12)
      .rounded(2)
      .border_1()
      .border_color(t.border)
      .bg(t.surface)
      .child(div().text_size(12).text_color(t.muted).child("Pairing code"))
      .child(
        div()
          .font_family(MONO())
          .text_size(26)
          .font_semibold()
          .text_color(t.foreground)
          .child(p.code),
      )
      .when(p.qr !== null, (el) => el.child(h_flex().justify_center().child(this.qr(t, p.qr))))
      .child(
        div()
          .text_size(12)
          .text_color(t.muted)
          .child(
            p.qr !== null
              ? "Scan the code with the phone's camera. Or open Collie on the phone, go to Settings and enter the code."
              : "Open Collie on the phone, go to Settings and enter the code. There is no QR code: Collie knows no phone URL.",
          ),
      )
      .child(
        div()
          .text_size(12)
          .text_color(t.dim)
          .child(
            `Single use. It stops working in ${left} ${left === 1 ? "minute" : "minutes"}.` +
              (p.replaced ? " The code you made before no longer works." : ""),
          ),
      )
      .child(
        h_flex().child(
          this.button(t, "pair-hide", "Hide code", true, (cx) => {
            this.pairing = null;
            cx.notify();
          }),
        ),
      );
  }

  render() {
    const t = theme();
    const state = { status: this.status, health: this.health, problem: this.problem, busy: this.busy };
    const view = describe(state);
    const can = this.can();
    const overlay = props()?.overlay;
    const label = (verb, text) => (this.busy === verb ? BUSY_LABEL[verb] : text);
    const running = this.status?.running === true;
    const url = this.status?.phoneUrl ?? null;

    return v_flex()
      .id("collie-root")
      .on_size_change((size, cx) => {
        this.width = size.width;
        cx.notify();
      })
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .text_color(t.foreground)
      .child(
        h_flex()
          .flex_none()
          .h(36)
          .px(14)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(div().flex_1().text_size(13).font_semibold().child("Collie"))
          .when(Boolean(overlay), (el) =>
            el.child(
              div()
                .id("collie-close")
                .px(6)
                .text_color(t.dim)
                .cursor_pointer()
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => closeOverlay(overlay))
                .child("Close"),
            ),
          ),
      )
      .child(
        v_flex()
          .id("collie-body")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .p(14)
          .gap(14)
          .child(
            v_flex()
              .gap(6)
              .child(h_flex().gap(8).items_center().child(this.mark(t, view.mark)).child(div().text_size(14).font_semibold().child(view.headline)))
              .when(view.detail !== "", (el) => el.child(div().text_size(12).text_color(t.muted).child(view.detail))),
          )
          .when(view.rows.length > 0, (el) => el.child(v_flex().gap(4).children(view.rows.map((r) => this.row(t, r.label, r.value)))))
          .when(url !== null, (el) =>
            el.child(
              v_flex()
                .gap(4)
                .child(div().text_size(12).text_color(t.dim).child("Phone URL"))
                .child(
                  div()
                    .font_family(MONO())
                    .text_size(12)
                    .child(TextView.markdown("collie-url", `[${url}](${url})`).selectable(true)),
                ),
            ),
          )
          .when(this.status !== null, (el) =>
            el.child(
              v_flex()
                .gap(6)
                .child(
                  h_flex()
                    .gap(6)
                    .child(this.button(t, "collie-start", label("start", "Start"), can.start, (cx) => this.act("start", cx), running ? "plain" : "solid"))
                    .child(
                      this.button(
                        t,
                        "collie-stop",
                        this.busy === "stop" ? BUSY_LABEL.stop : this.armed ? "Confirm stop" : "Stop",
                        can.stop,
                        (cx) => {
                          if (!this.armed) {
                            // Stopping cuts the phone off, so the first tap only arms it.
                            this.armed = true;
                            cx.timer.after(4000, (tick) => {
                              this.armed = false;
                              tick.notify();
                            });
                            cx.notify();
                            return;
                          }
                          this.act("stop", cx);
                        },
                        this.armed ? "armed" : "plain",
                      ),
                    )
                    .child(this.button(t, "collie-restart", label("restart", "Restart"), can.restart, (cx) => this.act("restart", cx))),
                )
                .child(
                  h_flex()
                    .gap(6)
                    .child(this.button(t, "collie-open", "Open URL", can.open, (cx) => this.open(cx)))
                    .child(this.button(t, "collie-push", label("push-test", "Test push"), can.pushTest, (cx) => this.act("push-test", cx))),
                ),
            ),
          )
          .when(this.note !== null, (el) =>
            el.child(
              div()
                .text_size(12)
                .text_color(this.note.error ? t.blocked : t.muted)
                .child(this.note.text),
            ),
          )
          .when(this.status !== null && this.pairing === null && this.status.crew !== "peer", (el) =>
            el.child(
              v_flex()
                .gap(6)
                .pt(10)
                .border_t(1)
                .border_color(t.border)
                .child(div().text_size(12).text_color(t.muted).child("Pair a phone: Collie makes a single-use code, good for 10 minutes."))
                .child(h_flex().child(this.button(t, "collie-pair", label("pair", "Pair a phone"), can.pair, (cx) => this.pair(cx), "solid"))),
            ),
          )
          .when(this.pairing !== null, (el) => el.child(this.pairingBlock(t))),
      );
  }
}
