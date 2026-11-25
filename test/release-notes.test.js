import test from "node:test";
import assert from "node:assert/strict";
import {createReleaseNotes,shouldShowReleaseNotes} from "../src/release-notes.js";
test("only first install or a newer numeric public version triggers automatic notes",()=>{
  for(const [seen,current,expected] of [["","1.2.0.2",true],["1.2.0.1","1.2.0.2",true],["1.2.0.2","1.2.0.2",false],
    ["1.2.0.2","1.2.0.3",true],["1.2.0.9","1.2.0.10",true],["1.2.0.3","1.2.0.2",false],["broken","1.2.0.2",true],
    ["v1.2.0.2","1.2.0.2",false],["1.2.0.1","invalid",false]]) assert.equal(shouldShowReleaseNotes(seen,current),expected,`${seen} -> ${current}`);
});
function fixture(){
  class Element {
    constructor(){this.handlers={};this.children=[];this.parts={};this.open=false;}
    setAttribute(){} addEventListener(name,fn){this.handlers[name]=fn;} querySelector(key){return this.parts[key]??=new Element();}
    append(...nodes){this.children.push(...nodes);} replaceChildren(){this.children=[];} focus(){this.focused=true;}
    showModal(){this.open=true;} close(){this.open=false;this.handlers.close?.();}
  }
  const doc={body:new Element(),createElement(){return new Element();}};
  return createReleaseNotes(doc);
}
test("notes are read safely as text and close, Escape or done all acknowledge a displayed window",async()=>{
  const ui=fixture(),sections=[{title:"同步优化",items:["原文件校验","<img src=x onerror=evil()>"]}];
  for(const dismiss of [()=>ui.dialog.parts['[data-release="done"]'].handlers.click(),()=>ui.dialog.parts['[data-release="close"]'].handlers.click(),()=>ui.dialog.handlers.cancel({preventDefault(){}})]){
    const answer=ui.show("1.2.0.2",sections);assert.equal(ui.dialog.parts.h2.textContent,"v1.2.0.2 更新日志");
    assert.equal(ui.dialog.parts[".consent-copy"].children[2].children[1].textContent,"<img src=x onerror=evil()>");
    assert.equal(await ui.show("1.2.0.2",sections),false);dismiss();assert.equal(await answer,true);
  }
});
test("failure to open notes never counts as read",async()=>{
  const ui=fixture();ui.dialog.showModal=()=>{throw Error("unavailable")};assert.equal(await ui.show("1.2.0.2",[]),false);
});
