import { chromium } from "playwright-core";
import { spawn } from "child_process";
const server = spawn("python3",["-m","http.server","8398"],{cwd:"/home/user/izzbah-game",stdio:"ignore"});
await new Promise(r=>setTimeout(r,1200));
const b=await chromium.launch({executablePath:process.env.IZZBAH_CHROMIUM});
for(const reserve of [250,290,320]){
  for(const [vw,vh] of [[1180,820],[1024,768],[820,460]]){
    const p=await b.newPage({viewport:{width:vw,height:vh}});
    await p.route("**/firebasejs/**",r=>r.abort());
    await p.addInitScript(()=>{try{localStorage.setItem("izzbah-legal-consent-v1","1");}catch(e){}});
    await p.goto("http://127.0.0.1:8398/game-mobile.html",{waitUntil:"load"});
    await p.waitForTimeout(1300);
    const res=await p.evaluate((reserve)=>{
      // override the cap live
      const st=document.createElement("style");
      st.textContent=`#questionPage .question-main-card .question-text{max-height:calc(var(--game-vh,100dvh) - ${reserve}px)!important;}`;
      document.head.appendChild(st);
      state.teamCount=2;state.teams=[{name:"أ",helpers:["fourChoices","firstLetter","doublePoints"],helpUsed:{},score:0},{name:"ب",helpers:["fourChoices","firstLetter","doublePoints"],helpUsed:{},score:0}];state.activeTeam=0;
      const cat={id:"x",name:"تاريخ"};const q={q:"ما هو ".repeat(60)+"؟",a:"ج",points:100};
      state.activeQuestion={cat,q,key:"t",team:0};fillQuestionContent(cat,q);showScreen("questionPage",{keepQuestion:true});
      renderTeamHelpBar(document.getElementById("questionHelpBar"),0,"question");
      const t=document.getElementById("modalQuestion").getBoundingClientRect();const rv=document.getElementById("revealAnswer").getBoundingClientRect();
      const v=Math.min(t.bottom,rv.bottom)-Math.max(t.top,rv.top);const h=Math.min(t.right,rv.right)-Math.max(t.left,rv.left);
      return (h>1&&v>1)?v:0;
    },reserve);
    console.log(`reserve=${reserve} ${vw}x${vh}: revealOverlap=${res}`);
    await p.close();
  }
}
await b.close();server.kill();
