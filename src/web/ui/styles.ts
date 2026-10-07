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
.visually-hidden{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
code,.mono,pre,kbd{font-family:var(--mono);font-size:.86em}
/* ---------------------------------------------------------------- shell */
.app{display:grid;grid-template-columns:var(--sidebar) minmax(0,1fr);min-height:100dvh}.col{min-width:0}main{min-width:0}
.side{position:sticky;top:0;height:100dvh;overflow-y:auto;background:var(--surface);border-right:1px solid var(--line);display:flex;flex-direction:column;padding:var(--s4) var(--s3)}
.brand{display:flex;align-items:center;gap:10px;padding:4px 8px 14px;font-weight:700;letter-spacing:-.01em}
.brand .mark{width:28px;height:28px;border-radius:8px;background:var(--brand);display:grid;place-items:center;color:#fff}
.switch-wrap{position:relative;margin:0 0 12px}.switch-wrap .switch{margin:0}
.modeset{position:relative}
.modeset>summary{list-style:none;display:inline-flex;align-items:center;gap:8px;height:34px;padding:0 10px 0 12px;border-radius:99px;cursor:pointer;font-size:13px;font-weight:600;color:var(--ink-2);background:var(--surface);border:1px solid var(--line)}
.modeset>summary::-webkit-details-marker{display:none}.modeset>summary:hover,.modeset[open]>summary{color:var(--ink);border-color:var(--line-2)}
.modeset>summary svg{color:var(--muted);transition:transform var(--t-fast)}.modeset[open]>summary svg{transform:rotate(180deg)}

.mode-dot{width:10px;height:10px;border-radius:50%;flex:none;background:var(--muted)}.mode-dot.m-autonomous{background:var(--brand)}.mode-dot.m-human_approval{background:var(--ok)}.mode-dot.m-dry_run{background:var(--info)}.mode-dot.m-development{background:var(--muted)}
.mode-menu{position:absolute;right:0;top:calc(100% + 8px);width:290px;max-width:calc(100vw - 24px);background:var(--surface);border:1px solid var(--line-2);border-radius:var(--r);box-shadow:var(--shadow-lg);padding:6px;z-index:40}
.mode-menu .mode-h{margin:4px 8px 6px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:600}
.mode-menu button,.mode-menu a{all:unset;box-sizing:border-box;display:flex;gap:10px;align-items:center;width:100%;padding:8px;border-radius:8px;cursor:pointer}
.mode-menu button:hover,.mode-menu a:hover,.mode-menu button:focus-visible,.mode-menu a:focus-visible{background:var(--surface-2)}
.mode-menu button[aria-current] b{color:var(--ink)}.mode-menu .who{flex:1;min-width:0}.mode-menu .sep{height:1px;background:var(--line);margin:6px 0}
@media (max-width:640px){.modeset .mode-name{display:none}.modeset>summary{padding:0 10px}}
.switch{margin:0 0 12px;position:relative}
.switch summary{list-style:none;display:flex;align-items:center;gap:10px;padding:8px;border:1px solid var(--line);border-radius:var(--r);cursor:pointer;background:var(--surface-2)}
.switch summary::-webkit-details-marker{display:none}
.tenant-card{display:flex;align-items:center;gap:10px;padding:8px;border:1px solid var(--line);border-radius:var(--r);background:var(--surface-2)}.tenant-card .who{min-width:0;flex:1}.tenant-card b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tenant-card small{color:var(--muted)}
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
.eyebrow{font-size:13.5px;color:var(--muted);font-weight:500;margin-bottom:4px}
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
.field{display:grid;gap:6px;margin-bottom:14px;align-content:start}.field label{font-weight:600;font-size:14px}.field .req{color:var(--bad)}.help{margin:0;color:var(--muted);font-size:12.5px}
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
.slides.story img,.thumbs.story img{aspect-ratio:9/16}.slides.story img{height:420px}
.slides video{height:420px;aspect-ratio:9/16;border-radius:12px;border:1px solid var(--line);display:block;background:var(--surface-2);object-fit:cover}
.slide-tools{display:flex;gap:6px;align-items:center;margin-top:6px}.slide-tools form{display:inline}.slide-tools .btn{padding:0;width:34px;min-height:34px;justify-content:center}
.slide-cover{display:inline-flex;align-items:center;gap:4px;font-weight:600;color:var(--brand)}.slide-cover svg{fill:currentColor}
.edit-caption textarea{min-height:120px}.counter{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}.counter.over{color:var(--bad);font-weight:600}
.thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.thumbs a,.thumbs figure{margin:0;display:block;text-decoration:none;color:inherit}.thumbs img{width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:12px;border:1px solid var(--line);background:var(--surface-2);display:block}
.thumbs .cap{font-size:12.5px;color:var(--muted);margin-top:6px;display:flex;gap:6px;align-items:center;justify-content:space-between}
pre{white-space:pre-wrap;word-break:break-word;background:var(--surface-2);padding:12px;border-radius:10px;font-size:12.5px;max-height:420px;overflow:auto;margin:0}
details summary{cursor:pointer;color:var(--ink-2)}
.bar{height:8px;background:var(--surface-3);border-radius:9px;overflow:hidden;margin:8px 0 4px}.bar i{display:block;height:100%;background:var(--brand);border-radius:9px}
.quote{background:var(--surface-2);border-radius:10px;padding:8px 12px;margin:8px 0;color:var(--ink-2)}
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
.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{font:inherit;font-size:13px;min-height:32px;padding:4px 11px;border-radius:99px;border:1px solid var(--line-2);background:var(--surface);color:var(--ink-2);cursor:pointer;transition:background var(--t-fast),border-color var(--t-fast)}.chip:hover{background:var(--surface-2);color:var(--ink);border-color:var(--line-2)}
.secret-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center}.secret-row:not(:has(button)){grid-template-columns:minmax(0,1fr)}
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
  .cr-card{padding:16px}.ph h1{font-size:22px}.slides img{height:260px}.slides.story img,.slides video{height:250px}.kpi-v{font-size:22px}th,td{padding:8px 6px}.card-b{padding:12px 14px 16px}.card-h{padding:12px 14px 0}.tw{margin:0 -14px;padding:0 14px}}
