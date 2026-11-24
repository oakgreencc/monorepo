// @ts-check
import { facetsOf, groupOf, inboxGroups, inboxItems, inboxStats, priorityRank, viewOf } from './inbox.mjs'
import { autoApproved, flameFrames, flameTree } from './flame.mjs'
import { markdown } from './markdown.mjs'
import { layoutGraph } from './graph-layout.mjs'

/** The oakgreen tree ring (docs' Ring.astro), stroked in currentColor so each placement sets its colour. */
const RING =
  '<svg viewBox="0 0 500 500" fill="none" stroke="currentColor" stroke-width="38" stroke-linecap="round" stroke-linejoin="round" focusable="false">' +
  '<circle cx="250" cy="250" r="230"/><path d="M430 250A180 180 0 0 1 262.008 429.599 180 180 0 0 1 71.602 273.962 180 180 0 0 1 214.191 73.598 180 180 0 0 1 423.62 202.503"/>' +
  '<path d="M330 250H430"/><path d="M370.161 299.613A130 130 0 0 1 224.154 377.405 130 130 0 0 1 120.005 248.866 130 130 0 0 1 226.382 122.163 130 130 0 0 1 371.008 202.492"/>' +
  '<path d="M314.416 297.44A80 80 0 0 1 225.033 326.004 80 80 0 0 1 170 250a80 80 0 0 1 55.033-76.004 80 80 0 0 1 89.383 28.565"/></svg>'

