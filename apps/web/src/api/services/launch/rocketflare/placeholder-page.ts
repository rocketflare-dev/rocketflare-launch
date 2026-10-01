/**
 * The page a browser sees on an app's host before its first deploy (issue #4): the placeholder
 * Worker serves it, still as a 503, to any `GET`/`HEAD` that accepts `text/html`.
 *
 * A rocket idles on a pad with the app's name on the tower, a mission-control checklist ticks
 * through, and every 12 s the page asks the same host's `/api/health`. The placeholder answers
 * that 503 (plain text), so the first 200 is the real app: the page plays the lift-off and reloads
 * into it. Under `prefers-reduced-motion` the scene is still and the reload is immediate.
 *
 * Self-contained by design — inline CSS, SVG and script, no fonts, assets or third parties — and
 * the response's CSP says so. The display name is user input: it is HTML-escaped here and only
 * ever lands in text nodes; the script never reads it.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => HTML_ESCAPES[c] ?? c)
}

/** The page's CSP: nothing leaves the page except the same-origin health poll. */
export const LAUNCHING_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

const CLOUDS =
  '<svg viewBox="0 0 1600 200" preserveAspectRatio="none"><use href="#c"/></svg>'.repeat(2)

const CSS = `
:root{--bg:#fffaf5;--ink:#211633;--muted:#6b5f7a;--primary:#c2410c;--violet:#7c3aed;--sky-top:#fbd9c2;--sky-mid:#fff0e3;--sky-bottom:#fffaf5;--sun:#ffb26b;--cloud:#fff;--star:transparent;--ground:#e9dccd;--steel:#8b7f99;--hull:#f5f0ff;--hull-shade:#d9ccfa;--glass:#bfe6ff;--flame-a:#ffd166;--flame-b:#ff7a45;--card:rgba(255,250,245,.84);--shadow:rgba(33,22,51,.16)}
@media(prefers-color-scheme:dark){:root{--bg:#140f1f;--ink:#f6efff;--muted:#b9abcf;--primary:#ff7a45;--violet:#a78bfa;--sky-top:#07050d;--sky-mid:#1a1229;--sky-bottom:#2b1d40;--sun:#efe9ff;--cloud:#3b2c55;--star:#fff;--ground:#221833;--steel:#6f6385;--hull:#e9e1fb;--hull-shade:#b8a5ef;--glass:#7cc6f2;--card:rgba(20,15,31,.8);--shadow:rgba(0,0,0,.45)}}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{min-height:100vh;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow-x:hidden}
.sky{position:fixed;inset:0;overflow:hidden;background:linear-gradient(180deg,var(--sky-top),var(--sky-mid) 55%,var(--sky-bottom))}
.stars{position:absolute;inset:0;background-image:radial-gradient(1.6px 1.6px at 12% 18%,var(--star),transparent),radial-gradient(1.4px 1.4px at 32% 8%,var(--star),transparent),radial-gradient(1.8px 1.8px at 58% 22%,var(--star),transparent),radial-gradient(1.3px 1.3px at 74% 12%,var(--star),transparent),radial-gradient(1.6px 1.6px at 88% 30%,var(--star),transparent),radial-gradient(1.2px 1.2px at 22% 40%,var(--star),transparent),radial-gradient(1.5px 1.5px at 46% 34%,var(--star),transparent);animation:twinkle 4.5s ease-in-out infinite alternate}
.sun{position:absolute;top:9%;right:9%;width:120px;height:120px;border-radius:50%;background:var(--sun);opacity:.6;box-shadow:0 0 80px 36px var(--sun);animation:pulse 7s ease-in-out infinite}
.band{position:absolute;left:0;display:flex;width:200%}
.band svg{width:50%;height:auto;flex:none}
.b1{bottom:46%;opacity:.4;animation:drift 90s linear infinite}
.b2{bottom:30%;opacity:.65;animation:drift 60s linear infinite}
.b3{bottom:10%;opacity:.9;animation:drift 38s linear infinite}
.ground{position:absolute;left:0;right:0;bottom:0;height:9vh;background:var(--ground);z-index:2}
.pad{position:absolute;right:12vw;bottom:9vh;width:230px;height:320px;z-index:1}
.tower{position:absolute;left:0;bottom:0;width:36px;height:290px;border:4px solid var(--steel);border-bottom:0;background:repeating-linear-gradient(45deg,var(--steel) 0 3px,transparent 3px 16px),repeating-linear-gradient(-45deg,var(--steel) 0 3px,transparent 3px 16px)}
.arm{position:absolute;left:36px;bottom:205px;width:68px;height:7px;background:var(--steel);transform-origin:0 50%;transition:transform .6s ease-in}
.sign{position:absolute;left:-14px;bottom:296px;max-width:240px;padding:.2rem .6rem;border-radius:.4rem;background:var(--primary);color:#fff;font-weight:700;font-size:.9rem;letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 6px 16px var(--shadow)}
.deck{position:absolute;left:24px;right:-12px;bottom:0;height:12px;border-radius:4px 4px 0 0;background:var(--steel);z-index:3}
.launcher{position:absolute;left:80px;bottom:-66px;width:126px;cursor:pointer;z-index:2}
.launcher svg{display:block;width:126px;height:auto;filter:drop-shadow(0 14px 18px var(--shadow))}
.wobble{transform-origin:50% 75%;animation:wobble 2.6s ease-in-out infinite}
.hop.up{animation:hop .55s cubic-bezier(.3,1.6,.5,1)}
.fl{transform-box:fill-box;transform-origin:50% 0;transform:scale(.38);transition:transform .5s}
.flame{transform-box:fill-box;transform-origin:50% 0;animation:flicker .4s steps(2,jump-none) infinite alternate}
.launcher:hover .flame{animation-duration:.12s}
.launcher:hover .fl{transform:scale(.55)}
.wave{transform-box:fill-box;transform-origin:0 100%;animation:wave 1.6s ease-in-out infinite}
.steam,.smoke,.bit{position:absolute;border-radius:50%;pointer-events:none}
.steam{bottom:10px;left:132px;width:26px;height:26px;background:var(--cloud);opacity:0;animation:vent 3.2s ease-out infinite}
.steam:nth-of-type(2){left:156px;animation-delay:1.1s}
.steam:nth-of-type(3){left:112px;animation-delay:2.2s}
.smoke{bottom:-10px;left:120px;width:70px;height:70px;background:var(--cloud);opacity:0;z-index:4}
.fx{position:absolute;left:143px;bottom:20px;width:0;height:0;z-index:5}
.bit{width:8px;height:8px;left:0;top:0;background:var(--c);animation:burst var(--t,1.1s) cubic-bezier(.2,.7,.4,1) forwards}
.bit.star{border-radius:2px;transform:rotate(45deg)}
.go .launcher{animation:liftoff 3s cubic-bezier(.6,0,.9,.45) .5s forwards;cursor:default}
.go .wobble{animation:shake .08s linear infinite}
.go .fl,.go .launcher:hover .fl{transform:scale(1.3)}
.go .flame{animation-duration:.08s}
.go .arm{transform:rotate(-70deg)}
.go .steam{display:none}
.go .smoke{animation:billow 2.8s ease-out .3s forwards}
.go .smoke:nth-of-type(4){--dx:-110px}
.go .smoke:nth-of-type(5){--dx:120px;animation-delay:.45s}
.go .smoke:nth-of-type(6){--dx:-30px;animation-delay:.6s}
.go .band{animation-duration:9s}
main{position:relative;z-index:5;max-width:31rem;margin:13vh 0 2rem 7vw;padding:1.75rem 2rem;border-radius:1.25rem;background:var(--card);box-shadow:0 20px 50px var(--shadow);backdrop-filter:blur(6px)}
.kicker{margin:0;color:var(--violet);font-weight:700;font-size:.78rem;letter-spacing:.14em;text-transform:uppercase}
h1{margin:.3rem 0 .4rem;font-size:clamp(1.7rem,4vw,2.5rem);line-height:1.15;overflow-wrap:anywhere}
h1 span{color:var(--primary)}
.lede{margin:0;color:var(--muted)}
.checks{list-style:none;margin:1.1rem 0 .4rem;padding:0;font-size:.95rem}
.checks li{padding:.12rem 0;color:var(--muted)}
.checks li::before{content:"○";display:inline-block;width:1.5rem;color:var(--muted)}
.checks li.done{color:var(--ink)}
.checks li.done::before{content:"✓";color:var(--primary);font-weight:700}
.checks li.now::before{content:"●";color:var(--violet);animation:blink 1s ease-in-out infinite}
.quip{margin:.5rem 0 0;font-style:italic;color:var(--violet);min-height:1.5em}
.status{margin:.6rem 0 0;font-size:.85rem;color:var(--muted)}
@keyframes drift{to{transform:translateX(-50%)}}
@keyframes twinkle{from{opacity:.4}to{opacity:1}}
@keyframes pulse{50%{transform:scale(1.07);opacity:.75}}
@keyframes wobble{0%,100%{transform:rotate(-1.4deg)}50%{transform:rotate(1.4deg)}}
@keyframes shake{0%{transform:translate(-1.5px,0)}50%{transform:translate(1.5px,1px)}100%{transform:translate(-1px,-1px)}}
@keyframes hop{40%{transform:translateY(-34px)}}
@keyframes flicker{from{transform:scaleY(.82) scaleX(1.06);opacity:.9}to{transform:scaleY(1.14) scaleX(.94);opacity:1}}
@keyframes wave{0%,100%{transform:rotate(-12deg)}50%{transform:rotate(28deg)}}
@keyframes vent{0%{opacity:0;transform:translate(0,0) scale(.4)}20%{opacity:.85}100%{opacity:0;transform:translate(var(--dx,18px),-90px) scale(2.2)}}
@keyframes billow{0%{opacity:0;transform:translateX(0) scale(.3)}15%{opacity:.95}100%{opacity:0;transform:translate(var(--dx,60px),-40px) scale(3.4)}}
@keyframes liftoff{0%{transform:translateY(0)}12%{transform:translateY(6px)}100%{transform:translateY(-150vh)}}
@keyframes burst{0%{opacity:1;transform:translate(0,0) rotate(0) scale(1)}100%{opacity:0;transform:translate(var(--x),var(--y)) rotate(var(--r,180deg)) scale(.4)}}
@keyframes blink{50%{opacity:.25}}
@media(max-width:760px){main{margin:1rem;padding:1.25rem 1.4rem}.pad{right:50%;margin-right:-115px;scale:.72;transform-origin:50% 100%}.sun{width:70px;height:70px;top:4%;right:6%}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`

