import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ONBOARDING_STEPS, tourPlacement, clipTourTarget } from "../src/onboarding.js";

test("tour covers real controls with seven skippable, replayable steps", () => {
  const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  assert.equal(ONBOARDING_STEPS.length, 7);
  assert.equal(ONBOARDING_STEPS.at(-1).target, "#onboarding-replay-button");
  assert.ok(source.includes('onboardingDismissed: state.onboardingDismissed'));
  assert.ok(source.includes('loadJson(ONBOARDING_KEY, "onboardingDismissed", false)'));
  assert.ok(source.includes('if (onboarding.active && locked)'));
});

test("tour card stays inside small and large windows and avoids the highlighted control", () => {
  for (const viewport of [{ width: 640, height: 280 }, { width: 640, height: 360 }, { width: 1080, height: 600 }, { width: 1920, height: 1080 }]) {
    const card = { width: 336, height: 218 };
    for (const target of [
      { left: viewport.width - 150, right: viewport.width - 18, top: 32, bottom: 100 },
      { left: 20, right: 150, top: viewport.height - 64, bottom: viewport.height - 18 },
    ]) {
      const point = tourPlacement(target, card, viewport);
      assert.ok(point.left >= 12 && point.top >= 12);
      assert.ok(point.left + card.width <= viewport.width - 12);
      assert.ok(point.top + card.height <= viewport.height - 12);
      const overlaps = point.left < target.right && point.left + card.width > target.left
        && point.top < target.bottom && point.top + card.height > target.top;
      assert.equal(overlaps, false);
    }
  }
});

test("tour isolates dim-area input and wraps Tab without disabling its real target", () => {
  const source = readFileSync(new URL("../src/onboarding.js", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/onboarding.css", import.meta.url), "utf8");
  assert.match(styles, /\.tour-shield\s*\{[^}]*pointer-events:\s*auto/);
  assert.ok(source.includes('Array.from({ length: 4 }'));
  assert.ok(source.includes('event.key === "Tab"'));
  assert.ok(source.includes('current === buttons.length - 1'));
  assert.ok(source.includes('event.shiftKey && current === 0'));
});

test("tour highlights only the visible part of a scrolled settings target", () => {
  assert.deepEqual(clipTourTarget({ left: 350, right: 650, top: 110, bottom: 490 },
    { width: 640, height: 360 }, { left: 340, right: 610, top: 90, bottom: 320 }),
  { left: 350, right: 610, top: 110, bottom: 320, width: 260, height: 210 });
  assert.equal(clipTourTarget({ left: 10, right: 100, top: -90, bottom: -10 }, { width: 640, height: 360 }), null);
  assert.equal(clipTourTarget(null, { width: 640, height: 360 }), null);
});

test("compact guide can sit beside a full-height settings target without overlap", () => {
  const target = { left: 350, right: 610, top: 100, bottom: 320 };
  const card = { width: 296, height: 280 };
  const point = tourPlacement(target, card, { width: 640, height: 360 });
  assert.ok(point.left + card.width < target.left);
  assert.ok(point.top >= 12 && point.top + card.height <= 348);
});