/* ---------------------------------------------------------------- liquid glass
   One material, used where depth means something: the chrome that floats over
   content (top bar, section nav, menus, dialogs, toasts) and the Config panels.
   A soft brand-tinted light field sits behind the page so the glass has
   something to refract. Solid fallbacks: no backdrop-filter support,
   prefers-reduced-transparency, and prefers-contrast:more. */
:root{
  --glass:color-mix(in srgb,var(--surface) 64%,transparent);--glass-strong:color-mix(in srgb,var(--surface) 80%,transparent);
  --glass-edge:rgb(255 255 255/.7);--glass-line:rgb(16 18 26/.08);--glass-hi:inset 0 1px 0 rgb(255 255 255/.85),inset 0 -1px 0 rgb(16 18 26/.04);
  --glass-blur:blur(22px) saturate(1.7);--glass-shadow:0 1px 1px rgb(16 18 26/.04),0 8px 28px -6px rgb(16 18 26/.12);
  --field-a:rgb(255 90 31/.20);--field-b:rgb(37 99 235/.12);--field-c:rgb(255 170 60/.12);
}
:root[data-theme=dark]{--glass:color-mix(in srgb,var(--surface) 58%,transparent);--glass-strong:color-mix(in srgb,var(--surface) 78%,transparent);
  --glass-edge:rgb(255 255 255/.14);--glass-line:rgb(255 255 255/.07);--glass-hi:inset 0 1px 0 rgb(255 255 255/.10),inset 0 -1px 0 rgb(0 0 0/.3);
  --glass-shadow:0 1px 1px rgb(0 0 0/.3),0 12px 36px -8px rgb(0 0 0/.6);--field-a:rgb(255 106 51/.22);--field-b:rgb(90 120 255/.15);--field-c:rgb(255 150 60/.07)}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--glass:color-mix(in srgb,var(--surface) 58%,transparent);--glass-strong:color-mix(in srgb,var(--surface) 78%,transparent);
  --glass-edge:rgb(255 255 255/.14);--glass-line:rgb(255 255 255/.07);--glass-hi:inset 0 1px 0 rgb(255 255 255/.10),inset 0 -1px 0 rgb(0 0 0/.3);
  --glass-shadow:0 1px 1px rgb(0 0 0/.3),0 12px 36px -8px rgb(0 0 0/.6);--field-a:rgb(255 106 51/.22);--field-b:rgb(90 120 255/.15);--field-c:rgb(255 150 60/.07)}}
