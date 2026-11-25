function parts(value) {
  const text=String(value||"").replace(/^v/i,"");
  return /^\d+(?:\.\d+){0,3}$/.test(text) ? text.split(".").map(Number) : null;
}
export function shouldShowReleaseNotes(seen,current) {
  const next=parts(current),previous=parts(seen);
  if(!next)return false;
  if(!previous)return true;
  for(let i=0;i<Math.max(next.length,previous.length);i++) {
    const delta=(next[i]||0)-(previous[i]||0);
    if(delta)return delta>0;
  }
  return false;
}
export function createReleaseNotes(doc=document) {
  const dialog=doc.createElement("dialog");
  dialog.className="netease-confirmation release-notes";
  dialog.setAttribute("aria-labelledby","release-notes-title");
  dialog.innerHTML=`<div class="consent-heading"><h2 id="release-notes-title"></h2><button type="button" class="icon-button" data-release="close" aria-label="关闭更新日志"><i class="ph ph-x" aria-hidden="true"></i></button></div>
    <div class="consent-copy current-changelog"></div><footer class="consent-actions"><button type="button" data-release="done" autofocus>知道了</button></footer>`;
  doc.body.append(dialog);
  const title=dialog.querySelector("h2"),copy=dialog.querySelector(".consent-copy"),done=dialog.querySelector('[data-release="done"]');
  let pending=null;
  function finish() {
    if(!pending)return;const resolve=pending;pending=null;
    if(dialog.open)dialog.close();resolve(true);
  }
  done.addEventListener("click",finish);
  dialog.querySelector('[data-release="close"]').addEventListener("click",finish);
  dialog.addEventListener("cancel",event=>{event.preventDefault();finish();});
  dialog.addEventListener("close",()=>{if(!dialog.open)finish();});
  return {dialog,show(version,sections) {
    if(pending)return Promise.resolve(false);
    title.textContent=`v${version} 更新日志`;
    copy.replaceChildren();
    const status=doc.createElement("p");status.textContent="2026-11-25 · RiverXILee桌面歌词";copy.append(status);
    for(const section of sections) {
      const heading=doc.createElement("h3");heading.textContent=section.title;
      const list=doc.createElement("ul");
      for(const text of section.items) {const item=doc.createElement("li");item.textContent=text;list.append(item);}
      copy.append(heading,list);
    }
    return new Promise(resolve=>{pending=resolve;try{dialog.showModal();copy.scrollTop=0;done.focus({preventScroll:true});}catch{pending=null;resolve(false);}});
  }};
}
