import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url"; import { dirname, join } from "path";
const ROOT=join(dirname(fileURLToPath(import.meta.url)),"..");
const PORT=8406;
const srv=spawn("python3",["-m","http.server",String(PORT)],{cwd:ROOT,stdio:"ignore"});
await new Promise(r=>setTimeout(r,1200));
const b=await chromium.launch({executablePath:process.env.IZZBAH_CHROMIUM});
const checks=[]; const ck=(n,ok)=>{checks.push(!!ok);console.log((ok?"PASS":"FAIL")+"  "+n);};
const p=await b.newPage({viewport:{width:460,height:900},deviceScaleFactor:1});
await p.route("**/firebasejs/**",r=>r.abort());
await p.addInitScript(()=>{try{localStorage.setItem("izzbah-legal-consent-v1","1");localStorage.setItem("izzbah-coach-v1",JSON.stringify({__all:1}));}catch(e){}});
const errs=[]; p.on("pageerror",e=>errs.push(e.message));
await p.goto("http://127.0.0.1:"+PORT+"/game-mobile.html",{waitUntil:"load",timeout:30000});
await p.waitForFunction(()=>typeof state!=="undefined" && typeof openReport==="function",{timeout:15000});
await p.waitForTimeout(300);

ck("«الأسئلة المُجابة» progress bar removed", await p.evaluate(()=>!document.getElementById("gameProgress") && !document.body.innerHTML.includes("الأسئلة المُجابة")));
ck("in-game report button exists", await p.$("#reportGame")!==null);

// capture feedback + open report, type, send
const out = await p.evaluate(async ()=>{
  window.__fb=[];
  window.IZZBAH=window.IZZBAH||{};
  window.IZZBAH.sendFeedback=(t)=>{ window.__fb.push(t); return Promise.resolve(true); };
  openReport();
  const open1 = document.getElementById("reportModal").classList.contains("open");
  document.getElementById("reportText").value = "السؤال رقم ٣ إجابته غلط";
  sendReport();
  await new Promise(r=>setTimeout(r,80));
  return { open1, fb: window.__fb, closed: !document.getElementById("reportModal").classList.contains("open") };
});
ck("report button opens the text-box modal", out.open1===true);
ck("send posts the report via feedback channel", out.fb.length===1 && /بلاغ من داخل اللعبة/.test(out.fb[0]) && out.fb[0].includes("إجابته غلط"));
ck("modal closes after send", out.closed===true);

// empty send shows a hint, does not post
const empty = await p.evaluate(()=>{
  window.__fb=[]; openReport(); document.getElementById("reportText").value=""; sendReport();
  return { posted: window.__fb.length, hint: document.getElementById("reportStatus").textContent };
});
ck("empty report is blocked with a hint", empty.posted===0 && /اكتب/.test(empty.hint));

ck("no uncaught JS errors", errs.length===0);
if(errs.length) console.log("  errs:", errs.slice(0,3));
await b.close();srv.kill();
process.exit(checks.every(Boolean)?0:1);