const CSS = `
/* The oakgreen.cc forest (docs/DESIGN.md, "The Forest Manual"): one green family from Forest Black to Mint Ink, flat,
   hairlines and tonal steps instead of shadows. Dark is the forest at night; light is Moss Paper. Brand Green marks one
   thing per region (the current tab, the primary action, focus); Mint High is link text. Status hues are the docs'
   semantic gold and rust. --flow-* steps the green ramp intake to promote; --fam-* tells cambium (green), claude (the
   docs' semantic blue) and mycelium (bark) spans apart. */
:root{color-scheme:light dark;--bg:#f6f8f3;--panel:#eef3eb;--raised:#fbfcf9;--line:#d3dfd2;--strong:#0b190f;--text:#15301e;
--muted:#2b4434;--faint:#4a6352;--chip:#e1ebdf;--accent-low:#d5e8d9;--bar:#c6d5c8;--ring:#cfdfd1;
--brand:#2e7547;--accent:#2e7547;--link:#2e7547;--label:#2e7547;--on-brand:#f6f8f3;
--ok:#2e7547;--warn:#8f5f0c;--err:#b73a2c;
--flow-1:#a6cdb0;--flow-2:#6aa77b;--flow-3:#2e7547;--flow-4:#1b4a2b;
--fam-cambium:#3c9057;--fam-claude:#3d6db3;--fam-mycelium:#93774a;--health:var(--faint);
--sans:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
--mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono",monospace;
--s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:24px}
@media (prefers-color-scheme:dark){:root{--bg:#0b190f;--panel:#0f2215;--raised:#10241a;--line:#1d3a25;--strong:#eef5ef;--text:#d6e3d8;
--muted:#b4c6b8;--faint:#87a08d;--chip:#142c1c;--accent-low:#173620;--bar:#24412d;--ring:#1d4128;
--brand:#3c9057;--accent:#3c9057;--link:#92d3a6;--label:#56ad70;--on-brand:#0b190f;
--ok:#56ad70;--warn:#d9a640;--err:#e0624f;
--flow-1:#2a5c39;--flow-2:#3c9057;--flow-3:#56ad70;--flow-4:#92d3a6;
--fam-cambium:#56ad70;--fam-claude:#7ea6dc;--fam-mycelium:#c2a874}}
body[data-health=ok]{--health:var(--ok)}body[data-health=warn]{--health:var(--warn)}body[data-health=err]{--health:var(--err)}body.down{--health:var(--faint)}
*{box-sizing:border-box}
html{scrollbar-color:var(--bar) transparent;caret-color:var(--brand);accent-color:var(--brand)}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.5 var(--sans);font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
::selection{background:color-mix(in srgb,var(--brand) 45%,transparent);color:var(--strong)}
a{color:var(--link);text-decoration:none;text-underline-offset:.2em;text-decoration-thickness:1px}a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
a:focus-visible{border-radius:2px}
code,.mono{font-family:var(--mono);font-size:12px}
#top{position:sticky;top:0;z-index:1;border-top:2px solid var(--health);transition:border-color .4s ease-out}
header{display:flex;flex-wrap:wrap;align-items:center;gap:6px var(--s4);padding:10px var(--s4);border-bottom:1px solid var(--line);background:var(--bg)}
header h1{display:inline-flex;align-items:center;gap:10px;margin:0 var(--s2) 0 0;font-size:13px;font-weight:300;letter-spacing:.28em;text-transform:uppercase;color:var(--strong)}
/* The tree ring, the oakgreen mark, worn in the health colour: the tab's state reads before its text does. */
.mark{flex:none;display:block;width:22px;height:22px;color:var(--health);transition:color .4s ease-out,transform .6s cubic-bezier(.16,1,.3,1)}.mark svg,.wm svg{display:block;width:100%;height:100%}
header h1:hover .mark{transform:rotate(-30deg)}
.tabs{display:flex;gap:2px;padding:6px var(--s3);border-bottom:1px solid var(--line);background:var(--bg);overflow-x:auto;scrollbar-width:none}
.tab{appearance:none;background:none;border:0;border-radius:999rem;padding:5px 12px;font:inherit;font-weight:400;color:var(--muted);cursor:pointer;display:inline-flex;align-items:center;gap:7px;white-space:nowrap;transition:background-color .15s ease-out,color .15s ease-out}
.tab:hover{color:var(--strong);background:color-mix(in srgb,var(--brand) 12%,transparent)}
.tab[aria-selected=true]{color:var(--strong);background:var(--accent-low);font-weight:500}
.tab:focus-visible{outline-offset:0}
.tab .count{min-width:20px;padding:0 6px;border-radius:999rem;background:var(--chip);color:var(--muted);font-size:12px;font-weight:500;text-align:center}
.tab[aria-selected=true] .count{background:color-mix(in srgb,var(--bg) 45%,transparent)}
.tab .count.attn{background:color-mix(in srgb,var(--warn) 20%,transparent);color:var(--warn);font-weight:600}
.tab .dot{margin:0}
main{padding:var(--s4) var(--s4) var(--s5);display:grid;gap:var(--s4);max-width:1600px}
.ib{display:grid;grid-template-columns:minmax(320px,440px) minmax(0,1fr);gap:var(--s3) var(--s4);align-items:start}
/* Figures: the stats bands over the Inbox and Queue tabs. Parts keep a fixed order and color as counts move;
   labels and values wear text colors, the swatch beside them carries identity. */
.figs{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:var(--s3) var(--s5);padding:var(--s3) var(--s4) var(--s4)}
.fig{flex:1 1 200px;min-width:0;display:grid;align-content:start;gap:6px}
.fig>h3,.ranked-h{font-size:12.5px;color:var(--text);margin:0;font-weight:500;display:flex;flex-wrap:wrap;gap:0 var(--s2);align-items:baseline}
.fig>h3 span{font-weight:400;color:var(--faint)}
.fig-total{flex:0 1 auto;min-width:120px}.fig-total .big{font-size:34px;font-weight:300;line-height:1.1;letter-spacing:-.015em;color:var(--strong)}
.fig-total .big.attn{color:var(--warn)}.fig-sub{font-size:12px;color:var(--muted)}.fig-sub+.fig-sub{margin-top:-4px}
.stack{display:flex;gap:2px;height:8px;margin-top:4px}.stack i{flex:var(--n) 1 0;min-width:3px;background:var(--c);border-radius:2px}
.stack i:first-child{border-radius:4px 2px 2px 4px}.stack i:last-child{border-radius:2px 4px 4px 2px}.stack i:only-child{border-radius:4px}
.stack.none{background:var(--chip);border-radius:4px}
.key{display:flex;flex-wrap:wrap;gap:2px var(--s3);font-size:12px;color:var(--muted)}
.key>span{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}.key i{width:8px;height:8px;border-radius:2px;background:var(--c)}
.key b{font-weight:600;color:var(--strong)}
.hist{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;font-size:11px;text-align:center}
.hcol{display:grid;gap:2px;min-width:0}.hcol b{font-size:12px;font-weight:600}.hcol b.zero{color:var(--faint);font-weight:400}
.hb{height:30px;display:flex;align-items:flex-end;border-bottom:1px solid var(--line)}
.hb i{flex:1;border-radius:3px 3px 0 0;background:color-mix(in oklch,var(--faint) 45%,var(--panel))}
.hcol span{color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* Queue figures: where every issue in the loop sits, then what the loop did in the last day. */
.stage-cells{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:var(--s2) var(--s3);margin-top:2px}
.stage-cell{display:grid;gap:1px;min-width:0;font-size:12px;color:var(--muted)}
.stage-cell .nm{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.stage-cell .nm i{display:inline-block;width:8px;height:8px;margin-right:5px;border-radius:2px;background:var(--c)}
.stage-cell b{font-size:20px;font-weight:400;color:var(--strong);line-height:1.25}.stage-cell b.zero{color:var(--faint);font-weight:300}
.stage-cell .sub{color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stage-cell.go{appearance:none;background:none;border:0;padding:0;margin:0;font:inherit;text-align:left;cursor:pointer;border-radius:6px}
.stage-cell.go:hover b{color:var(--warn)}.stage-cell.go:hover .nm{color:var(--text)}.stage-cell.go:focus-visible{outline-offset:3px}
.fig-flow{flex:3 1 420px}.fig-day{flex:2 1 260px}.fig-cost{flex:2 1 260px}
.cost-hist{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px;font-size:11px;text-align:center}
.hb.stk{flex-direction:column;justify-content:flex-end;align-items:stretch}.hb.stk i{flex:none;border-radius:0;background:var(--c)}
.hb.stk i:first-child{border-radius:3px 3px 0 0}
.cost{font-variant-numeric:tabular-nums}
.ranked{list-style:none;margin:2px 0 0;padding:0;display:grid;gap:3px;font-size:12px}
.ranked li{display:grid;grid-template-columns:minmax(0,9.5em) minmax(0,1fr) 3.5ch;gap:var(--s2);align-items:center}
.ranked .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}
.ranked .tr{height:6px}.ranked .tr i{display:block;height:100%;min-width:3px;border-radius:0 3px 3px 0;background:var(--flow-3)}
.ranked b{text-align:right;font-weight:600}
.day-foot{display:flex;flex-wrap:wrap;gap:2px var(--s3);font-size:12px;color:var(--muted)}
/* Inbox toolbar: filters and sort sit on the list they change. Each facet is a disclosure holding its tags. */
.ib-tools{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:var(--s2) var(--s3);border-bottom:1px solid var(--line)}
.ib-tools .sep-sort{margin-left:auto}
.dd{position:relative}
.dd-btn{appearance:none;font:inherit;font-size:12px;color:var(--muted);background:color-mix(in srgb,var(--raised) 70%,transparent);border:1px solid var(--line);border-radius:999rem;padding:3px 10px 3px 12px;transition:color .15s ease-out,border-color .15s ease-out,background-color .15s ease-out;cursor:pointer;display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.dd-btn::after{content:"";width:5px;height:5px;margin:-3px 1px 0 2px;border:solid currentColor;border-width:0 1.5px 1.5px 0;transform:rotate(45deg);opacity:.7;transition:transform .15s ease-out}
.dd-btn[aria-expanded=true]::after{transform:translateY(3px) rotate(-135deg)}
.dd-btn:hover{color:var(--strong);border-color:var(--label)}
.dd-btn[aria-expanded=true]{color:var(--strong);background:var(--chip)}
.dd-btn.on{color:var(--strong);border-color:color-mix(in srgb,var(--brand) 60%,var(--line));background:var(--accent-low)}
.dd-btn b{font-weight:600;color:var(--strong);max-width:12ch;overflow:hidden;text-overflow:ellipsis}.dd-btn .q{color:var(--faint)}
.menu{position:absolute;z-index:3;top:calc(100% + 4px);left:0;min-width:220px;max-width:min(320px,calc(100vw - 32px));max-height:min(340px,60vh);overflow:auto;padding:5px;
background:var(--raised);border:1px solid var(--line);border-radius:.75rem;scrollbar-width:thin;scrollbar-color:var(--bar) transparent}
.dd-sort .menu{left:auto;right:0;min-width:150px}
.opt{appearance:none;width:100%;display:grid;grid-template-columns:14px minmax(0,1fr) auto;gap:8px;align-items:center;padding:4px 10px 4px 8px;border:0;border-radius:999rem;background:none;font:inherit;font-size:12.5px;color:var(--text);text-align:left;cursor:pointer}
.opt:hover{background:color-mix(in srgb,var(--brand) 12%,transparent);color:var(--strong)}.opt:focus-visible{outline-offset:-2px}
.opt .bx{width:13px;height:13px;border:1px solid color-mix(in srgb,var(--text) 35%,var(--line));border-radius:3px;display:grid;place-items:center}
.opt[aria-pressed=true] .bx{background:var(--brand);border-color:var(--brand)}
.opt[aria-pressed=true] .bx::after{content:"";width:3px;height:7px;margin-top:-2px;border:solid var(--on-brand);border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}
.opt.radio .bx{border-radius:50%}.opt.radio[aria-pressed=true] .bx{background:var(--raised);border:4px solid var(--brand)}.opt.radio[aria-pressed=true] .bx::after{content:none}
.opt .lb{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.opt .n{color:var(--faint)}
.ib-active{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px var(--s3);border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--brand) 6%,var(--panel));font-size:12px}
.chip{appearance:none;font:inherit;font-size:12px;display:inline-flex;align-items:center;gap:6px;padding:1px 6px 1px 9px;border-radius:999px;cursor:pointer;white-space:nowrap;
color:var(--strong);font-weight:500;border:1px solid color-mix(in srgb,var(--brand) 60%,var(--line));background:var(--accent-low)}
.chip .x{position:relative;width:10px;height:10px;opacity:.6}.chip .x::before,.chip .x::after{content:"";position:absolute;left:4px;top:0;width:1.5px;height:10px;background:currentColor;transform:rotate(45deg)}.chip .x::after{transform:rotate(-45deg)}
.chip:hover .x{opacity:1}.chip:hover{border-color:var(--label)}
.dd-btn:focus-visible,.chip:focus-visible,.btn:focus-visible{outline-offset:2px}
.ib-count{margin-left:auto;color:var(--muted);white-space:nowrap}
.ib-side{min-width:0}
.ib-list{padding:0}
.ib-list .row:last-child{border-radius:0 0 .75rem .75rem}
.ib-list ul{list-style:none;margin:0;padding:0}
.ib-group{display:flex;justify-content:space-between;gap:var(--s2);padding:6px var(--s3) 5px;border-top:1px solid var(--line);background:color-mix(in srgb,var(--bg) 55%,var(--panel));font-size:12px;font-weight:500;color:var(--label)}
.ib-group .n{font-weight:400;color:var(--faint)}
.row{display:grid;gap:4px;padding:11px var(--s3);border-top:1px solid var(--line);cursor:pointer;transition:background-color .15s ease-out}

.row:hover{background:color-mix(in srgb,var(--brand) 7%,transparent)}
.row[aria-selected=true]{background:var(--accent-low)}
.row:focus-visible{outline-offset:-2px}
.row-t{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;font-weight:500;color:var(--strong)}
.row[aria-selected=true] .row-t{font-weight:600}
.row .meta{align-items:center}.row .age{margin-left:auto}
.why{display:inline-block;padding:0 8px;border-radius:999rem;font-size:12px;font-weight:600;color:var(--warn);background:color-mix(in srgb,var(--warn) 14%,transparent)}
.prio-critical{color:var(--err);font-weight:600}.prio-high{color:var(--warn);font-weight:600}
.keys{margin-top:var(--s2);font-size:12px;color:var(--faint)}
kbd{font:11px var(--mono);padding:0 5px;border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;color:var(--muted);background:var(--raised)}
.ib-pane{position:sticky;top:calc(var(--top-h,90px) + var(--s4));max-height:calc(100vh - var(--top-h,90px) - var(--s4) * 2);overflow:auto;padding:var(--s4) var(--s5) var(--s5);scrollbar-width:thin;scrollbar-color:var(--bar) transparent;outline:none}
.ib-pane:focus-visible{outline-offset:-2px}
.pane-head{display:grid;gap:10px;padding-bottom:var(--s4);border-bottom:1px solid var(--line)}
h2.pane-title{font-size:22px;font-weight:300;line-height:1.25;letter-spacing:-.015em;color:var(--strong);margin:0;overflow-wrap:anywhere;text-wrap:balance}
.pane-title .faint{font-weight:300}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s1) var(--s3)}
.btn{display:inline-block;padding:4px 14px;border-radius:999rem;border:1px solid var(--brand);background:var(--brand);color:var(--on-brand);font:inherit;font-weight:500;cursor:pointer;transition:background-color .15s ease-out,border-color .15s ease-out,color .15s ease-out}
.btn:hover{text-decoration:none;background:color-mix(in srgb,var(--brand) 85%,#eef5ef);border-color:color-mix(in srgb,var(--brand) 85%,#eef5ef)}
button.btn{background:none;border-color:var(--line);color:var(--strong)}button.btn:hover{background:none;border-color:var(--label);color:var(--label)}
.back{display:none;justify-self:start}
.part{margin-top:var(--s5)}.part>h3,.part>summary>h3{font-size:12.5px;color:var(--label);margin:0 0 var(--s2);font-weight:500;display:flex;gap:var(--s2);align-items:baseline}
.part>h3 span,.part>summary>h3 span{font-weight:400;color:var(--faint)}
/* A collapsible part (cambium's status log): the whole header toggles it, with a caret in place of the list marker. */
.part>summary{list-style:none;cursor:pointer}.part>summary::-webkit-details-marker{display:none}
.part>summary>h3{align-items:center}.part>summary>h3::before{content:'';flex:none;width:5px;height:5px;margin:0 2px 0 1px;border:solid currentColor;border-width:0 1.5px 1.5px 0;transform:rotate(-45deg);transition:transform .15s ease-out}.part[open]>summary>h3::before{transform:translateY(-2px) rotate(45deg)}
.part>summary:hover>h3{color:var(--strong)}.part>summary:focus-visible{border-radius:2px}
.part:not([open])>summary>h3{margin-bottom:0}
.part .banner{margin-bottom:var(--s2)}
.cmt{padding:var(--s3) 0;border-top:1px solid var(--line)}.cmt:first-of-type{border-top:0;padding-top:0}
.cmt-head{display:flex;flex-wrap:wrap;gap:2px 8px;align-items:baseline;font-size:12px;margin-bottom:var(--s1)}.cmt-head b{font-size:13px;font-weight:500;color:var(--strong)}
.status{padding:var(--s3) var(--s4);border-radius:.75rem;border:1px solid var(--line);background:color-mix(in srgb,var(--bg) 40%,var(--panel))}
/* cambium's status comment: its "Last failure" is prose in a code fence, and its history table carries long reasons.
   Both fill the pane and wrap instead of scrolling sideways. */
.status .md{max-width:none}.status .md pre{max-height:40vh}.status .md pre code{white-space:pre-wrap;overflow-wrap:anywhere}
.status .md table{width:100%}.status .md th:last-child,.status .md td:last-child{width:100%;min-width:24ch}
.status .md td code{overflow-wrap:anywhere}
.md{font-size:13.5px;line-height:1.65;overflow-wrap:anywhere;max-width:78ch}
.md>:first-child{margin-top:0}.md>:last-child{margin-bottom:0}
.md p,.md ul,.md ol,.md pre,.md blockquote,.md .md-table,.md details{margin:0 0 var(--s2)}
.md h3,.md h4,.md h5,.md h6{margin:var(--s4) 0 var(--s1);font-weight:500;line-height:1.3;color:var(--strong);text-wrap:balance}.md h3{font-size:15px}.md h4{font-size:14px}.md h5,.md h6{font-size:13px}
.md ul,.md ol{padding-left:22px}.md li>p{margin:0}.md li+li{margin-top:2px}.md li>ul,.md li>ol{margin:2px 0 0}
.md li.task{list-style:none}.md li.task>input{margin:0 6px 0 -20px;vertical-align:-1px;accent-color:var(--ok)}.md li.task>p:first-of-type{display:inline}
.md code{font-size:12px;background:var(--accent-low);color:var(--strong);padding:.1em .35em;border-radius:.3em}
.md pre{background:var(--bg);border:1px solid var(--line);padding:var(--s2) var(--s3);border-radius:.625rem;overflow:auto;scrollbar-width:thin}
.md pre code{background:none;color:var(--text);padding:0;white-space:pre;overflow-wrap:normal}
.md blockquote{margin-left:0;padding-left:var(--s3);border-left:2px solid var(--bar);color:var(--muted)}
.md hr{border:0;border-top:1px solid var(--line);margin:var(--s3) 0}
.md .md-table{overflow-x:auto;scrollbar-width:thin}.md a{text-decoration:underline;text-decoration-color:color-mix(in srgb,currentColor 40%,transparent)}.md a:hover{text-decoration-color:currentColor}.md table{width:auto;overflow-wrap:normal}.md th,.md td{font-size:12px;padding:3px 12px 3px 0}
.md td:last-child{white-space:normal;min-width:18ch;overflow-wrap:anywhere}
.md summary{cursor:pointer;color:var(--muted)}.md summary:hover{color:var(--text)}.md details[open]>summary{margin-bottom:var(--s1)}
.md summary:focus-visible{border-radius:2px}
.calm{padding:var(--s5) 0;text-align:center}.calm p{margin:0}.calm p+p{margin-top:6px}.calm b{font-size:17px;font-weight:300;letter-spacing:-.01em;color:var(--strong)}
section.calm{position:relative;overflow:hidden;padding:52px var(--s4)}section.calm>*{position:relative}
section.calm>.wm{position:absolute;top:-7rem;right:-4rem;width:17rem;height:17rem;color:var(--ring);pointer-events:none}
.lane-label{font-weight:400;color:var(--faint);margin-left:6px}
.linkish{appearance:none;background:none;border:0;padding:0;font:inherit;color:var(--link);cursor:pointer;text-underline-offset:.2em}.linkish:hover{text-decoration:underline}
.linkish:focus-visible{border-radius:2px}
section{background:var(--panel);border:1px solid var(--line);border-radius:.75rem;padding:14px var(--s4) var(--s4);min-width:0}
section.attn{border-color:color-mix(in srgb,var(--warn) 45%,var(--line))}section.attn>h2 .n{color:var(--warn)}
h2{font-size:14px;letter-spacing:-.005em;line-height:1.3;color:var(--strong);margin:0 0 10px;font-weight:500;text-wrap:balance}
h2 .n{color:var(--faint);font-weight:400;margin-left:6px}
.muted{color:var(--muted)}.faint{color:var(--faint)}.ok{color:var(--ok)}.warn{color:var(--warn)}.err{color:var(--err)}
.pill{display:inline-block;padding:0 8px;border-radius:999rem;background:var(--chip);font-size:12px}
.pill.ok{background:color-mix(in srgb,var(--ok) 16%,transparent)}.pill.warn{background:color-mix(in srgb,var(--warn) 18%,transparent)}
.pill.err{background:color-mix(in srgb,var(--err) 16%,transparent)}.pill .faint{color:var(--muted)}
.session .cmd{display:flex;align-items:flex-start;gap:var(--s2)}.session code{flex:1;padding:5px 10px;border:1px solid var(--line);border-radius:.625rem;background:var(--bg);overflow-wrap:anywhere;user-select:all}
.banner{padding:10px var(--s4);border-radius:.75rem;border:1px solid var(--line);background:var(--panel)}
.banner.err{border-color:color-mix(in srgb,var(--err) 45%,var(--line))}.banner.warn{border-color:color-mix(in srgb,var(--warn) 45%,var(--line))}
.watch{list-style:none;margin:0;padding:0}.watch li+li{margin-top:2px}
.detail{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:var(--s4);align-items:start}
.stats{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s4);margin-top:var(--s3);padding-top:var(--s3);border-top:1px solid var(--line)}.stat b{font-size:18px;font-weight:400;color:var(--strong);margin-right:5px}
.steps{display:flex;flex-wrap:wrap;gap:var(--s1)}.steps+.err{margin-top:var(--s1)}
/* Queue tab: work in hand over the queues it came from. One column template for both rows, so Triage sits over Intake,
   Running over Task and Pull requests over Promote. The queues sit on the page, the active row is lifted onto a panel. */
.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr) minmax(0,1.3fr);gap:var(--s4) var(--s5)}
.active:not(.has-triage)>.l-running{grid-column:span 2}
section.lanes{background:none;border-color:transparent}
.col{min-width:0}.col ul{list-style:none;margin:0;padding:0}
.col>h2{display:flex;flex-wrap:wrap;align-items:baseline;padding-top:10px;border-top:2px solid var(--line)}.col>h2 .lane-label:first-of-type{margin-left:auto}
.col.l-intake>h2,.col.l-triage>h2{border-top-color:var(--flow-1)}.col.l-task>h2{border-top-color:var(--flow-2)}.col.l-running>h2{border-top-color:var(--flow-3)}
.col.l-prs>h2{border-top-color:color-mix(in oklch,var(--flow-3),var(--flow-4))}.col.l-promote>h2{border-top-color:var(--flow-4)}
.col li.work{display:grid;gap:5px;padding:10px 0}.col li.work:first-child{padding-top:var(--s1)}
.work-head{display:flex;align-items:baseline;gap:var(--s3)}.work-head>a{min-width:0;flex:1}
.closes{flex:none;font-size:12px}
.trail{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 6px;font-size:12px;overflow-wrap:anywhere}.trail b{font-weight:600;color:var(--strong)}.trail .sep{color:var(--faint)}
.prog{display:flex;align-items:center;gap:6px;font-size:12px}.prog .muted{margin-left:auto;padding-left:var(--s2)}
.prog .bar{flex:1;width:auto;min-width:48px;margin:0}
.stages{list-style:none;margin:3px 0 1px;padding:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:3px}
.col li.stg{padding:0;border-top:0;display:grid;gap:3px;min-width:0;font-size:11px;color:var(--faint)}
.stg span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stg i{display:block;height:4px;border-radius:2px;background:var(--bar)}
.stg.done{color:var(--muted)}.stg.done i{background:var(--ok)}
.stg.now{color:var(--text);font-weight:600}.stg.fail{color:var(--err);font-weight:600}.stg.fail i{background:var(--err)}
.work.draft .stg i{opacity:.5}
/* In flight: a slow sheen runs along a stage in progress and a running worker's clock. The page re-renders on every poll,
   so each one is started at the shared clock's phase (inline animation-delay) and the motion never jumps. */
.stg.now i,.prog .bar i.moving{background:var(--flow-3)}
@media (prefers-reduced-motion:no-preference){.stg.now i,.prog .bar i.moving{animation:sheen 2.4s ease-in-out infinite}}
@keyframes sheen{0%,100%{opacity:1}50%{opacity:.45}}
.col li>a,.work-head>a{color:var(--strong)}.col li>a:hover,.work-head>a:hover{color:var(--link);text-decoration:none}.col li>a:hover .t,.work-head>a:hover .t{text-decoration:underline}
.col li{padding:6px 0;border-top:1px solid var(--line)}.col li:first-child{border-top:0}
.t{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.col .t{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.meta{font-size:12px;color:var(--muted);display:flex;flex-wrap:wrap;gap:2px 8px}
.empty{color:var(--faint);font-size:12px}
.col>h3.sub{display:flex;align-items:baseline;gap:6px;margin:var(--s3) 0 0;padding-top:var(--s2);border-top:1px dashed var(--line);font-size:12.5px;font-weight:500;color:var(--label)}
.col li .why-wait{font-size:12px;color:var(--muted);overflow-wrap:anywhere}
table{border-collapse:collapse;width:100%}th{text-align:left;font-weight:500;color:var(--text);font-size:12px;letter-spacing:.04em}thead th{border-bottom:1px solid var(--bar)}
td,th{padding:4px 10px 4px 0;border-top:1px solid var(--line);vertical-align:top;white-space:nowrap}tr.logs td{border-top:0;padding-top:0;white-space:normal;overflow-wrap:anywhere}td.br{white-space:normal;overflow-wrap:anywhere;min-width:16ch}.scroll{overflow-x:auto}thead th{border-top:0}
.bar{display:inline-block;width:80px;height:6px;background:var(--bar);border-radius:3px;vertical-align:middle;overflow:hidden;margin-right:6px}
.bar i{display:block;height:100%;background:var(--ok)}.bar i.warn{background:var(--warn)}.bar i.err{background:var(--err)}
.events,.scroll{scrollbar-width:thin;scrollbar-color:var(--bar) transparent}
.events:focus-visible,.scroll:focus-visible{border-radius:2px}
body.down #top,body.down main>:not(#down){opacity:.5;transition:opacity .3s ease-out}
.events{max-height:320px;overflow:auto}.events div{display:grid;grid-template-columns:62px 40px minmax(0,1fr);gap:8px;padding:2px 0}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--faint);margin-right:5px}
.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.err{background:var(--err)}
a.row-link{color:var(--strong)}a.row-link:hover{text-decoration:none;color:var(--link)}tr.run td{transition:background-color .15s ease-out}tr.run:hover td{background:color-mix(in srgb,var(--brand) 7%,transparent)}
.trace-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--s1) var(--s3)}.trace-head .title{font-size:18px;font-weight:300;letter-spacing:-.01em;color:var(--strong)}.trace-head .mono{overflow-wrap:anywhere}
.wf{margin-top:var(--s3)}
.wf-axis{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,3fr) 64px;gap:var(--s3);font-size:12px;color:var(--faint);padding-bottom:2px}
.wf-axis .ticks{display:flex;justify-content:space-between}
.sp{appearance:none;background:none;border:0;border-top:1px solid var(--line);width:100%;display:grid;grid-template-columns:minmax(0,2fr) minmax(0,3fr) 64px;gap:var(--s3);align-items:center;padding:3px 0;font:inherit;color:inherit;text-align:left;cursor:pointer}
.sp:hover{background:color-mix(in srgb,var(--brand) 7%,transparent)}.sp:focus-visible{outline-offset:-2px;border-radius:3px}
.sp .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sp .nm .faint{margin-left:6px}
.sp .track{position:relative;height:12px;background:color-mix(in srgb,var(--bar) 35%,transparent);border-radius:2px}
.sp .track i{position:absolute;top:2px;height:8px;border-radius:2px;background:var(--fam,var(--muted));min-width:2px}
.f-cambium{--fam:var(--fam-cambium)}.f-claude{--fam:var(--fam-claude)}.f-mycelium{--fam:var(--fam-mycelium)}
.sp .track i.wait{background:repeating-linear-gradient(135deg,var(--bar) 0 3px,transparent 3px 6px);box-shadow:inset 0 0 0 1px var(--bar)}.sp .track i.err{background:var(--err)}
.legend{display:flex;flex-wrap:wrap;gap:2px var(--s3);margin-bottom:var(--s3);font-size:12px;color:var(--muted)}.legend span{display:inline-flex;align-items:center;gap:5px}
.legend i{width:10px;height:8px;border-radius:2px;background:var(--fam,var(--muted))}.legend i.wait{background:repeating-linear-gradient(135deg,var(--bar) 0 3px,transparent 3px 6px);box-shadow:inset 0 0 0 1px var(--bar)}.legend i.err{background:var(--err)}
.sp .d{text-align:right;color:var(--muted)}
.sp .nm .pill{margin-left:6px}
main:has(.flame){max-width:none}
.quiet-note{display:flex;flex-wrap:wrap;gap:2px var(--s2);margin-bottom:var(--s2);font-size:12px;color:var(--faint)}
.flame{margin-top:var(--s3);padding-bottom:var(--s3);border-bottom:1px solid var(--line);max-height:60vh;overflow:hidden auto;scrollbar-width:thin;scrollbar-color:var(--bar) transparent}
.flame h2{margin-bottom:var(--s1)}.crumbs{display:flex;flex-wrap:wrap;gap:2px 6px;font-size:12px;color:var(--faint);margin-bottom:var(--s2);overflow-wrap:anywhere}
.fl{position:relative}
.fr{appearance:none;position:absolute;height:18px;min-width:0;padding:0;border:0;border-radius:2px;box-shadow:inset 0 0 0 1px var(--panel);font:11px/18px var(--mono);text-align:left;overflow:hidden;cursor:pointer;
color:var(--text);background:color-mix(in srgb,var(--fam,var(--muted)) 32%,var(--panel))}
.fr:hover{background:color-mix(in srgb,var(--fam,var(--muted)) 55%,var(--panel))}.fr:focus-visible{outline-offset:-2px}
.fr.err{box-shadow:inset 0 -2px 0 var(--err),inset 0 0 0 1px var(--panel)}
.fr>span{display:block;padding:0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fl-note{font-size:12px;color:var(--faint);margin-top:var(--s2)}
.attrs{margin:0;padding:var(--s2) 0 var(--s3) var(--s4);display:grid;grid-template-columns:max-content minmax(0,1fr);gap:2px var(--s3);font-size:12px}
.attrs dt{color:var(--muted)}.attrs dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}
/* Intake tab: mycelium's sources. Configured sources are a table whose dots carry each one's state; the rest are a
   quiet ruled list naming what each lacks. What mycelium filed wears bark, its span family colour on the Traces tab. */
.fig-into{flex:2 1 260px}.fig-into p{margin:0}.into-repo{font-size:15px;color:var(--strong)}
.ranked.bark .tr i{background:var(--fam-mycelium)}
.src-name{display:inline-flex;align-items:baseline;gap:6px}.src-name b{font-weight:500;color:var(--strong)}
td.wrap{white-space:normal;min-width:16ch;overflow-wrap:anywhere}
tr.src-err td{border-top:0;padding-top:0;white-space:normal;overflow-wrap:anywhere}
.subhead{display:flex;align-items:baseline;gap:6px;margin:var(--s5) 0 0;font-size:12.5px;font-weight:500;color:var(--label)}.subhead .n{color:var(--faint);font-weight:400}
.off-list{list-style:none;margin:var(--s1) 0 0;padding:0}
.off-list li{display:grid;grid-template-columns:minmax(0,15em) minmax(0,1fr);gap:2px var(--s3);padding:6px 0;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}
.off-list li:first-child{border-top:0}.off-list .src-name b{color:var(--text);font-weight:400}.off-list .mono{overflow-wrap:anywhere}
table.fit{width:auto}table.fit td,table.fit th{padding-right:var(--s5)}
/* Phone: each table row stacks into a block (the header row hidden, cells labelled), so state never scrolls offscreen. */
@media (max-width:640px){.off-list li{grid-template-columns:minmax(0,1fr)}.fig-into{flex-basis:100%}
table.stack-sm,table.stack-sm tbody,table.filings,table.filings tbody{display:block}table.stack-sm thead,table.filings thead{display:none}
tr.src-row,table.filings tr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px var(--s3);padding:10px 0;border-top:1px solid var(--line)}
tbody>tr.src-row:first-child,table.filings tr:first-child{border-top:0}
tr.src-row td,table.filings td{border:0;padding:0;white-space:normal;min-width:0}
tr.src-row .c-name{display:flex;align-items:flex-start}tr.src-row .c-name .dot{flex:none;margin-top:6px}tr.src-row .src-name{flex-wrap:wrap;column-gap:6px}
tr.src-row .c-state{grid-column:2;grid-row:1;justify-self:end}tr.src-row .c-reads,tr.src-row .c-last{grid-column:1/-1}
tr.src-row td[data-k]::before{content:attr(data-k) " ";color:var(--faint)}
table.stack-sm tr.src-err{display:block}table.stack-sm tr.src-err td{display:block;padding:0 0 10px}
.filings .c-src{grid-row:1;color:var(--strong)}.filings .c-act{grid-column:2;grid-row:1;justify-self:end}
.filings .c-when{grid-row:2;color:var(--muted)}.filings .c-issue{grid-column:2;grid-row:2;justify-self:end}.filings .c-ext{grid-column:1/-1}}
@media (max-width:900px){.ib{grid-template-columns:minmax(0,1fr)}.ib.open>.figs,.ib.open>.ib-side,.ib:not(.open)>.ib-pane{display:none}
.ib-pane{position:static;max-height:none;padding:var(--s3) var(--s4) var(--s4)}.back{display:inline-block}
.dd{position:static}.menu{left:var(--s3);right:var(--s3);max-width:none}.dd-sort .menu{left:auto}}
@media (max-width:640px){.stage-cells{grid-template-columns:repeat(3,minmax(0,1fr))}.fig-total{flex-basis:100%}.fig{flex-basis:140px}.fig:has(.hist),.fig-flow,.fig-day,.fig-cost{flex-basis:100%}}
@media (max-width:1100px){.active{grid-template-columns:repeat(2,minmax(0,1fr))}.active>.col{grid-column:auto}.active.has-triage>.l-prs{grid-column:1/-1}.detail{grid-template-columns:1fr}}
/* Narrow: the status header wraps to three lines, so it scrolls away and only the tabs (which carry the health dot) stay put. */
@media (max-width:760px){#top{display:contents}header{border-top:2px solid var(--health);transition:border-color .4s ease-out}
.tabs{position:sticky;top:0;z-index:1}body.down header,body.down .tabs{opacity:.5;transition:opacity .3s ease-out}
td.br{white-space:nowrap}.grid,.active{grid-template-columns:minmax(0,1fr)}.active>.col,.active.has-triage>.l-prs{grid-column:auto}
.sp,.wf-axis{grid-template-columns:minmax(0,1fr) 56px}.sp .track,.wf-axis .ticks{grid-column:1/-1;order:3}.wf-axis>span:not(.ticks){display:none}}
@media (max-width:480px){main{padding:var(--s3) var(--s3) var(--s5);gap:var(--s3)}section{padding:var(--s3)}
.tabs{padding:6px var(--s1);gap:0}.tab{padding:5px 8px;gap:5px}}
/* Graphs tab: cambium's graphs in a drawer beside the drawing of the one chosen. The drawing persists across polls
   (only its figures are patched), so the replay of the day's moves never restarts. Pulses wear the flow hue;
   a node's queue label is a swatch in its meta line, colored like the Queue tab's lanes. */
main:has(.gx){max-width:none}
.gx{display:grid;grid-template-columns:264px minmax(0,1fr);gap:var(--s4);align-items:start}
.gx.undocked{grid-template-columns:minmax(0,1fr)}.gx.undocked>.gx-drawer{display:none}
.gx-drawer{background:var(--panel);border:1px solid var(--line);border-radius:.75rem;position:sticky;top:calc(var(--top-h,90px) + var(--s4));max-height:calc(100vh - var(--top-h,90px) - var(--s4) * 2);overflow:auto;padding:var(--s3) 0 var(--s3);scrollbar-width:thin;scrollbar-color:var(--bar) transparent}
.gx-dh{display:flex;align-items:center;gap:var(--s2);padding:0 var(--s4) var(--s2)}.gx-dh h2{margin:0}.gx-dh .icon-btn{margin-left:auto;display:none}
.gx-list{list-style:none;margin:0;padding:0}
.gx-item{appearance:none;width:100%;display:grid;gap:3px;padding:10px var(--s4);border:0;border-top:1px solid var(--line);background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;transition:background-color .15s ease-out}
.gx-item:hover{background:color-mix(in srgb,var(--brand) 7%,transparent)}
.gx-item[aria-current=true]{background:var(--accent-low)}
.gx-item:focus-visible{outline-offset:-2px}
.gx-nm{display:flex;align-items:baseline;gap:var(--s2)}.gx-nm b{font:600 13px var(--mono);color:var(--strong)}
.gx-item[aria-current=true] .gx-nm b{color:var(--label)}
.gx-about{font-size:12px;color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.gx-item .meta b{font-weight:600;color:var(--strong)}
.gx-src{margin:0;padding:var(--s3) var(--s4) 0;border-top:1px solid var(--line);font-size:12px;color:var(--faint)}
.gx-stage{position:relative;padding:0}
.gx-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s2) var(--s3);padding:var(--s3) var(--s4);border-bottom:1px solid var(--line)}
.gx-title{margin:0;font:600 15px/1.3 var(--mono);color:var(--strong)}
.gx-head .gx-about{flex-basis:100%;margin:0;font-size:13px;-webkit-line-clamp:3;max-width:90ch}
.gx-legend{margin-left:auto;display:flex;flex-wrap:wrap;gap:2px var(--s3);font-size:12px;color:var(--muted)}
.gx-legend span{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}.gx-legend svg{overflow:visible}
.lg-step,.lg-wait{fill:var(--panel);stroke:color-mix(in oklch,var(--text) 30%,var(--line))}.lg-wait{fill:var(--chip)}
.lg-end{fill:var(--panel);stroke:var(--muted)}.lg-end-dot{fill:var(--muted)}.lg-pulse{stroke:var(--flow-3);stroke-width:2.5;stroke-linecap:round}.lg-head{fill:var(--flow-3)}
.gx-legend .sw{width:8px;height:8px;border-radius:50%;background:var(--c)}
.icon-btn{appearance:none;display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border:1px solid var(--line);border-radius:999rem;background:color-mix(in srgb,var(--raised) 70%,transparent);color:var(--muted);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;transition:color .15s ease-out,border-color .15s ease-out}
.icon-btn:hover{color:var(--strong);border-color:var(--label)}
.icon-btn:focus-visible{outline-offset:2px}
.icon-btn[aria-pressed=true]{color:var(--strong);background:var(--accent-low)}
.icon-btn svg{width:14px;height:14px;flex:none;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.gx-canvas{padding:var(--s5) var(--s4) var(--s4);overflow-x:auto;scrollbar-width:thin;scrollbar-color:var(--bar) transparent}
.gx-svg{display:block;margin:0 auto;height:auto;overflow:visible;font-family:var(--sans)}
.g-edge{fill:none;stroke:color-mix(in oklch,var(--muted) 62%,var(--panel));stroke-width:var(--sw,1.25);transition:opacity .15s ease-out,stroke .15s ease-out}
.g-edge.idle{stroke:color-mix(in oklch,var(--muted) 34%,var(--panel))}
.g-edge.flash{stroke:var(--flow-3);transition:none}
.g-arrow{fill:color-mix(in oklch,var(--muted) 72%,var(--panel))}
.g-lbl rect{fill:var(--panel)}.g-lbl text{font:11px var(--mono);fill:var(--muted)}
.g-end circle{fill:var(--panel);stroke:color-mix(in oklch,var(--muted) 62%,var(--panel));stroke-width:1.25}.g-end circle+circle{fill:color-mix(in oklch,var(--muted) 62%,var(--panel));stroke:none}
.g-node{cursor:pointer;outline:none}
.g-node .body{fill:var(--bg);stroke:color-mix(in oklch,var(--text) 22%,var(--line));stroke-width:1;transition:stroke .15s ease-out,fill .15s ease-out}
.g-node.wait .body{fill:color-mix(in oklch,var(--chip) 75%,var(--panel))}
.g-node.start .body{fill:var(--accent-low);stroke:none}
.g-node .nm{font:600 12px var(--mono);fill:var(--strong)}
.g-node.start .nm{font-weight:500;font-size:11px;fill:var(--muted)}
.g-node .mt{font-size:11px;fill:var(--faint)}
.g-node .sw{fill:var(--c)}
.g-node:focus-visible{outline:none}.g-node:hover .body,.g-node.on .body{stroke:var(--brand);stroke-width:1.5}
.g-node:focus-visible .body{stroke:var(--brand);stroke-width:2}
.g-badge circle{fill:var(--flow-3)}.g-badge.human circle{fill:var(--warn)}
.g-badge text{font:600 10.5px var(--sans);fill:var(--on-brand)}
.g-ring{fill:none;stroke:var(--flow-3);stroke-width:2;opacity:0;pointer-events:none;transform-box:fill-box;transform-origin:center}
.g-ring.err{stroke:var(--err)}
.g-pulse{fill:none;stroke:var(--flow-3);stroke-width:2.5;stroke-linecap:round;pointer-events:none}
.g-pulse.live{stroke:var(--flow-4);stroke-width:3}.g-pulse.err{stroke:var(--err)}
.g-head{fill:var(--flow-3);pointer-events:none}.g-head.live{fill:var(--flow-4)}.g-head.err{fill:var(--err)}
.gx-svg .g-node,.gx-svg .g-edge,.gx-svg .g-lbl,.gx-svg .g-end{transition:opacity .15s ease-out}
.gx-svg.focus .g-node:not(.hot),.gx-svg.focus .g-lbl:not(.hot),.gx-svg.focus .g-end:not(.hot){opacity:.3}
.gx-svg.focus .g-edge:not(.hot){opacity:.18}.gx-svg.focus .g-edge.hot{stroke:var(--accent)}
.gx-tip{position:absolute;z-index:2;width:min(340px,calc(100% - 24px));padding:var(--s3) var(--s4) var(--s4);background:var(--raised);border:1px solid color-mix(in srgb,var(--label) 35%,var(--line));border-radius:.75rem;
font-size:12.5px;pointer-events:none;opacity:0;transform:translateY(2px);transition:opacity .12s ease-out,transform .12s ease-out}
.gx-tip.shown{opacity:1;transform:none}.gx-tip.pinned{pointer-events:auto}
.gx-tip[hidden]{display:block;visibility:hidden}
.tip-h{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px var(--s2)}.tip-h b{font:600 13px var(--mono);color:var(--strong);overflow-wrap:anywhere}
.tip-h .hint{margin-left:auto;font-size:11px;color:var(--faint)}
.tip-about{margin:var(--s1) 0 0;color:var(--muted);line-height:1.45}
.tip-sec{margin-top:var(--s3);padding-top:var(--s2);border-top:1px solid var(--line)}
.tip-sec>h3{margin:0 0 var(--s1);font-size:12px;color:var(--label);font-weight:500;display:flex;gap:var(--s2);align-items:baseline}
.tip-sec>h3 span{font-weight:400;color:var(--faint)}
.tip-figs{display:flex;flex-wrap:wrap;gap:2px var(--s4)}.tip-figs b{font-size:15px;font-weight:400;color:var(--strong);margin-right:3px}
.tip-list{list-style:none;margin:0;padding:0;display:grid;gap:3px}
.tip-list li{display:flex;align-items:baseline;gap:var(--s2);min-width:0}.tip-list .t{flex:1;min-width:0}.tip-list .n{margin-left:auto;color:var(--faint);flex:none}
.tip-list code{font-size:12px}.tip-list i{color:var(--muted)}
.gx-play{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s2) var(--s3);padding:10px var(--s4) var(--s3);border-top:1px solid var(--line);font-size:12px;color:var(--muted)}
.gx-tl{position:relative;flex:1 1 200px;min-width:120px;height:22px;cursor:pointer;border-radius:3px}
.gx-tl::before{content:"";position:absolute;left:0;right:0;top:50%;height:1px;background:var(--line)}
.gx-tl i{position:absolute;top:6px;width:1.5px;height:10px;margin-left:-.75px;background:color-mix(in oklch,var(--flow-2) 70%,var(--panel));border-radius:1px}
.gx-tl i.err{background:var(--err)}
.gx-tl b{position:absolute;top:1px;bottom:1px;width:2px;margin-left:-1px;background:var(--flow-4);border-radius:1px}
.gx-tl:focus-visible{outline-offset:2px}
.gx-play .what{flex-basis:100%}
.gx-scrim{display:none}
@media (max-width:900px){.gx,.gx.undocked{grid-template-columns:minmax(0,1fr)}
.gx-drawer,.gx.undocked>.gx-drawer{display:block;position:fixed;z-index:5;top:0;bottom:0;left:0;width:min(320px,86vw);max-height:none;border-radius:0 .75rem .75rem 0;border-left:0;
background:var(--raised);transform:translateX(-104%);visibility:hidden;transition:transform .28s cubic-bezier(.16,1,.3,1),visibility 0s linear .28s}
.gx.drawer-open .gx-drawer{transform:none;visibility:visible;transition:transform .28s cubic-bezier(.16,1,.3,1)}
.gx-dh .icon-btn{display:inline-flex}
.gx-scrim{display:block;position:fixed;inset:0;z-index:4;background:rgb(7 17 10 / .6);opacity:0;pointer-events:none;transition:opacity .2s ease-out}
.gx.drawer-open .gx-scrim{opacity:1;pointer-events:auto}
.gx-legend{margin-left:0;flex-basis:100%}}
@media (max-width:480px){.gx-head,.gx-play{padding-left:var(--s3);padding-right:var(--s3)}.gx-canvas{padding:var(--s3)}}
@media (prefers-reduced-motion:reduce){.gx-drawer,.gx.drawer-open .gx-drawer,.gx-scrim,.gx-tip,.mark,.tab,.row,.btn,.dd-btn,.icon-btn{transition:none}}
`