// The script holds no data of the app's: it reads the page it is in and polls its own origin.
const SCRIPT = `
(function(){
var d=document,still=matchMedia("(prefers-reduced-motion: reduce)").matches;
var items=d.querySelectorAll(".checks li"),status=d.getElementById("status"),quip=d.getElementById("quip");
var rocket=d.getElementById("rocket"),hop=d.getElementById("hop"),fx=d.getElementById("fx");
var colours=["#ff7a45","#c2410c","#a78bfa","#7c3aed","#ffd166","#7cc6f2"],live=false,n=0;
function tick(){if(live||n>=items.length-1){if(!live)items[n].className="now";return}items[n++].className="done";setTimeout(tick,still?0:1500+Math.random()*1500)}
setTimeout(tick,still?0:900);
var quips=["T-minus one deploy.","Polishing the fins.","Astronaut reports: all good up here.","Checking the weather above the clouds.","Counting down in hexadecimal.","Fuel: plenty. Patience: also plenty.","Mission control is on its third coffee.","Testing the big red button. Not that one."];
if(!still)setInterval(function(){if(!live)quip.textContent=quips[Math.floor(Math.random()*quips.length)]},6500);
function burst(count,far,kind){for(var i=0;i<count;i++){var b=d.createElement("i"),a=Math.random()*Math.PI*2,r=far*(.4+Math.random()*.6);b.className="bit"+(kind?" "+kind:"");b.style.setProperty("--x",Math.cos(a)*r+"px");b.style.setProperty("--y",(Math.sin(a)*r-far*.4)+"px");b.style.setProperty("--r",(Math.random()*720-360)+"deg");b.style.setProperty("--c",kind==="puff"?"var(--cloud)":colours[i%colours.length]);b.style.setProperty("--t",(.8+Math.random()*.9)+"s");fx.appendChild(b);setTimeout(function(x){return function(){x.remove()}}(b),2000)}}
rocket.addEventListener("click",function(){if(live||still)return;hop.classList.remove("up");void hop.offsetWidth;hop.classList.add("up");burst(7,50,"puff")});
function launch(){live=true;clearInterval(timer);for(var i=0;i<items.length;i++)items[i].className="done";quip.textContent="Lift-off!";status.textContent="It\\u2019s live! Opening the app\\u2026";if(still){setTimeout(function(){location.reload()},800);return}d.body.classList.add("go");setTimeout(function(){burst(40,260,"star")},900);setTimeout(function(){location.reload()},3600)}
function check(){if(live||d.hidden)return;fetch("/api/health",{cache:"no-store",headers:{accept:"application/json"}}).then(function(r){if(r.ok)launch()},function(){})}
var timer=setInterval(check,12000);
})();
`

