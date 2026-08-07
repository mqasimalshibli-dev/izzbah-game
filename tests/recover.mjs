import { chromium } from "playwright-core";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const PORT=8399;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const srv=spawn("python3",["-m","http.server",String(PORT)],{cwd:ROOT,stdio:"ignore"});
await new Promise(r=>setTimeout(r,1200));
const b=await chromium.launch({executablePath:process.env.IZZBAH_CHROMIUM});
const ok=[]; const ck=(n,v)=>{ok.push(!!v);console.log((v?"PASS":"FAIL")+"  "+n);};
const p=await b.newPage({viewport:{width:900,height:900}});
const errs=[]; p.on("pageerror",e=>errs.push(e.message));

// Seed the cache exactly as loadCategoryMedia writes it: store "cats",
// key "media:<id>", value {ver, qs:[{image,answerImage},...]}.
await p.goto(`http://127.0.0.1:${PORT}/recover.html`,{waitUntil:"load"});
await p.evaluate(() => new Promise(res => {
  const req = indexedDB.open("izzbah-cloud-cache", 1);
  req.onupgradeneeded = () => req.result.createObjectStore("cats");
  req.onsuccess = () => {
    const idb = req.result;
    const tx = idb.transaction("cats","readwrite");
    const s = tx.objectStore("cats");
    s.put({ ver: 1754000000000, qs: [
      {image:"data:image/webp;base64,"+"A".repeat(4000), answerImage:""},
      {image:"data:image/webp;base64,"+"B".repeat(4000), answerImage:"data:image/webp;base64,"+"C".repeat(2000)},
      {image:"", answerImage:""}
    ]}, "media:pub-brands");
    s.put({ ver: 1754000000001, qs: [{image:"",answerImage:""}] }, "media:pub-empty");
    s.put({ some:"unrelated" }, "settings:x");
    tx.oncomplete = () => res();
  };
}));
await p.reload({waitUntil:"load"});
await p.click("#scan");
await p.waitForTimeout(600);
const r = await p.evaluate(()=>({
  text: document.getElementById("out").innerText,
  nextShown: !document.getElementById("next").hidden,
  stopHidden: document.getElementById("stopNote").hidden,
}));
console.log("--- table ---\n"+r.text);
ck("finds the seeded category", /pub-brands/.test(r.text));
ck("counts 3 images (2 question + 1 answer)", /\b3\b/.test(r.text));
ck("ignores non-media keys", !/settings:x|unrelated/.test(r.text));
ck("lists an image-less cached category as 0", /pub-empty/.test(r.text));
ck("totals line present", /المجموع: 3 صورة/.test(r.text));
ck("offers the download once something was found", r.nextShown);
ck("the warning is dismissed after the scan", r.stopHidden);

// the download must carry the actual base64 back out
const dl = await Promise.all([p.waitForEvent("download"), p.click("#dl")]).then(([d])=>d);
const path = await dl.path();
const fs = await import("fs");
const j = JSON.parse(fs.readFileSync(path,"utf8"));
const brands = j.categories.find(c=>c.id==="pub-brands");
ck("download filename", dl.suggestedFilename()==="izzbah-media-backup.json");
ck("download carries the real image data", brands && brands.qs[0].image.length>4000);
ck("download preserves question ORDER (index 2 empty)", brands && brands.qs.length===3 && !brands.qs[2].image);
ck("download records the cache version", brands && brands.ver===1754000000000);

// a device with nothing cached must say so, not crash
const p2=await b.newPage(); p2.on("pageerror",e=>errs.push(e.message));
await p2.goto(`http://127.0.0.1:${PORT}/recover.html`,{waitUntil:"load"});
await p2.click("#scan"); await p2.waitForTimeout(500);
const t2 = await p2.evaluate(()=>document.getElementById("out").innerText);
ck("a device with no cache reports it cleanly", /لا توجد/.test(t2));

ck("no JS errors", errs.length===0);
if(errs.length) console.log(errs.slice(0,3));
await b.close(); srv.kill();
process.exit(ok.every(Boolean)?0:1);