const JS = `
${[inboxItems, priorityRank, groupOf, inboxGroups, facetsOf, viewOf, inboxStats, markdown, autoApproved, flameTree, flameFrames, layoutGraph].map(String).join('\n')}
const $ = (id) => document.getElementById(id)
const RING = '${RING}'
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) el.setAttribute(k, v)
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k))
  return el
}
const ring = (cls) => { const el = h('span', { class: cls, 'aria-hidden': 'true' }); el.innerHTML = RING; return el }
const link = (url, text) => (/^https:\\/\\//.test(url || '') ? h('a', { href: url, target: '_blank', rel: 'noopener' }, text) : h('span', {}, text))
function dur(ms) {
  if (ms == null || !isFinite(ms)) return '–'
  if (Math.abs(ms) < 1000) return Math.round(Math.abs(ms)) + 'ms'
  const s = Math.round(Math.abs(ms) / 1000)
  if (s < 90) return s + 's'
  const m = Math.round(s / 60)
  if (m < 90) return m + 'm'
  const hr = Math.floor(m / 60)
  return hr < 48 ? hr + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '') : Math.round(hr / 24) + 'd'
}
const ago = (iso, now) => (!iso ? '–' : now - Date.parse(iso) < 1000 ? 'just now' : dur(now - Date.parse(iso)) + ' ago')
const section = (title, n, ...kids) => h('section', {}, h('h2', {}, title, n == null ? null : h('span', { class: 'n' }, n)), ...kids)
const MODE = { running: 'ok', draining: 'warn', paused: 'warn' }
const CHECK = { SUCCESS: ['ok', 'checks pass'], FAILURE: ['err', 'checks fail'], ERROR: ['err', 'checks errored'], PENDING: ['warn', 'checks running'], EXPECTED: ['warn', 'checks expected'] }
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many)
let traceIdx = {}
let costFlagUsd = null
const traceLink = (repo, issue) => {
  const id = repo && issue ? traceIdx[repo + '#' + issue] : null
  return id ? h('a', { href: '#traces/' + id, title: 'Open the newest trace for this issue' }, 'trace') : null
}

function header(s, now) {
  const hb = s.heartbeat, d = hb.data
  const kids = [h('h1', {}, ring('mark'), 'canopy')]
  if (d) {
    kids.push(h('span', { class: 'pill ' + (MODE[d.mode] || '') }, d.mode))
    kids.push(h('span', { class: 'muted' }, d.host || '?', d.pid ? ' · pid ' + d.pid : ''))
    kids.push(h('span', { class: hb.stale ? 'warn' : 'muted' }, 'tick ', d.tick.n ?? '–', ' · ', ago(d.tick.finishedAt, now), d.tick.durationMs != null ? ' · took ' + dur(d.tick.durationMs) : ''))
    if (d.tick.nextAt && !hb.stale) {
      const left = Date.parse(d.tick.nextAt) - now
      kids.push(h('span', { class: 'faint' }, left > 0 ? 'next in ' + dur(left) : 'next tick due now'))
    }
  }
  const gh = s.github
  kids.push(h('span', { class: 'faint', style: 'margin-left:auto', title: s.cacheMs ? 'Each repo is re-read from GitHub at most every ' + dur(s.cacheMs) : null },
    gh.fetchedAt ? 'GitHub read ' + ago(gh.fetchedAt, now) : 'GitHub not read yet'))
  return h('header', {}, kids)
}

const HB_TITLE = { missing: 'No heartbeat yet', unreadable: "Can't read the heartbeat", 'unknown-version': 'Heartbeat version mismatch' }

function banners(s, now) {
  const out = []
  const hb = s.heartbeat
  if (hb.status !== 'ok') out.push(h('div', { class: 'banner err' }, h('b', {}, (HB_TITLE[hb.status] || 'Heartbeat ' + hb.status) + ': '), hb.message))
  else if (hb.stale) out.push(h('div', { class: 'banner warn' }, h('b', {}, 'cambium may have stopped: '), hb.message))
  for (const r of s.github.repos) if (!r.ok) out.push(h('div', { class: 'banner err' }, h('b', {}, 'GitHub read failed for ' + r.slug + ': '), r.error,
    r.fetchedAt ? '. Showing what it returned ' + ago(r.fetchedAt, now) + '.' : ". Its issues and PRs aren't shown."))
  for (const r of (hb.data && hb.data.repos) || []) {
    if (r.pausedUntil) out.push(h('div', { class: 'banner' }, h('b', {}, 'Reads paused for ' + r.slug + ': '), 'the GraphQL budget is spent, so cambium waits for it to reset ' + until(r.pausedUntil, now) + '. Nothing is failing.'))
    else if (!r.ok) out.push(h('div', { class: 'banner warn' }, h('b', {}, 'cambium could not read ' + r.slug + ': '), r.error || 'no reason given'))
    for (const w of r.watch) if (w.state === 'red') out.push(h('div', { class: 'banner err' }, h('b', {}, w.workflow + ' is red' + (w.branch ? ' on ' + w.branch : '') + ' in ' + r.slug + ': '),
      w.run && w.run.url ? link(w.run.url, 'the newest run') : 'the newest run', ' concluded ' + ((w.run && w.run.conclusion) || 'failing'),
      w.issue ? [' · ', link('https://github.com/' + r.slug + '/issues/' + w.issue, 'watch issue #' + w.issue)] : null))
  }
  for (const n of s.notes || []) out.push(h('div', { class: 'banner' }, n))
  return out
}

function summary(d) {
  const c = d.counts, caps = d.caps
  const stat = (label, v, extra) => h('span', { class: 'stat' }, h('b', {}, v ?? '–'), h('span', { class: 'muted' }, label), extra ? h('span', { class: 'faint' }, ' ' + extra) : null)
  const live = d.workers.filter((w) => w.alive && w.phase === 'task').length
  const stats = h('div', { class: 'stats' },
    stat('intake', c.intake), stat('task', c.task), stat('running', c.running), stat('human', c.human),
    stat('promote', c.promote), stat('review', c.review), stat('workers', c.workers, caps.task != null ? '(' + live + ' of ' + caps.task + ' task slots in use' + (caps.dispatch ? ', dispatch cap ' + caps.dispatch : '') + ')' : null))
  const steps = h('div', { class: 'steps' }, d.steps.length ? d.steps.map((st) =>
    h('span', { class: 'pill ' + (st.ok ? 'ok' : 'err'), title: st.error || '' }, st.name, ' ', h('span', { class: 'faint' }, st.ms != null ? dur(st.ms) : ''))) : h('span', { class: 'empty' }, 'no steps recorded for this tick'))
  const errs = d.steps.filter((st) => !st.ok && st.error).map((st) => h('div', { class: 'err mono' }, st.name + ': ' + st.error))
  return section('Last tick', null, steps, errs, stats)
}

// Past or future: "in 12m" for a reset still to come, "5m ago" for one already due.
const until = (iso, now) => { const ms = Date.parse(iso) - now; return !isFinite(ms) ? 'at an unknown time' : ms > 0 ? 'in ' + dur(ms) + ' (' + new Date(iso).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' }) + ')' : dur(-ms) + ' ago' }
const WATCH = { green: ['ok', 'green'], red: ['err', 'red'], unknown: ['', 'unknown'] }

// Each repo cambium reads: whether its last read worked, the GraphQL budget left, and its watched workflows.
function repos(d, now) {
  const rows = d.repos.map((r) => {
    const read = r.pausedUntil ? h('span', { class: 'pill warn', title: r.error || '' }, 'paused')
      : r.ok ? h('span', { class: 'pill ok' }, 'read') : h('span', { class: 'pill err', title: r.error || '' }, 'read failed')
    const rl = r.rateLimit
    const budget = r.pausedUntil ? h('span', {}, 'spent · resets ' + until(r.pausedUntil, now))
      : rl ? h('span', { title: rl.cost != null ? 'Each read costs ' + rl.cost : null }, rl.remaining.toLocaleString() + ' left', rl.resetAt ? h('span', { class: 'faint' }, ' · resets ' + until(rl.resetAt, now)) : null)
      : h('span', { class: 'faint' }, 'not reported')
    const watch = r.watch.length ? h('ul', { class: 'watch' }, r.watch.map((w) => {
      const [tone, word] = WATCH[w.state] || WATCH.unknown
      const name = w.workflow + (w.branch ? ' @ ' + w.branch : '')
      return h('li', {}, h('span', { class: 'pill ' + tone, title: w.run && w.run.conclusion ? 'newest run: ' + w.run.conclusion : 'no completed run read yet' }, word), ' ',
        w.run && w.run.url ? link(w.run.url, name) : h('span', {}, name),
        w.issue ? [' · ', link('https://github.com/' + r.slug + '/issues/' + w.issue, '#' + w.issue)] : null,
        w.checkedAt ? h('span', { class: 'faint' }, ' · checked ' + ago(w.checkedAt, now)) : null,
        w.error ? h('span', { class: 'warn', title: w.error }, ' · ' + w.error) : null)
    })) : h('span', { class: 'faint' }, 'none')
    return h('tr', {}, h('td', {}, link('https://github.com/' + r.slug, r.slug)), h('td', {}, read), h('td', {}, budget), h('td', {}, watch))
  })
  if (!rows.length) return section('Repositories', 0, h('div', { class: 'empty' }, 'cambium lists no repositories'))
  return section('Repositories', rows.length, h('div', { class: 'scroll', tabindex: 0, 'aria-label': 'Repositories table' }, h('table', {},
    h('thead', {}, h('tr', {}, ['repo', 'last read', 'GraphQL budget', 'watched workflows'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows))))
}

function item(i, multi, now) {
  return h('li', {},
    link(i.url, h('span', { class: 't', title: i.title }, h('span', { class: 'faint' }, '#' + i.number + ' '), i.title)),
    h('div', { class: 'meta' },
      multi ? h('span', {}, i.repo) : null,
      i.why ? h('span', { class: 'warn' }, 'why:' + i.why) : null,
      i.priority ? h('span', {}, 'priority:' + i.priority) : null,
      costChip(i.cost),
      h('span', { class: 'faint' }, ago(i.updatedAt || i.createdAt, now)),
      traceLink(i.repo, i.number)))
}

// A parked intake issue: why it waits (the defer reason and when it is due, or its open blockers).
const due = (until, now) => { const t = Date.parse(until || ''); return !isFinite(t) ? null : t <= now ? 'due now' : 'due in ' + dur(t - now) }
function waitItem(i, multi, now) {
  const w = i.wait || { kind: 'deferred', reason: null, until: null, blockers: [] }
  const when = w.kind === 'deferred' ? due(w.until, now) : null
  return h('li', {},
    link(i.url, h('span', { class: 't', title: i.title }, h('span', { class: 'faint' }, '#' + i.number + ' '), i.title)),
    h('div', { class: 'meta' },
      h('span', { class: 'pill' }, w.kind),
      w.kind === 'blocked'
        ? h('span', {}, 'by', w.blockers.length ? w.blockers.map((b) => [' ', link(b.url, h('span', { title: b.title }, '#' + b.number))]) : h('span', { class: 'faint' }, ' (blockers closed; triage next tick)'))
        : when ? h('span', { title: w.until }, when) : null,
      multi ? h('span', {}, i.repo) : null,
      prio(i.priority),
      costChip(i.cost),
      traceLink(i.repo, i.number)),
    w.reason ? h('div', { class: 'why-wait', title: w.reason }, w.reason.length > 200 ? w.reason.slice(0, 200) + '…' : w.reason) : null)
}

const isMulti = (gh) => new Set(gh.repos.map((r) => r.slug)).size > 1
const list = (xs, render, multi, now) => xs.length ? h('ul', {}, xs.map((x) => render(x, multi, now))) : h('div', { class: 'empty' }, 'empty')


const strandedOf = (gh) => gh.stranded || []
const flaggedOf = (gh) => gh.flagged || []
const needsYou = (gh) => gh.columns.human.length + strandedOf(gh).length + flaggedOf(gh).length

function inbox(s, now) {
  const gh = s.github, xs = [...gh.columns.human, ...flaggedOf(gh)], st = strandedOf(gh), multi = isMulti(gh)
  const failed = gh.repos.filter((r) => !r.ok).map((r) => r.slug)
  const calm = (title, ...rest) => h('section', { class: 'calm' }, ring('wm'), h('p', {}, h('b', {}, title)), h('p', { class: 'muted' }, ...rest))
  if (!xs.length && !st.length && !gh.repos.length) return [calm('No repositories to read.', "Pass --repo owner/name to canopy, or list repos in cambium's config.")]
  if (!xs.length && !st.length && failed.length) return [calm('The inbox may be incomplete.', 'GitHub read failed for ' + failed.join(', ') + '; see the error above.')]
  if (!xs.length && !st.length) return [calm('Nothing needs you.',
    plural(inFlight(gh), 'issue', 'issues') + ' queued · ' + plural(gh.prs.length, 'agent PR', 'agent PRs') + ' open · ',
    h('button', { class: 'linkish', type: 'button', 'data-go': 'queue' }, 'see the queue'))]
  return [inboxSplit(gh, multi, now)]
}

// Inbox reading pane. The list is the inbox model (inbox.mjs); the pane reads one issue through /api/issue,
// prefetching the rest of the list one at a time so moving through it rarely waits.
const store = {
  get(k, dflt) { try { const v = localStorage.getItem('canopy.' + k); return v == null ? dflt : JSON.parse(v) } catch { return dflt } },
  set(k, v) { try { localStorage.setItem('canopy.' + k, JSON.stringify(v)) } catch {} },
}
const SORTS = [['newest', 'Newest'], ['oldest', 'Oldest'], ['priority', 'Priority']]
let ibSort = SORTS.some(([k]) => k === store.get('inbox.sort')) ? store.get('inbox.sort') : 'newest'
let ibTags = new Set([].concat(store.get('inbox.tags', [])).filter((t) => typeof t === 'string'))
let ibSel = null, ibOpen = false, ibShown = [], ibMenu = null
const details = new Map()
const ibHash = (key) => '#inbox/' + key.replace('#', '/')
const DETAIL_FRESH_MS = 60000, DETAIL_RETRY_MS = 30000
const versionOf = (it) => it.updatedAt || it.at

function wantDetail(it) {
  const d = details.get(it.key)
  if (!d) return true
  if (d.loading) return false
  if (d.error && !d.data) return Date.now() - d.at > DETAIL_RETRY_MS
  return d.forV !== versionOf(it) || Date.now() - d.at > DETAIL_FRESH_MS
}

async function loadDetail(it, force) {
  if (!force && !wantDetail(it)) return
  const prev = details.get(it.key) || {}
  details.set(it.key, { ...prev, loading: true })
  if (force && last) render(last)
  const [repo, n] = it.key.split('#')
  let next
  try {
    const r = await fetch('/api/issue/' + repo + '/' + n, { cache: 'no-store' })
    const j = await r.json()
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status)
    next = { data: j.issue, fetchedAt: j.fetchedAt, stale: j.error, error: null }
  } catch (err) {
    next = { data: prev.data || null, fetchedAt: prev.fetchedAt, stale: null, error: (err && err.message) || 'no answer' }
  }
  details.set(it.key, { ...next, loading: false, at: Date.now(), forV: versionOf(it) })
  if (last && tab === 'inbox') render(last)
}

let pumping = false
async function pump() {
  if (pumping) return
  pumping = true
  try {
    for (;;) {
      const sel = ibShown.find((x) => x.key === ibSel)
      const next = tab === 'inbox' ? [sel, ...ibShown].find((it) => it && wantDetail(it)) : null
      if (!next) break
      await loadDetail(next)
    }
  } finally { pumping = false }
}

function select(key, how) {
  ibSel = key
  if (how && how.open) ibOpen = true
  history.replaceState(null, '', ibHash(key))
  if (last) render(last)
  if (how && how.focus) focusRow(key)
  if (how && how.open && how.focusPane) $('ib-pane')?.focus({ preventScroll: true })
  const it = ibShown.find((x) => x.key === key)
  if (it) loadDetail(it)
}
const focusRow = (key) => document.querySelector('[data-key="' + CSS.escape(key) + '"]')?.focus({ preventScroll: false })
function move(step, focus) {
  if (!ibShown.length) return
  const at = ibShown.findIndex((x) => x.key === ibSel)
  const i = at < 0 ? 0 : Math.max(0, Math.min(ibShown.length - 1, at + step))
  if (ibShown[i].key !== ibSel || focus) select(ibShown[i].key, { focus })
}
const selectedUrl = () => {
  const it = ibShown.find((x) => x.key === ibSel)
  return (it && it.url) || (details.get(ibSel) && details.get(ibSel).data && details.get(ibSel).data.url) || null
}

const PRIO = { critical: 'prio-critical', high: 'prio-high' }
const prio = (p) => (p ? h('span', { class: PRIO[p] || null }, 'priority:' + p) : null)
const whyOf = (it) => (it.kind === 'stranded' ? h('span', { class: 'why' }, 'PR closed') : it.kind === 'cost' ? h('span', { class: 'why' }, 'session candidate') : it.why ? h('span', { class: 'why' }, 'why:' + it.why) : h('span', { class: 'faint' }, 'no why: label'))
const tagText = (t) => (t.id === 'kind:human' ? 'q:human' : t.id === 'kind:stranded' ? 'stranded' : t.id === 'kind:cost' ? 'session candidate' : t.id === 'flag:cost' ? 'over budget' : t.id.startsWith('label:') || t.id.startsWith('repo:') ? t.value : t.id)
const FACET_NAME = { kind: 'Kind', flag: 'Flag', why: 'Reason', priority: 'Priority', repo: 'Repo', label: 'Label' }
const TAG_TITLE = { 'kind:human': 'In the Human Queue (q:human)', 'kind:stranded': 'Agent PR closed unmerged; no queue label',
  'kind:cost': "Here only because its task spend is over cambium's costFlagUsd with no merged PR", 'flag:cost': "Task spend over cambium's costFlagUsd with no merged PR" }

function inboxSplit(gh, multi, now) {
  const all = inboxItems(gh)
  // Grouped by what answering takes (inbox.mjs inboxGroups); the sort holds within each group.
  const groups = inboxGroups(viewOf(all, { sort: ibSort, tags: ibTags }))
  const shown = groups.flatMap((g) => g.items)
  ibShown = shown
  // Keep the selection while it is in the list; an issue that has left the inbox stays open (marked as gone)
  // if it was already read, rather than jumping away while someone is reading it.
  let sel = shown.find((x) => x.key === ibSel) || null, gone = null
  if (!sel && ibSel && !all.some((x) => x.key === ibSel) && details.get(ibSel) && details.get(ibSel).data) gone = details.get(ibSel).data
  if (!sel && !gone) {
    sel = shown[0] || null
    ibSel = sel ? sel.key : null
    if (tab === 'inbox') history.replaceState(null, '', ibSel ? ibHash(ibSel) : '#inbox')
  }

  const facets = facetsOf(all, ibTags)
  const menu = (id, label, summary, on, opts) => h('div', { class: 'dd' + (id === 'sort' ? ' dd-sort' : '') },
    h('button', { type: 'button', class: 'dd-btn' + (on ? ' on' : ''), 'data-menu': id, 'data-fk': 'menu:' + id,
      'aria-expanded': String(ibMenu === id), 'aria-controls': ibMenu === id ? 'menu-' + id : null,
      'aria-label': id === 'sort' ? 'Sort: ' + summary.textContent : null, title: id === 'sort' ? 'Sort order' : null }, id === 'sort' ? null : label, summary),
    ibMenu === id ? h('div', { class: 'menu', id: 'menu-' + id, role: 'group', 'aria-label': label }, opts) : null)
  const filters = facets.map((f) => {
    const on = f.tags.filter((t) => t.on)
    const summary = on.length === 1 ? h('b', {}, f.facet === 'kind' ? tagText(on[0]) : on[0].value) : on.length ? h('b', {}, on.length) : null
    return menu(f.facet, FACET_NAME[f.facet] || f.facet, summary, on.length > 0, f.tags.map((t) =>
      h('button', { type: 'button', class: 'opt', 'data-tag': t.id, 'data-fk': 'tag:' + t.id, 'aria-pressed': String(t.on), title: TAG_TITLE[t.id] || null },
        h('span', { class: 'bx', 'aria-hidden': 'true' }), h('span', { class: 'lb' }, tagText(t)), h('span', { class: 'n' }, t.n))))
  })
  const sortLabel = (SORTS.find(([k]) => k === ibSort) || SORTS[0])[1]
  const tools = h('div', { class: 'ib-tools', role: 'toolbar', 'aria-label': 'Filter and sort the inbox' },
    filters.length ? filters : h('span', { class: 'faint' }, 'Nothing to filter by'),
    h('span', { class: 'sep-sort' }),
    menu('sort', 'Sort', h('b', {}, sortLabel), false, SORTS.map(([k, label]) =>
      h('button', { type: 'button', class: 'opt radio', 'data-sort': k, 'data-fk': 'sort:' + k, 'aria-pressed': String(ibSort === k) },
        h('span', { class: 'bx', 'aria-hidden': 'true' }), h('span', { class: 'lb' }, label), h('span')))))
  const chosen = [...ibTags].map((id) => facets.flatMap((f) => f.tags).find((t) => t.id === id) || { id, value: id.slice(id.indexOf(':') + 1) })
  const active = ibTags.size ? h('div', { class: 'ib-active' },
    chosen.map((t) => h('button', { type: 'button', class: 'chip', 'data-tag': t.id, 'data-fk': 'chip:' + t.id, 'aria-label': 'Remove filter ' + tagText(t) },
      tagText(t), h('span', { class: 'x', 'aria-hidden': 'true' }))),
    h('span', { class: 'ib-count', 'aria-live': 'polite' }, shown.length + ' of ' + all.length + ' · ',
      h('button', { class: 'linkish', type: 'button', 'data-clear': '', 'data-fk': 'clear' }, 'Clear'))) : null

  const focusable = sel ? sel.key : shown[0] && shown[0].key
  const row = (it) => h('li', { class: 'row', role: 'option', 'data-key': it.key, 'data-fk': 'row:' + it.key,
      'aria-selected': String(it.key === ibSel), tabindex: it.key === focusable ? 0 : -1 },
    h('span', { class: 'row-t', title: it.title }, h('span', { class: 'faint' }, '#' + it.number + ' '), it.title),
    h('span', { class: 'meta' }, whyOf(it), prio(it.priority), costChip(it.cost), multi ? h('span', {}, it.repo.split('/')[1]) : null,
      h('span', { class: 'faint age', title: it.at || '' }, ago(it.at, now))))
  const rows = groups.flatMap((g) => [
    h('li', { class: 'ib-group', role: 'presentation', title: g.hint }, h('span', {}, g.label), h('span', { class: 'n' }, g.items.length)),
    ...g.items.map(row)])
  const side = h('div', { class: 'ib-side' },
    h('section', { class: 'ib-list attn' }, tools, active, rows.length
      ? h('ul', { role: 'listbox', 'aria-label': 'Inbox' }, rows)
      : h('div', { class: 'calm' }, h('p', {}, h('b', {}, 'Nothing matches these tags.')),
          h('p', {}, h('button', { class: 'linkish', type: 'button', 'data-clear': '', 'data-fk': 'clear-empty' }, 'Clear filters')))),
    rows.length ? h('div', { class: 'keys' }, h('kbd', {}, 'j'), ' ', h('kbd', {}, 'k'), ' move · ', h('kbd', {}, 'o'), ' open on GitHub') : null)

  const d = sel || gone ? details.get(sel ? sel.key : ibSel) : null
  const sig = JSON.stringify([ibSel, sel, gone && gone.updatedAt, traceIdx[ibSel], ago(sel && sel.at, now),
    d && [d.loading && !d.data, d.error, d.stale, d.data,
      d.data && [ago(d.data.createdAt, now), d.data.status && ago(d.data.status.updatedAt, now), d.data.comments.map((c) => ago(c.createdAt, now))]]])
  const old = $('ib-pane')
  const pane = sel || gone ? (old && old.dataset.sig === sig ? null : issuePane(sel, gone, d, multi, now, sig)) : h('section', { class: 'ib-pane calm', id: 'ib-pane' }, ring('wm'), h('p', { class: 'muted' }, 'Pick an item to read it here.'))
  const stats = inboxFigures(inboxStats(all, now), multi, now)
  return { ib: h('div', { class: 'ib' + (ibOpen ? ' open' : ''), id: 'ib' }, stats, side, pane), stats, side, pane }
}

// Figures. A stacked bar is a part-to-whole; its key below names every part with its count.
const pct = (n, total) => Math.round((n / Math.max(1, total)) * 100) + '%'
function stack(parts, colorOf, total, what) {
  if (!total) return h('div', { class: 'stack none', role: 'img', 'aria-label': what + ': none' })
  return h('div', { class: 'stack', role: 'img', 'aria-label': what + ': ' + parts.map((p) => p.label + ' ' + p.n).join(', ') },
    parts.map((p, i) => h('i', { style: '--n:' + p.n + ';--c:' + colorOf(p, i), title: p.label + ': ' + p.n + ' of ' + total + ' (' + pct(p.n, total) + ')' })))
}
const key = (parts, colorOf) => h('div', { class: 'key', 'aria-hidden': 'true' },
  parts.map((p, i) => h('span', {}, h('i', { style: '--c:' + colorOf(p, i) }), p.label, h('b', {}, p.n))))
const WARN_STEPS = ['var(--warn)', 'color-mix(in srgb,var(--warn) 58%,var(--panel))', 'color-mix(in srgb,var(--warn) 30%,var(--panel))']
const reasonColor = (p, i) => (p.key === 'why:~stranded' ? 'var(--err)' : p.key === 'why:~none' ? 'var(--bar)' : WARN_STEPS[Math.min(i, 2)])
const PRIO_COLOR = { critical: 'var(--err)', high: 'var(--warn)', medium: WARN_STEPS[1] }
const prioColor = (p) => (p.key === 'priority:~none' ? 'var(--bar)' : PRIO_COLOR[p.label] || WARN_STEPS[2])

function inboxFigures(st, multi, now) {
  const max = Math.max(1, ...st.opened.map((p) => p.n))
  return h('section', { class: 'figs', 'aria-label': 'Inbox at a glance' },
    h('div', { class: 'fig fig-total' }, h('h3', {}, 'Needs you'),
      h('div', { class: 'big' + (st.total ? ' attn' : '') }, st.total),
      st.oldest ? h('div', { class: 'fig-sub', title: 'Oldest issue in the inbox was opened ' + st.oldest }, 'oldest opened ' + ago(st.oldest, now)) : null,
      multi ? h('div', { class: 'fig-sub' }, st.repos.map((r, i) => [i ? ' · ' : '', h('b', {}, r.n), ' ' + r.label.split('/')[0]])) : null),
    h('div', { class: 'fig' }, h('h3', {}, 'Reason'), stack(st.reasons, reasonColor, st.total, 'Reasons'), key(st.reasons, reasonColor)),
    h('div', { class: 'fig' }, h('h3', {}, 'Priority'), stack(st.priorities, prioColor, st.total, 'Priorities'), key(st.priorities, prioColor)),
    h('div', { class: 'fig' }, h('h3', { title: "By when the issue was opened: GitHub doesn't say when it entered the inbox" }, 'Opened', h('span', {}, 'issue age')),
      h('div', { class: 'hist', role: 'img', 'aria-label': 'Issue age: ' + st.opened.map((p) => p.label + ' ' + p.n).join(', ') },
        st.opened.map((p) => h('div', { class: 'hcol', title: p.label + ': ' + p.n + ' of ' + st.total },
          h('b', { class: p.n ? null : 'zero' }, p.n),
          h('span', { class: 'hb' }, p.n ? h('i', { style: 'height:' + Math.max(3, Math.round((p.n / max) * 30)) + 'px' }) : null),
          h('span', {}, p.label))))))
}

// A q:human item cambium wrote a session brief for (cambium briefs.mjs): the command that starts claude in the repo
// with it. Only items with a brief get one.
const sessionPart = (b) => h('div', { class: 'part session' },
  h('h3', {}, 'Interactive session', h('span', {}, 'cambium wrote a brief')),
  h('p', { class: 'muted' }, 'Starts claude in the repo, seeded with the issue, its history, the last failure and the approaches already rejected.'),
  h('div', { class: 'cmd' }, h('code', { class: 'mono' }, b.command),
    h('button', { class: 'btn', type: 'button', 'data-copy': b.command, title: 'Copy the command' }, 'Copy')),
  h('p', { class: 'faint mono', title: 'The brief' }, b.path))

function issuePane(sel, gone, d, multi, now, sig) {
  const base = sel || gone, repo = base.repo, data = d && d.data
  const url = (sel && sel.url) || gone.url
  const md = (src) => h('div', { class: 'md' }, markdown(src, h, { repo }))
  const comment = (c, extra) => h('article', { class: 'cmt' },
    h('div', { class: 'cmt-head' }, h('b', {}, c.author || 'ghost'), link(c.url, h('span', { title: c.createdAt || '' }, ago(c.createdAt, now))), extra), md(c.body))
  const edited = (c) => (c.updatedAt && c.updatedAt !== c.createdAt ? h('span', { class: 'faint', title: c.updatedAt }, 'edited ' + ago(c.updatedAt, now)) : null)

  const head = h('div', { class: 'pane-head' },
    h('button', { class: 'linkish back', type: 'button', 'data-back': '', 'data-fk': 'back' }, 'Back to the inbox'),
    h('h2', { class: 'pane-title', id: 'pane-title' }, h('span', { class: 'faint' }, '#' + base.number + ' '), base.title),
    h('div', { class: 'meta' },
      sel ? whyOf(sel) : h('span', { class: 'why' }, 'left the inbox'), prio(sel ? sel.priority : null), costChip(sel && sel.cost),
      multi ? h('span', {}, repo) : null,
      data && data.author ? h('span', {}, 'opened by ', h('b', {}, data.author), ' ', h('span', { class: 'faint', title: data.createdAt || '' }, ago(data.createdAt, now))) : null,
      sel ? h('span', { class: 'faint', title: sel.at || '' }, (sel.kind === 'stranded' ? 'PR closed ' : 'updated ') + ago(sel.at, now)) : null),
    h('div', { class: 'actions' },
      /^https:\\/\\//.test(url || '') ? h('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener' }, 'Open on GitHub') : null,
      sel && sel.pr ? h('span', { class: 'muted' }, 'closed PR ', link(sel.pr.url, '#' + sel.pr.number), ' ', h('span', { class: 'faint mono' }, sel.pr.branch)) : null,
      traceLink(repo, base.number)))

  const parts = []
  if (gone) parts.push(h('div', { class: 'banner warn part' }, h('b', {}, 'No longer in the inbox. '), "It has left q:human (or is no longer stranded). Showing it as last read; it won't refresh here."))
  if (sel && sel.brief) parts.push(sessionPart(sel.brief))
  if (sel && sel.cost && sel.cost.flagged) parts.push(h('div', { class: 'banner warn part' }, h('b', {}, 'Session candidate: '),
    'task workers have spent ' + usd(sel.cost.task) + ' on this issue' + (costFlagUsd != null ? ', over the ' + usd(costFlagUsd) + ' threshold,' : '') + ' with no merged PR. More attempts may not get it there; consider working it in a session.'))
  if (sel && sel.kind === 'stranded') parts.push(h('div', { class: 'banner warn part' }, h('b', {}, 'Stranded: '),
    'agent PR #' + sel.pr.number + ' closed unmerged ' + ago(sel.pr.closedAt, now) + ' and no open agent PR replaces it. With no queue label, cambium will not pick this issue up again. Add a queue label to send it back, or close it.'))
  if (d && d.error) parts.push(h('div', { class: 'banner err part' }, h('b', {}, data ? "Couldn't refresh this issue: " : "Couldn't read this issue from GitHub: "), d.error,
    data ? '. Showing what canopy read ' + ago(d.fetchedAt, now) + '. ' : '. ', h('button', { class: 'linkish', type: 'button', 'data-retry': '', 'data-fk': 'retry' }, 'Try again')))
  else if (d && d.stale) parts.push(h('div', { class: 'banner warn part' }, h('b', {}, 'GitHub refresh failed: '), d.stale, '. Showing what it returned ' + ago(d.fetchedAt, now) + '.'))
  if (!data) {
    if (!d || d.loading || !d.error) parts.push(h('p', { class: 'faint part' }, 'Reading #' + base.number + ' from GitHub…'))
  } else {
    // Collapsed to start: the status log is long and the description is what a reader comes for. render() keeps it open across polls.
    if (data.status) parts.push(h('details', { class: 'part' }, h('summary', {}, h('h3', {}, 'cambium status', edited(data.status) || h('span', { title: data.status.createdAt || '' }, ago(data.status.createdAt, now)))),
      h('div', { class: 'status' }, md(data.status.body))))
    parts.push(h('div', { class: 'part' }, h('h3', {}, 'Description'), data.body.trim() ? md(data.body) : h('p', { class: 'faint' }, 'No description.')))
    const n = data.comments.length
    parts.push(h('div', { class: 'part' }, h('h3', {}, 'Comments', h('span', {}, n ? (data.earlier ? 'latest ' + n + ' of ' + (n + data.earlier) : String(n)) : 'none')),
      data.earlier ? h('p', { class: 'faint' }, link(url, plural(data.earlier, 'earlier comment', 'earlier comments') + ' on GitHub')) : null,
      data.comments.map((c) => comment(c, edited(c)))))
  }
  return h('section', { class: 'ib-pane', id: 'ib-pane', tabindex: -1, 'aria-labelledby': 'pane-title', 'data-sig': sig, 'data-key': base.repo + '#' + base.number }, head, parts)
}

// Queue tab. The top row is work cambium has in hand (triage, task workers, agent PRs) with how far each has got;
// the row under it is the three queues waiting on it. Both rows share one grid so Triage sits over Intake,
// Running over Task and PRs over Promote: each piece of live work is above the queue it came from.
const LANES = [['intake', 'Intake', 'q:intake'], ['task', 'Task', 'q:task'], ['running', 'Running', 'running'], ['promote', 'Promote', 'q:promote']]
const inFlight = (gh) => LANES.reduce((n, [k]) => n + gh.columns[k].length, 0) + waitingOf(gh).length
const waitingOf = (gh) => gh.columns.waiting || []
const issueKey = (repo, n) => repo + '#' + n
let traceProg = {}
const SHEEN_MS = 2400
const sheenPhase = () => 'animation-delay:-' + (Date.now() % SHEEN_MS) + 'ms'

function activeWork(s) {
  const gh = s.github, d = s.heartbeat.data
  const workers = new Map((d ? d.workers : []).map((w) => [issueKey(w.repo, w.issue), w]))
  const triage = [], running = []
  for (const i of gh.columns.running) (i.labels.includes('q:intake') ? triage : running).push(i)
  // A worker this host runs whose issue GitHub doesn't show as running (yet, or any more) still shows: truth over comfort.
  const listed = new Set(gh.columns.running.map((i) => issueKey(i.repo, i.number)))
  for (const w of workers.values()) {
    if (listed.has(issueKey(w.repo, w.issue))) continue
    const orphan = { repo: w.repo, number: w.issue, title: 'not labelled running on GitHub', url: 'https://github.com/' + w.repo + '/issues/' + w.issue, labels: [], orphan: true }
    ;(w.phase === 'dispatch' ? triage : running).push(orphan)
  }
  return { triage, running, workers, caps: (d && d.caps) || {} }
}

function trail(p) {
  if (!p || !p.trail || !p.trail.length) return null
  const last = p.trail.length - 1
  return h('div', { class: 'trail mono', title: (p.graph ? p.graph + ' graph: ' : '') + p.trail.join(' › ') },
    p.trail.map((n, i) => [i ? h('span', { class: 'sep', 'aria-hidden': 'true' }, '›') : null, i === last ? h('b', {}, n) : h('span', { class: 'faint' }, n)]))
}

function clock(w, ageMs) {
  if (!w) return h('div', { class: 'prog faint' }, 'no worker on this host')
  const elapsed = (w.elapsedMs || 0) + (w.alive && ageMs ? ageMs : 0)
  const frac = w.wallClockMs ? Math.min(1, elapsed / w.wallClockMs) : 0
  const tone = frac >= 1 ? 'err' : frac > 0.8 ? 'warn' : ''
  return h('div', { class: 'prog', title: 'Wall clock: ' + dur(elapsed) + ' of the ' + dur(w.wallClockMs) + ' a worker may run' },
    h('span', { class: 'bar', role: 'meter', 'aria-label': 'wall clock used', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(frac * 100) },
      h('i', { class: tone || (w.alive ? 'moving' : null), style: 'width:' + Math.round(frac * 100) + '%;' + sheenPhase() })),
    h('span', { class: tone || null }, dur(elapsed)), h('span', { class: 'faint' }, '/ ' + dur(w.wallClockMs)),
    h('span', { class: 'muted' }, 'attempt ' + (w.attempt ?? '–')))
}

function workCard(i, multi, now, w, ageMs) {
  const p = traceProg[issueKey(i.repo, i.number)]
  return h('li', { class: 'work' },
    link(i.url, h('span', { class: 't', title: i.title }, h('span', { class: 'faint' }, '#' + i.number + ' '), i.orphan ? h('span', { class: 'warn' }, i.title) : i.title)),
    trail(p) || h('div', { class: 'trail faint' }, 'no trace for this run yet'),
    clock(w, ageMs),
    w && w.killedReason ? h('div', { class: 'err' }, 'killed: ' + w.killedReason) : w && !w.alive ? h('div', { class: 'err' }, 'worker exited; cambium reconciles it next tick') : null,
    h('div', { class: 'meta' },
      p && p.errors ? h('span', { class: 'err' }, plural(p.errors, 'failed span', 'failed spans')) : null,
      i.cost ? costChip(i.cost) : p && p.costUsd != null ? h('span', { title: 'This run so far, from its trace' }, usd(p.costUsd)) : null,
      p ? h('span', { class: 'faint', title: new Date(p.end).toISOString() }, 'active ' + ago(new Date(p.end).toISOString(), now)) : null,
      prio(i.priority),
      multi ? h('span', {}, i.repo) : null,
      traceLink(i.repo, i.number)))
}

// Where an agent PR is on its way in: checks, auto-merge, the merge queue, merged. A merged PR leaves this list,
// so the last stage only ever shows as next.
const RED = { FAILURE: 1, ERROR: 1 }
function stages(p) {
  const passed = p.checks === 'SUCCESS'
  const reported = p.checks || (p.tally && p.tally.passed + p.tally.failed + p.tally.pending)
  const checks = RED[p.checks] ? 'fail' : passed ? 'done' : reported || !p.draft ? 'now' : 'todo'
  const auto = p.inMergeQueue || p.autoMerge ? 'done' : p.mergeState === 'DIRTY' ? 'fail' : passed ? 'now' : 'todo'
  const pos = p.inMergeQueue && p.queue && p.queue.position != null ? ' #' + p.queue.position : ''
  return [['checks', checks], ['auto-merge', auto], ['queue' + pos, p.inMergeQueue ? 'now' : 'todo'], ['merged', 'todo']]
}
const STAGE_WORD = { done: 'done', now: 'in progress', fail: 'stuck', todo: 'not yet' }
const MERGE_STATE = { DIRTY: ['err', 'merge conflicts'], BEHIND: ['warn', 'behind base'] }

function tallyText(p) {
  const t = p.tally, total = t ? t.passed + t.failed + t.pending : 0
  if (!total) { const [cls, word] = CHECK[p.checks] || ['faint', 'no checks reported']; return h('span', { class: cls }, word) }
  // Nothing finished yet: "0 of 2 checks pass" reads as failure, so say what is happening.
  if (!t.passed && !t.failed) return h('span', { class: 'muted' }, plural(t.pending, 'check', 'checks') + ' running')
  return [h('span', { class: t.failed ? null : t.pending ? null : 'ok' }, t.passed + ' of ' + total + ' checks pass'),
    t.pending ? h('span', { class: 'muted' }, t.pending + ' running') : null,
    t.failed ? h('span', { class: 'err' }, t.failed + ' failing') : null]
}

function prCard(p, multi, now) {
  const issue = p.closes[0], prog = issue ? traceProg[issueKey(p.repo, issue)] : null
  const [msCls, msWord] = MERGE_STATE[p.mergeState] || []
  return h('li', { class: 'work' + (p.draft ? ' draft' : '') },
    h('div', { class: 'work-head' },
      link(p.url, h('span', { class: 't', title: p.title }, h('span', { class: 'faint' }, '#' + p.number + ' '), p.title)),
      p.closes.length ? h('span', { class: 'closes faint' }, 'closes', p.closes.map((n) => [' ', link('https://github.com/' + p.repo + '/issues/' + n, '#' + n)])) : null),
    h('ol', { class: 'stages', 'aria-label': 'Progress to merge' },
      stages(p).map(([label, state]) => h('li', { class: 'stg ' + state, title: label + ': ' + STAGE_WORD[state] }, h('i', { style: state === 'now' ? sheenPhase() : null }), h('span', {}, label)))),
    h('div', { class: 'meta' },
      p.draft ? h('span', { class: 'pill' }, 'draft') : null,
      tallyText(p),
      msWord ? h('span', { class: msCls }, msWord) : null,
      prog && prog.node ? h('span', { class: 'muted', title: 'Last node cambium recorded' + (prog.graph ? ' in the ' + prog.graph + ' graph' : '') }, 'cambium at ', h('span', { class: 'mono' }, prog.node)) : null),
    h('div', { class: 'meta' },
      p.additions != null ? [h('span', { class: 'ok' }, '+' + p.additions), h('span', { class: 'err' }, '−' + p.deletions)] : null,
      p.files != null ? h('span', { class: 'faint' }, plural(p.files, 'file', 'files')) : null,
      h('span', { class: 'faint', title: p.createdAt || '' }, 'opened ' + ago(p.createdAt || p.updatedAt, now)),
      multi ? h('span', {}, p.repo) : null,
      h('span', { class: 'faint mono' }, p.branch),
      issue ? traceLink(p.repo, issue) : null))
}

// Queue figures. Every issue in the loop by where it sits now, q:human included, since that is often where
// work piles up; then what the loop did over the last day, from the traces: where each active issue ended up.
const STAGES = [['intake', 'Intake', 'var(--flow-1)'], ['waiting', 'Deferred / Blocked', 'var(--bar)'], ['task', 'Task', 'var(--flow-2)'], ['running', 'Running', 'var(--flow-3)'],
  ['human', 'Human', 'var(--warn)'], ['promote', 'Promote', 'var(--flow-4)']]
const oldestOpened = (xs) => xs.reduce((m, i) => { const t = Date.parse(i.createdAt || ''); return isFinite(t) && (m == null || t < m) ? t : m }, null)
const DAY_SHOWN = 5

function queueFigures(s, a, liveTask, now) {
  const gh = s.github
  const cells = STAGES.map(([k, label, c]) => {
    const xs = k === 'running' ? [...a.triage, ...a.running] : gh.columns[k] || []
    const old = oldestOpened(xs)
    const sub = k === 'running' && a.caps.task ? liveTask + ' of ' + a.caps.task + ' slots' : old != null ? 'oldest ' + dur(now - old) : '–'
    return { k, label, c, n: xs.length, sub, title: old != null ? 'Oldest issue here was opened ' + new Date(old).toISOString() : null }
  })
  const total = cells.reduce((n, x) => n + x.n, 0)
  const parts = cells.filter((x) => x.n).map((x) => ({ label: x.label, n: x.n, c: x.c }))
  const flow = h('div', { class: 'fig fig-flow' },
    h('h3', {}, 'In the loop', h('span', {}, plural(total, 'issue', 'issues'))),
    stack(parts, (p) => p.c, total, 'Issues by stage'),
    h('div', { class: 'stage-cells' }, cells.map((x) => {
      const kids = [h('span', { class: 'nm' }, h('i', { style: '--c:' + x.c }), x.label), h('b', { class: x.n ? null : 'zero' }, x.n), h('span', { class: 'sub', title: x.title }, x.sub)]
      return x.k === 'human'
        ? h('button', { type: 'button', class: 'stage-cell go', 'data-go': 'inbox', title: 'Open the Inbox' }, kids)
        : h('div', { class: 'stage-cell' }, kids)
    })))
  const tr = s.traces, r = tr && tr.status === 'ok' ? tr.recent : null
  let day
  if (!r) day = h('div', { class: 'fig fig-day' }, h('h3', {}, 'Last 24 hours'),
    h('p', { class: 'fig-sub', style: 'margin:0' }, !tr ? 'Tracing is off, so there is no throughput to show.'
      : tr.status !== 'ok' ? tr.message : 'This canopy server sends no throughput figures; restart it to pick up the new version.'))
  else {
    const top = r.byNode.slice(0, DAY_SHOWN), rest = r.byNode.slice(DAY_SHOWN).reduce((n, x) => n + x.n, 0)
    const max = Math.max(1, ...top.map((x) => x.n))
    const name = (node) => (node == null ? h('span', { class: 'faint' }, 'no cambium step') : h('span', { class: 'mono' }, node))
    day = h('div', { class: 'fig fig-day' },
      h('h3', { title: 'Traces with a span in the last ' + dur(r.sinceMs) + ', by the last cambium node each reached' }, 'Last 24 hours',
        h('span', {}, plural(r.runs, 'issue', 'issues') + ' active · where each ended up')),
      r.runs ? h('ul', { class: 'ranked' }, top.map((x) => h('li', { title: (x.node || 'no cambium step') + ': ' + x.n + ' of ' + r.runs },
        h('span', { class: 'nm' }, name(x.node)), h('span', { class: 'tr' }, h('i', { style: 'width:' + Math.round((x.n / max) * 100) + '%' })), h('b', {}, x.n))),
        rest ? h('li', {}, h('span', { class: 'nm faint' }, 'other steps'), h('span'), h('b', { class: 'faint' }, rest)) : null)
        : h('p', { class: 'fig-sub', style: 'margin:0' }, 'No traced activity in the last day.'),
      h('div', { class: 'day-foot' },
        r.costUsd != null ? h('span', {}, h('b', { style: 'color:var(--text)' }, usd(r.costUsd)), ' spent') : null,
        r.errored ? h('button', { type: 'button', class: 'linkish', 'data-go': 'traces' }, h('span', { class: 'err' }, plural(r.errored, 'run', 'runs') + ' with a failed span')) : h('span', { class: 'faint' }, 'no failed spans')))
  }
  return h('section', { class: 'figs', 'aria-label': 'Queue at a glance' }, flow, day, costFigure(s.cost))
}

// Spend per day by phase, from cambium's per-repo daily ledger: one stacked column per UTC day, today last.
function costFigure(cost) {
  const days = (cost && cost.days) || []
  if (!days.length) return h('div', { class: 'fig fig-cost' }, h('h3', {}, 'Cost'),
    h('p', { class: 'fig-sub', style: 'margin:0' }, cost ? 'cambium reports no cost yet.' : 'This canopy server sends no cost figures; restart it to pick up the new version.'))
  const max = Math.max(0.01, ...days.map((d) => d.total))
  const sum = (k) => days.reduce((n, d) => n + (d[k] || 0), 0)
  const total = sum('total')
  const parts = COST_PHASES.map(([k, label, c]) => ({ label, n: usd(sum(k)), c }))
  const dayName = (day) => new Date(day + 'T00:00:00Z').toLocaleDateString([], { weekday: 'short', timeZone: 'UTC' })
  const H = 30
  return h('div', { class: 'fig fig-cost' },
    h('h3', { title: 'What workers cost per UTC day, by phase, summed over every repo' }, 'Cost', h('span', {}, 'last ' + days.length + ' days by phase · ' + usd(total))),
    h('div', { class: 'cost-hist', role: 'img', 'aria-label': 'Cost per day: ' + days.map((d) => d.day + ' ' + usd(d.total)).join(', ') },
      days.map((d) => h('div', { class: 'hcol', title: d.day + ': ' + usd(d.total) + (d.total ? ' (' + COST_PHASES.filter(([k]) => d[k]).map(([k, label]) => label.toLowerCase() + ' ' + usd(d[k])).join(', ') + ')' : '') },
        h('b', { class: d.total ? null : 'zero' }, d.total ? usd(d.total) : '–'),
        h('span', { class: 'hb stk' }, d.total ? COST_PHASES.slice().reverse().filter(([k]) => d[k]).map(([k, , c]) =>
          h('i', { style: '--c:' + c + ';height:' + Math.max(2, Math.round((d[k] / max) * H)) + 'px' })) : null),
        h('span', {}, dayName(d.day))))),
    key(parts, (p) => p.c),
    costFlagUsd ? h('div', { class: 'fig-sub' }, 'Task spend over ' + usd(costFlagUsd) + ' without a merged PR is flagged in the Inbox.') : null)
}

const slots = (n, cap) => (cap ? h('span', { class: 'lane-label' }, n + ' of ' + cap + ' slots') : null)
const heading = (title, n, ...extra) => h('h2', {}, title, h('span', { class: 'n' }, n), extra)

function queues(s, now) {
  const gh = s.github, multi = isMulti(gh), ageMs = s.heartbeat.ageMs
  traceProg = (s.traces && s.traces.progress) || {}
  const a = activeWork(s)
  const workerOf = (i) => a.workers.get(issueKey(i.repo, i.number))
  const live = (xs, phase) => xs.filter((i) => { const w = workerOf(i); return w && w.alive && w.phase === phase }).length
  const cards = (xs, empty) => (xs.length ? h('ul', {}, xs.map((i) => workCard(i, multi, now, workerOf(i), ageMs))) : h('div', { class: 'empty' }, empty))
  const waiting = gh.columns.task.length
  const green = gh.prs.filter((p) => p.checks === 'SUCCESS').length, red = gh.prs.filter((p) => RED[p.checks]).length
  const prSum = [green ? h('span', { class: 'ok' }, green + ' green') : null, red ? h('span', { class: 'err' }, red + ' failing') : null]
  const active = h('section', { class: 'grid active' + (a.triage.length ? ' has-triage' : ''), 'aria-label': 'Work in progress' },
    a.triage.length ? h('div', { class: 'col l-triage' }, heading('Triage', a.triage.length, slots(live(a.triage, 'dispatch'), a.caps.dispatch)), cards(a.triage)) : null,
    h('div', { class: 'col l-running' }, heading('Running', a.running.length, slots(live(a.running, 'task'), a.caps.task)),
      cards(a.running, waiting ? 'No worker running; ' + plural(waiting, 'issue waits', 'issues wait') + ' in q:task.' : 'No worker running.')),
    h('div', { class: 'col l-prs' }, heading('Pull requests', gh.prs.length, h('span', { class: 'lane-label mono' }, 'agent/*'), h('span', { class: 'lane-label' }, prSum[0], prSum[0] && prSum[1] ? ' · ' : null, prSum[1])),
      gh.prs.length ? h('ul', {}, gh.prs.map((p) => prCard(p, multi, now))) : h('div', { class: 'empty' }, 'No open agent PRs.')))
  // Intake is what awaits triage; under it, what triage parked (wait:deferred / wait:blocked), apart.
  const parked = waitingOf(gh)
  const lane = ([k, title, label]) => h('div', { class: 'col l-' + k },
    heading(title, gh.columns[k].length, h('span', { class: 'lane-label mono' }, label)), list(gh.columns[k], item, multi, now),
    k === 'intake' && parked.length ? [h('h3', { class: 'sub' }, 'Deferred / Blocked', h('span', { class: 'n' }, parked.length), h('span', { class: 'lane-label mono' }, 'wait:*')),
      list(parked, waitItem, multi, now)] : null)
  const queued = h('section', { class: 'grid lanes', 'aria-label': 'Queues' }, LANES.filter(([k]) => k !== 'running').map(lane))
  return [queueFigures(s, a, live(a.running, 'task'), now), active, queued]
}

// Intake tab. mycelium's status file names every source, configured or not; its mycelium.intake spans say what each
// filed. Each configured source is a row with its state, cadence, last pass and filings; the others list what they lack.
const SOURCE_LABEL = { discord: 'Discord', asc: 'App Store reviews', testflight: 'TestFlight feedback', play: 'Google Play reviews', vitals: 'Android vitals', 'device-logs': 'In-app bug reports' }
const SOURCE_READS = { discord: 'channel messages and forum posts', asc: 'customer reviews', testflight: 'tester feedback and crashes', play: 'reviews from the last week', vitals: 'crash and ANR clusters', 'device-logs': 'reports sent from the app' }
const SOURCE_STATE = { ok: ['ok', 'polling'], waiting: ['', 'first pass due'], failing: ['err', 'failing'], overdue: ['warn', 'overdue'], stopped: ['', 'stopped'] }
const srcName = (n) => h('span', { class: 'src-name' }, h('b', {}, SOURCE_LABEL[n] || n), h('span', { class: 'mono faint' }, n))
const srcTrouble = (src) => src.state === 'failing' || src.state === 'overdue'
const filedText = (c) => {
  const bits = [c.created ? c.created + ' opened' : null, c.commented ? plural(c.commented, 'comment', 'comments') : null].filter(Boolean)
  return bits.length ? bits.join(', ') : 'nothing new'
}

// The Intake tab's badge: configured sources, amber when one is failing or late, or mycelium is not running.
function intakeBadge(s) {
  const it = s.intake
  if (!it) return ['–', false, 'This canopy server reads no mycelium status; restart it to pick up the new version.']
  if (it.status !== 'ok') return ['–', it.status !== 'missing', it.message]
  const on = it.data.sources.filter((x) => x.configured), bad = on.filter(srcTrouble)
  const why = plural(on.length, 'source', 'sources') + ' configured' + (bad.length ? ', ' + bad.map((x) => x.name + ' ' + x.state).join(', ') : '') + (it.running ? '' : '; mycelium is not running')
  return [on.length, bad.length > 0 || !it.running, why]
}

function intakeTab(s, now) {
  const it = s.intake
  if (!it) return [calmBox('No intake view yet.', 'This canopy server predates the Intake tab; restart it to pick up the new version.')]
  if (it.status === 'missing') return [calmBox('mycelium is not reporting here.', it.message)]
  if (it.status !== 'ok') return [h('div', { class: 'banner err' }, h('b', {}, it.status === 'unknown-version' ? 'mycelium status version mismatch: ' : "Can't read mycelium's status: "), it.message)]
  const d = it.data, act = it.activity
  const on = d.sources.filter((x) => x.configured), off = d.sources.filter((x) => !x.configured)
  const out = []
  if (it.message) out.push(h('div', { class: 'banner warn' }, h('b', {}, d.stoppedAt ? 'mycelium is stopped: ' : 'mycelium may have stopped: '), it.message))
  out.push(intakeFigures(s, d, act, on, now), sourcesSection(act, on, off, now), filingsSection(d, act, now, s.traces))
  return out
}

function intakeFigures(s, d, act, on, now) {
  const bad = on.filter(srcTrouble)
  const total = h('div', { class: 'fig fig-total' },
    h('h3', {}, 'Sources'),
    h('div', { class: 'big' + (bad.length ? ' attn' : '') }, on.length),
    h('div', { class: 'fig-sub' }, 'of ' + d.sources.length + ' configured'),
    bad.length ? h('div', { class: 'fig-sub warn' }, plural(bad.length, 'needs', 'need') + ' a look') : null,
    h('div', { class: 'fig-sub faint', title: d.startedAt ? 'Started ' + d.startedAt : null },
      d.stoppedAt ? 'stopped ' + ago(d.stoppedAt, now) : 'up ' + (d.startedAt ? dur(now - Date.parse(d.startedAt)) : '–'), d.pid ? ' · pid ' + d.pid : ''))
  let day
  if (!act) day = h('div', { class: 'fig fig-day' }, h('h3', {}, 'Filed, last 24 hours'),
    h('p', { class: 'fig-sub', style: 'margin:0' }, s.traces && s.traces.status !== 'ok' ? s.traces.message : 'Tracing is off, so there are no filings to count. mycelium records each one when OTEL_EXPORTER_OTLP_ENDPOINT is set.'))
  else {
    const rows = on.map((x) => ({ name: x.name, c: (act.bySource[x.name] || {}).day || { created: 0, commented: 0, failed: 0 } }))
    const sum = (k) => rows.reduce((n, r) => n + r.c[k], 0)
    const max = Math.max(1, ...rows.map((r) => r.c.created + r.c.commented))
    day = h('div', { class: 'fig fig-day' },
      h('h3', { title: 'mycelium.intake spans that ended in the last 24 hours' }, 'Filed, last 24 hours', h('span', {}, plural(sum('created'), 'issue', 'issues') + ' opened · ' + plural(sum('commented'), 'comment', 'comments'))),
      rows.length ? h('ul', { class: 'ranked bark' }, rows.map((r) => {
        const n = r.c.created + r.c.commented
        return h('li', { title: (SOURCE_LABEL[r.name] || r.name) + ': ' + filedText(r.c) + (r.c.failed ? ', ' + r.c.failed + ' failed' : '') },
          h('span', { class: 'nm' }, SOURCE_LABEL[r.name] || r.name), h('span', { class: 'tr' }, n ? h('i', { style: 'width:' + Math.round((n / max) * 100) + '%' }) : null), h('b', { class: n ? null : 'faint' }, n))
      })) : h('p', { class: 'fig-sub', style: 'margin:0' }, 'No source is configured.'),
      sum('failed') ? h('div', { class: 'day-foot' }, h('span', { class: 'err' }, plural(sum('failed'), 'filing', 'filings') + ' failed')) : null)
  }
  const waiting = s.github.columns.intake.length
  const into = h('div', { class: 'fig fig-into' },
    h('h3', {}, 'Files into'),
    d.repo ? h('p', { class: 'into-repo' }, link('https://github.com/' + d.repo + '/issues?q=is%3Aopen+label%3Aq%3Aintake', d.repo)) : h('p', { class: 'warn' }, 'no repository set (MYCELIUM_REPO)'),
    h('p', { class: 'fig-sub' }, 'as ', h('span', { class: 'mono' }, 'q:intake'), ' · ',
      h('button', { type: 'button', class: 'linkish', 'data-go': 'queue' }, plural(waiting, 'issue', 'issues') + ' awaiting triage')),
    h('p', { class: 'fig-sub' }, d.notify
      ? ['answers reporters on ', d.notify.channels.map((c) => SOURCE_LABEL[c] || c).join(', '), d.notify.last && !d.notify.last.ok ? h('span', { class: 'err', title: d.notify.last.error || '' }, ' · last reply pass failed') : null]
      : h('span', { class: 'faint' }, 'replies to reporters off')))
  return h('section', { class: 'figs', 'aria-label': 'Intake at a glance' }, total, day, into)
}

function sourcesSection(act, on, off, now) {
  const filed = (name, w) => {
    if (!act) return h('span', { class: 'faint' }, '–')
    const c = (act.bySource[name] || {})[w]
    if (!c) return h('span', { class: 'faint' }, '0')
    const n = c.created + c.commented
    return h('span', { title: filedText(c) + (c.failed ? ', ' + c.failed + ' failed' : '') }, h('span', { class: n ? null : 'faint' }, n), c.failed ? h('span', { class: 'err' }, ' · ' + c.failed + ' failed') : null)
  }
  const rows = on.map((x) => {
    const [tone, word] = SOURCE_STATE[x.state] || ['', x.state]
    const l = x.last, next = x.nextAt ? Date.parse(x.nextAt) - now : null
    const lastCell = !l ? h('span', { class: 'faint' }, 'not yet')
      : [h('span', { title: l.at }, ago(l.at, now)), ' · ', l.ok ? h('span', { class: 'muted', title: l.skipped ? l.skipped + ' skipped' : null }, filedText(l)) : h('span', { class: 'err' }, 'failed'), l.ms != null ? h('span', { class: 'faint' }, ' · took ' + dur(l.ms)) : null]
    const nextCell = x.state === 'stopped' || next == null ? h('span', { class: 'faint' }, '–')
      : x.state === 'overdue' ? h('span', { class: 'warn', title: x.nextAt }, 'late by ' + dur(-next))
      : h('span', { title: x.nextAt }, next > 0 ? 'in ' + dur(next) : 'due now')
    // data-k labels each cell when the row stacks on a phone, where the header row is hidden.
    return [h('tr', { class: 'src-row' },
      h('td', { class: 'c-name' }, h('span', { class: 'dot ' + tone }), srcName(x.name)),
      h('td', { class: 'c-reads wrap' }, x.target ? [x.target, h('span', { class: 'faint' }, ' · ')] : null, h('span', { class: 'muted' }, SOURCE_READS[x.name] || '')),
      h('td', { class: 'c-state' }, h('span', { class: 'pill ' + tone }, word)),
      h('td', { 'data-k': 'every' }, x.intervalMs ? dur(x.intervalMs) : '–'),
      h('td', { class: 'c-last wrap', 'data-k': 'last pass' }, lastCell),
      h('td', { 'data-k': 'next' }, nextCell),
      h('td', { 'data-k': 'filed 24h' }, filed(x.name, 'day')),
      h('td', { 'data-k': '7d' }, filed(x.name, 'week'))),
      l && l.error ? h('tr', { class: 'src-err' }, h('td', { colspan: 8, class: 'mono err' }, l.error)) : null]
  })
  const table = on.length ? h('div', { class: 'scroll', tabindex: 0, 'aria-label': 'Configured sources' }, h('table', { class: 'stack-sm' },
    h('thead', {}, h('tr', {}, ['source', 'reads', 'state', 'every', 'last pass', 'next', '24h', '7d'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows))) : h('div', { class: 'empty' }, 'No source is configured. mycelium reads its settings from ~/.mycelium/env; see its README, Configuration.')
  return h('section', { 'aria-label': 'Sources' },
    h('h2', {}, 'Configured', h('span', { class: 'n' }, on.length)),
    table,
    off.length ? [h('h3', { class: 'subhead' }, 'Not configured', h('span', { class: 'n' }, off.length)),
      h('ul', { class: 'off-list' }, off.map((x) => h('li', {}, srcName(x.name), h('span', { class: 'mono' }, (x.needs || 'not configured').replace('not configured; set ', 'needs ')))))] : null)
}

function filingsSection(d, act, now, tr) {
  const head = h('h2', {}, 'Recent filings', act && act.recent.length ? h('span', { class: 'n' }, act.recent.length) : null)
  if (!act) return h('section', {}, head, h('div', { class: 'empty' }, tr && tr.status !== 'ok' ? tr.message : 'Tracing is off. Filings show here once mycelium exports spans to the collector canopy reads.'))
  if (!act.recent.length) return h('section', {}, head, h('div', { class: 'empty' }, 'mycelium has filed nothing in the traces canopy holds.'))
  const ACTION = { create: ['ok', 'opened'], comment: ['', 'commented'] }
  return h('section', {}, head, h('div', { class: 'scroll', tabindex: 0, 'aria-label': 'Recent filings' }, h('table', { class: 'fit filings' },
    h('thead', {}, h('tr', {}, ['when', 'source', 'action', 'issue', 'external id'].map((t) => h('th', {}, t)))),
    h('tbody', {}, act.recent.map((f) => {
      const [tone, word] = f.failed ? ['err', 'failed'] : ACTION[f.action] || ['', f.action || '?']
      const issue = f.issue ? (d.repo ? link('https://github.com/' + d.repo + '/issues/' + f.issue, '#' + f.issue) : '#' + f.issue) : h('span', { class: 'faint' }, 'no issue')
      return h('tr', {},
        h('td', { class: 'c-when', title: new Date(f.at).toISOString() }, ago(new Date(f.at).toISOString(), now)),
        h('td', { class: 'c-src' }, SOURCE_LABEL[f.source] || f.source),
        h('td', { class: 'c-act' }, h('span', { class: 'pill ' + tone }, word)),
        h('td', { class: 'c-issue' }, issue, ' · ', h('a', { href: '#traces/' + f.traceId, title: "Open this filing's trace" }, 'trace')),
        h('td', { class: 'c-ext mono faint wrap' }, f.externalId || '–'))
    })))))
}

function healthOf(s) {
  const hb = s.heartbeat, d = hb.data
  if (hb.status !== 'ok' || !d) return ['err', 'no readable heartbeat']
  const failedSteps = d.steps.filter((st) => !st.ok).map((st) => st.name)
  if (failedSteps.length) return ['err', failedSteps.join(', ') + ' failed in the last tick']
  if (d.workers.some((w) => w.killedReason)) return ['err', 'a worker was killed']
  const red = d.repos.flatMap((r) => r.watch.filter((w) => w.state === 'red').map((w) => w.workflow))
  if (red.length) return ['err', red.join(', ') + ' red']
  if (hb.stale) return ['warn', 'no recent tick']
  if (d.mode !== 'running') return ['warn', 'cambium is ' + d.mode]
  const paused = d.repos.filter((r) => r.pausedUntil).map((r) => r.slug)
  if (paused.length) return ['warn', 'reads paused for ' + paused.join(', ')]
  return ['ok', 'healthy']
}

// Log paths sit under the user's home; ~ keeps them pasteable into a shell at a third of the width.
const homeless = (p) => String(p).replace(/^\\/(?:Users|home)\\/[^/]+(?=\\/)/, '~')

function workers(d, ageMs) {
  if (!d.workers.length) return section('Workers', 0, h('div', { class: 'empty' }, 'no workers on this host'))
  const rows = d.workers.map((w) => {
    const elapsed = (w.elapsedMs || 0) + (w.alive && ageMs ? ageMs : 0)
    const frac = w.wallClockMs ? Math.min(1, elapsed / w.wallClockMs) : 0
    const tone = frac >= 1 ? 'err' : frac > 0.8 ? 'warn' : ''
    const issueUrl = w.repo && w.issue ? 'https://github.com/' + w.repo + '/issues/' + w.issue : null
    const logs = [w.logs.stdout, w.logs.stderr].filter(Boolean)
    return [h('tr', {},
      h('td', {}, link(issueUrl, (w.repo || '') + '#' + (w.issue ?? '?')), traceLink(w.repo, w.issue) ? [' · ', traceLink(w.repo, w.issue)] : null),
      h('td', {}, w.phase || '–'), h('td', {}, w.attempt ?? '–'),
      h('td', {}, h('span', { class: 'dot ' + (w.alive ? 'ok' : 'err') }), w.pid ?? '–', w.killedReason ? h('span', { class: 'err' }, ' killed: ' + w.killedReason) : null),
      h('td', {}, h('span', { class: 'bar' }, h('i', { class: tone, style: 'width:' + Math.round(frac * 100) + '%' })), dur(elapsed), h('span', { class: 'faint' }, ' / ' + dur(w.wallClockMs))),
      h('td', { class: 'mono br' }, w.branch || '–')),
      logs.length ? h('tr', { class: 'logs' }, h('td', { colspan: 6, class: 'mono faint' }, logs.map((l) => h('div', { title: l }, homeless(l))))) : null]
  })
  return section('Workers', d.workers.length, h('div', { class: 'scroll', tabindex: 0, 'aria-label': 'Workers table' }, h('table', {},
    h('thead', {}, h('tr', {}, ['issue', 'phase', 'attempt', 'pid', 'elapsed / cap', 'branch'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows))))
}

function events(d) {
  const list = d.events.slice(-60).reverse()
  return section('Recent events', d.events.length, list.length ? h('div', { class: 'events mono', tabindex: 0, 'aria-label': 'Recent events' }, list.map((e) => {
    const t = e.at ? new Date(e.at) : null
    return h('div', {}, h('span', { class: 'faint', title: e.at || '' }, t ? t.toLocaleTimeString([], { hour12: false }) : '–'),
      h('span', { class: e.level === 'error' ? 'err' : e.level === 'warn' ? 'warn' : 'faint' }, e.level || ''),
      h('span', {}, e.repo && e.issue ? h('span', { class: 'faint' }, e.repo.split('/')[1] + '#' + e.issue + ' ') : null, e.msg || ''))
  })) : h('div', { class: 'empty' }, 'no events recorded yet'))
}

const usd = (n) => (n == null ? '–' : '$' + (n < 10 ? n.toFixed(2) : Math.round(n)))
// What an issue has cost so far (cambium's heartbeat), per phase on hover; red once flagged.
const COST_PHASES = [['triage', 'Triage', 'var(--flow-1)'], ['task', 'Task', 'var(--flow-3)'], ['rescue', 'Rescue', 'var(--warn)']]
function costChip(c) {
  if (!c || !c.usd) return null
  const title = 'Spent on this issue so far: ' + COST_PHASES.filter(([k]) => c[k]).map(([k, label]) => label.toLowerCase() + ' ' + usd(c[k])).join(' · ') +
    (c.flagged ? '. Task spend is over the threshold with no merged PR.' : '')
  return h('span', { class: 'cost' + (c.flagged ? ' err' : ''), title }, usd(c.usd))
}
const runName = (t) => (t.repo && t.issue ? t.repo.split('/')[1] + '#' + t.issue : t.root)
const runUrl = (t) => (t.repo && t.issue ? 'https://github.com/' + t.repo + '/issues/' + t.issue : null)
const OUTCOME = { ok: 'ok', merged: 'ok', error: 'err', failed: 'err', stalled: 'warn', budgetSpent: 'warn' }
const calmBox = (title, ...rest) => h('section', { class: 'calm' }, ring('wm'), h('p', {}, h('b', {}, title)), h('p', { class: 'muted' }, ...rest))

function traceFileNote(f) {
  const bits = []
  if (f.malformed) bits.push(plural(f.malformed, 'line', 'lines') + " couldn't be parsed and were skipped")
  if (f.files > 1) bits.push('read from ' + f.files + ' files (the current one and its rotated backups)')
  return bits.length ? h('div', { class: 'faint', style: 'margin-top:var(--s2)' }, 'Spans ' + bits.join('; ') + '.') : null
}

function runsView(f, now) {
  if (f.status !== 'ok') return calmBox(f.status === 'missing' ? 'No traces yet.' : "Can't read the trace file.", f.message)
  if (!f.traces.length) return calmBox('No workflow runs traced yet.', h('code', {}, f.path), ' has no spans. Runs appear once cambium moves an issue through a graph with tracing on.')
  const rows = f.traces.map((t) => {
    const open = (kid) => h('a', { class: 'row-link', href: '#traces/' + t.id }, kid)
    return h('tr', { class: 'run' },
      h('td', {}, open([h('span', { class: 'dot ' + (t.errors ? 'err' : 'ok') }), runName(t)])),
      h('td', {}, t.graph || h('span', { class: 'faint' }, t.services.join(', ') || '–')),
      h('td', { class: 'mono' }, t.node || '–'),
      h('td', {}, t.outcome ? h('span', { class: 'pill ' + (OUTCOME[t.outcome] || '') }, t.outcome) : '–'),
      h('td', { title: new Date(t.start).toISOString() }, ago(new Date(t.start).toISOString(), now)),
      h('td', {}, dur(t.durationMs)),
      h('td', {}, t.spans, t.errors ? h('span', { class: 'err' }, ' · ' + t.errors + ' failed') : null),
      h('td', {}, usd(t.costUsd)))
  })
  return h('section', {}, h('h2', {}, 'Workflow runs', h('span', { class: 'n' }, f.total > f.traces.length ? f.traces.length + ' of ' + f.total : f.total)),
    h('div', { class: 'scroll', tabindex: 0, 'aria-label': 'Workflow runs' }, h('table', {},
      h('thead', {}, h('tr', {}, ['run', 'graph', 'last node', 'outcome', 'started', 'took', 'spans', 'cost'].map((x) => h('th', {}, x)))),
      h('tbody', {}, rows))),
    traceFileNote(f))
}

function spanDetail(sp) {
  const a = sp.attrs
  if (sp.name === 'claude_code.tool.blocked_on_user') return [a.decision === 'reject' ? 'rejected' : 'accepted', a.source ? 'by ' + a.source : null]
  if (a.tool_name) return [a.tool_name]
  if (a['cambium.node']) return [a['cambium.node'], a['cambium.edge'] ? '→ ' + a['cambium.edge'] : null, a['cambium.attempt'] != null ? 'attempt ' + a['cambium.attempt'] : null]
  if (a['claude.tool.name']) return [a['claude.tool.name'], a['claude.tool.command']]
  if (a['claude.task.description']) return [a['claude.task.description']]
  if (a['claude.thinking'] || a['claude.text']) return [a['claude.turn.tools'] || null, preview(a['claude.thinking'] || a['claude.text'])]
  if (a['claude.model']) return [a['claude.model'], a['claude.cost_usd'] != null ? usd(a['claude.cost_usd']) : null]
  if (a['mycelium.source']) return [a['mycelium.source'], a['mycelium.action']]
  if (a['cambium.graph']) return [a['cambium.graph']]
  return []
}
const preview = (v) => { const t = String(v).replace(/\\s+/g, ' ').trim(); return t.length > 120 ? t.slice(0, 119) + '…' : t }
const showValue = (v) => (typeof v === 'string' ? v : JSON.stringify(v))
let openSpans = new Set(), showQuiet = false, flameKey = ''
// Bars are colored by the span name's prefix: which part of the stack did this work.
const FAMILIES = ['cambium', 'claude', 'mycelium']
const familyOf = (name) => { const f = String(name).split('.')[0]; return FAMILIES.includes(f) ? f : null }
function legend(spans) {
  const fams = FAMILIES.filter((f) => spans.some((sp) => familyOf(sp.name) === f))
  const key = (cls, label) => h('span', {}, h('i', { class: cls }), label)
  return h('div', { class: 'legend', 'aria-hidden': 'true' }, fams.map((f) => key('f-' + f, f + '.*')),
    spans.some((sp) => familyOf(sp.name) === null) ? key('', 'other') : null,
    spans.some((sp) => sp.name === 'cambium.wait') ? key('wait', 'waiting') : null,
    spans.some((sp) => sp.status === 'error') ? key('err', 'failed') : null)
}

function traceView(d) {
  const t = d.summary, span = Math.max(1, t.end - t.start)
  const head = h('div', { class: 'trace-head' },
    h('a', { href: '#traces' }, '← all runs'),
    h('span', { class: 'title' }, link(runUrl(t), runName(t))),
    t.graph ? h('span', { class: 'pill' }, t.graph) : null,
    t.node ? h('span', { class: 'muted' }, 'last at ', h('span', { class: 'mono' }, t.node), t.outcome ? ' · ' + t.outcome : '') : null,
    h('span', { class: t.errors ? 'err' : 'faint' }, plural(t.spans, 'span', 'spans'), t.errors ? ' · ' + t.errors + ' failed' : ''),
    h('span', { class: 'faint', title: new Date(t.start).toISOString() }, 'started ', new Date(t.start).toLocaleString(), ' · took ', dur(t.durationMs)),
    t.costUsd != null ? h('span', { class: 'faint' }, usd(t.costUsd)) : null,
    h('span', { class: 'faint mono', style: 'margin-left:auto' }, t.id))
  const axis = h('div', { class: 'wf-axis', 'aria-hidden': 'true' }, h('span', {}, 'span'),
    h('span', { class: 'ticks' }, [0, 0.25, 0.5, 0.75, 1].map((f) => h('span', {}, f ? '+' + dur(span * f) : '0'))), h('span', { style: 'text-align:right' }, 'took'))
  const quiet = d.spans.filter(autoApproved)
  const shown = showQuiet ? d.spans : d.spans.filter((sp) => !autoApproved(sp))
  const rows = shown.map((sp) => {
    const left = ((sp.start - t.start) / span) * 100, width = ((sp.end - sp.start) / span) * 100
    const open = openSpans.has(sp.spanId)
    const detail = spanDetail(sp).filter((x) => x != null && x !== '')
    const fam = familyOf(sp.name)
    const bar = [fam ? 'f-' + fam : '', sp.name === 'cambium.wait' ? 'wait' : '', sp.status === 'error' ? 'err' : ''].join(' ').trim()
    const row = h('button', { type: 'button', class: 'sp', 'data-span': sp.spanId, 'aria-expanded': String(open),
        title: sp.name + ' · at +' + dur(sp.start - t.start) + ' · took ' + dur(sp.end - sp.start) },
      h('span', { class: 'nm', style: 'padding-left:' + sp.depth * 14 + 'px' },
        sp.status === 'error' ? h('span', { class: 'dot err' }) : null, sp.name, detail.length ? h('span', { class: 'faint' }, detail.join(' · ')) : null, askPill(sp)),
      h('span', { class: 'track' }, h('i', { class: bar || null, style: 'left:' + left.toFixed(3) + '%;width:' + width.toFixed(3) + '%' })),
      h('span', { class: 'd' }, dur(sp.end - sp.start)))
    if (!open) return row
    const kv = [['service', sp.service], ['status', sp.status + (sp.statusMessage ? ': ' + sp.statusMessage : '')],
      ['started', new Date(sp.start).toISOString()], ['span id', sp.spanId], ...Object.entries(sp.attrs)].filter(([, v]) => v != null)
    for (const e of sp.events) kv.push(['event · ' + e.name, (isFinite(e.at) ? '+' + dur(e.at - sp.start) + ' ' : '') + Object.entries(e.attrs).map(([k, v]) => k + '=' + showValue(v)).join(' ')])
    return [row, h('dl', { class: 'attrs mono' }, kv.map(([k, v]) => [h('dt', {}, k), h('dd', {}, showValue(v))]))]
  })
  const note = quiet.length ? h('div', { class: 'quiet-note' },
    h('span', {}, plural(quiet.length, 'permission check', 'permission checks'), ' approved by config or a hook, with nobody asked, ', showQuiet ? 'shown' : 'hidden', '.'),
    h('button', { type: 'button', class: 'linkish', 'data-quiet': '' }, showQuiet ? 'hide them' : 'show them')) : null
  return h('section', {}, head, flameView(d.spans), h('div', { class: 'wf' }, legend(d.spans), note, axis, rows), traceFileNote(d))
}

// A permission check a person answered, or one that was refused, is the one worth seeing.
function askPill(sp) {
  if (sp.name !== 'claude_code.tool.blocked_on_user' || autoApproved(sp)) return null
  if (sp.attrs.decision === 'reject') return h('span', { class: 'pill err' }, 'refused')
  return h('span', { class: 'pill warn' }, 'asked you · ' + dur(sp.end - sp.start))
}

// Where the time went: spans with the same path of names fold into one frame, as wide as their summed time.
function flameView(spans) {
  const tree = flameTree(spans)
  const { top, frames } = flameFrames(tree, flameKey)
  const ROW = 20
  const levels = frames.reduce((n, f) => Math.max(n, f.level), 0) + 1
  const crumbs = [h('button', { type: 'button', class: 'linkish', 'data-frame': '' }, 'all spans')]
  let at = tree
  for (const part of top.key.split('/').slice(1)) {
    at = at.kids.find((k) => k.label === part)
    if (!at) break
    crumbs.push(' › ', at === top ? h('span', {}, part) : h('button', { type: 'button', class: 'linkish', 'data-frame': at.key }, part))
  }
  const share = (f) => (top.ms ? Math.round((f.ms / top.ms) * 1000) / 10 : 0) + '%'
  const boxes = frames.map((f) => {
    const fam = familyOf(f.label)
    const up = f === frames[0] && top !== tree ? top.key.slice(0, top.key.lastIndexOf('/')) : f.key
    return h('button', { type: 'button', class: ['fr', fam ? 'f-' + fam : '', f.errors ? 'err' : ''].join(' ').trim(), 'data-frame': up,
      style: 'left:' + (f.left * 100).toFixed(3) + '%;width:' + (f.width * 100).toFixed(3) + '%;top:' + f.level * ROW + 'px',
      title: f.label + '\\n' + dur(f.ms) + ' · ' + share(f) + ' · ' + plural(f.count, 'span', 'spans') + (f.errors ? ' · ' + f.errors + ' failed' : '') +
        (f === frames[0] && top !== tree ? '\\nclick to zoom out' : '') },
      h('span', {}, f.label + ' · ' + dur(f.ms)))
  })
  return h('aside', { class: 'flame', 'aria-label': 'Flame graph' }, h('h2', {}, 'Where time went'),
    h('div', { class: 'crumbs' }, crumbs),
    h('div', { class: 'fl', style: 'height:' + levels * ROW + 'px' }, boxes),
    h('div', { class: 'fl-note' }, 'Width is time summed over every span on that path, so parallel work adds up. Click a frame to zoom in.'))
}

function tracesTab(now) {
  if (!traceState || traceState.key !== traceKey()) return section('Traces', null, h('div', { class: 'empty' }, 'reading traces…'))
  if (traceState.error) return h('div', { class: 'banner err' }, h('b', {}, traceSel ? "Can't load this trace: " : "Can't load traces: "), traceState.error,
    traceSel ? [' · ', h('a', { href: '#traces' }, 'all runs')] : null)
  return traceSel ? traceView(traceState.data) : runsView(traceState.data, now)
}

// Graphs tab. The drawing is built once per graph and direction and then kept: each poll patches its figures
// (traffic, who is where) and feeds it new moves, so the replay runs on without a restart.
// The SVG namespace is a name, not a request; spelled in parts so the page holds no outside URL.
const SVGNS = ['http:', '', 'www.w3.org', '2000', 'svg'].join('/')
function sv(tag, attrs, ...kids) {
  const el = document.createElementNS(SVGNS, tag)
  for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) el.setAttribute(k, v)
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k))
  return el
}
const GX_LOOP_MS = 24000 // the replay plays the window (24 h) in 24 s: a second is an hour
const GX_SPEED = 0.2 // px per ms a pulse travels
const GX_TAIL = 30
const GX_MAX_PULSES = 48
const QUEUE_COLOR = { 'q:intake': 'var(--flow-1)', 'q:task': 'var(--flow-2)', 'q:promote': 'var(--flow-4)', 'q:human': 'var(--warn)' }
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
let gxSel = store.get('graphs.sel', null), gxDock = store.get('graphs.dock', true) !== false, gxOpen = false
let gxPaused = false, gxHover = null, gxPin = null, gxIssues = new Map(), gx = null
const ICONS = {
  drawer: 'M2.5 3.5h11v9h-11zM6 3.5v9',
  close: 'M4 4l8 8M12 4l-8 8',
  pause: 'M5.5 3.5v9M10.5 3.5v9',
  play: 'M5 3.2v9.6l7.5-4.8z',
}
const icon = (k) => sv('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }, sv('path', { d: ICONS[k] }))
const edgeId = (from, to) => (from || '') + '>' + (to || '')

// Issue keys still in the loop: queued, running, waiting on a human, or closed by an open agent PR.
function loopIssues(gh) {
  const m = new Map()
  for (const k of ['intake', 'waiting', 'task', 'running', 'human', 'promote']) for (const i of gh.columns[k] || []) m.set(issueKey(i.repo, i.number), i)
  for (const i of strandedOf(gh)) m.set(issueKey(i.repo, i.number), i)
  for (const p of gh.prs) for (const n of p.closes || []) if (!m.has(issueKey(p.repo, n))) m.set(issueKey(p.repo, n), { repo: p.repo, number: n, title: p.title, url: 'https://github.com/' + p.repo + '/issues/' + n })
  return m
}
// Per node, the issues still in the loop whose newest traced step was there.
function hereNow(flow, graph) {
  const by = {}
  if (!flow) return by
  for (const [k, st] of Object.entries(flow.at || {})) {
    if (st.graph !== graph || !gxIssues.has(k)) continue
    ;(by[st.node] = by[st.node] || []).push({ key: k, at: st.at })
  }
  for (const xs of Object.values(by)) xs.sort((a, b) => b.at - a.at)
  return by
}
const countHere = (by) => Object.values(by).reduce((n, xs) => n + xs.length, 0)

// LR reads like the flow; it is kept while it draws at 90% scale or more, else whichever direction draws larger.
// The drawing may grow to 1.3x where the stage has room, so a small graph still reads from across the desk.
const GX_GROW = 1.3
const GX_MIN = 0.72
function gxAvail() {
  const main = $('main'), wide = !matchMedia('(max-width:900px)').matches
  const narrow = matchMedia('(max-width:480px)').matches
  return Math.max(240, (main ? main.clientWidth : innerWidth) - (narrow ? 24 : 32) - (wide && gxDock ? 264 + 16 : 0) - (narrow ? 26 : 34))
}
function gxLayout(g) {
  const avail = gxAvail()
  const lr = layoutGraph(g, { dir: 'LR' })
  const fit = (l) => Math.min(1, avail / l.width)
  if (fit(lr) >= 0.9) return lr
  const td = layoutGraph(g, { dir: 'TD' })
  return fit(td) > fit(lr) ? td : lr
}
function gxSize(svg, layout) {
  const tall = Math.max(260, innerHeight - 300)
  // Never below GX_MIN: past that the names stop being readable, so a narrow screen pans the drawing instead.
  const vb = layout.vb || { w: layout.width, h: layout.height }
  const k = Math.max(GX_MIN, Math.min(GX_GROW, gxAvail() / vb.w, Math.max(1, tall / vb.h)))
  svg.setAttribute('width', Math.round(vb.w * k))
  svg.setAttribute('height', Math.round(vb.h * k))
}

function gxDrawer(graphs, flow, cur) {
  const items = graphs.map((g) => {
    const gf = flow && flow.graphs[g.name], here = countHere(hereNow(flow, g.name)), waits = g.nodes.filter((n) => n.kind === 'wait').length
    return h('li', {}, h('button', { type: 'button', class: 'gx-item', 'data-graph': g.name, 'data-fk': 'graph:' + g.name, 'aria-current': String(g.name === cur) },
      h('span', { class: 'gx-nm' }, h('b', {}, g.name), g.version != null ? h('span', { class: 'faint' }, 'v' + g.version) : null),
      g.about ? h('span', { class: 'gx-about' }, g.about) : null,
      h('span', { class: 'meta' }, h('span', {}, plural(g.nodes.length, 'node', 'nodes') + (waits ? ' · ' + plural(waits, 'wait', 'waits') : '')),
        here ? h('span', {}, h('b', {}, here), ' in the loop') : null,
        gf ? h('span', { class: 'faint' }, plural(gf.total, 'move', 'moves') + ' today') : null)))
  })
  return h('aside', { class: 'gx-drawer', id: 'gx-drawer', 'aria-label': 'Graphs' },
    h('div', { class: 'gx-dh' }, h('h2', {}, 'Graphs', h('span', { class: 'n' }, graphs.length)),
      h('button', { type: 'button', class: 'icon-btn', 'data-gx-close': '', 'data-fk': 'gx-close', 'aria-label': 'Close the list of graphs' }, icon('close'))),
    h('ul', { class: 'gx-list' }, items),
    h('p', { class: 'gx-src' }, "From cambium's heartbeat. Moves come from its traces."))
}

function gxHead(g) {
  const wide = !matchMedia('(max-width:900px)').matches
  const toggle = h('button', { type: 'button', class: 'icon-btn', 'data-gx-drawer': '', 'data-fk': 'gx-drawer',
    'aria-expanded': String(wide ? gxDock : gxOpen), 'aria-controls': 'gx-drawer', title: wide ? (gxDock ? 'Hide the list of graphs' : 'Show the list of graphs') : 'Choose a graph' },
    icon('drawer'), wide ? null : 'Graphs')
  const queues = [...new Set(g.nodes.map((n) => n.queue).filter(Boolean))]
  const shape = (d, cls) => sv('svg', { width: 16, height: 12, viewBox: '0 0 16 12', 'aria-hidden': 'true' }, sv('path', { d, class: cls }))
  const legend = h('div', { class: 'gx-legend', 'aria-hidden': 'true' },
    h('span', {}, shape('M2 1.5h12a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H2A1.5 1.5 0 0 1 .5 9V3A1.5 1.5 0 0 1 2 1.5z', 'lg-step'), 'step'),
    h('span', {}, shape('M3.5 1.5h9l3 4.5-3 4.5h-9l-3-4.5z', 'lg-wait'), 'wait'),
    h('span', {}, sv('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true' }, sv('circle', { cx: 6, cy: 6, r: 5, class: 'lg-end' }), sv('circle', { cx: 6, cy: 6, r: 2.4, class: 'lg-end-dot' })), 'ends'),
    h('span', {}, sv('svg', { width: 22, height: 12, viewBox: '0 0 22 12', 'aria-hidden': 'true' }, sv('path', { d: 'M1 6h14', class: 'lg-pulse' }), sv('circle', { cx: 17, cy: 6, r: 3, class: 'lg-head' })), 'a move'),
    queues.map((q) => h('span', {}, h('i', { class: 'sw', style: '--c:' + (QUEUE_COLOR[q] || 'var(--faint)') }), h('span', { class: 'mono' }, q))))
  return h('div', { class: 'gx-head' }, toggle, h('h2', { class: 'gx-title', id: 'gx-title' }, g.name),
    g.version != null ? h('span', { class: 'pill' }, 'v' + g.version) : null, legend,
    g.about ? h('p', { class: 'gx-about' }, g.about) : null)
}

function gxBar(gf, flow, g) {
  const btn = h('button', { type: 'button', class: 'icon-btn', 'data-gx-play': '', 'data-fk': 'gx-play', 'aria-pressed': String(gxPaused) },
    icon(gxPaused ? 'play' : 'pause'), gxPaused ? 'Play' : 'Pause')
  if (gf && gf.moves.length) {
    const span = flow.sinceMs, t0 = Date.now() - span
    const ticks = gf.moves.map((m) => h('i', { class: m.error ? 'err' : null, style: 'left:' + Math.max(0, Math.min(100, ((m.at - t0) / span) * 100)).toFixed(2) + '%' }))
    const shown = gf.total > gf.moves.length ? 'the newest ' + gf.moves.length + ' of ' + gf.total + ' moves' : plural(gf.total, 'move', 'moves')
    return h('div', { class: 'gx-play' }, btn,
      h('span', { class: 'faint' }, dur(span) + ' ago'),
      h('div', { class: 'gx-tl', id: 'gx-tl', role: 'slider', tabindex: 0, 'data-fk': 'gx-tl', 'aria-label': 'Replay position', 'aria-valuemin': 0, 'aria-valuemax': 100,
        'aria-valuenow': 0, title: 'Click to jump the replay to that time' }, ticks, h('b', { id: 'gx-head' })),
      h('span', { class: 'faint' }, 'now'),
      h('span', { class: 'what' }, 'Replaying the last ' + dur(span) + ' of the ', h('span', { class: 'mono' }, g.name), ' graph: ' + shown + ', a second for each hour. Moves that land while you watch run as they happen.'))
  }
  const why = !flow ? (last && last.traces ? last.traces.message || 'Tracing is off' : 'Tracing is off') + ', so there are no real moves to replay.'
    : 'No moves through this graph were traced in the last ' + dur(flow.sinceMs) + '.'
  return h('div', { class: 'gx-play' }, btn, h('span', {}, why + ' Showing every path an issue can take instead.'))
}

function gxBuild(g, layout) {
  const defs = sv('defs', {}, sv('marker', { id: 'gx-arrow', viewBox: '0 0 10 10', refX: 8.5, refY: 5, markerWidth: 9, markerHeight: 9, orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' },
    sv('path', { d: 'M1 1.5L9 5L1 8.5z', class: 'g-arrow' })))
  const edgesG = sv('g', {}), labelsG = sv('g', {}), nodesG = sv('g', {}), pulsesG = sv('g', {})
  const paths = new Map(), nodes = new Map(), ends = new Map(), labels = new Map()
  for (const e of layout.edges) {
    const p = sv('path', { d: e.d, class: 'g-edge' + (e.back ? ' loop' : ''), 'marker-end': e.to !== null ? 'url(#gx-arrow)' : null, 'data-edge': e.id })
    edgesG.append(p)
    paths.set(e.id, p)
    if (e.end) {
      const m = sv('g', { class: 'g-end' }, sv('circle', { cx: e.end.x, cy: e.end.y, r: 5 }), sv('circle', { cx: e.end.x, cy: e.end.y, r: 2.4 }))
      edgesG.append(m)
      ends.set(e.id, m)
    }
    if (e.label) {
      const w = Math.round(e.label.text.length * 6.6 + 8)
      const lg = sv('g', { class: 'g-lbl' }, sv('rect', { x: e.label.x - w / 2, y: e.label.y - 8, width: w, height: 16, rx: 3 }),
        sv('text', { x: e.label.x, y: e.label.y + 3.5, 'text-anchor': 'middle' }, e.label.text))
      labelsG.append(lg)
      labels.set(e.id, lg)
    }
  }
  for (const n of layout.nodes) {
    const isStart = n.kind === 'start', d = isStart ? null : g.nodes.find((x) => x.name === n.name)
    const kids = [sv('path', { d: n.shape, class: 'body' }), sv('path', { d: n.shape, class: 'g-ring' })]
    if (isStart) kids.push(sv('text', { x: n.cx, y: n.cy + 4, 'text-anchor': 'middle', class: 'nm' }, n.label))
    else {
      const sw = d.queue ? 9 : 0, mw = n.meta.length * 6.4
      kids.push(sv('text', { x: n.cx, y: n.cy - 3, 'text-anchor': 'middle', class: 'nm' }, n.label))
      if (sw) kids.push(sv('circle', { cx: n.cx - (mw + sw) / 2 + 3.5, cy: n.cy + 10.5, r: 3.5, class: 'sw', style: '--c:' + (QUEUE_COLOR[d.queue] || 'var(--faint)') }))
      kids.push(sv('text', { x: n.cx + sw / 2, y: n.cy + 14, 'text-anchor': 'middle', class: 'mt' }, n.meta))
    }
    const label = isStart ? 'Entry: issues start here from ' + n.label : n.name + ', ' + (d.kind === 'wait' ? 'wait' : 'step') + (d.queue ? ', in ' + d.queue : '')
    const el = sv('g', { class: 'g-node ' + n.kind, tabindex: 0, role: 'button', 'data-node': n.id, 'data-fk': 'gnode:' + n.id, 'aria-label': label + '. Show details', 'aria-expanded': 'false' }, kids)
    nodesG.append(el)
    nodes.set(n.id, { el, n, ring: kids[1] })
  }
  // Labels may reach past the layout's box (a wide one on an edge near the margin): the view takes them in.
  let x0 = 0, y0 = 0, x1 = layout.width, y1 = layout.height
  for (const e of layout.edges) if (e.label) {
    const hw = (e.label.text.length * 6.6 + 8) / 2 + 4
    x0 = Math.min(x0, e.label.x - hw); x1 = Math.max(x1, e.label.x + hw); y0 = Math.min(y0, e.label.y - 12); y1 = Math.max(y1, e.label.y + 12)
  }
  layout.vb = { x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(x1 - x0), h: Math.ceil(y1 - y0) }
  const svg = sv('svg', { class: 'gx-svg', id: 'gx-svg', width: layout.vb.w, height: layout.vb.h, viewBox: [layout.vb.x, layout.vb.y, layout.vb.w, layout.vb.h].join(' '),
    role: 'group', 'aria-label': g.name + ' graph: ' + plural(g.nodes.length, 'node', 'nodes') + '. Each node shows its details on focus.' },
    defs, edgesG, labelsG, nodesG, pulsesG)
  return { svg, paths, nodes, ends, labels, pulsesG }
}

// Traffic and who is where, patched into the kept drawing on every poll.
function gxOverlay(gf, here) {
  const traffic = new Map((gf ? gf.edges : []).map((e) => [edgeId(e.from, e.to), e.n]))
  const max = Math.max(1, ...traffic.values())
  for (const [id, p] of gx.paths) {
    const n = traffic.get(id) || 0
    p.style.setProperty('--sw', (1.25 + (n ? 2.25 * Math.sqrt(n / max) : 0)).toFixed(2))
    p.classList.toggle('idle', gx.mode === 'replay' && !n && !id.endsWith('>'))
  }
  for (const [id, x] of gx.nodes) {
    const xs = here[id] || [], old = x.el.querySelector('.g-badge')
    if (!xs.length) { if (old) old.remove(); continue }
    const r = 9, cx = x.n.x + x.n.w - 4, cy = x.n.y + 4, human = x.n.meta && x.n.meta.startsWith('q:human')
    const badge = sv('g', { class: 'g-badge' + (human ? ' human' : ''), 'aria-hidden': 'true' }, sv('circle', { cx, cy, r: xs.length > 9 ? r + 2 : r }),
      sv('text', { x: cx, y: cy + 3.6, 'text-anchor': 'middle' }, xs.length))
    if (old) old.replaceWith(badge)
    else x.el.append(badge)
    x.el.setAttribute('aria-label', x.el.getAttribute('aria-label').replace(/ · \\d+ in the loop here/, '').replace('. Show details', ' · ' + xs.length + ' in the loop here. Show details'))
  }
}

// What the replay plays: the real moves in the window, or, with none, a walk along every edge from the entry.
function gxSchedule(gf, flow, g) {
  if (gf && gf.moves.length) {
    const t0 = Date.now() - flow.sinceMs
    return { mode: 'replay', loop: GX_LOOP_MS, moves: gf.moves.map((m) => ({ ...m, phase: Math.max(0, Math.min(1, (m.at - t0) / flow.sinceMs)) * GX_LOOP_MS })) }
  }
  const order = [], seenNodes = new Set(), queue = [null]
  seenNodes.add(null)
  order.push({ from: null, to: g.entry.node })
  queue.push(g.entry.node)
  seenNodes.add(g.entry.node)
  queue.shift()
  while (queue.length) {
    const v = queue.shift()
    for (const e of g.edges.filter((x) => x.from === v)) {
      if (order.some((o) => o.from === e.from && o.to === e.to)) continue
      order.push({ from: e.from, to: e.to })
      if (e.to !== null && !seenNodes.has(e.to)) { seenNodes.add(e.to); queue.push(e.to) }
    }
  }
  const STEP = 650
  return { mode: 'paths', loop: order.length * STEP + 1600, moves: order.map((m, i) => ({ ...m, phase: i * STEP, walk: true })) }
}

const easeInOut = (t) => 0.5 - Math.cos(Math.PI * t) / 2
function gxBlip(id, err) {
  const x = gx && gx.nodes.get(id)
  if (!x || !x.ring.animate) return
  x.ring.classList.toggle('err', !!err)
  x.ring.animate(reducedMotion.matches ? [{ opacity: 0.9 }, { opacity: 0 }] : [{ opacity: 0.9, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.18)' }],
    { duration: 700, easing: 'cubic-bezier(.16,1,.3,1)' })
}
function gxFlash(p) {
  p.classList.add('flash')
  setTimeout(() => p.classList.remove('flash'), 600)
}
function gxPulse(id, opts) {
  const p = gx.paths.get(id)
  const to = id.slice(id.indexOf('>') + 1)
  if (!p) { if (to) gxBlip(to, opts.error); return }
  if (reducedMotion.matches) { gxFlash(p); if (to) gxBlip(to, opts.error); return }
  if (gx.pulses.length >= GX_MAX_PULSES) { if (to) gxBlip(to, opts.error); return }
  const len = p.getTotalLength()
  const cls = opts.error ? ' err' : opts.live ? ' live' : ''
  const tail = sv('path', { d: p.getAttribute('d'), class: 'g-pulse' + cls, 'stroke-dasharray': GX_TAIL + ' ' + (len + GX_TAIL * 2), 'stroke-dashoffset': GX_TAIL })
  const p0 = p.getPointAtLength(0)
  const head = sv('circle', { r: opts.live ? 4 : 3.2, class: 'g-head' + cls, cx: p0.x.toFixed(1), cy: p0.y.toFixed(1) })
  gx.pulsesG.append(tail, head)
  gx.pulses.push({ p, len, tail, head, to, start: performance.now(), dur: Math.max(420, Math.min(1800, len / GX_SPEED)), opts })
}
// A move into a node whose only way on is the end carries on through its stub.
const onlyEnds = (g, node) => { const outs = g.edges.filter((e) => e.from === node); return outs.length > 0 && outs.every((e) => e.to === null) }

function gxFrame(ts) {
  if (!gx || !gx.svg.isConnected) { if (gx) gx.raf = 0; return }
  gx.raf = requestAnimationFrame(gxFrame)
  if (document.hidden) { gx.lastTs = ts; return }
  const S = gx.sched
  if (!gxPaused) {
    if (gx.lastTs != null) gx.clock = (gx.clock + Math.min(250, ts - gx.lastTs)) % S.loop
    const prev = gx.played, now = gx.clock
    for (const m of S.moves) {
      const hit = prev <= now ? m.phase > prev && m.phase <= now : m.phase > prev || m.phase <= now
      if (hit) gxPulse(edgeId(m.from, m.to), { error: m.error, walk: m.walk })
    }
    gx.played = now
  }
  gx.lastTs = ts
  const head = $('gx-head')
  if (head && S.mode === 'replay') {
    head.style.left = ((gx.clock / S.loop) * 100).toFixed(2) + '%'
    const tl = $('gx-tl')
    if (tl) tl.setAttribute('aria-valuenow', Math.round((gx.clock / S.loop) * 100))
  }
  gx.pulses = gx.pulses.filter((u) => {
    const t = Math.min(1, (ts - u.start) / u.dur), at = easeInOut(t) * u.len
    u.tail.setAttribute('stroke-dashoffset', (GX_TAIL - at).toFixed(1))
    const pt = u.p.getPointAtLength(at)
    u.head.setAttribute('cx', pt.x.toFixed(1))
    u.head.setAttribute('cy', pt.y.toFixed(1))
    if (t < 1) return true
    u.tail.remove()
    u.head.remove()
    if (u.to) {
      gxBlip(u.to, u.opts.error)
      if (!u.opts.walk && onlyEnds(gx.g, u.to)) gxPulse(edgeId(u.to, null), u.opts)
    }
    return false
  })
}

// Moves traced since the last poll run now, ahead of the replay, as they happen.
function gxIngest(gf, first) {
  const latest = gf && gf.moves.length ? gf.moves[gf.moves.length - 1].at : 0
  if (first || gx.seen == null) { gx.seen = latest; return }
  if (!gf) return
  for (const m of gf.moves) if (m.at > gx.seen) gxPulse(edgeId(m.from, m.to), { error: m.error, live: true })
  gx.seen = Math.max(gx.seen, latest)
}

function gxTipContent(id) {
  const now = Date.now(), g = gx.g, gf = gx.gf, flow = gx.flow
  const pinned = gxPin === id
  const hint = h('span', { class: 'hint' }, pinned ? 'Esc to close' : 'click to pin')
  if (id === '\\u0000start') {
    const n = gf ? gf.edges.filter((e) => e.from === null).reduce((s, e) => s + e.n, 0) : null
    return [h('div', { class: 'tip-h' }, h('b', {}, 'entry'), hint),
      h('p', { class: 'tip-about' }, g.entry.queue ? ['Issues labelled ', h('code', {}, g.entry.queue), ' enter at ', h('code', {}, g.entry.node), '.'] : ['A run starts at ', h('code', {}, g.entry.node), '.']),
      n != null ? h('div', { class: 'tip-sec' }, h('h3', {}, 'Last ' + dur(flow.sinceMs)), h('div', { class: 'tip-figs' }, h('span', {}, h('b', {}, n), plural(n, 'entry', 'entries').replace(/^\\d+ /, '')))) : null]
  }
  const d = g.nodes.find((x) => x.name === id)
  const st = gf && gf.nodes[id], here = gx.here[id] || []
  const traffic = new Map((gf ? gf.edges : []).map((e) => [edgeId(e.from, e.to), e.n]))
  const cond = (e) => (e.when ? h('i', {}, e.when) : h('span', { class: 'faint' }, 'otherwise'))
  const outs = g.edges.filter((e) => e.from === id).map((e) => h('li', {}, h('span', { class: 't' }, e.to === null ? h('span', { class: 'muted' }, 'the end') : h('code', {}, e.to), ' ', h('span', { class: 'faint' }, 'when'), ' ', cond(e)),
    traffic.get(edgeId(id, e.to)) ? h('span', { class: 'n' }, traffic.get(edgeId(id, e.to))) : null))
  const ins = [...(g.entry.node === id ? [h('li', {}, h('span', { class: 't' }, h('span', { class: 'muted' }, 'entry'), g.entry.queue ? [' ', h('span', { class: 'faint' }, 'from'), ' ', h('code', {}, g.entry.queue)] : null),
      traffic.get(edgeId(null, id)) ? h('span', { class: 'n' }, traffic.get(edgeId(null, id))) : null)] : []),
    ...g.edges.filter((e) => e.to === id).map((e) => h('li', {}, h('span', { class: 't' }, h('code', {}, e.from), ' ', h('span', { class: 'faint' }, 'when'), ' ', cond(e)),
      traffic.get(edgeId(e.from, id)) ? h('span', { class: 'n' }, traffic.get(edgeId(e.from, id))) : null))]
  const labels = d.queue ? [h('code', {}, d.queue), d.running ? [' and ', h('code', {}, 'running')] : null] : [h('span', { class: 'faint' }, 'none')]
  let figs
  if (!flow) figs = h('p', { class: 'faint', style: 'margin:0' }, 'Tracing is off, so there are no visits to count.')
  else if (!st) figs = h('p', { class: 'faint', style: 'margin:0' }, 'No visits in the last ' + dur(flow.sinceMs) + '.')
  else figs = h('div', { class: 'tip-figs' },
    h('span', {}, h('b', {}, st.visits), st.visits === 1 ? 'visit' : 'visits'),
    st.errors ? h('span', { class: 'err' }, h('b', {}, st.errors), 'failed') : null,
    st.medianMs != null ? h('span', { title: d.kind === 'wait' ? 'Median time an issue waited here' : 'Median time this step took' }, h('b', {}, dur(st.medianMs)), d.kind === 'wait' ? 'median wait' : 'median run') : null,
    st.lastAt ? h('span', { class: 'faint', title: new Date(st.lastAt).toISOString() }, 'last ' + ago(new Date(st.lastAt).toISOString(), now)) : null)
  const SHOW = 6
  return [
    h('div', { class: 'tip-h' }, h('b', {}, d.name), h('span', { class: 'pill' }, d.kind), g.entry.node === id ? h('span', { class: 'pill' }, 'entry') : null, hint),
    d.about ? h('p', { class: 'tip-about' }, d.about) : null,
    h('div', { class: 'tip-sec' }, h('h3', {}, 'Labels', h('span', {}, 'an issue resting here carries')), h('div', {}, labels)),
    h('div', { class: 'tip-sec' }, h('h3', {}, flow ? 'Last ' + dur(flow.sinceMs) : 'Traffic'), figs),
    here.length ? h('div', { class: 'tip-sec' }, h('h3', {}, 'Last step here', h('span', {}, here.length + ' still in the loop')),
      h('ul', { class: 'tip-list' }, here.slice(0, SHOW).map((x) => {
        const i = gxIssues.get(x.key), [repo, n] = x.key.split('#')
        return h('li', {}, link(i && i.url, h('span', { class: 't t1', title: i ? i.title : x.key }, h('span', { class: 'faint' }, '#' + n + ' '), i ? i.title : repo)),
          h('span', { class: 'n', title: new Date(x.at).toISOString() }, ago(new Date(x.at).toISOString(), now)))
      }), here.length > SHOW ? h('li', { class: 'faint' }, (here.length - SHOW) + ' more') : null)) : null,
    outs.length ? h('div', { class: 'tip-sec' }, h('h3', {}, 'Leads to', h('span', {}, 'tried in order')), h('ul', { class: 'tip-list' }, outs)) : null,
    ins.length ? h('div', { class: 'tip-sec' }, h('h3', {}, 'Comes from'), h('ul', { class: 'tip-list' }, ins)) : null]
}

function gxShowTip(id) {
  const tip = $('gx-tip'), stage = tip && tip.parentElement
  if (!gx || !tip || !stage) return
  const shown = gxPin || id
  for (const [k, x] of gx.nodes) { x.el.classList.toggle('on', k === shown); x.el.setAttribute('aria-expanded', String(k === gxPin)) }
  // Focus: the node, its edges and their ends stay lit; the rest of the drawing steps back.
  gx.svg.classList.toggle('focus', !!shown)
  const hot = new Set(shown ? [shown] : [])
  for (const [eid, p] of gx.paths) {
    const [from, to] = eid.split('>'), f = from || '\\u0000start'
    const on = !!shown && (f === shown || to === shown)
    p.classList.toggle('hot', on)
    gx.labels.get(eid)?.classList.toggle('hot', on)
    gx.ends.get(eid)?.classList.toggle('hot', on)
    if (on) { hot.add(f); if (to) hot.add(to) }
  }
  for (const [k, x] of gx.nodes) x.el.classList.toggle('hot', hot.has(k))
  if (!shown) { tip.classList.remove('shown', 'pinned'); tip.hidden = true; tip.dataset.node = ''; return }
  tip.replaceChildren(...gxTipContent(shown).filter(Boolean))
  tip.dataset.node = shown
  tip.hidden = false
  tip.classList.toggle('pinned', !!gxPin)
  const node = gx.nodes.get(shown).el.querySelector('.body').getBoundingClientRect(), box = stage.getBoundingClientRect()
  const tw = tip.offsetWidth, th = tip.offsetHeight, gap = 10
  let left = node.right - box.left + gap
  if (left + tw > box.width - 8) left = node.left - box.left - tw - gap
  let top = node.top - box.top
  if (left < 8) { left = Math.max(8, Math.min(box.width - tw - 8, node.left - box.left + node.width / 2 - tw / 2)); top = node.bottom - box.top + gap }
  top = Math.max(8, Math.min(top, Math.max(8, box.height - th - 8)))
  tip.style.left = Math.round(left) + 'px'
  tip.style.top = Math.round(top) + 'px'
  requestAnimationFrame(() => tip.classList.add('shown'))
}

function graphsTab(s) {
  const d = s.heartbeat.data
  if (!d) return [calmBox('Graphs appear once cambium writes a readable heartbeat.', 'See the message above.')]
  if (!d.graphs) return [calmBox("This cambium doesn't publish its graphs.", 'Newer versions of @oakgreencc/cambium list every graph in the heartbeat; upgrade it and restart the daemon.')]
  if (!d.graphs.length) return [calmBox('cambium lists no graphs.', 'Its heartbeat has an empty graphs list.')]
  const graphs = d.graphs, g = graphs.find((x) => x.name === gxSel) || graphs[0]
  const flow = s.traces && s.traces.status === 'ok' && s.traces.flow ? s.traces.flow : null
  const gf = (flow && flow.graphs[g.name]) || null
  gxIssues = loopIssues(s.github)
  const here = hereNow(flow, g.name)
  const out = []
  if (d.engine === 'legacy') out.push(h('div', { class: 'banner warn' }, h('b', {}, 'cambium runs the legacy engine: '),
    'these graphs describe its code, but no issue moves through them. Set ', h('code', {}, '"engine": "graph"'), " in cambium's config to run them."))
  const cls = 'gx' + (gxDock ? '' : ' undocked') + (gxOpen ? ' drawer-open' : '')
  const drawer = gxDrawer(graphs, flow, g.name), head = gxHead(g), bar = gxBar(gf, flow, g)
  const old = $('gx'), layout = gx && old && gx.g.name === g.name && JSON.stringify(gx.g) === JSON.stringify(g) ? gx.layout : null
  const fresh = layout ? null : gxLayout(g)
  // Kept: the same graph, drawn the same way. Only the figures around and on it change.
  if (old && gx && layout && gxLayout(g).dir === layout.dir) {
    old.className = cls
    old.querySelector(':scope > .gx-drawer').replaceWith(drawer)
    old.querySelector('.gx-head').replaceWith(head)
    old.querySelector('.gx-play').replaceWith(bar)
    const sched = gxSchedule(gf, flow, g)
    if (sched.mode !== gx.sched.mode || sched.moves.length !== gx.sched.moves.length) { gx.sched = sched; gx.played = gx.clock % sched.loop }
    Object.assign(gx, { gf, flow, here, mode: sched.mode })
    gxOverlay(gf, here)
    gxIngest(gf, false)
    gxSize(gx.svg, gx.layout)
    if ($('gx-tip') && $('gx-tip').dataset.node) gxShowTip(gxHover)
    out.push(old)
    return out
  }
  const lay = fresh || gxLayout(g)
  const built = gxBuild(g, lay)
  const tip = h('div', { class: 'gx-tip', id: 'gx-tip', role: 'tooltip', hidden: '' })
  const el = h('div', { class: cls, id: 'gx' }, drawer, h('div', { class: 'gx-scrim', 'data-gx-close': '' }),
    h('section', { class: 'gx-stage', 'aria-labelledby': 'gx-title' }, head, h('div', { class: 'gx-canvas' }, built.svg), bar, tip))
  if (gx && gx.raf) cancelAnimationFrame(gx.raf)
  const sched = gxSchedule(gf, flow, g)
  gx = { g, layout: lay, ...built, gf, flow, here, sched, mode: sched.mode, clock: 0, played: -1, lastTs: null, pulses: [], seen: null, raf: 0 }
  // The replay starts at the window's newest end, so a fresh view first shows what just happened.
  if (sched.mode === 'replay') { gx.clock = Math.max(0, sched.loop - 6000); gx.played = gx.clock }
  gxOverlay(gf, here)
  gxIngest(gf, true)
  gxSize(built.svg, lay)
  gxHover = null
  if (gxPin && !gx.nodes.has(gxPin)) gxPin = null
  gx.raf = requestAnimationFrame(gxFrame)
  out.push(el)
  return out
}

function gxPick(name) {
  gxSel = name
  store.set('graphs.sel', name)
  gxPin = null
  gxHover = null
  const was = gxOpen
  gxOpen = false
  history.replaceState(null, '', '#graphs/' + encodeURIComponent(name))
  if (last) render(last)
  if (was) document.querySelector('[data-gx-drawer]')?.focus({ preventScroll: true })
}
function gxToggleDrawer() {
  if (matchMedia('(max-width:900px)').matches) {
    gxOpen = !gxOpen
    if (last) render(last)
    if (gxOpen) (document.querySelector('.gx-item[aria-current=true]') || document.querySelector('.gx-item'))?.focus({ preventScroll: true })
  } else {
    gxDock = !gxDock
    store.set('graphs.dock', gxDock)
    if (last) render(last)
  }
}
function gxCloseDrawer() {
  if (!gxOpen) return
  gxOpen = false
  if (last) render(last)
  document.querySelector('[data-gx-drawer]')?.focus({ preventScroll: true })
}

$('main').addEventListener('pointerover', (e) => {
  const n = e.target.closest && e.target.closest('.g-node')
  if (!n || tab !== 'graphs' || e.pointerType === 'touch') return
  if (gxHover !== n.dataset.node) { gxHover = n.dataset.node; gxShowTip(gxHover) }
})
$('main').addEventListener('pointerout', (e) => {
  const n = e.target.closest && e.target.closest('.g-node')
  if (!n || tab !== 'graphs' || (e.relatedTarget && n.contains(e.relatedTarget))) return
  if (gxHover === n.dataset.node) { gxHover = null; gxShowTip(null) }
})
$('main').addEventListener('focusin', (e) => {
  const n = e.target.closest && e.target.closest('.g-node')
  if (n && tab === 'graphs') { gxHover = n.dataset.node; gxShowTip(gxHover) }
})
$('main').addEventListener('focusout', (e) => {
  const n = e.target.closest && e.target.closest('.g-node')
  if (!n || tab !== 'graphs' || (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.gx-tip'))) return
  if (gxHover === n.dataset.node) { gxHover = null; gxShowTip(null) }
})
document.addEventListener('keydown', (e) => {
  if (tab !== 'graphs' || e.defaultPrevented) return
  if (e.key === 'Escape') {
    if (gxOpen) { e.preventDefault(); return gxCloseDrawer() }
    if (gxPin) { e.preventDefault(); const id = gxPin; gxPin = null; gxShowTip(gxHover); return document.querySelector('[data-node="' + CSS.escape(id) + '"]')?.focus({ preventScroll: true }) }
  }
  const n = e.target.closest && e.target.closest('.g-node')
  if (n && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); gxPin = gxPin === n.dataset.node ? null : n.dataset.node; gxShowTip(n.dataset.node) }
  const tl = e.target.closest && e.target.closest('#gx-tl')
  const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key]
  if (tl && step && gx) { e.preventDefault(); gx.clock = (gx.clock + step * gx.sched.loop / 24 + gx.sched.loop) % gx.sched.loop; gx.played = gx.clock }
})
// A click outside a pinned card lets it go.
document.addEventListener('click', (e) => {
  if (tab !== 'graphs' || !gxPin || (e.target.closest && e.target.closest('.g-node,.gx-tip'))) return
  gxPin = null
  gxShowTip(gxHover)
})
let gxResize = 0
new ResizeObserver(() => {
  if (tab !== 'graphs' || !gx || gxResize) return
  gxResize = requestAnimationFrame(() => {
    gxResize = 0
    if (gx && gx.svg.isConnected && gxLayout(gx.g).dir !== gx.layout.dir && last) return render(last)
    if (gx && gx.svg.isConnected) gxSize(gx.svg, gx.layout)
    if (gxHover || gxPin) gxShowTip(gxHover)
  })
}).observe($('main'))

const TABS = ['inbox', 'queue', 'graphs', 'traces', 'intake', 'health']
// #inbox/<owner>/<name>/<n> selects an inbox item; #traces/<id> opens a trace; #graphs/<name> picks a graph.
const parseHash = () => {
  const [t, id, name, n] = location.hash.slice(1).split('/')
  if (!TABS.includes(t)) return ['inbox', null, null, null]
  let graph = null
  try { graph = t === 'graphs' && id ? decodeURIComponent(id) : null } catch {}
  return [t, t === 'traces' && /^[0-9a-f]{32}$/.test(id || '') ? id : null, t === 'inbox' && name && /^[1-9][0-9]*$/.test(n || '') ? id + '/' + name + '#' + n : null, graph]
}
let [tab, traceSel, hashSel, hashGraph] = parseHash(), last = null, traceState = null
if (hashSel) { ibSel = hashSel; ibOpen = true }
if (hashGraph) gxSel = hashGraph
const traceKey = () => (traceSel ? '/api/traces/' + traceSel : '/api/traces')
async function loadTraces() {
  if (tab !== 'traces') return
  const key = traceKey()
  try {
    const r = await fetch(key, { cache: 'no-store' })
    const j = await r.json()
    traceState = { key, data: r.ok ? j : null, error: r.ok ? null : j.error || 'HTTP ' + r.status }
  } catch (err) {
    traceState = { key, data: null, error: (err && err.message) || 'no answer' }
  }
}

// The browser tab carries health too, by color and shape: the oakgreen tree ring when healthy, a triangle on a
// warning, a square on a failure, a plain hollow circle when the canopy server is unreachable.
const RING_PATHS = ['M480 250A230 230 0 1 1 20 250 230 230 0 1 1 480 250', 'M430 250A180 180 0 0 1 262.008 429.599 180 180 0 0 1 71.602 273.962 180 180 0 0 1 214.191 73.598 180 180 0 0 1 423.62 202.503',
  'M330 250H430', 'M370.161 299.613A130 130 0 0 1 224.154 377.405 130 130 0 0 1 120.005 248.866 130 130 0 0 1 226.382 122.163 130 130 0 0 1 371.008 202.492',
  'M314.416 297.44A80 80 0 0 1 225.033 326.004 80 80 0 0 1 170 250a80 80 0 0 1 55.033-76.004 80 80 0 0 1 89.383 28.565']
const ICON = {
  ok: ['#3c9057', (g) => { g.scale(32 / 500, 32 / 500); Object.assign(g, { lineWidth: 44, lineCap: 'round', lineJoin: 'round' }); for (const d of RING_PATHS) g.stroke(new Path2D(d)) }],
  warn: ['#d9a640', (g) => { g.beginPath(); g.moveTo(16, 3); g.lineTo(30, 29); g.lineTo(2, 29); g.closePath(); g.fill() }],
  err: ['#e0624f', (g) => { g.beginPath(); g.roundRect(3, 3, 26, 26, 6); g.fill() }],
  down: ['#87a08d', (g) => { g.beginPath(); g.arc(16, 16, 11, 0, 2 * Math.PI); g.lineWidth = 5; g.stroke() }],
}
let iconTone = null
function setIcon(tone) {
  if (tone === iconTone || !ICON[tone]) return
  const cv = Object.assign(document.createElement('canvas'), { width: 32, height: 32 }), g = cv.getContext('2d')
  if (!g) return
  iconTone = tone
  const [c, draw] = ICON[tone]
  Object.assign(g, { fillStyle: c, strokeStyle: c })
  draw(g)
  let el = document.querySelector('link[rel=icon]')
  if (!el) document.head.append((el = Object.assign(document.createElement('link'), { rel: 'icon' })))
  el.href = cv.toDataURL('image/png')
}

function tabs(s) {
  const human = needsYou(s.github), queued = inFlight(s.github), [tone, why] = healthOf(s)
  document.body.dataset.health = tone
  setIcon(tone)
  $('n-inbox').textContent = human
  $('n-inbox').className = 'count' + (human ? ' attn' : '')
  $('tab-inbox').setAttribute('aria-label', 'Inbox: ' + plural(human, 'issue needs', 'issues need') + ' you')
  $('n-queue').textContent = queued
  $('tab-queue').setAttribute('aria-label', 'Queue: ' + plural(queued, 'issue', 'issues') + ' queued')
  $('d-health').className = 'dot ' + tone
  $('d-health').title = why
  $('tab-health').setAttribute('aria-label', 'Health: ' + why)
  const tr = s.traces, traced = tr && tr.status === 'ok'
  const tWhy = traced ? plural(tr.total, 'run', 'runs') + ' traced' + (tr.errored ? ', ' + tr.errored + ' with a failed span' : '') : (tr && tr.message) || 'tracing is off'
  $('n-traces').textContent = traced ? tr.total : '–'
  $('n-traces').className = 'count' + (traced && tr.errored ? ' attn' : '')
  $('tab-traces').title = tWhy
  $('tab-traces').setAttribute('aria-label', 'Traces: ' + tWhy)
  const [iN, iAttn, iWhy] = intakeBadge(s)
  $('n-intake').textContent = iN
  $('n-intake').className = 'count' + (iAttn ? ' attn' : '')
  $('tab-intake').title = iWhy
  $('tab-intake').setAttribute('aria-label', 'Intake: ' + iWhy)
  for (const t of TABS) {
    const b = $('tab-' + t), on = t === tab
    b.setAttribute('aria-selected', on)
    b.tabIndex = on ? 0 : -1
  }
  $('main').setAttribute('aria-labelledby', 'tab-' + tab)
}

async function go(t, focus) {
  if (!TABS.includes(t)) return
  tab = t
  traceSel = null
  history.replaceState(null, '', t === 'inbox' && ibSel ? ibHash(ibSel) : t === 'graphs' && gxSel ? '#graphs/' + encodeURIComponent(gxSel) : '#' + t)
  window.scrollTo(0, 0)
  if (last) render(last)
  if (focus) $('tab-' + t).focus()
  if (t === 'traces') {
    await loadTraces()
    if (last) render(last)
  }
}

$('tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) go(b.dataset.tab) })
$('tabs').addEventListener('keydown', (e) => {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key]
  if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); return go(e.key === 'Home' ? TABS[0] : TABS[TABS.length - 1], true) }
  if (!step) return
  e.preventDefault()
  go(TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length], true)
})
$('main').addEventListener('click', (e) => {
  const b = e.target.closest('[data-go]')
  if (b) return go(b.dataset.go, true)
  const gb = e.target.closest('[data-graph],[data-gx-drawer],[data-gx-close],[data-gx-play],#gx-tl,.g-node')
  if (gb) {
    if (gb.dataset.graph) return gxPick(gb.dataset.graph)
    if (gb.dataset.gxDrawer != null) return gxToggleDrawer()
    if (gb.dataset.gxClose != null) return gxCloseDrawer()
    if (gb.dataset.gxPlay != null) { gxPaused = !gxPaused; if (last) render(last); return }
    if (gb.id === 'gx-tl' && gx) {
      const r = gb.getBoundingClientRect()
      gx.clock = Math.max(0, Math.min(0.999, (e.clientX - r.left) / r.width)) * gx.sched.loop
      gx.played = gx.clock
      return
    }
    if (gb.dataset.node) { gxPin = gxPin === gb.dataset.node ? null : gb.dataset.node; gxHover = gb.dataset.node; return gxShowTip(gxHover) }
  }
  const cp = e.target.closest('[data-copy]')
  if (cp) {
    const done = (t) => { cp.textContent = t }
    if (navigator.clipboard) navigator.clipboard.writeText(cp.dataset.copy).then(() => done('Copied'), () => done('Select it to copy'))
    else done('Select it to copy')
    return
  }
  const mb = e.target.closest('[data-menu]')
  if (mb) { ibMenu = ibMenu === mb.dataset.menu ? null : mb.dataset.menu; if (last) render(last); return }
  const ctl = e.target.closest('[data-sort],[data-tag],[data-clear],[data-key],[data-back],[data-retry]')
  if (ctl) {
    const ds = ctl.dataset
    if (ds.key) return select(ds.key, { open: true, focus: true })
    if (ds.back != null) { ibOpen = false; if (last) render(last); return ibSel && focusRow(ibSel) }
    if (ds.retry != null) { const it = ibShown.find((x) => x.key === ibSel); return it && loadDetail(it, true) }
    const chip = ctl.classList.contains('chip')
    if (ds.sort) { ibSort = ds.sort; ibMenu = null }
    else if (ds.tag) ibTags.has(ds.tag) ? ibTags.delete(ds.tag) : ibTags.add(ds.tag)
    else { ibTags.clear(); ibMenu = null }
    store.set('inbox.sort', ibSort)
    store.set('inbox.tags', [...ibTags])
    if (last) render(last)
    if (ds.sort) $('ib')?.querySelector('[data-menu=sort]')?.focus()
    // A removed chip or a clear takes its button away: land on the next chip, else the first filter.
    if (chip || ds.clear != null) ($('ib')?.querySelector('.ib-active .chip') || $('ib')?.querySelector('[data-menu]'))?.focus()
    return pump()
  }
  const fr = e.target.closest('[data-frame]')
  if (fr) {
    flameKey = fr.dataset.frame
    if (last) render(last)
    return document.querySelector('.fr[data-frame="' + CSS.escape(flameKey) + '"],.crumbs [data-frame="' + CSS.escape(flameKey) + '"]')?.focus({ preventScroll: true })
  }
  if (e.target.closest('[data-quiet]')) {
    showQuiet = !showQuiet
    if (last) render(last)
    return document.querySelector('[data-quiet]')?.focus({ preventScroll: true })
  }
  const sp = e.target.closest('[data-span]')
  if (!sp) return
  const id = sp.dataset.span
  if (openSpans.has(id)) openSpans.delete(id)
  else openSpans.add(id)
  if (last) render(last)
  document.querySelector('[data-span="' + id + '"]')?.focus({ preventScroll: true })
})
// An open filter or sort menu closes on a click anywhere outside it.
document.addEventListener('click', (e) => {
  if (!ibMenu || e.target.closest('.dd')) return
  ibMenu = null
  if (last) render(last)
})
// Inbox keys: j/k (and arrows in the list) move, Enter reads, o opens on GitHub, Escape goes back on narrow screens.
document.addEventListener('keydown', (e) => {
  if (tab !== 'inbox' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
  const t = e.target
  if (ibMenu && e.key === 'Escape') {
    e.preventDefault()
    const id = ibMenu
    ibMenu = null
    if (last) render(last)
    return $('ib')?.querySelector('[data-menu="' + CSS.escape(id) + '"]')?.focus()
  }
  if (t.closest && t.closest('.dd')) {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key]
    const opts = [...($('ib')?.querySelectorAll('.menu .opt') || [])]
    if (step && opts.length) {
      e.preventDefault()
      const i = opts.indexOf(t)
      opts[i < 0 ? (step > 0 ? 0 : opts.length - 1) : (i + step + opts.length) % opts.length].focus()
    }
    return
  }
  if (t.closest && t.closest('input,textarea,select,[contenteditable],#tabs')) return
  const inList = !!(t.closest && t.closest('[role=listbox]'))
  const step = { j: 1, k: -1 }[e.key] || (inList ? { ArrowDown: 1, ArrowUp: -1 }[e.key] : 0)
  if (step) { e.preventDefault(); return move(step, inList) }
  if (inList && (e.key === 'Home' || e.key === 'End')) {
    e.preventDefault()
    const it = e.key === 'Home' ? ibShown[0] : ibShown[ibShown.length - 1]
    return it && select(it.key, { focus: true })
  }
  if (inList && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); return ibSel && select(ibSel, { open: true, focusPane: true }) }
  if (e.key === 'o' && !t.closest('a,button')) { const u = selectedUrl(); if (/^https:/.test(u || '')) { e.preventDefault(); window.open(u, '_blank', 'noopener') } return }
  if (e.key === 'Escape' && ibOpen && matchMedia('(max-width:900px)').matches) { ibOpen = false; if (last) render(last); if (ibSel) focusRow(ibSel) }
})
addEventListener('hashchange', async () => {
  const before = traceSel
  let sel
  let graph
  ;[tab, traceSel, sel, graph] = parseHash()
  if (sel) { ibSel = sel; ibOpen = true }
  if (graph && graph !== gxSel) { gxSel = graph; gxPin = null }
  if (traceSel !== before) { openSpans = new Set(); flameKey = ''; window.scrollTo(0, 0) }
  if (last) render(last)
  await loadTraces()
  if (last) render(last)
})

function render(s) {
  last = s
  traceIdx = (s.traces && s.traces.byIssue) || {}
  costFlagUsd = s.cost && s.cost.flagUsd != null ? s.cost.flagUsd : null
  const now = Date.parse(s.now) || Date.now()
  const d = s.heartbeat.data
  const body = [...banners(s, now)]
  let split = null
  if (tab === 'inbox') for (const x of inbox(s, now)) if (x instanceof Node) body.push(x); else body.push((split = x).ib)
  if (tab === 'queue') body.push(...queues(s, now))
  if (tab === 'graphs') body.push(...graphsTab(s))
  if (tab === 'traces') body.push(tracesTab(now))
  if (tab === 'intake') body.push(...intakeTab(s, now))
  if (tab === 'health') {
    if (d) body.push(summary(d), repos(d, now), h('div', { class: 'detail' }, workers(d, s.heartbeat.ageMs), events(d)))
    else body.push(section('Health', null, h('div', { class: 'empty' }, 'Ticks, workers and events appear once cambium writes a readable heartbeat; see the message above.')))
  }
  tabs(s)
  const focused = document.activeElement, href = focused && focused.getAttribute && focused.getAttribute('href')
  const fk = focused && focused.dataset && focused.dataset.fk
  const scrolled = [...document.querySelectorAll('.events,.scroll,.menu')].map((el) => [el.className, el.scrollTop, el.scrollLeft])
  $('head').replaceChildren(header(s, now))
  const ib = $('ib'), oldPane = $('ib-pane')
  const paneWas = oldPane && { key: oldPane.dataset.key, top: oldPane.scrollTop, open: [...oldPane.querySelectorAll('details')].map((x) => x.open) }
  if (split && !split.pane && ib && $('ib-pane')) {
    // The pane hasn't changed: patch around it so a selection, scroll position or open <details> in it survive the poll.
    ib.className = split.ib.className
    ib.querySelector(':scope > .figs').replaceWith(split.stats)
    ib.querySelector(':scope > .ib-side').replaceWith(split.side)
    for (const c of [...$('main').children]) if (c !== ib) c.remove()
    ib.before(...body.filter((x) => x !== split.ib))
  } else if (body.includes($('gx'))) {
    // The graph drawing is kept (graphsTab patched it): swap what sits around it, leave it in place.
    const gxEl = $('gx')
    for (const c of [...$('main').children]) if (c !== gxEl) c.remove()
    gxEl.before(...body.filter((x) => x !== gxEl))
  } else {
    $('main').replaceChildren(...body)
    const p = $('ib-pane')
    if (p && paneWas && p.dataset.key === paneWas.key) {
      p.querySelectorAll('details').forEach((x, i) => { if (paneWas.open[i]) x.open = true })
      p.scrollTop = paneWas.top
    }
  }
  document.documentElement.style.setProperty('--top-h', $('top').offsetHeight + 'px')
  document.body.classList.remove('down')
  for (const [cls, top, left] of scrolled) {
    const el = document.getElementsByClassName(cls)[0]
    if (el) Object.assign(el, { scrollTop: top, scrollLeft: left })
  }
  if (fk) document.querySelector('[data-fk="' + CSS.escape(fk) + '"]')?.focus({ preventScroll: true })
  else if (href) [...document.querySelectorAll('a')].find((a) => a.getAttribute('href') === href)?.focus({ preventScroll: true })
  else if (focused && focused.classList && (focused.classList.contains('events') || focused.classList.contains('scroll'))) document.getElementsByClassName(focused.className)[0]?.focus({ preventScroll: true })
  if (tab === 'inbox') pump()
  const human = needsYou(s.github)
  document.title = (human ? '(' + human + ') ' : '') + 'canopy' + (d ? ' · ' + d.mode : '') + (s.heartbeat.stale ? ' · stale' : '')
}

let pollMs = 5000
async function poll() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' })
    const s = await r.json()
    if (!r.ok) throw new Error(s.error || r.status)
    pollMs = s.pollMs || pollMs
    await loadTraces()
    render(s)
  } catch (err) {
    $('down')?.remove()
    document.body.classList.add('down')
    setIcon('down')
    document.title = 'canopy · unreachable'
    const banner = h('div', { id: 'down', class: 'banner err' }, h('b', {}, "Can't reach the canopy server: "), (err && err.message) || 'no answer',
      (last ? '. Showing the last data it sent; retrying' : '. Nothing read yet; retrying') + ' every ' + dur(pollMs) + '. Is canopy still running?')
    if (last) $('main').prepend(banner)
    else $('main').replaceChildren(banner)
  }
  setTimeout(poll, pollMs)
}
poll()
`