body::before{content:"";position:fixed;inset:-10vmax;z-index:-1;pointer-events:none;
  background:radial-gradient(38vmax 30vmax at 82% 4%,var(--field-a),transparent 70%),radial-gradient(34vmax 28vmax at 8% 92%,var(--field-b),transparent 70%),radial-gradient(26vmax 22vmax at 48% 55%,var(--field-c),transparent 72%)}
.glass,.card,.kpi,.tabs,.top,.side,.mode-menu,.switch .menu,dialog,.cfg-nav{background:var(--glass);-webkit-backdrop-filter:var(--glass-blur);backdrop-filter:var(--glass-blur)}
.glass,.card,.kpi{border:1px solid var(--glass-edge);box-shadow:var(--glass-hi),var(--glass-shadow)}
.top{border-bottom:1px solid var(--glass-line);box-shadow:var(--glass-hi)}
.side{border-right:1px solid var(--glass-line)}
.mode-menu,.switch .menu,dialog{background:var(--glass-strong);border-color:var(--glass-edge);box-shadow:var(--glass-hi),var(--shadow-lg)}
dialog::backdrop{background:rgb(10 12 16/.32);-webkit-backdrop-filter:blur(6px) saturate(1.2);backdrop-filter:blur(6px) saturate(1.2)}
.dialog-f{background:transparent;border-top-color:var(--glass-line)}
.toast{-webkit-backdrop-filter:var(--glass-blur);backdrop-filter:var(--glass-blur);background:color-mix(in srgb,var(--ink) 88%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255/.12),var(--shadow-lg)}
.toast.bad{background:color-mix(in srgb,var(--bad) 92%,transparent)}
.glass input,.glass select,.glass textarea,.card input,.card select,.card textarea{background:color-mix(in srgb,var(--surface) 72%,transparent);border-color:var(--glass-line);box-shadow:inset 0 1px 2px rgb(16 18 26/.06)}
.glass input:hover,.glass select:hover,.card input:hover,.card select:hover{border-color:var(--line-2)}
.glass input:focus,.glass select:focus,.glass textarea:focus,.card input:focus,.card select:focus,.card textarea:focus{background:var(--surface);border-color:var(--focus);box-shadow:0 0 0 3px color-mix(in srgb,var(--focus) 22%,transparent)}
.glass .btn:not(.primary),.card .btn:not(.primary){background:color-mix(in srgb,var(--surface) 55%,transparent);border-color:var(--glass-line);box-shadow:var(--glass-hi)}
.glass .btn:not(.primary):hover,.card .btn:not(.primary):hover{background:var(--surface)}
.glass .btn.primary,.card .btn.primary{box-shadow:inset 0 1px 0 rgb(255 255 255/.28),0 6px 16px -6px color-mix(in srgb,var(--primary) 70%,transparent)}
/* Glass everywhere (DESIGN.md: The Glass Control Room). Every section panel is glass;
   dense data sits on calm, legible insets inside it. */
