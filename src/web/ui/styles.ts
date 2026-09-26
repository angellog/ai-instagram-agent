/**
 * Console design system (see docs/design/HANDOFF.md). Semantic tokens only in
 * components; light and dark designed together; 4px spacing scale; motion
 * 150–250ms and disabled under prefers-reduced-motion.
 */
export const CSS = String.raw`
:root{
  --font:"Fira Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"Fira Code",ui-monospace,SFMono-Regular,Menlo,monospace;
  --s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:20px;--s6:24px;--s8:32px;--s10:40px;
  --r-sm:8px;--r:12px;--r-lg:16px;--sidebar:252px;
  --t-fast:150ms;--t:220ms;--ease:cubic-bezier(.2,.8,.2,1);
  --bg:#f6f6f8;--surface:#fff;--surface-2:#f0f1f4;--surface-3:#e8e9ee;--ink:#12141a;--ink-2:#3b3f4c;--muted:#636878;--line:#e3e4ea;--line-2:#d3d5dd;
  --brand:#ff5a1f;--brand-soft:#fff0ea;--primary:#c8410e;--primary-ink:#fff;--primary-hover:#a93609;--focus:#2563eb;
  --ok:#137a3a;--ok-bg:#e4f5ea;--warn:#8a5300;--warn-bg:#fff3d6;--bad:#b3141a;--bad-bg:#fde6e6;--info:#1d4ed8;--info-bg:#e5ecfe;
  --shadow:0 1px 2px rgb(16 18 26/.06),0 1px 3px rgb(16 18 26/.05);--shadow-lg:0 12px 32px rgb(16 18 26/.14);
  color-scheme:light;
}
:root[data-theme=dark]{
  --bg:#0d0e12;--surface:#15171c;--surface-2:#1c1f26;--surface-3:#252932;--ink:#eceef2;--ink-2:#c5c8d1;--muted:#9a9fad;--line:#262a33;--line-2:#343945;
  --brand:#ff6a33;--brand-soft:#2a1710;--primary:#ff6a33;--primary-ink:#1b0b04;--primary-hover:#ff8455;--focus:#7aa2ff;
  --ok:#5fd38b;--ok-bg:#0f2a1a;--warn:#f3c056;--warn-bg:#2d2208;--bad:#ff8a8a;--bad-bg:#351314;--info:#8fb0ff;--info-bg:#131e3b;
  --shadow:0 1px 2px rgb(0 0 0/.4);--shadow-lg:0 16px 40px rgb(0 0 0/.55);color-scheme:dark;
}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
  --bg:#0d0e12;--surface:#15171c;--surface-2:#1c1f26;--surface-3:#252932;--ink:#eceef2;--ink-2:#c5c8d1;--muted:#9a9fad;--line:#262a33;--line-2:#343945;
  --brand:#ff6a33;--brand-soft:#2a1710;--primary:#ff6a33;--primary-ink:#1b0b04;--primary-hover:#ff8455;--focus:#7aa2ff;
  --ok:#5fd38b;--ok-bg:#0f2a1a;--warn:#f3c056;--warn-bg:#2d2208;--bad:#ff8a8a;--bad-bg:#351314;--info:#8fb0ff;--info-bg:#131e3b;
  --shadow:0 1px 2px rgb(0 0 0/.4);--shadow-lg:0 16px 40px rgb(0 0 0/.55);color-scheme:dark;}}
*{box-sizing:border-box}[hidden]{display:none!important}html{-webkit-text-size-adjust:100%}
body{margin:0;font:15px/1.55 var(--font);background:var(--bg);color:var(--ink);font-feature-settings:"tnum" 1}
a{color:inherit}main :where(a){color:var(--info);text-decoration-thickness:1px;text-underline-offset:2px}
main :where(a.btn,a.kpi,.thumbs a,.tabs a){color:inherit;text-decoration:none}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:6px}
.skip{position:absolute;left:-999px;top:8px;background:var(--surface);padding:8px 12px;border-radius:8px;z-index:100}.skip:focus{left:8px}
.i{flex:none;vertical-align:-3px}
code,.mono,pre,kbd{font-family:var(--mono);font-size:.86em}
/* ---------------------------------------------------------------- shell */
.app{display:grid;grid-template-columns:var(--sidebar) minmax(0,1fr);min-height:100dvh}.col{min-width:0}main{min-width:0}
.side{position:sticky;top:0;height:100dvh;overflow-y:auto;background:var(--surface);border-right:1px solid var(--line);display:flex;flex-direction:column;padding:var(--s4) var(--s3)}
.brand{display:flex;align-items:center;gap:10px;padding:4px 8px 14px;font-weight:700;letter-spacing:-.01em}
.brand .mark{width:28px;height:28px;border-radius:8px;background:var(--brand);display:grid;place-items:center;color:#fff}
.switch{margin:0 0 12px;position:relative}
.switch summary{list-style:none;display:flex;align-items:center;gap:10px;padding:8px;border:1px solid var(--line);border-radius:var(--r);cursor:pointer;background:var(--surface-2)}
.switch summary::-webkit-details-marker{display:none}
.switch summary .who{min-width:0;flex:1}.switch summary b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.switch summary small{color:var(--muted)}
.switch[open] summary{border-color:var(--line-2)}
.switch .menu{position:absolute;left:0;right:0;top:calc(100% + 6px);background:var(--surface);border:1px solid var(--line-2);border-radius:var(--r);box-shadow:var(--shadow-lg);padding:6px;z-index:30;max-height:60vh;overflow:auto}
.switch .menu button,.switch .menu a{all:unset;box-sizing:border-box;display:flex;gap:10px;align-items:center;width:100%;padding:8px;border-radius:8px;cursor:pointer}
.switch .menu button:hover,.switch .menu a:hover,.switch .menu button:focus-visible{background:var(--surface-2)}
.switch .menu .sep{height:1px;background:var(--line);margin:6px 0}
.av{border-radius:50%;object-fit:cover;flex:none;background:var(--surface-3)}.av-t{display:inline-grid;place-items:center;font-weight:700;color:var(--ink-2);font-size:13px}
.nav{display:flex;flex-direction:column;gap:2px}
.nav h3{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:14px 10px 6px;font-weight:600}
.nav a{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:9px;text-decoration:none;color:var(--ink-2);min-height:38px;transition:background var(--t-fast) var(--ease),color var(--t-fast)}
.nav a:hover{background:var(--surface-2);color:var(--ink)}
.nav a[aria-current=page]{background:var(--brand-soft);color:var(--ink);font-weight:600;box-shadow:inset 3px 0 0 var(--brand)}
.nav .badge{margin-left:auto;background:var(--brand);color:#fff;border-radius:99px;font-size:11px;font-weight:700;padding:1px 7px}
.side-foot{margin-top:auto;padding:12px 8px 0;border-top:1px solid var(--line);display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px}
.top{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:var(--s3);padding:10px var(--s6);background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.top .grow{flex:1}.top .crumb{color:var(--muted);font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.iconbtn{all:unset;box-sizing:border-box;display:inline-grid;place-items:center;width:40px;height:40px;border-radius:10px;cursor:pointer;color:var(--ink-2)}
.iconbtn:hover{background:var(--surface-2);color:var(--ink)}.iconbtn:focus-visible{outline:2px solid var(--focus)}
.menu-btn{display:none}
main{padding:var(--s6);max-width:1320px;width:100%;margin:0 auto}
.banner{display:flex;gap:10px;align-items:center;padding:10px var(--s6);font-size:14px;background:var(--warn-bg);color:var(--warn);border-bottom:1px solid var(--line)}
.banner.bad{background:var(--bad-bg);color:var(--bad)}
/* ---------------------------------------------------------------- content */
.ph{display:flex;flex-wrap:wrap;gap:var(--s4);align-items:flex-end;justify-content:space-between;margin:4px 0 var(--s5)}
.ph h1{font-size:26px;line-height:1.2;margin:0;letter-spacing:-.02em}.ph .sub{margin:6px 0 0;color:var(--muted);max-width:70ch}
.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:600;margin-bottom:4px}
.ph-actions{display:flex;flex-wrap:wrap;gap:8px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow);margin-bottom:var(--s4);min-width:0}
.card-h{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px var(--s5) 0}
.card-h h2{font-size:15px;margin:0;font-weight:600}
.card-b{padding:14px var(--s5) var(--s5)}
.grid{display:grid;gap:var(--s4);grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.grid-2{display:grid;gap:var(--s4);grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)}
.kpis{display:grid;gap:var(--s3);grid-template-columns:repeat(auto-fit,minmax(180px,1fr));margin-bottom:var(--s4)}
.kpi{display:block;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);padding:14px 16px;text-decoration:none;color:inherit;box-shadow:var(--shadow);transition:border-color var(--t-fast),transform var(--t-fast) var(--ease)}
a.kpi:hover{border-color:var(--line-2);transform:translateY(-1px)}
.kpi-l{display:flex;gap:6px;align-items:center;color:var(--muted);font-size:13px}.kpi-v{font-size:26px;font-weight:700;letter-spacing:-.02em;margin-top:4px}
.kpi-v.ok{color:var(--ok)}.kpi-v.warn{color:var(--warn)}.kpi-v.bad{color:var(--bad)}.kpi-h{color:var(--muted);font-size:12.5px;margin-top:2px}
.muted{color:var(--muted)}.small{font-size:13px}.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.stack{display:grid;gap:12px}.right{margin-left:auto}
.pill{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:99px;font-size:12px;font-weight:600;background:var(--surface-2);color:var(--ink-2);white-space:nowrap;border:1px solid transparent}
.pill.ok{background:var(--ok-bg);color:var(--ok)}.pill.warn{background:var(--warn-bg);color:var(--warn)}.pill.bad{background:var(--bad-bg);color:var(--bad)}.pill.info{background:var(--info-bg);color:var(--info)}
.st{display:inline-flex;align-items:center;gap:6px;font-size:13px;white-space:nowrap}.st i{width:8px;height:8px;border-radius:50%;background:var(--line-2)}
.st.ok i{background:var(--ok)}.st.warn i{background:var(--warn)}.st.bad i{background:var(--bad)}.st.info i{background:var(--info)}
.tw{overflow-x:auto;margin:0 calc(-1 * var(--s5));padding:0 var(--s5)}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;position:sticky;top:0;background:var(--surface)}
tbody tr{transition:background var(--t-fast)}tbody tr:hover{background:var(--surface-2)}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;font:inherit;font-size:14px;font-weight:500;min-height:38px;padding:7px 14px;border-radius:10px;border:1px solid var(--line-2);background:var(--surface);color:var(--ink);cursor:pointer;text-decoration:none;white-space:nowrap;transition:background var(--t-fast),border-color var(--t-fast),transform var(--t-fast)}
.btn:hover{background:var(--surface-2)}.btn:active{transform:scale(.98)}
.btn.primary{background:var(--primary);border-color:var(--primary);color:var(--primary-ink)}.btn.primary:hover{background:var(--primary-hover)}
.btn.danger{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 35%,var(--line))}.btn.danger:hover{background:var(--bad-bg)}
.btn.ghost{border-color:transparent;background:transparent}.btn.sm{min-height:32px;padding:4px 10px;font-size:13px}
.btn[disabled],.btn.busy{opacity:.55;cursor:progress}
form.inline{display:inline}
.field{display:grid;gap:6px;margin-bottom:14px}.field label{font-weight:600;font-size:14px}.field .req{color:var(--bad)}.help{margin:0;color:var(--muted);font-size:12.5px}
input,select,textarea{font:inherit;font-size:15px;min-height:40px;padding:8px 11px;border-radius:10px;border:1px solid var(--line-2);background:var(--surface);color:var(--ink);width:100%;max-width:100%;transition:border-color var(--t-fast),box-shadow var(--t-fast)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--focus);box-shadow:0 0 0 3px color-mix(in srgb,var(--focus) 22%,transparent)}
textarea{min-height:90px;resize:vertical;line-height:1.5}textarea.mono{font-family:var(--mono);font-size:13px}
input[type=checkbox]{width:18px;height:18px;min-height:0;accent-color:var(--primary)}
.cols{display:grid;gap:0 16px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin:-4px 0 var(--s4);overflow-x:auto}
.tabs a{padding:10px 12px;text-decoration:none;color:var(--muted);border-bottom:2px solid transparent;white-space:nowrap;font-weight:500}
.tabs a:hover{color:var(--ink)}.tabs a.on{color:var(--ink);border-color:var(--brand)}.tabs .count{background:var(--surface-2);border-radius:99px;padding:0 7px;font-size:12px;margin-left:4px}
.empty{display:grid;justify-items:center;gap:6px;text-align:center;padding:36px 16px;color:var(--muted)}.empty b{color:var(--ink)}.empty p{margin:0;max-width:52ch}
.slides{display:flex;gap:12px;overflow-x:auto;padding-bottom:6px;scroll-snap-type:x mandatory}
.slides figure{margin:0;scroll-snap-align:start;flex:none}.slides img{height:320px;aspect-ratio:4/5;object-fit:cover;border-radius:12px;border:1px solid var(--line);display:block;background:var(--surface-2)}
.slides figcaption{display:flex;justify-content:space-between;align-items:center;margin-top:6px;font-size:12px;color:var(--muted)}
.thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.thumbs a,.thumbs figure{margin:0;display:block;text-decoration:none;color:inherit}.thumbs img{width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:12px;border:1px solid var(--line);background:var(--surface-2);display:block}
.thumbs .cap{font-size:12.5px;color:var(--muted);margin-top:6px;display:flex;gap:6px;align-items:center;justify-content:space-between}
pre{white-space:pre-wrap;word-break:break-word;background:var(--surface-2);padding:12px;border-radius:10px;font-size:12.5px;max-height:420px;overflow:auto;margin:0}
details summary{cursor:pointer;color:var(--ink-2)}
.bar{height:8px;background:var(--surface-3);border-radius:9px;overflow:hidden;margin:8px 0 4px}.bar i{display:block;height:100%;background:var(--brand);border-radius:9px}
.quote{border-left:3px solid var(--line-2);padding:2px 0 2px 12px;margin:8px 0;color:var(--ink-2)}
.list{list-style:none;margin:0;padding:0}.list li{display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--line)}.list li:last-child{border:0}
.meta{color:var(--muted);font-size:12.5px}
.steps{list-style:none;display:flex;flex-wrap:wrap;gap:8px;padding:0;margin:0 0 var(--s5)}
.steps li{display:flex;align-items:center;gap:8px;padding:6px 12px 6px 6px;border-radius:99px;background:var(--surface-2);color:var(--muted);font-size:14px}
.steps li span{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:var(--surface-3);font-size:12px;font-weight:700}
.steps li.on{background:var(--brand-soft);color:var(--ink);font-weight:600}.steps li.on span{background:var(--brand);color:#fff}.steps li.done span{background:var(--ok);color:#fff}
.choice{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
.choice label{display:block;border:2px solid var(--line);border-radius:14px;padding:8px;cursor:pointer;transition:border-color var(--t-fast)}
.choice input{position:absolute;opacity:0;width:1px;height:1px}.choice input:checked+label{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
.choice input:focus-visible+label{outline:2px solid var(--focus)}
.choice img{width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:10px;display:block}
.callout{display:flex;gap:12px;padding:12px 14px;border-radius:12px;background:var(--info-bg);color:var(--info);font-size:14px;margin-bottom:var(--s4)}
.callout.warn{background:var(--warn-bg);color:var(--warn)}.callout.ok{background:var(--ok-bg);color:var(--ok)}.callout.bad{background:var(--bad-bg);color:var(--bad)}
.callout p{margin:0}.callout a{color:inherit}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:0;font-size:14px}.kv dt{color:var(--muted)}.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:4px 0 12px;text-align:center}.stats div{background:var(--surface-2);border-radius:10px;padding:8px 4px;display:grid}.stats b{font-size:18px;font-variant-numeric:tabular-nums}.stats span{font-size:12px;color:var(--muted)}
.secret-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center}
.src{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:2px 7px;border-radius:6px;background:var(--surface-2);color:var(--muted)}
.src.app{background:var(--ok-bg);color:var(--ok)}.src.env{background:var(--info-bg);color:var(--info)}
/* ---------------------------------------------------------------- overlays */
.toasts{position:fixed;right:16px;bottom:16px;display:grid;gap:8px;z-index:60;max-width:min(420px,calc(100vw - 32px))}
.toast{display:flex;gap:10px;align-items:flex-start;background:var(--ink);color:var(--bg);padding:12px 14px;border-radius:12px;box-shadow:var(--shadow-lg);font-size:14px;animation:tin var(--t) var(--ease)}
.toast.bad{background:var(--bad);color:#fff}.toast button{all:unset;cursor:pointer;margin-left:auto;opacity:.8}
@keyframes tin{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
dialog{border:1px solid var(--line-2);border-radius:var(--r-lg);background:var(--surface);color:var(--ink);box-shadow:var(--shadow-lg);padding:0;width:min(520px,calc(100vw - 32px))}
dialog::backdrop{background:rgb(10 12 16/.45);backdrop-filter:blur(2px)}
dialog[open]{display:flex;flex-direction:column;max-height:calc(100dvh - 32px);overflow:hidden}dialog>form{display:flex;flex-direction:column;min-height:0;max-height:100%}
dialog .dh{padding:18px 20px 0;font-weight:700;font-size:17px;flex:none}.dialog-b{padding:12px 20px;overflow-y:auto;min-height:0;flex:1}.dialog-f{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px 16px;border-top:1px solid var(--line);flex:none;background:var(--surface)}
.scrim{display:none}
/* ---------------------------------------------------------------- responsive */
@media (max-width:1100px){.grid-2{grid-template-columns:1fr}}
@media (max-width:1023px){
  .app{grid-template-columns:minmax(0,1fr)}
  .side{position:fixed;inset:0 auto 0 0;width:min(300px,86vw);z-index:50;transform:translateX(-102%);transition:transform var(--t) var(--ease);box-shadow:var(--shadow-lg)}
  body.nav-open .side{transform:none}body.nav-open .scrim{display:block;position:fixed;inset:0;background:rgb(10 12 16/.4);z-index:40}
  .menu-btn{display:inline-grid}.top{padding:8px 12px}main{padding:16px}
}
@media (max-width:640px){.top .crumb{display:none}.top{gap:6px}.top .pill{font-size:11px;padding:2px 7px}.top .btn.sm span{display:none}.top .btn.sm{padding:4px 8px}
  .kpis{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.kpi{padding:12px}.kpi-h{font-size:11.5px}
  .banner{padding:8px 16px;font-size:13px}.ph-actions{width:100%}.grid{grid-template-columns:minmax(0,1fr)}
  .cr-card{padding:16px}.ph h1{font-size:22px}.slides img{height:260px}.kpi-v{font-size:22px}th,td{padding:8px 6px}.card-b{padding:12px 14px 16px}.card-h{padding:12px 14px 0}.tw{margin:0 -14px;padding:0 14px}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
@media print{.side,.top,.toasts{display:none}.app{display:block}}
`;
