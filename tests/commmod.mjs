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
await p.goto("http://127.0.0.1:"+PORT+"/index.html",{waitUntil:"load",timeout:30000});
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

// The unblock control moved OUT of its own «المحتوى المحظور» settings row and
// into the «إبلاغ» sheet, so the settings list carries one report entry named
// exactly like the flag on the board and the 🚩 on a category card. The row now
// only hints at the count; the undo itself lives in the report modal.
const rowShown = await p.evaluate(()=>{
  renderSettingsSheet();
  const r = document.getElementById("settingsReport");
  const st = document.getElementById("settingsReportState");
  return {
    gone: !document.getElementById("settingsBlocked"),      // old row is retired
    label: (r && r.querySelector(".settings-label").textContent || "").trim(),
    always: !!r && !r.hidden,                                // never hidden now
    hint: /مخفية/.test((st && st.textContent) || ""),
  };
});
ck("the old «المحتوى المحظور» row is gone", rowShown.gone);
ck("settings carries one row named «إبلاغ», always visible", rowShown.label==="إبلاغ" && rowShown.always);
ck("…and it hints how many categories are hidden", rowShown.hint);

// The undo lives in the report sheet, and still works from there.
const inSheet = await p.evaluate(async ()=>{
  openReport();
  await new Promise(r=>setTimeout(r,120));
  const row = document.getElementById("reportBlocked");
  const shown = row && !row.hidden;
  const text = document.getElementById("reportBlockedText").textContent;
  document.getElementById("reportUnblock").click();   // window.confirm auto-accepts
  await new Promise(r=>setTimeout(r,120));
  return { shown, text, count: blockedCommCount(), hiddenAfter: document.getElementById("reportBlocked").hidden };
});
ck("the report sheet shows the blocked-content line when something is hidden", inSheet.shown && /أخفيت/.test(inSheet.text));
ck("«إظهار الكل» in the report sheet clears every block", inSheet.count===0);
ck("…and the line disappears once nothing is blocked", inSheet.hiddenAfter===true);

/* ── reporting must tell the TRUTH about delivery (guideline 1.2) ──────────
   ⚠️ sendFeedback REJECTS when signed out; it does not throw. The old code was
   `try { send(body); sent = true } catch {}`, so `sent` was true whatever
   happened and a signed-out player saw «وصل بلاغك للمطوّرين» while the report
   went nowhere — plus an unhandled rejection. A report mechanism that lies
   about delivering is worse than none, because nobody follows up on a report
   they believe arrived.
   ⚠️ All four outcomes are asserted. A happy-path-only test would have PASSED
   against the broken code, because the broken code always claimed success. */
for (const [label, mode, wantDelivered] of [
  ["delivered",              "resolve", true],
  ["rejected (signed out)",  "reject",  false],
  ["throws synchronously",   "throw",   false],
  ["bridge absent entirely", "none",    false],
]) {
  const out = await p.evaluate(async (mode) => {
    localStorage.removeItem("izzbah-blocked-comm-v1");
    window.IZZBAH = window.IZZBAH || {};
    if (mode === "none") delete window.IZZBAH.sendFeedback;
    else if (mode === "resolve") window.IZZBAH.sendFeedback = () => Promise.resolve();
    else if (mode === "reject") window.IZZBAH.sendFeedback = () => Promise.reject(new Error("not signed in"));
    else window.IZZBAH.sendFeedback = () => { throw new Error("boom"); };
    let claimed = "";
    const rt = window.showToast, rn = window.popNote;
    window.showToast = (t) => { claimed = String(t || ""); };
    window.popNote = (t, bd) => { claimed = String(t || "") + " " + String(bd || ""); };
    const cat = { id: "rep-1", community: true, name: "x", authorUid: "a-9" };
    window.IZZBAH_TEST.reportCommunityCategory(cat);
    await new Promise(r => setTimeout(r, 250));
    window.showToast = rt; window.popNote = rn;
    return { claimed, hidden: window.IZZBAH_TEST.isCommBlocked(cat) };
  }, mode);
  ck(`report — ${label}: claims delivery only when it WAS delivered`,
     /وصل بلاغك/.test(out.claimed) === wantDelivered);
  // Hiding is local and unconditional: reporting means "I do not want to see
  // this", and that must not depend on the network.
  ck(`report — ${label}: hidden on this device either way`, out.hidden === true);
  if (!wantDelivered)
    ck(`report — ${label}: points at the published address instead`,
       /izzbahgame@gmail\.com/.test(out.claimed));
}

ck("no uncaught JS errors", errs.length===0);
if(errs.length) console.log("  errs:", errs.slice(0,3));
await b.close();srv.kill();
process.exit(checks.every(Boolean)?0:1);