/** The rocket, after the rocketflare.dev hero's, with an astronaut waving from the window. */
const ROCKET = `<svg viewBox="0 0 220 470" role="presentation">
<defs><clipPath id="w"><circle cx="110" cy="140" r="22"/></clipPath></defs>
<g class="fl"><g class="flame"><path fill="var(--flame-a)" d="M110 336c-22 34-33 62-33 84 0 19 15 30 33 30s33-11 33-30c0-22-11-50-33-84z"/><path fill="var(--flame-b)" d="M110 348c-14 26-21 47-21 62 0 13 9 21 21 21s21-8 21-21c0-15-7-36-21-62z"/><path fill="var(--primary)" d="M110 366c-7 17-11 30-11 39 0 8 5 13 11 13s11-5 11-13c0-9-4-22-11-39z"/></g></g>
<path fill="var(--primary)" d="M62 150C30 168 12 200 6 246l56-22zM158 150c32 18 50 50 56 96l-56-22z"/>
<path fill="var(--hull)" d="M110 8C67 43 46 98 46 168v108c0 20 14 34 34 34h60c20 0 34-14 34-34V168c0-70-21-125-64-160z"/>
<path fill="var(--hull-shade)" d="M110 8c14 35 22 88 22 160v150h8c20 0 34-14 34-34V168c0-70-21-125-64-160z" opacity=".6"/>
<path fill="var(--violet)" d="M110 8C86 28 70 53 60 83h100C150 53 134 28 110 8z"/>
<rect x="104" y="196" width="12" height="80" rx="6" fill="var(--primary)" opacity=".85"/>
<circle cx="110" cy="140" r="30" fill="var(--steel)"/><circle cx="110" cy="140" r="22" fill="var(--glass)"/>
<g clip-path="url(#w)"><path fill="#fff" d="M90 166c0-14 9-22 20-22s20 8 20 22z"/><circle cx="110" cy="138" r="11" fill="#fff"/><rect x="102" y="133" width="16" height="9" rx="4.5" fill="#3b2c55"/><rect class="wave" x="124" y="136" width="5" height="16" rx="2.5" fill="#fff"/></g>
<circle cx="101" cy="128" r="5" fill="#fff" opacity=".7"/>
<path fill="var(--steel)" d="M78 306h64l-10 34H88z"/>
</svg>`

