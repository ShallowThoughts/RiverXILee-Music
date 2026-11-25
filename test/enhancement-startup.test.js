import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {requireEnhancementConsent} from "../src/enhancement-startup.js";
import {CONFIRMATION_STAGES} from "../src/netease-confirmation.js";
test("fresh install enters only after explicit backend approval; refusal and errors quit",async()=>{
  for(const response of [{approved:true},{approved:false},null,new Error("timeout")]) {
    const calls=[];
    const result=await requireEnhancementConsent({read:async()=>({approved:false}),confirm:async()=>{calls.push("confirm");if(response instanceof Error)throw response;return response;},quit:async()=>calls.push("quit")});
    assert.equal(result,response?.approved===true);
    assert.deepEqual(calls,response?.approved===true?["confirm"]:["confirm","quit"]);
  }
});
test("current consent skips the prompt, but missing or corrupt storage does not",async()=>{
  assert.equal(await requireEnhancementConsent({read:async()=>({approved:true}),confirm:()=>{throw Error("must not prompt");},quit:()=>{throw Error("must not quit");}}),true);
  let quit=0;await requireEnhancementConsent({read:async()=>{throw Error("corrupt")},confirm:()=>{throw Error("no authority")},quit:async()=>quit++});assert.equal(quit,1);
});
test("first-use dismissal means exit, never a route into the main UI",()=>{
  const stage=CONFIRMATION_STAGES["startup-enhancements"];
  assert.equal(stage.action,"同意并进入");assert.equal(stage.cancel,"退出应用");
  const main=readFileSync(new URL("../src/main.js",import.meta.url),"utf8");
  assert.ok(main.indexOf("await requireEnhancementConsent")<main.indexOf('const nativePreferences'));
  assert.ok(!main.includes('id="netease-control-button"'));assert.ok(!main.includes('id="kugou-control-button"'));
  assert.ok(main.includes("restore-enhancements-requested"));
});
