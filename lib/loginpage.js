import crypto from "crypto";

// Sign-in and message pages of the OAuth flow. Each is one self-contained HTML document: no external fonts, scripts
// or images (the page handles passwords). Inline <style>/<script> carry a per-response nonce, so a strict CSP can be used.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const CSS = String.raw`
:root{color-scheme:dark;--bg:#05060a;--ink:#eef0f6;--mute:#98a0b8;--dim:#6b7390;--line:rgba(255,255,255,.1);--red:#e5484d;--red2:#ff7a59;--amber:#f5a524;--teal:#2dd4bf;--ease:cubic-bezier(.2,.8,.2,1)}
@property --a{syntax:"<angle>";inherits:false;initial-value:0deg}
*{box-sizing:border-box}
html,body{min-height:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 ui-sans-serif,system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;overflow-x:hidden}

/* ---- backdrop: aurora, horizon glow, film grain, vignette, stardust ---- */
.sky{position:fixed;inset:0;overflow:hidden;z-index:0}
.blob{position:absolute;display:block;border-radius:50%;filter:blur(70px);opacity:.55;will-change:transform}
.b1{width:60vmax;height:60vmax;left:-15vmax;top:-20vmax;background:radial-gradient(circle,rgba(229,72,77,.75),transparent 62%);animation:d1 26s ease-in-out infinite alternate}
.b2{width:55vmax;height:55vmax;right:-18vmax;top:10vh;background:radial-gradient(circle,rgba(91,108,255,.7),transparent 62%);animation:d2 32s ease-in-out infinite alternate}
.b3{width:45vmax;height:45vmax;left:20vw;bottom:-25vmax;background:radial-gradient(circle,rgba(45,212,191,.45),transparent 62%);animation:d3 38s ease-in-out infinite alternate}
@keyframes d1{to{transform:translate(18vmax,12vmax) scale(1.15)}}
@keyframes d2{to{transform:translate(-14vmax,10vmax) scale(.9)}}
@keyframes d3{to{transform:translate(12vmax,-8vmax) scale(1.2)}}
.horizon{position:absolute;left:0;right:0;bottom:0;height:45vh;background:linear-gradient(to top,rgba(229,72,77,.13),transparent)}
.grain{position:absolute;inset:-50%;opacity:.07;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>");animation:gr 1.2s steps(6) infinite}
@keyframes gr{0%{transform:translate(0,0)}20%{transform:translate(-3%,2%)}40%{transform:translate(2%,-3%)}60%{transform:translate(-2%,-1%)}80%{transform:translate(3%,2%)}100%{transform:translate(0,0)}}
.vig{position:absolute;inset:0;background:radial-gradient(ellipse at center,transparent 45%,rgba(0,0,0,.75) 100%)}
#fx{position:fixed;inset:0;width:100%;height:100%;z-index:1;pointer-events:none}

/* ---- cinematic letterbox that opens at load ---- */
.lb{position:fixed;left:0;right:0;height:17vh;background:#000;z-index:60;pointer-events:none;animation:lb 1.5s var(--ease) .25s forwards}
.lb.t{top:0}.lb.b{bottom:0}
@keyframes lb{to{height:0}}

/* ---- layout ---- */
.stage{position:relative;z-index:2;min-height:100vh;min-height:100dvh;display:grid;align-items:center;gap:clamp(24px,5vw,72px);padding:clamp(20px,5vw,72px);max-width:1240px;margin:0 auto}
.stage.solo{grid-template-columns:1fr}
.stage:not(.solo){grid-template-areas:"hero" "card" "guide"}
.stage:not(.solo) .hero{grid-area:hero}.stage:not(.solo) .tilt{grid-area:card}.stage:not(.solo) .guide{grid-area:guide}
@media(min-width:960px){.stage:not(.solo){grid-template-columns:1.05fr .95fr;grid-template-areas:"hero card" "guide card";align-content:center;align-items:start;row-gap:26px}.stage:not(.solo) .tilt{align-self:center}}

/* ---- hero ---- */
.hero{max-width:560px}
.eyebrow{display:inline-flex;align-items:center;gap:10px;font-size:12px;letter-spacing:.28em;text-transform:uppercase;color:var(--mute);opacity:0;animation:up 1s var(--ease) .9s forwards}
.dot{width:8px;height:8px;border-radius:50%;background:var(--red);animation:ping 2s infinite}
@keyframes ping{0%{box-shadow:0 0 0 0 rgba(229,72,77,.6)}70%,100%{box-shadow:0 0 0 12px rgba(229,72,77,0)}}
h1{margin:18px 0 18px;font-size:clamp(34px,4.6vw,56px);line-height:1.05;letter-spacing:-.02em;font-weight:700;background:linear-gradient(100deg,#fff 20%,#ffc9c4 45%,#fff 60%);background-size:220% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;opacity:0;animation:title 1.4s var(--ease) 1s forwards,sheen 7s ease-in-out 3s infinite}
@keyframes title{from{opacity:0;transform:translateY(28px);letter-spacing:.06em;filter:blur(14px)}to{opacity:1;transform:none;letter-spacing:-.02em;filter:blur(0)}}
@keyframes sheen{0%,100%{background-position:100% 0}50%{background-position:0 0}}
.lead{margin:0;color:var(--mute);font-size:clamp(15px,1.6vw,18px);max-width:46ch;opacity:0;animation:up 1s var(--ease) 1.35s forwards}
@keyframes up{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}

/* ---- flow: You -> Claude -> Task Filler -> EMS ---- */
.works{margin:14px 0 0;font-size:13px;color:var(--dim);opacity:0;animation:up 1s var(--ease) 1.5s forwards}
.flow{margin-top:30px;width:100%;max-width:520px;opacity:0;animation:up 1s var(--ease) 1.7s forwards}
.flow svg{display:block;width:100%;height:auto;overflow:visible}
.ln{stroke:rgba(255,255,255,.16);stroke-width:1.5;fill:none}
.ln.run{stroke:url(#g1);stroke-dasharray:6 10;animation:dash 1.1s linear infinite}
@keyframes dash{to{stroke-dashoffset:-32}}
.nd{fill:#0b0d14;stroke:rgba(255,255,255,.28);stroke-width:1.5}
.nd.hot{stroke:var(--red)}
.in{fill:rgba(255,255,255,.5)}
.in.hot{fill:var(--red2)}
.ring{fill:none;stroke:var(--red);stroke-width:1;opacity:0;transform-box:fill-box;transform-origin:center;animation:ring 3.2s ease-out infinite}
.ring.r2{animation-delay:1.6s}
@keyframes ring{0%{opacity:.7;transform:scale(1)}100%{opacity:0;transform:scale(2.3)}}
.lab{fill:var(--mute);font:11px ui-sans-serif,system-ui,sans-serif;letter-spacing:.06em;text-anchor:middle}
.pkt{fill:#fff;filter:drop-shadow(0 0 4px #e5484d)}

/* ---- card ---- */
.tilt{justify-self:center;width:min(440px,100%);will-change:transform}
.card{position:relative;padding:34px 32px 26px;border-radius:24px;background:linear-gradient(180deg,rgba(255,255,255,.075),rgba(255,255,255,.025));backdrop-filter:blur(22px) saturate(140%);-webkit-backdrop-filter:blur(22px) saturate(140%);box-shadow:0 30px 80px -20px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.08);opacity:0;transform:translateY(40px) scale(.97);filter:blur(10px);animation:rise 1.3s var(--ease) 1.2s forwards}
@keyframes rise{to{opacity:1;transform:none;filter:none}}
.card::before{content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;pointer-events:none;background:conic-gradient(from var(--a),transparent 0 62%,rgba(255,122,89,.95) 80%,rgba(245,165,36,.85) 88%,transparent 100%);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude;animation:spin 7s linear infinite}
@keyframes spin{to{--a:360deg}}
.card::after{content:"";position:absolute;inset:0;border-radius:inherit;border:1px solid var(--line);pointer-events:none}
.card>*{opacity:0;animation:up .8s var(--ease) forwards}
.card>:nth-child(1){animation-delay:1.55s}.card>:nth-child(2){animation-delay:1.65s}.card>:nth-child(3){animation-delay:1.75s}
.card>:nth-child(4){animation-delay:1.85s}.card>:nth-child(5){animation-delay:1.95s}.card>:nth-child(6){animation-delay:2.05s}.card>:nth-child(7){animation-delay:2.15s}

.chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 18px}
.chip{font-size:11.5px;color:var(--mute);padding:5px 10px;border-radius:999px;border:1px solid var(--line);background:rgba(255,255,255,.03);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip b{color:var(--ink);font-weight:600}
.mark{width:46px;height:46px;border-radius:14px;display:grid;place-items:center;background:linear-gradient(145deg,var(--red),#a3262b);box-shadow:0 10px 30px -8px rgba(229,72,77,.7),inset 0 1px 0 rgba(255,255,255,.35);margin-bottom:18px;color:#fff}
.mark svg{width:24px;height:24px}
h2{margin:0 0 6px;font-size:24px;letter-spacing:-.01em;line-height:1.2}
.sub{margin:0 0 20px;color:var(--mute);font-size:14.5px}
.err{display:flex;gap:10px;align-items:flex-start;margin:0 0 6px;padding:12px 14px;border-radius:12px;background:rgba(229,72,77,.12);border:1px solid rgba(229,72,77,.4);color:#ffb3ad;font-size:14px;animation:shk .5s 2.6s both}
.err svg{flex:none;width:18px;height:18px;margin-top:1px}
@keyframes shk{0%,100%{transform:none}20%{transform:translateX(-7px)}40%{transform:translateX(6px)}60%{transform:translateX(-4px)}80%{transform:translateX(3px)}}
label{display:block;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);margin:16px 0 7px}
.field{display:flex;align-items:center;border-radius:14px;background:rgba(255,255,255,.04);border:1px solid var(--line);transition:border-color .25s,box-shadow .25s,background .25s}
.field:focus-within{border-color:rgba(255,122,89,.7);background:rgba(255,255,255,.06);box-shadow:0 0 0 4px rgba(229,72,77,.16),0 8px 30px -10px rgba(229,72,77,.5)}
.field>svg{flex:none;width:18px;height:18px;margin-left:14px;color:var(--dim);transition:color .25s}
.field:focus-within>svg{color:var(--red2)}
.field input{flex:1;min-width:0;background:none;border:0;outline:0;color:var(--ink);font:inherit;font-size:16px;padding:14px 14px 14px 12px}
.eye{flex:none;margin-right:6px;width:36px;height:36px;border:0;border-radius:10px;background:none;color:var(--dim);cursor:pointer;display:grid;place-items:center}
.eye svg{width:18px;height:18px}
.eye:hover,.eye:focus-visible{color:var(--ink);background:rgba(255,255,255,.08);outline:0}
.eye .off{display:none}.eye.on .off{display:block}.eye.on .on{display:none}
.go{position:relative;overflow:hidden;width:100%;margin-top:24px;padding:15px 18px;border:0;border-radius:14px;font:inherit;font-weight:600;font-size:16px;color:#fff;cursor:pointer;background:linear-gradient(135deg,#e5484d,#ff7a59);box-shadow:0 14px 34px -10px rgba(229,72,77,.8),inset 0 1px 0 rgba(255,255,255,.35);transition:transform .2s,filter .2s}
.go::after{content:"";position:absolute;top:0;left:-60%;width:40%;height:100%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.45),transparent);transform:skewX(-20deg);transition:left .7s var(--ease)}
.go:hover::after{left:130%}
.go:hover{transform:translateY(-1px);filter:brightness(1.06)}
.go:active{transform:translateY(1px)}
.go:focus-visible{outline:2px solid #fff;outline-offset:3px}
.go .sp{display:none;width:16px;height:16px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:rot .7s linear infinite;margin-left:10px;vertical-align:-3px}
.go.busy{pointer-events:none;filter:saturate(.7)}
.go.busy .sp{display:inline-block}
@keyframes rot{to{transform:rotate(360deg)}}
.trust{list-style:none;margin:22px 0 0;padding:16px 0 0;border-top:1px solid var(--line);display:grid;gap:9px;font-size:12.5px;color:var(--mute)}
.trust li{display:flex;gap:10px;align-items:center}
.trust svg{flex:none;width:15px;height:15px;color:var(--teal)}
.msg p{margin:0;color:var(--mute);font-size:15px}

/* ---- how-to guide on the sign-in page ---- */
.guide{max-width:560px;display:grid;gap:18px;opacity:0;animation:up 1s var(--ease) 2s forwards}
.guide .demo{margin-top:0}
.guide .works{margin:0;opacity:1;animation:none}
.steps{list-style:none;margin:0;padding:0;display:grid;gap:10px}
@media(min-width:960px){.steps{grid-template-columns:repeat(3,1fr)}}
.steps li{padding:13px;border-radius:14px;border:1px solid var(--line);background:rgba(255,255,255,.03);animation:stepglow 7.5s infinite}
.steps li:nth-child(2){animation-delay:2.5s}.steps li:nth-child(3){animation-delay:5s}
@keyframes stepglow{0%,38%,100%{border-color:rgba(255,255,255,.1);background:rgba(255,255,255,.03)}6%,32%{border-color:rgba(255,122,89,.55);background:rgba(229,72,77,.09)}}
.steps b{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;background:linear-gradient(135deg,var(--red),var(--red2));font-size:12px;margin-bottom:8px}
.steps h4{margin:0 0 4px;font-size:14px}
.steps p{margin:0;font-size:12.5px;line-height:1.45;color:var(--mute)}
.try h3{margin:0 0 8px;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim);font-weight:600}
.tags{display:flex;flex-wrap:wrap;gap:7px}
.tags span{font-size:12px;color:var(--mute);padding:5px 10px;border-radius:999px;border:1px solid var(--line);background:rgba(255,255,255,.03)}

/* ---- success page ---- */
.okmark{position:relative;width:84px;height:84px;margin:0 0 16px}
.okmark svg{width:84px;height:84px;display:block}
.okmark circle{fill:rgba(45,212,191,.08);stroke:var(--teal);stroke-width:3;stroke-dasharray:240;stroke-dashoffset:240;transform:rotate(-90deg);transform-origin:center;animation:draw .9s var(--ease) 1.5s forwards}
.okmark path{fill:none;stroke:#fff;stroke-width:4;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:50;stroke-dashoffset:50;animation:draw .5s var(--ease) 2.2s forwards}
.okmark::before{content:"";position:absolute;inset:0;border-radius:50%;border:2px solid var(--teal);opacity:0;animation:burst 1.3s ease-out 2.1s}
@keyframes draw{to{stroke-dashoffset:0}}
@keyframes burst{0%{opacity:.8;transform:scale(.85)}100%{opacity:0;transform:scale(2.4)}}
.flow.ok{margin:18px 0 0;max-width:none}
.flow.ok .nd{stroke:var(--teal)}.flow.ok .in{fill:var(--teal)}.flow.ok .ring{stroke:var(--teal)}.flow.ok .pkt{filter:drop-shadow(0 0 4px #2dd4bf)}
.demo{margin-top:20px;padding:14px;border-radius:16px;background:rgba(0,0,0,.28);border:1px solid var(--line)}
.demo h3{margin:0 0 10px;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim);font-weight:600}
.bub{font-size:13.5px;line-height:1.45;padding:10px 12px;border-radius:12px;max-width:92%;min-height:40px}
.bub.u{background:rgba(255,255,255,.08);color:var(--ink);margin-left:auto;border-bottom-right-radius:4px}
.bub.a{margin-top:8px;background:rgba(45,212,191,.1);border:1px solid rgba(45,212,191,.28);color:#c9f7ef;border-bottom-left-radius:4px;opacity:0;transform:translateY(6px);transition:opacity .4s,transform .4s}
.bub.a.show{opacity:1;transform:none}
.caret::after{content:"";display:inline-block;width:2px;height:1em;margin-left:2px;background:var(--ink);vertical-align:-2px;animation:blink 1s steps(2) infinite}
@keyframes blink{50%{opacity:0}}
.redir{margin-top:18px}
.prog{height:3px;border-radius:3px;background:rgba(255,255,255,.1);overflow:hidden}
.prog i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--red),var(--amber));animation:fill 3.6s linear 1.5s forwards}
@keyframes fill{to{width:100%}}
.redir p{margin:8px 0 0;font-size:12.5px;color:var(--mute);text-align:center}
a.go{display:block;text-align:center;text-decoration:none;margin-top:14px}

@media(max-width:959px){.hero .flow{display:none}.hero{text-align:center;margin:0 auto}.lead{margin:0 auto}.eyebrow{justify-content:center}}
@media(max-width:420px){.card{padding:26px 20px 20px}}
@media(prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.001ms!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:.001ms!important}
  .lb,#fx,.pkt,.grain{display:none}
}
`;

const JS = String.raw`
(function(){
var rm=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
var $=function(i){return document.getElementById(i)};
var pw=$('password'),eye=$('eye');
if(eye&&pw){eye.addEventListener('click',function(){var s=pw.type==='password';pw.type=s?'text':'password';eye.setAttribute('aria-label',s?'Hide password':'Show password');eye.classList.toggle('on',s);});}
var f=$('f'),go=$('go');
if(f&&go){
 f.addEventListener('submit',function(e){if(go.classList.contains('busy')){e.preventDefault();return;}go.classList.add('busy');go.querySelector('.t').textContent='Connecting…';});
 window.addEventListener('pageshow',function(ev){if(ev.persisted){go.classList.remove('busy');go.querySelector('.t').textContent='Connect securely';}});
}
if(rm)return;
var tilt=$('tilt');
if(tilt&&window.matchMedia('(hover: hover)').matches){
 var tx=0,ty=0,cx=0,cy=0,raf=0;
 var loop=function(){cx+=(tx-cx)*.08;cy+=(ty-cy)*.08;tilt.style.transform='perspective(900px) rotateY('+(cx*7)+'deg) rotateX('+(-cy*7)+'deg)';raf=(Math.abs(tx-cx)>.001||Math.abs(ty-cy)>.001)?requestAnimationFrame(loop):0;};
 window.addEventListener('pointermove',function(e){tx=e.clientX/innerWidth-.5;ty=e.clientY/innerHeight-.5;if(!raf)raf=requestAnimationFrame(loop);});
}
var c=$('fx');if(!c)return;
var g=c.getContext('2d'),W,H,dpr=Math.min(window.devicePixelRatio||1,2),P=[],N=70,run=true;
function size(){W=c.width=innerWidth*dpr;H=c.height=innerHeight*dpr;}
function mk(r){return{x:Math.random()*W,y:r?Math.random()*H:H+10,s:(Math.random()*1.6+.4)*dpr,v:(Math.random()*.25+.05)*dpr,a:Math.random()*6.283,t:Math.random()*.02+.005,h:Math.random()<.3?'255,122,89':'200,210,255'};}
size();for(var i=0;i<N;i++)P.push(mk(true));
addEventListener('resize',size);
document.addEventListener('visibilitychange',function(){run=!document.hidden;if(run)requestAnimationFrame(draw);});
function draw(){
 if(!run)return;
 g.clearRect(0,0,W,H);
 for(var i=0;i<P.length;i++){var p=P[i];p.y-=p.v;p.a+=p.t;p.x+=Math.sin(p.a)*.25*dpr;if(p.y<-10){P[i]=mk(false);continue;}
  var al=.25+.45*Math.abs(Math.sin(p.a));g.beginPath();g.fillStyle='rgba('+p.h+','+al+')';g.shadowColor='rgba('+p.h+',.9)';g.shadowBlur=8*dpr;g.arc(p.x,p.y,p.s,0,6.283);g.fill();}
 requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
})();
`;

// success page: continue to the client's callback by itself
const JS_DONE = String.raw`
(function(){
var el=document.getElementById('done');if(!el)return;
var rm=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
setTimeout(function(){location.href=el.getAttribute('data-target');},rm?1500:5200);
})();
`;

// example prompts typed out in a chat box (sign-in page and success page)
const JS_DEMO = String.raw`
(function(){
var rm=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
var ex=[
["Add 3 tasks on MyBuddy AI: login API, bug fixes, code review. No times.","Saved 3 tasks. Day total 8:45, split evenly."],
["Add my tasks for today: 3h development on MyBuddy AI, 1h standup","Saved 2 tasks. Day total 4:00 of 8:45."],
["How much time is left on my tracker?","3:54 left. You will reach 9:30 at about 7:19 PM."],
["Make my tasks from the tracker for today","Drafted 5 tasks from your work blocks. 2 gaps need your answer."],
["Apply half-day leave tomorrow and send it to my approver","Leave request submitted to your approver."]];
var u=document.getElementById('du'),a=document.getElementById('da');
if(!u||!a)return;
var i=0,first=Number(u.getAttribute('data-delay')||1600);
function typeIt(s,done){
 if(rm){u.textContent=s;done();return;}
 u.classList.add('caret');var n=0;
 (function t(){u.textContent=s.slice(0,++n);if(n<s.length)setTimeout(t,26);else{u.classList.remove('caret');done();}})();
}
function run(){
 var e=ex[i%ex.length],d=i===0?first:1600;i++;
 a.classList.remove('show');u.textContent='';a.textContent='';
 setTimeout(function(){typeIt(e[0],function(){setTimeout(function(){a.textContent=e[1];a.classList.add('show');},450);if(!rm)setTimeout(run,3500);});},rm?0:d);
}
run();
})();
`;

const I = {
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
  eyeOn: '<svg class="on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg class="off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.4 6.5A17 17 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 4-.8"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/></svg>',
  logo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5h14M5 12h10M5 19h14"/></svg>',
};

const flow = (cls = "") => `<div class="flow ${cls}" aria-hidden="true"><svg viewBox="0 0 520 100">
<defs><linearGradient id="g1" x1="0" x2="1"><stop offset="0" stop-color="#e5484d"/><stop offset="1" stop-color="#f5a524"/></linearGradient></defs>
<path class="ln" d="M58 40H162M198 40H322M358 40H462"/><path class="ln run" d="M58 40H162M198 40H322M358 40H462"/>
<circle class="ring" cx="340" cy="40" r="18"/><circle class="ring r2" cx="340" cy="40" r="18"/>
<circle class="nd" cx="40" cy="40" r="18"/><circle class="in" cx="40" cy="40" r="4"/>
<circle class="nd" cx="180" cy="40" r="18"/><circle class="in" cx="180" cy="40" r="4"/>
<circle class="nd hot" cx="340" cy="40" r="18"/><circle class="in hot" cx="340" cy="40" r="4"/>
<circle class="nd" cx="480" cy="40" r="18"/><circle class="in" cx="480" cy="40" r="4"/>
<text class="lab" x="40" y="82">You</text><text class="lab" x="180" y="82">AI tool</text><text class="lab" x="340" y="82">Task Filler</text><text class="lab" x="480" y="82">EMS</text>
<circle class="pkt" r="3.2" cy="0"><animateMotion dur="4.5s" repeatCount="indefinite" path="M58 40H462"/></circle>
<circle class="pkt" r="3.2"><animateMotion dur="4.5s" begin="-2.25s" repeatCount="indefinite" path="M58 40H462"/></circle>
</svg></div>`;

const shell = (nonce, { title, solo = false, hero = "", card, guide = "", js = JS }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#05060a">
<title>${esc(title)}</title>
<style nonce="${nonce}">${CSS}</style></head><body>
<div class="sky" aria-hidden="true"><i class="blob b1"></i><i class="blob b2"></i><i class="blob b3"></i><div class="horizon"></div><div class="grain"></div><div class="vig"></div></div>
<canvas id="fx" aria-hidden="true"></canvas><div class="lb t"></div><div class="lb b"></div>
<div class="stage${solo ? " solo" : ""}">${hero}<div class="tilt" id="tilt">${card}</div>${guide}</div>
<script nonce="${nonce}">${js}</script></body></html>`;

/** The EMS sign-in page. `app`/`host` tell the user which app is asking and where they will be sent back to. */
export function loginPage(nonce, { tx, error = "", app = "", host = "" } = {}) {
  const hero = `<section class="hero">
<div class="eyebrow"><span class="dot"></span>EMS &middot; Task Filler</div>
<h1>Your workday,<br>logged in one sentence.</h1>
<p class="lead">Connect EMS once. Then just tell your AI assistant what you worked on &mdash; tasks, leaves, tracker and reports, handled for you.</p></section>`;
  const guide = `<section class="guide" aria-label="How to use">
<div class="demo" aria-live="polite"><h3>See it in action &mdash; examples</h3><div class="bub u" id="du" data-delay="2600"></div><div class="bub a" id="da"></div></div>
<ol class="steps">
<li><b>1</b><h4>Sign in once</h4><p>Enter your EMS email and password here. It is stored encrypted and only used to sign in to EMS for you.</p></li>
<li><b>2</b><h4>Ask in plain words</h4><p>In your AI tool (Claude, Cursor, VS Code&hellip;) say what you did, like &ldquo;add 2h on MyBuddy AI, development&rdquo;.</p></li>
<li><b>3</b><h4>Check and done</h4><p>Your tasks are saved in EMS and summarised back. Ask for a preview first if you want to review them.</p></li>
</ol>
<div class="try"><h3>Try asking</h3><div class="tags"><span>Add today's tasks</span><span>Copy yesterday's tasks</span><span>Edit or delete a task</span><span>Time left on my tracker</span><span>Draft tasks from my tracker</span><span>Which days am I short on hours?</span><span>Hours per project this month</span><span>Apply for leave</span><span>My attendance</span><span>My projects and bugs</span></div></div>
<p class="works">Works with Claude, Cursor and any other tool that supports MCP.</p>
</section>`;
  const chips = [app && `<span class="chip">Requested by <b>${esc(app)}</b></span>`, host && `<span class="chip">Returns to <b>${esc(host)}</b></span>`].filter(Boolean).join("");
  const card = `<main class="card" aria-labelledby="t">
<div class="chips">${chips || '<span class="chip">Secure sign-in</span>'}</div>
<div><div class="mark">${I.logo}</div><h2 id="t">Connect your EMS account</h2><p class="sub">Sign in with your EMS email and password.</p></div>
<div>${error ? `<div class="err" role="alert">${I.warn}<span>${esc(error)}</span></div>` : ""}</div>
<form method="post" action="/login" id="f" autocomplete="on">
<input type="hidden" name="tx" value="${esc(tx)}">
<label for="email">EMS email / username</label>
<div class="field">${I.user}<input id="email" name="email" type="text" required autofocus autocomplete="username" autocapitalize="none" spellcheck="false"></div>
<label for="password">EMS password</label>
<div class="field">${I.lock}<input id="password" name="password" type="password" required autocomplete="current-password"><button class="eye" id="eye" type="button" aria-label="Show password">${I.eyeOn}${I.eyeOff}</button></div>
<button class="go" id="go" type="submit"><span class="t">Connect securely</span><span class="sp"></span></button>
</form>
<ul class="trust"><li>${I.shield}Your password is encrypted on this server (AES-256).</li><li>${I.key}Used only to sign in to EMS on your behalf.</li><li>${I.trash}Remove it anytime: ask your AI assistant to run &ldquo;forget me&rdquo;.</li></ul>
</main>`;
  return shell(nonce, { title: "Connect EMS", hero, card, guide, js: JS + JS_DEMO });
}

/** Shown after a successful sign-in, then continues to the client's callback (a page the client itself renders). */
export function successPage(nonce, { app = "", host = "", target }) {
  const name = app || "your app";
  const card = `<main class="card done" id="done" data-target="${esc(target)}" aria-labelledby="t">
<div><div class="okmark"><svg viewBox="0 0 84 84" aria-hidden="true"><circle cx="42" cy="42" r="38"/><path d="M26 43l11 11 21-23"/></svg></div>
<h2 id="t">You're connected</h2><p class="sub">EMS is now linked to ${esc(name)}${host ? " &middot; " + esc(host) : ""}.</p></div>
${flow("ok")}
<div class="demo" aria-live="polite"><h3>Try saying &mdash; examples</h3><div class="bub u" id="du"></div><div class="bub a" id="da"></div></div>
<div class="redir"><div class="prog"><i></i></div><p>Returning to ${esc(name)}&hellip;</p><a class="go" href="${esc(target)}"><span class="t">Continue now</span></a></div>
</main>`;
  return shell(nonce, { title: "EMS connected", solo: true, card, js: JS + JS_DEMO + JS_DONE });
}

/** A short message page (expired link, too many attempts) in the same look. */
export function messagePage(nonce, title, text) {
  const card = `<main class="card msg" role="alert"><div><div class="mark">${I.warn}</div><h2>${esc(title)}</h2></div><p>${esc(text)}</p></main>`;
  return shell(nonce, { title, solo: true, card });
}

/** Sends a page with a strict CSP. form-action is left open on purpose: after login we redirect to the client's callback. */
export function sendPage(res, status, build) {
  const nonce = crypto.randomBytes(16).toString("base64");
  res.status(status).set({
    "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data:; base-uri 'none'; frame-ancestors 'none'`,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  }).type("html").send(build(nonce));
}
