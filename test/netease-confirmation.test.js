import test from "node:test";
import assert from "node:assert/strict";
import { CONFIRMATION_STAGES, createNeteaseConfirmation } from "../src/netease-confirmation.js";

function fixture() {
  class Element {
    constructor() { this.handlers = {}; this.children = []; this.dataset = {}; this.open = false; }
    setAttribute() {}
    addEventListener(name, fn) { this.handlers[name] = fn; }
    querySelector(name) { return this.parts[name] ??= new Element(); }
    append(node) { this.children.push(node); }
    replaceChildren() { this.children = []; }
    focus() { this.focused = true; }
    showModal() { this.open = true; }
    close() { this.open = false; this.handlers.close?.(); }
  }
  const doc = { body: new Element(), createElement() { const el = new Element(); el.parts = {}; return el; } };
  const ui = createNeteaseConfirmation(doc);
  return { ...ui, cancelButton: ui.dialog.parts['[data-consent="cancel"]'], acceptButton: ui.dialog.parts['[data-consent="accept"]'] };
}
test("both opening stages and restore use explicit action labels with cancellation focused", async () => {
  const ui = fixture();
  for (const stage of Object.keys(CONFIRMATION_STAGES)) {
    const answer = ui.show({ stage, message: "第一段\n\n第二段" });
    assert.equal(ui.cancelButton.focused, true);
    assert.equal(ui.dialog.parts['.consent-copy'].children.length, 2);
    assert.equal(ui.acceptButton.textContent, CONFIRMATION_STAGES[stage].action);
    ui.cancelButton.handlers.click();
    assert.equal(await answer, false);
  }
});
test("Escape, external close and cleanup cannot approve a request", async () => {
  const ui = fixture();
  for (const exit of [() => ui.dialog.handlers.cancel({ preventDefault() {} }), () => ui.dialog.close(), () => ui.cancel()]) {
    const answer = ui.show({ stage: "risk", message: "本机调试访问风险" });
    exit(); assert.equal(await answer, false);
  }
});
test("a fresh dialog is needed for each approval; stale close events and duplicate requests cannot advance it", async () => {
  const ui = fixture();
  const first = ui.show({ stage: "purpose", message: "重启说明" });
  assert.equal(await ui.show({ stage: "risk", message: "不能覆盖尚未确认的第一步" }), false);
  ui.acceptButton.handlers.click(); assert.equal(await first, true);
  const second = ui.show({ stage: "risk", message: "第二次风险提醒" });
  ui.dialog.handlers.close(); // delayed close from the prior step, while the next dialog is open
  assert.equal(ui.dialog.open, true);
  ui.cancelButton.handlers.click(); assert.equal(await second, false);
  assert.equal(await ui.show({ stage: "unknown", message: "invalid" }), false);
});