/** The whole page, with the app's display name escaped into its three text nodes. */
export function launchingPage(displayName: string): string {
  const name = escapeHtml(displayName.trim() || 'Your app')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="color-scheme" content="light dark">
<title>${name} is launching</title><style>${CSS}</style></head>
<body>
<div class="sky" aria-hidden="true">
<div class="stars"></div><div class="sun"></div>
<div class="band b1">${CLOUDS}</div><div class="band b2">${CLOUDS}</div><div class="band b3">${CLOUDS}</div>
<svg width="0" height="0" style="position:absolute"><defs><g id="c" fill="var(--cloud)"><path d="M80 150c0-28 22-50 50-50 6 0 12 1 17 3 9-27 34-47 64-47 32 0 59 22 66 52 8-6 17-9 27-9 26 0 47 20 49 46 19 2 34 18 34 38v17H40v-12c0-19 17-36 40-38z"/><path d="M520 160c0-22 18-40 40-40 5 0 9 1 14 2 7-22 28-38 52-38 26 0 47 18 53 42 6-5 14-7 21-7 21 0 38 16 40 37 15 2 27 14 27 30v14H488v-10c0-16 14-29 32-30z"/><path d="M980 152c0-25 20-45 45-45 5 0 11 1 16 3 8-25 31-43 58-43 29 0 54 20 60 47 7-5 16-8 24-8 24 0 43 18 45 42 17 2 31 16 31 34v16H944v-11c0-17 15-33 36-35z"/><path d="M1380 165c0-19 15-34 34-34 4 0 8 0 12 2 6-19 24-33 45-33 22 0 40 15 45 36 5-4 11-6 18-6 18 0 33 14 34 32 13 1 23 12 23 26v12h-268v-9c0-14 12-25 27-26z"/></g></defs></svg>
<div class="pad">
<div class="tower"></div><div class="arm"></div><div class="sign">${name}</div>
<div class="launcher" id="rocket"><div class="hop" id="hop"><div class="wobble">${ROCKET}</div></div></div>
<span class="steam"></span><span class="steam" style="--dx:-14px"></span><span class="steam"></span>
<span class="smoke"></span><span class="smoke"></span><span class="smoke"></span>
<div class="deck"></div><div class="fx" id="fx"></div>
</div>
<div class="ground"></div>
</div>
<main>
<p class="kicker">Mission control</p>
<h1><span>${name}</span> is launching</h1>
<p class="lede">It will be ready in a few minutes. Keep this page open: it opens the app by itself the moment it goes live.</p>
<ol class="checks" aria-hidden="true"><li>Fuelling the database</li><li>Attaching storage</li><li>Writing the flight plan</li><li>Polishing the fins</li><li>Waiting for the first deploy</li></ol>
<p class="quip" id="quip" aria-hidden="true">T-minus one deploy.</p>
<p class="status" id="status" role="status" aria-live="polite">Still on the pad. This page checks again every few seconds.</p>
</main>
<script>${SCRIPT}</script>
</body></html>`
}
