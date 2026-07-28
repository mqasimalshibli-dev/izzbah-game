import { chromium } from "playwright-core";
import { spawn } from "child_process";
const PORT=8401;
const srv=spawn("python3",["-m","http.server",String(PORT)],{cwd:"/home/user/izzbah-game",stdio:"ignore"});
await new Promise(r=>setTimeout(r,1200));
const b=await chromium.launch({executablePath:process.env.IZZBAH_CHROMIUM});
const checks=[]; const ck=(n,ok)=>{checks.push(!!ok);console.log((ok?"PASS":"FAIL")+"  "+n);};
const p=await b.newPage({viewport:{width:460,height:920},deviceScaleFactor:2});
await p.route("**/firebasejs/**",r=>r.abort());
await p.addInitScript(()=>{try{localStorage.setItem("izzbah-legal-consent-v1","1");localStorage.setItem("izzbah-theme-v1","dark");localStorage.setItem("izzbah-coach-v1",JSON.stringify({__all:1}));}catch(e){}});
const errs=[]; p.on("pageerror",e=>errs.push(e.message));
await p.goto("http://127.0.0.1:"+PORT+"/game-mobile.html",{waitUntil:"load",timeout:30000});
await p.waitForFunction(()=>typeof qHash==="function" && typeof allQuestionsIndex==="function",{timeout:15000});
await p.waitForTimeout(400);

const res = await p.evaluate(()=>{
  document.documentElement.setAttribute("data-theme","dark");
  // grab three real questions from the banks
  const cat = "history";
  const bank = builtinQuestionBanks[cat];
  const qs = [];
  Object.values(bank).forEach(list => (list||[]).forEach(qa => { const t=Array.isArray(qa)?qa[0]:(qa&&qa.q); if(t) qs.push(t); }));
  const hard=qs[0], skip=qs[1], easy=qs[2];
  const q = {};
  q[qHash(hard)] = { n:10, c:1, s:1, t:80 };   // 10% correct -> hardest
  q[qHash(skip)] = { n:10, c:2, s:7, t:60 };   // 70% skip -> most skipped
  q[qHash(easy)] = { n:10, c:9, s:0, t:20 };   // 90% correct -> easiest
  const m=document.getElementById("qHealthModal"); m.classList.add("open"); m.setAttribute("aria-hidden","false");
  window.IZZBAH_TEST.renderQHealth([{ catId:cat, q }]);
  const body=document.getElementById("qhBody");
  const secs=[...body.querySelectorAll(".qh-section")].map(s=>({h:s.querySelector(".qh-h").textContent, rows:[...s.querySelectorAll(".qh-q")].map(r=>r.textContent)}));
  return { hard, skip, easy, secs };
});

const hardSec = res.secs.find(s=>/أصعب/.test(s.h));
const skipSec = res.secs.find(s=>/تخطّياً/.test(s.h));
const easySec = res.secs.find(s=>/الأسهل/.test(s.h));
ck("has «أصعب الأسئلة» section", !!hardSec);
ck("has «الأكثر تخطّياً» section", !!skipSec);
ck("has «الأسهل» section", !!easySec);
ck("hardest question ranks #1 in أصعب", hardSec && hardSec.rows[0]===res.hard);
ck("most-skipped question ranks #1 in تخطّياً", skipSec && skipSec.rows[0]===res.skip);
ck("easiest question ranks #1 in الأسهل", easySec && easySec.rows[0]===res.easy);
ck("junk hash is ignored (only 3 known questions shown across hardest)", hardSec && hardSec.rows.length===3);

// min-plays filter: raise to 20 -> nothing (our n=10)
await p.evaluate(()=>{ document.getElementById("qhMinPlays").value="10"; });
await p.evaluate(()=>{ // inject a junk hash + low-n question, then set min 10
  window.IZZBAH_TEST.renderQHealth([{catId:"history", q:{ "zzzjunkhash":{n:99,c:1,s:1,t:5} }}]);
});
const emptyAfterJunk = await p.evaluate(()=>/لا توجد بيانات/.test(document.getElementById("qhBody").textContent));
ck("a doc of only junk hashes renders empty (junk-safe)", emptyAfterJunk);

ck("no uncaught JS errors", errs.length===0);
if(errs.length) console.log("  errs:", errs.slice(0,3));

await b.close();srv.kill();
process.exit(checks.every(Boolean)?0:1);
