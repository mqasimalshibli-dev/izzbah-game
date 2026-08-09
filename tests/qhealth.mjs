import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT=8401;
const srv=spawn("python3",["-m","http.server",String(PORT)],{cwd:ROOT,stdio:"ignore"});
await new Promise(r=>setTimeout(r,1200));
const b=await chromium.launch({executablePath:process.env.IZZBAH_CHROMIUM});
const checks=[]; const ck=(n,ok)=>{checks.push(!!ok);console.log((ok?"PASS":"FAIL")+"  "+n);};
const p=await b.newPage({viewport:{width:460,height:920},deviceScaleFactor:2});
await p.route("**/firebasejs/**",r=>r.abort());
await p.addInitScript(()=>{try{localStorage.setItem("izzbah-legal-consent-v1","1");localStorage.setItem("izzbah-theme-v1","dark");localStorage.setItem("izzbah-coach-v1",JSON.stringify({__all:1}));}catch(e){}});
const errs=[]; p.on("pageerror",e=>errs.push(e.message));
await p.goto("http://127.0.0.1:"+PORT+"/index.html",{waitUntil:"load",timeout:30000});
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
  // the answer that belongs to `hard`, straight from the bank
  let hardAnswer="";
  Object.values(bank).forEach(list => (list||[]).forEach(qa => {
    const t=Array.isArray(qa)?qa[0]:(qa&&qa.q); if(t===hard) hardAnswer=Array.isArray(qa)?qa[1]:(qa&&qa.a);
  }));
  const q = {};
  q[qHash(hard)] = { n:10, c:1, s:1, t:80 };   // 10% correct -> hardest
  q[qHash(skip)] = { n:10, c:2, s:7, t:60 };   // 70% skip -> most skipped
  q[qHash(easy)] = { n:10, c:9, s:0, t:20 };   // 90% correct -> easiest
  const m=document.getElementById("qHealthModal"); m.classList.add("open"); m.setAttribute("aria-hidden","false");
  window.IZZBAH_TEST.renderQHealth([{ catId:cat, q }]);
  const body=document.getElementById("qhBody");
  const secs=[...body.querySelectorAll(".qh-section")].map(s=>({h:s.querySelector(".qh-h").textContent,
    rows:[...s.querySelectorAll(".qh-q")].map(r=>r.textContent),
    answers:[...s.querySelectorAll(".qh-row")].map(r=>{const a=r.querySelector(".qh-a"); return a?a.textContent.trim():null;})}));
  const firstA=body.querySelector(".qh-a");
  return { hard, skip, easy, hardAnswer, secs,
    answerColour: firstA ? getComputedStyle(firstA).color : "",
    // the answer must sit between the question and the stats, not after them
    answerBeforeMeta: !!(firstA && firstA.compareDocumentPosition(firstA.closest(".qh-row").querySelector(".qh-meta")) & Node.DOCUMENT_POSITION_FOLLOWING) };
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
// «أصعب» and «الأسهل» are the two ends of ONE ranking, so a question may sit in
// one or the other but never in both. They used to be independent slices of the
// same sorted array, which is why a small sample showed the SAME question as the
// hardest and the easiest at once. Each list can now take at most half the rows —
// so with three ranked questions the hard list holds one, not all three. What
// this check guards is that property, not the old count.
ck("no question is both the hardest and the easiest",
   hardSec && easySec && !hardSec.rows.some(r=>easySec.rows.includes(r)));
ck("…and the two lists together never exceed the ranked questions (1+1 of 3)",
   hardSec && easySec && (hardSec.rows.length+easySec.rows.length)<=3);
ck("only questions the client can name are listed",
   res.secs.every(s=>s.rows.every(r=>[res.hard,res.skip,res.easy].includes(r))));

// the answer shows next to each question, so a broken one can be judged in place
ck("every row shows an answer", hardSec && hardSec.answers.every(a=>a && a.length>1));
ck("the answer shown is the RIGHT one for that question",
   hardSec && res.hardAnswer && hardSec.answers[0].includes(res.hardAnswer));
ck("the answer is labelled «الإجابة»", hardSec && /الإجابة/.test(hardSec.answers[0]));
ck("the answer sits under the question, above the stats", res.answerBeforeMeta);
ck("the answer is readable in dark mode (not the light-theme green)",
   res.answerColour && res.answerColour !== "rgb(31, 82, 55)");

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
