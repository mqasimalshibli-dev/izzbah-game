import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT=8403;
const srv=spawn("python3",["-m","http.server",String(PORT)],{cwd:ROOT,stdio:"ignore"});
await new Promise(r=>setTimeout(r,1200));
const b=await chromium.launch({executablePath:process.env.IZZBAH_CHROMIUM});
const checks=[]; const ck=(n,ok)=>{checks.push(!!ok);console.log((ok?"PASS":"FAIL")+"  "+n);};
const p=await b.newPage({viewport:{width:460,height:900},deviceScaleFactor:1});
await p.route("**/firebasejs/**",r=>r.abort());
await p.addInitScript(()=>{try{localStorage.setItem("izzbah-legal-consent-v1","1");localStorage.setItem("izzbah-coach-v1",JSON.stringify({__all:1}));}catch(e){}});
const errs=[]; p.on("pageerror",e=>errs.push(e.message));
p.on("dialog", d=> d.accept("سبب تجريبي"));
await p.goto("http://127.0.0.1:"+PORT+"/game-mobile.html",{waitUntil:"load",timeout:30000});
await p.waitForFunction(()=>typeof state!=="undefined" && typeof renderCategories==="function" && typeof blockCommunityCategory==="function" && window.IZZBAH && typeof window.IZZBAH.applyAuth==="function",{timeout:15000});
await p.waitForTimeout(400);

// inject a community category by someone else + a captured sendFeedback
await p.evaluate(()=>{
  window.__fb=[];
  window.IZZBAH = window.IZZBAH || {};
  window.IZZBAH.sendFeedback = (t)=>{ window.__fb.push(t); return Promise.resolve(true); };
  state.myUid="me-123";
  state.communityCategories=[{ id:"comm-x", name:"فئة الغريب", community:true, authorUid:"other-999",
    authorName:"لاعب", color:"#7A3D88", questions:[{q:"سؤال؟",a:"جواب",points:100}], votes:2 }];
  state.categoryMode="community";
  renderCategories();
});
const cardSel = '#categoryGrid .category[data-cat-id="comm-x"]';
ck("community card renders with report+block", await p.$(cardSel+" .cat-report")!==null && await p.$(cardSel+" .cat-block")!==null);

// BLOCK (open the flip panel first — that's where the controls live)
await p.evaluate(sel=>document.querySelector(sel).classList.add("showing-info"), cardSel);
await p.evaluate(sel=>document.querySelector(sel+" .cat-block").click(), cardSel);
await p.waitForTimeout(120);
const afterBlock = await p.evaluate(()=>({
  present: !!document.querySelector('#categoryGrid .category[data-cat-id="comm-x"]'),
  blocked: isCommBlocked({id:"comm-x",community:true,authorUid:"other-999"}),
  count: blockedCommCount(),
  stored: !!(JSON.parse(localStorage.getItem("izzbah-blocked-comm-v1")||"{}").authors||[]).length
}));
ck("block hides the card from the picker", afterBlock.present===false);
ck("isCommBlocked true after block", afterBlock.blocked===true);
ck("block stores the author (blocks their other categories too)", afterBlock.stored===true);
ck("blockedCommCount reflects the block", afterBlock.count>=1);

// UNBLOCK ALL
await p.evaluate(()=>{ unblockAllComm(); });
await p.waitForTimeout(100);
const afterUnblock = await p.evaluate(()=>({
  present: !!document.querySelector('#categoryGrid .category[data-cat-id="comm-x"]'),
  count: blockedCommCount()
}));
ck("unblockAll restores the card", afterUnblock.present===true);
ck("unblockAll clears the count", afterUnblock.count===0);

// REPORT (dialog auto-accepts a reason)
await p.evaluate(sel=>{const c=document.querySelector(sel); if(c) c.classList.add("showing-info");}, cardSel);
await p.evaluate(sel=>document.querySelector(sel+" .cat-report").click(), cardSel);
await p.waitForTimeout(150);
const afterReport = await p.evaluate(()=>({
  fbLen: window.__fb.length,
  fbHasId: (window.__fb[0]||"").includes("comm-x"),
  fbIsReport: /بلاغ عن فئة/.test(window.__fb[0]||""),
  present: !!document.querySelector('#categoryGrid .category[data-cat-id="comm-x"]'),
  count: blockedCommCount()
}));
ck("report sends a structured report via feedback", afterReport.fbLen===1 && afterReport.fbIsReport && afterReport.fbHasId);
ck("report also hides the reported category", afterReport.present===false && afterReport.count>=1);

// SETTINGS unblock row appears
const rowShown = await p.evaluate(()=>{ renderSettingsSheet(); const r=document.getElementById("settingsBlocked"); return r && !r.hidden && /إظهار الكل/.test(document.getElementById("settingsBlockedState").textContent); });
ck("settings shows «المحتوى المحظور» unblock row when blocked", rowShown);

ck("no uncaught JS errors", errs.length===0);
if(errs.length) console.log("  errs:", errs.slice(0,3));
await b.close();srv.kill();
process.exit(checks.every(Boolean)?0:1);