.card{border-radius:20px}.kpi{border-radius:18px}
.card th{background:var(--glass-strong);-webkit-backdrop-filter:var(--glass-blur);backdrop-filter:var(--glass-blur)}
.card tbody tr:hover{background:color-mix(in srgb,var(--surface) 70%,transparent)}
.card pre,.card .stats div{background:color-mix(in srgb,var(--surface-2) 72%,transparent)}
a.kpi:hover{border-color:var(--glass-edge);box-shadow:var(--glass-hi),0 12px 28px -8px rgb(16 18 26/.18)}
/* Page tabs: the Config & keys pill bar */
.tabs{display:flex;gap:4px;padding:5px;margin:0 0 var(--s4);border:1px solid var(--glass-edge);border-radius:16px;box-shadow:var(--glass-hi),var(--glass-shadow);overflow-x:auto;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tabs a{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border:0;border-radius:11px;color:var(--ink-2);transition:background var(--t-fast) var(--ease),color var(--t-fast)}
.tabs a:hover{background:color-mix(in srgb,var(--surface) 70%,transparent);color:var(--ink)}
.tabs a.on,.tabs a[aria-current]{background:var(--surface);color:var(--ink);box-shadow:0 1px 2px rgb(16 18 26/.08),var(--glass-hi)}
.tabs .count{background:color-mix(in srgb,var(--ink) 8%,transparent)}
@media (max-width:640px){.tabs a{padding:7px 9px;gap:4px}.tabs .count{margin-left:0}}
/* Wide tables scroll inside their card; a soft fade says there's more to the side. */
.tw{position:relative}
.tw.more-right,.tabs.more-right{-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 36px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 36px),transparent)}
.tw.more-left.more-right,.tabs.more-left.more-right{-webkit-mask-image:linear-gradient(90deg,transparent,#000 36px,#000 calc(100% - 36px),transparent);mask-image:linear-gradient(90deg,transparent,#000 36px,#000 calc(100% - 36px),transparent)}
.tw.more-left:not(.more-right),.tabs.more-left:not(.more-right){-webkit-mask-image:linear-gradient(90deg,transparent,#000 36px);mask-image:linear-gradient(90deg,transparent,#000 36px)}
/* Long words, URLs and ids never push a layout wider than its column */
main :where(dd,p,li,.meta,.help,.kv dd){overflow-wrap:anywhere}
/* ids, dates and code tokens stay whole; their table scrolls inside its panel */
.nowrap,main td code{white-space:nowrap}
/* Table cells break a word only when it can't fit at all (numbers and short values never split) */
main td{overflow-wrap:break-word}
/* Browser surfaces in the palette */
::selection{background:color-mix(in srgb,var(--brand) 32%,transparent);color:var(--ink)}
input,textarea{caret-color:var(--brand)}
*{scrollbar-color:color-mix(in srgb,var(--ink) 22%,transparent) transparent;scrollbar-width:thin}
::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--ink) 22%,transparent);border-radius:99px;border:2px solid transparent;background-clip:padding-box}::-webkit-scrollbar-track{background:transparent}
/* ---------------------------------------------------------------- config & keys */
.cfg-ready{display:grid;grid-template-columns:auto minmax(0,1fr);gap:var(--s5) var(--s6);align-items:center;padding:var(--s5) var(--s6);border-radius:22px;margin-bottom:var(--s4)}
.ring{--p:0;width:104px;height:104px;border-radius:50%;display:grid;place-items:center;position:relative;
  background:conic-gradient(var(--brand) calc(var(--p)*1%),color-mix(in srgb,var(--ink) 9%,transparent) 0)}
.ring::before{content:"";position:absolute;inset:9px;border-radius:50%;background:var(--glass-strong);box-shadow:var(--glass-hi)}
.ring b{position:relative;font-size:26px;letter-spacing:-.02em;line-height:1}.ring small{position:relative;display:block;font-size:11.5px;color:var(--muted);text-align:center;margin-top:2px}
.ring.full{background:conic-gradient(var(--ok) 100%,transparent 0)}
.cfg-ready h2{margin:0;font-size:18px;letter-spacing:-.01em;text-wrap:balance}.cfg-ready>div>p{margin:4px 0 12px;color:var(--muted);font-size:14px;max-width:62ch}
.checks{list-style:none;margin:0;padding:0;display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(250px,1fr))}
.checks li{display:flex;gap:10px;align-items:flex-start;padding:9px 12px;border-radius:12px;background:color-mix(in srgb,var(--surface) 50%,transparent);border:1px solid var(--glass-line);font-size:13.5px}
.checks li:has(>a){padding:0}.checks li>a{display:flex;gap:10px;align-items:flex-start;padding:9px 12px;flex:1;border-radius:inherit;color:inherit;text-decoration:none;transition:background var(--t-fast)}.checks li>a:hover{background:color-mix(in srgb,var(--warn-bg) 60%,var(--surface))}.checks li>a>svg{color:var(--warn)}
.checks li b{display:block;font-weight:600;color:var(--ink)}.checks li span.meta{display:block;line-height:1.4}
.checks li.ok>svg{color:var(--ok)}.checks li.todo{background:color-mix(in srgb,var(--warn-bg) 70%,transparent);border-color:color-mix(in srgb,var(--warn) 22%,transparent)}.checks li.todo>svg{color:var(--warn)}
.cfg-nav{position:sticky;top:61px;z-index:15;display:flex;gap:4px;padding:5px;margin:0 0 var(--s4);border-radius:16px;border:1px solid var(--glass-edge);box-shadow:var(--glass-hi),var(--glass-shadow);overflow-x:auto;scrollbar-width:none}
.cfg-nav::-webkit-scrollbar{display:none}
.cfg-nav a{display:inline-flex;align-items:center;gap:7px;padding:7px 12px;border-radius:11px;white-space:nowrap;text-decoration:none;color:var(--ink-2);font-size:14px;font-weight:500;transition:background var(--t-fast) var(--ease),color var(--t-fast)}
.cfg-nav a:hover{background:color-mix(in srgb,var(--surface) 70%,transparent);color:var(--ink)}
.cfg-nav a.on{background:var(--surface);color:var(--ink);box-shadow:0 1px 2px rgb(16 18 26/.08),var(--glass-hi)}
.cfg-nav .dot{width:7px;height:7px;border-radius:50%;background:var(--line-2);flex:none}.cfg-nav .dot.ok{background:var(--ok)}.cfg-nav .dot.part{background:var(--warn)}
.cfg-group{border-radius:20px;margin-bottom:var(--s4);scroll-margin-top:124px}
.cfg-group .card-h{padding:18px var(--s6) 0;align-items:flex-start}.cfg-group .card-h h2{font-size:17px;letter-spacing:-.01em}
.cfg-group .card-h .sub{margin:3px 0 0;color:var(--muted);font-size:13.5px;max-width:70ch}
.cfg-group .card-b{padding:14px var(--s6) var(--s5)}
.cfg-group .count{font-size:12px;font-weight:600;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.cfg-group .cols{gap:4px 20px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}
.cfg-group .field{padding:12px 14px;margin:0 0 10px;border-radius:14px;background:color-mix(in srgb,var(--surface) 38%,transparent);border:1px solid var(--glass-line);transition:border-color var(--t-fast),background var(--t-fast)}
.cfg-group .field:focus-within{background:color-mix(in srgb,var(--surface) 70%,transparent);border-color:color-mix(in srgb,var(--focus) 40%,transparent)}
.cfg-group .field>label{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}
.cfg-group .field>label code{margin-left:auto;font-size:11.5px;padding:1px 6px;border-radius:6px;background:color-mix(in srgb,var(--ink) 6%,transparent)}
.cfg-group .foot{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;justify-content:space-between;margin-top:6px;padding-top:14px;border-top:1px solid var(--glass-line)}
.cfg-group .foot .meta{display:inline-flex;gap:6px;align-items:center}
.src{border:1px solid transparent}.glass .src{background:color-mix(in srgb,var(--ink) 6%,transparent)}.glass .src.app{background:var(--ok-bg);color:var(--ok)}.glass .src.env{background:var(--info-bg);color:var(--info)}
@media (max-width:1023px){.cfg-nav{top:57px}.cfg-group{scroll-margin-top:116px}}
@media (max-width:640px){.cfg-ready{grid-template-columns:1fr;justify-items:start;padding:var(--s4)}.ring{width:84px;height:84px}.ring b{font-size:21px}
  .cfg-group .card-h{padding:14px var(--s4) 0}.cfg-group .card-b{padding:12px var(--s4) var(--s4)}.cfg-group .cols{grid-template-columns:minmax(0,1fr)}.cfg-nav{border-radius:14px}}
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){
  .glass,.card,.kpi,.tabs,.top,.side,.mode-menu,.switch .menu,dialog,.cfg-nav{background:var(--surface)}.card th{background:var(--surface)}.toast{background:var(--ink)}.toast.bad{background:var(--bad)}}
@media (prefers-reduced-transparency:reduce),(prefers-contrast:more){
  body::before{display:none}
  .glass,.card,.kpi,.tabs,.card th,.top,.side,.mode-menu,.switch .menu,dialog,.cfg-nav,.toast{-webkit-backdrop-filter:none;backdrop-filter:none}
  .glass,.card,.kpi,.tabs,.card th,.side,.mode-menu,.switch .menu,dialog,.cfg-nav,.ring::before{background:var(--surface)}.top{background:var(--bg)}
  .toast{background:var(--ink)}.toast.bad{background:var(--bad)}
  .glass,.card,.kpi,.tabs,.cfg-nav{border-color:var(--line-2)}.tw,.tabs{-webkit-mask-image:none!important;mask-image:none!important}.cfg-group .field,.checks li{background:var(--surface-2);border-color:var(--line)}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
@media print{.side,.top,.toasts{display:none}.app{display:block}}
`;