/** The whole page: inline CSS and JS, no external requests, no build step. */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#f6f8f3" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0b190f" media="(prefers-color-scheme: dark)">
<title>canopy</title>
<style>${CSS}</style>
</head>
<body>
<div id="top"><div id="head"><header><h1><span class="mark" aria-hidden="true">${RING}</span>canopy</h1></header></div>
<nav class="tabs" id="tabs" role="tablist" aria-label="Views">
<button class="tab" role="tab" type="button" id="tab-inbox" data-tab="inbox" aria-controls="main">Inbox <span class="count" id="n-inbox">–</span></button>
<button class="tab" role="tab" type="button" id="tab-queue" data-tab="queue" aria-controls="main" tabindex="-1">Queue <span class="count" id="n-queue">–</span></button>
<button class="tab" role="tab" type="button" id="tab-graphs" data-tab="graphs" aria-controls="main" tabindex="-1">Graphs</button>
<button class="tab" role="tab" type="button" id="tab-traces" data-tab="traces" aria-controls="main" tabindex="-1">Traces <span class="count" id="n-traces">–</span></button>
<button class="tab" role="tab" type="button" id="tab-intake" data-tab="intake" aria-controls="main" tabindex="-1">Intake <span class="count" id="n-intake">–</span></button>
<button class="tab" role="tab" type="button" id="tab-health" data-tab="health" aria-controls="main" tabindex="-1">Health <span class="dot" id="d-health"></span></button>
</nav></div>
<main id="main" role="tabpanel" aria-labelledby="tab-inbox"><section class="calm"><span class="wm" aria-hidden="true">${RING}</span><p><b>Reading cambium and GitHub…</b></p><p class="muted">The first read of each repo's queues can take a few seconds.</p></section></main>
<script>${JS}</script>
</body>
</html>
`
