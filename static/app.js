
"use strict";
(()=>{
const $=id=>document.getElementById(id), $$=s=>[...document.querySelectorAll(s)];
const T=k=>(window.I18N?window.I18N.t(k):k);
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x)),fmt=n=>Number(n||0).toLocaleString("en-US");
const esc=s=>String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
async function api(url,opt){const r=await fetch(url,opt);let j;try{j=await r.json()}catch{throw new Error("پاسخ JSON معتبر نیست")};if(!r.ok||j.error)throw new Error(j.error||r.statusText);return j}
function toast(t){const e=$("toast");e.textContent=t;e.classList.add("show");setTimeout(()=>e.classList.remove("show"),1800)}
function hash01(s){let h=2166136261;for(const c of String(s)){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}return(h>>>0)/4294967295}

const CHANNELS={
 visual_left:"بینایی چپ",visual_right:"بینایی راست",odor_a:"بوی A",odor_b:"بوی B",
 wind:"باد",heat:"حرارت",touch:"لمس/مکانیکی",reward:"پاداش",punishment:"تنبیه",
 motor_forward:"حرکت جلو",motor_left:"چرخش چپ",motor_right:"چرخش راست",motor_stop:"توقف"
};

const S={
 graph:null,center:null,selectedNode:null,selectedEdge:null,nodeInfo:null,
 nodes:[],edges:[],pos:new Map(),projNodes:[],projEdges:[],
 cam:{rx:-.25,ry:.45,zoom:1.25,panX:0,panY:0},drag:false,moved:false,lastX:0,lastY:0,
 mode:"connectome",pathNodes:new Set(),pathEdges:new Set(),detailedSWC:null,
 atlasStatus:null,atlasLoaded:0,atlasStreaming:false,atlasTarget:0,activeAtlasRequested:new Set(),
 tasks:[],task:null,taskState:{},customTasks:JSON.parse(localStorage.getItem("flybrain_custom_tasks")||"[]"),
 mapping:Object.fromEntries(Object.keys(CHANNELS).map(k=>[k,new Set()])),
 fly:{x:.5,y:.55,a:-.6,speed:0,turn:0,collision:false,trail:[]},
 arena:{light:{x:.78,y:.22,on:true},odorA:{x:.22,y:.72,on:true},odorB:{x:.82,y:.75,on:true},
   obstacles:[{x:.52,y:.31,r:.07},{x:.66,y:.64,r:.065},{x:.30,y:.43,r:.055}],touchPulse:0,
   cue:null,context:0},
 learning:{on:false,episode:0,totalReward:0,lastReward:0,manualReward:0},
 simRunning:false,lastFrame:performance.now(),acc:0,fixedDt:1/120,
 fullConn:{dir:"in",offset:0},synPoints:[]
};
let flightLab=null;

const brain=$("brainCanvas"),bc=brain.getContext("2d"),arena=$("arenaCanvas"),ac=arena.getContext("2d"),
 chart=$("chart"),cc=chart.getContext("2d"),syn=$("synCanvas"),sc=syn.getContext("2d"),swcMini=$("swcMini"),smc=swcMini.getContext("2d");
const atlas=new SWCAtlasRenderer($("atlasCanvas"));atlas.camera=S.cam;
let DPR=Math.min(2,devicePixelRatio||1);
function resizeOne(c,ctx){const r=c.getBoundingClientRect(),w=Math.max(1,Math.floor(r.width*DPR)),h=Math.max(1,Math.floor(r.height*DPR));if(c.width!==w||c.height!==h){c.width=w;c.height=h}ctx.setTransform(DPR,0,0,DPR,0,0)}
function resize(){resizeOne(brain,bc);resizeOne(arena,ac);resizeOne(chart,cc);resizeOne(syn,sc);resizeOne(swcMini,smc)}
addEventListener("resize",resize);setTimeout(resize,50);

function leftPane(id){$$("[data-left]").forEach(b=>b.classList.toggle("on",b.dataset.left===id));$$(".left .pane").forEach(p=>p.classList.toggle("on",p.id===id))}
function rightPane(id){$$("[data-right]").forEach(b=>b.classList.toggle("on",b.dataset.right===id));$$(".right .pane").forEach(p=>p.classList.toggle("on",p.id===id))}
$$("[data-left]").forEach(b=>b.onclick=()=>leftPane(b.dataset.left));$$("[data-right]").forEach(b=>b.onclick=()=>rightPane(b.dataset.right));
function setMode(m){S.mode=m;$$("[data-mode]").forEach(b=>b.classList.toggle("on",b.dataset.mode===m));$("stage").classList.toggle("arenaOn",m==="sim"||m==="learn");if(m==="swc"&&S.selectedNode)loadSWC(S.selectedNode);requestAnimationFrame(resize)}
$$("[data-mode]").forEach(b=>b.onclick=()=>setMode(b.dataset.mode));

/* ------------------------- WebGL full-brain atlas ------------------------- */
async function atlasStatus(){
 try{S.atlasStatus=await api("/api/atlas/status");if(S.atlasStatus.bbox)atlas.setBBox(S.atlasStatus.bbox);
   const eta=S.atlasStatus.eta_seconds==null?"":` · ETA ${Math.floor(S.atlasStatus.eta_seconds/60)}m`;
   $("atlasState").textContent=S.atlasStatus.complete?`${fmt(S.atlasStatus.neurons)} ${T("app.atlas_ready_suffix")}`:(S.atlasStatus.building?`${S.atlasStatus.percent.toFixed(1)}% · ${Number(S.atlasStatus.rate||0).toFixed(1)}/s${eta}`:T("app.atlas_not_built"));
   $("atlasChip").textContent=S.atlasStatus.complete?`Atlas ${fmt(S.atlasStatus.neurons)}`:"Atlas pending";
   $("atlasProgress").value=S.atlasStatus.percent||0;
   $("atlasBuildBtn").disabled=!!S.atlasStatus.building;
   if(S.atlasStatus.building)setTimeout(atlasStatus,1000);
 }catch(e){$("atlasState").textContent="Atlas API error"}
}
$("atlasBuildBtn").onclick=async()=>{const max=+$("atlasLod").value;if(!confirm(`ساخت Atlas از تمام SWCها با حداکثر ${max} segment برای هر نورون شروع شود؟ این مرحله یک‌بار زمان‌بر است.`))return;await api("/api/atlas/build",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({max_segments:max,workers:+$("atlasWorkers").value||4,force:false})});toast("ساخت Atlas در پس‌زمینه شروع شد");atlasStatus()};
$("atlasLoadBtn").onclick=()=>{const v=$("atlasLoadCount").value;streamAtlas(v==="all"?Infinity:+v)};
$("atlasClearBtn").onclick=()=>{atlas.clear();S.atlasLoaded=0;S.activeAtlasRequested.clear();$("atlasLoaded").textContent="0";if(S.atlasStatus?.bbox)atlas.setBBox(S.atlasStatus.bbox)};
async function streamAtlas(target){
 if(!S.atlasStatus?.exists)return toast("هنوز هیچ SWC در Atlas cache نشده");if(S.atlasStreaming)return;
 S.atlasStreaming=true;S.atlasTarget=target;const batch=200,available=S.atlasStatus.neurons;
 try{while(S.atlasLoaded<(target===Infinity?available:Math.min(target,available))&&S.atlasLoaded<available){
   const d=await api(`/api/atlas/batch?offset=${S.atlasLoaded}&limit=${batch}`);if(!d.records)break;atlas.addBatch(d.vertices);S.atlasLoaded+=d.records;$("atlasLoaded").textContent=fmt(S.atlasLoaded);await new Promise(r=>setTimeout(r,8));
 }}catch(e){toast(e.message)}finally{S.atlasStreaming=false}
}
async function ensureActiveAtlas(){
 if(!S.atlasStatus?.exists||!S.graph)return;const ids=[];
 const arr=S.sim?.topActiveIds?.(60)||[];for(const id of arr)ids.push(id);
 if(S.selectedNode)ids.push(S.selectedNode);for(const id of S.pathNodes)ids.push(id);
 const missing=[...new Set(ids)].filter(id=>!atlas.active.has(id)&&!S.activeAtlasRequested.has(id)).slice(0,100);
 if(!missing.length)return;missing.forEach(x=>S.activeAtlasRequested.add(x));
 try{const d=await api("/api/atlas/selection",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ids:missing,limit:100})});for(const r of d.records||[])atlas.addActive(r.id,r.vertices)}
 catch{}finally{missing.forEach(x=>S.activeAtlasRequested.delete(x))}
}

/* ------------------------- graph loading / projection -------------------- */
function nodeLabel(id){return S.nodes.find(n=>n.id===id)?.label||id}
function edgeKey(a,b){return a+"→"+b}
async function loadGraph(){
 if(!S.center)return;const q=new URLSearchParams({source:$("source").value,topk:$("topk").value,depth:$("depth").value,min_syn:$("minSyn").value,max_nodes:$("maxNodes").value});toast("در حال ساخت زیرگراف…");
 try{S.graph=await api(`/api/graph/${encodeURIComponent(S.center)}?${q}`);S.nodes=S.graph.nodes||[];S.edges=S.graph.edges||[];buildPositions();S.pathNodes.clear();S.pathEdges.clear();compileSimulation();autoMap(false);selectNode(S.center,true);$("graphChip").textContent=`${fmt(S.nodes.length)}N / ${fmt(S.edges.length)}E`;toast(T("app.subgraph_ready"))}catch(e){toast(e.message)}
}
function buildPositions(){
 S.pos.clear();const valid=S.nodes.filter(n=>n.coord&&!n.coord.fallback&&Number.isFinite(+n.coord.x));const src=valid.length?valid:S.nodes;let cx=0,cy=0,cz=0;
 for(const n of src){cx+=+n.coord.x;cy+=+n.coord.y;cz+=+n.coord.z}cx/=src.length||1;cy/=src.length||1;cz/=src.length||1;let md=1;
 for(const n of src)md=Math.max(md,Math.hypot(+n.coord.x-cx,+n.coord.y-cy,+n.coord.z-cz));for(const n of S.nodes){let p=n.coord||{};let x=(+p.x-cx)/md,y=(+p.y-cy)/md,z=(+p.z-cz)/md;if(p.fallback&&valid.length){x*=1.5;y*=1.5;z*=1.5}S.pos.set(n.id,{x,y,z,raw:!p.fallback,rx:+p.x,ry:+p.y,rz:+p.z})}
}
function projectNorm(p,w,h){let x=p.x,y=p.y,z=p.z,cy=Math.cos(S.cam.ry),sy=Math.sin(S.cam.ry),cx=Math.cos(S.cam.rx),sx=Math.sin(S.cam.rx);let x1=x*cy+z*sy,z1=-x*sy+z*cy,y2=y*cx-z1*sx,z2=y*sx+z1*cx;const scale=Math.min(w,h)*.39*S.cam.zoom;return{x:w/2+x1*scale+S.cam.panX,y:h/2+y2*scale+S.cam.panY,z:z2}}
function projectRaw(x,y,z,w,h){
 const b=S.atlasStatus?.bbox;if(!b)return null;
 const cx0=(b[0]+b[3])/2,cy0=(b[1]+b[4])/2,cz0=(b[2]+b[5])/2,scale=Math.max(1,b[3]-b[0],b[4]-b[1],b[5]-b[2])/2;
 let qx=(x-cx0)/scale,qy=(y-cy0)/scale,qz=(z-cz0)/scale;
 const C=atlas.camera,cy=Math.cos(C.ry),sy=Math.sin(C.ry),cx=Math.cos(C.rx),sx=Math.sin(C.rx);
 const ax=qx*cy+qz*sy,az=-qx*sy+qz*cy,by=qy*cx-az*sx,bz=qy*sx+az*cx;
 const aspect=w/Math.max(1,h),ndcX=ax*C.zoom/aspect+C.panX,ndcY=by*C.zoom+C.panY;
 return{x:(ndcX+1)*.5*w,y:(1-ndcY)*.5*h,z:bz}
}
function edgeColor(e){const k=edgeKey(e.source,e.target),a=S.sim?.edgeFlowByKey?.get(k)||0,p=S.sim?.plasticByKey?.get(k)||1;if(S.pathEdges.has(k))return"#a856f6";if(p>1.08)return"#b86af9";if(a>.035)return"#ff56ec";return e.target===S.center?"#84ff6f":"#6affc3"}
function drawGraph(){
 const w=brain.clientWidth,h=brain.clientHeight;bc.clearRect(0,0,w,h);S.projNodes=[];S.projEdges=[];if(!S.graph)return;
 const P=new Map();for(const n of S.nodes){const q=S.pos.get(n.id);let p=null;if(q?.raw&&S.atlasStatus?.bbox)p=projectRaw(q.rx,q.ry,q.rz,w,h);if(!p)p=projectNorm(q,w,h);P.set(n.id,p)}
 const maxW=Math.max(1,...S.edges.map(e=>Math.log1p(e.weight)));for(const e of S.edges){const a=P.get(e.source),b=P.get(e.target);if(!a||!b)continue;const k=edgeKey(e.source,e.target),flow=S.sim?.edgeFlowByKey?.get(k)||0;bc.globalAlpha=S.mode==="swc"?.12:(flow>.02?.72:.28);bc.strokeStyle=edgeColor(e);bc.lineWidth=.45+Math.log1p(e.weight)/maxW*2.3+(flow>.02?1.2:0);bc.beginPath();bc.moveTo(a.x,a.y);bc.lineTo(b.x,b.y);bc.stroke();bc.globalAlpha=1;if(flow>.02){const phase=((S.simTime||0)*1.7+hash01(k))%1,px=a.x+(b.x-a.x)*phase,py=a.y+(b.y-a.y)*phase;bc.shadowColor="#ff8ff9";bc.shadowBlur=10;bc.fillStyle="#feeaff";bc.beginPath();bc.arc(px,py,2.1+Math.min(2,flow*4),0,Math.PI*2);bc.fill();bc.shadowBlur=0}S.projEdges.push({e,a,b})}
 const sorted=[...S.nodes].sort((a,b)=>(P.get(a.id)?.z||0)-(P.get(b.id)?.z||0));for(const n of sorted){const p=P.get(n.id),a=S.sim?.activityFor?.(n.id)||0;let col=n.id===S.center?"#ff56ec":"#ff9782";if(S.pathNodes.has(n.id))col="#a856f6";if(a>.03)col=`rgb(${Math.round(86+169*a)},${Math.round(230-105*a)},${Math.round(255-165*a)})`;if(n.id===S.selectedNode)col="#ffffff";const r=(3.4+Math.min(5,Math.log1p(a*20+1)))*(n.id===S.center?1.35:1);bc.fillStyle="#220617";bc.strokeStyle=col;bc.lineWidth=n.id===S.selectedNode?2:1;bc.beginPath();bc.arc(p.x,p.y,r,0,Math.PI*2);bc.fill();bc.stroke();if(n.id===S.selectedNode||n.id===S.center){bc.fillStyle="#f4d3eb";bc.font="8px Vazirmatn,Tahoma";bc.textAlign="center";bc.fillText((n.label||n.id).slice(0,24),p.x,p.y+r+10)}S.projNodes.push({id:n.id,x:p.x,y:p.y,r:r+4})}
 if(S.detailedSWC&&(S.mode==="swc"||S.mode==="connectome"))drawDetailedSWC(w,h)
}
function drawDetailedSWC(w,h){const seg=S.detailedSWC?.segments;if(!seg?.length)return;const act=S.sim?.activityFor?.(S.detailedSWC.root_id)||0;bc.globalAlpha=.45+.5*act;bc.strokeStyle=act>.03?`rgb(${Math.round(90+165*act)},${Math.round(220-90*act)},${Math.round(255-130*act)})`:"#ffa48c";bc.shadowColor=act>.03?"#ff56ec":"transparent";bc.shadowBlur=act>.03?10:0;bc.lineWidth=.8+act*1.6;const step=Math.max(1,Math.ceil(seg.length/120000));for(let i=0;i<seg.length;i+=step){const s=seg[i],a=projectRaw(s[0],s[1],s[2],w,h),b=projectRaw(s[3],s[4],s[5],w,h);if(!a||!b)continue;bc.beginPath();bc.moveTo(a.x,a.y);bc.lineTo(b.x,b.y);bc.stroke()}bc.globalAlpha=1;bc.shadowBlur=0}
function distSeg(px,py,x1,y1,x2,y2){const dx=x2-x1,dy=y2-y1,l=dx*dx+dy*dy;if(!l)return Math.hypot(px-x1,py-y1);let t=((px-x1)*dx+(py-y1)*dy)/l;t=clamp(t,0,1);return Math.hypot(px-(x1+t*dx),py-(y1+t*dy))}
brain.onmousedown=e=>{S.drag=true;S.moved=false;S.lastX=e.clientX;S.lastY=e.clientY};addEventListener("mouseup",()=>S.drag=false);addEventListener("mousemove",e=>{if(!S.drag)return;const dx=e.clientX-S.lastX,dy=e.clientY-S.lastY;S.lastX=e.clientX;S.lastY=e.clientY;if(Math.abs(dx)+Math.abs(dy)>2)S.moved=true;if(e.shiftKey){S.cam.panX+=dx;S.cam.panY+=dy;atlas.camera.panX+=dx/(brain.clientWidth/2);atlas.camera.panY-=dy/(brain.clientHeight/2)}else{S.cam.ry+=dx*.007;S.cam.rx+=dy*.007;atlas.camera.ry=S.cam.ry;atlas.camera.rx=S.cam.rx}});
brain.onwheel=e=>{e.preventDefault();S.cam.zoom=clamp(S.cam.zoom*Math.exp(-e.deltaY*.001),.2,8);atlas.camera.zoom=S.cam.zoom};
brain.onclick=e=>{if(S.moved)return;const r=brain.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;let hit=null,bd=1e9;for(const n of S.projNodes){const d=Math.hypot(x-n.x,y-n.y);if(d<n.r&&d<bd){hit=n;bd=d}}if(hit){selectNode(hit.id,true);return}let eh=null,ed=7;for(const z of S.projEdges){const d=distSeg(x,y,z.a.x,z.a.y,z.b.x,z.b.y);if(d<ed){ed=d;eh=z.e}}if(eh)selectEdge(eh)};
brain.ondblclick=()=>S.selectedNode&&loadSWC(S.selectedNode);
$("fitBtn").onclick=()=>{S.cam={rx:-.25,ry:.45,zoom:1.25,panX:0,panY:0};atlas.camera=S.cam;atlas.fit()};

/* ------------------------- search / inspector ---------------------------- */
async function search(){const q=$("searchInput").value.trim();$("searchResults").innerHTML='<div class="empty">در حال جستجو…</div>';try{const d=await api("/api/search?q="+encodeURIComponent(q)+"&limit=100");$("searchResults").innerHTML=d.results.length?d.results.map(r=>`<div class="result" data-n="${esc(r.root_id)}"><div class="rid">${esc(r.root_id)}</div><div class="rlabel">${esc(r.label||"بدون Label")}</div><div class="rmeta">${esc(r.source||"")}</div></div>`).join(""):'<div class="empty">نتیجه‌ای پیدا نشد.</div>';$$("[data-n]").forEach(x=>x.onclick=()=>loadNeuron(x.dataset.n))}catch(e){$("searchResults").innerHTML='<div class="empty bad">'+esc(e.message)+"</div>"}}
$("searchBtn").onclick=search;$("searchInput").onkeydown=e=>{if(e.key==="Enter")search()};
async function loadNeuron(id){S.center=id;S.selectedNode=id;$("pathFrom").value=id;await loadGraph()}
async function selectNode(id,fetchInfo=true){S.selectedNode=id;S.selectedEdge=null;rightPane("neuronPane");renderDock();if(!fetchInfo)return;try{const n=await api(`/api/neuron-full/${encodeURIComponent(id)}?source=${encodeURIComponent($("source").value)}`);S.nodeInfo=n;$("nId").textContent=id;$("nLabel").textContent=n.labels?.[0]?.label||"—";$("nProcessed").textContent=(n.processed_labels||[]).slice(0,4).join(" | ")||"—";$("nCoord").textContent=n.coord?`${Number(n.coord.x).toFixed(1)}, ${Number(n.coord.y).toFixed(1)}, ${Number(n.coord.z).toFixed(1)}`:"—";$("nTags").innerHTML=(n.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join("");const s=n.connection_stats||{};$("inP").textContent=fmt(s.input_partners);$("inS").textContent=fmt(s.input_synapses);$("outP").textContent=fmt(s.output_partners);$("outS").textContent=fmt(s.output_synapses);const ex=n.explanation_fa||{};$("explainRole").textContent=ex.role_name||"—";$("explainText").textContent=ex.summary_fa||"—";$("explainEvidence").innerHTML=(ex.evidence||[]).map(x=>`<div>• ${esc(x)}</div>`).join("");$("explainCaveat").textContent=ex.caveat||"";renderNeuropils(n.neuropils);$("swcAvailable").textContent=n.has_swc?"موجود":"—"}catch(e){toast(e.message)}}
function renderNeuropils(n){if(!n?.found){$("neuropils").innerHTML='<div class="empty">اطلاعاتی نیست.</div>';return}$("neuropils").innerHTML=`<div class="detail"><b>ورودی:</b><br>${(n.inputs||[]).slice(0,8).map(x=>`${esc(x.neuropil)}: ${fmt(x.value)}`).join("<br>")}<div class="sep"></div><b>خروجی:</b><br>${(n.outputs||[]).slice(0,8).map(x=>`${esc(x.neuropil)}: ${fmt(x.value)}`).join("<br>")}</div>`}
function renderDock(){if(!S.graph||!S.selectedNode)return;const ins=S.edges.filter(e=>e.target===S.selectedNode).sort((a,b)=>b.weight-a.weight).slice(0,60),outs=S.edges.filter(e=>e.source===S.selectedNode).sort((a,b)=>b.weight-a.weight).slice(0,60);const f=(a,incoming)=>a.length?a.map(e=>`<div class="edge" data-e="${esc(e.source+"|"+e.target)}"><span class="id">${esc(incoming?nodeLabel(e.source):nodeLabel(e.target))}</span><span class="n">${fmt(e.weight)}</span></div>`).join(""):'<div class="empty">—</div>';$("inDock").innerHTML=f(ins,true);$("outDock").innerHTML=f(outs,false);$$("[data-e]").forEach(x=>x.onclick=()=>{const[a,b]=x.dataset.e.split("|");const e=S.edges.find(e=>e.source===a&&e.target===b);if(e)selectEdge(e)})}
async function connPage(dir,offset=0){if(!S.selectedNode)return;try{const d=await api(`/api/connections/${encodeURIComponent(S.selectedNode)}?source=${encodeURIComponent($("source").value)}&direction=${dir}&limit=150&offset=${offset}`);$("connectionList").innerHTML=`<div class="grid2"><button class="btn" id="prevConn">قبلی</button><button class="btn" id="nextConn">بعدی</button></div><div class="detail">${fmt(offset+1)}–${fmt(Math.min(offset+150,d.total))} / ${fmt(d.total)}</div>`+d.items.map(x=>`<div class="result" data-open="${esc(x.partner_id)}"><div class="rid">${esc(x.partner_id)}</div><div class="rlabel">${esc(x.label||"")}</div><div class="rmeta">${fmt(x.syn_count)} syn · ${esc(x.nt_type||"")}</div></div>`).join("");$("prevConn").onclick=()=>connPage(dir,Math.max(0,offset-150));$("nextConn").onclick=()=>offset+150<d.total&&connPage(dir,offset+150);$$("[data-open]").forEach(x=>x.onclick=()=>loadNeuron(x.dataset.open))}catch(e){toast(e.message)}}
$("allInBtn").onclick=()=>connPage("in",0);$("allOutBtn").onclick=()=>connPage("out",0);
async function loadSWC(id){toast("خواندن SWC کامل…");try{const s=await api(`/api/skeleton/${encodeURIComponent(id)}?max_segments=160000`);if(!s.found)return toast("SWC پیدا نشد");S.detailedSWC=s;drawMiniSWC(s);toast(`${fmt(s.segment_count)} segment`)}catch(e){toast(e.message)}}
$("loadSwcBtn").onclick=()=>S.selectedNode&&loadSWC(S.selectedNode);
function drawMiniSWC(s){const w=swcMini.clientWidth,h=swcMini.clientHeight;smc.clearRect(0,0,w,h);const a=s.segments||[];if(!a.length)return;let mnx=Infinity,mxx=-Infinity,mny=Infinity,mxy=-Infinity;for(const q of a){for(const k of[0,3]){mnx=Math.min(mnx,q[k]);mxx=Math.max(mxx,q[k]);mny=Math.min(mny,q[k+1]);mxy=Math.max(mxy,q[k+1])}}smc.strokeStyle="#ff978288";smc.lineWidth=.6;const step=Math.max(1,Math.ceil(a.length/50000));for(let i=0;i<a.length;i+=step){const q=a[i],x1=5+(q[0]-mnx)/(mxx-mnx||1)*(w-10),y1=5+(q[1]-mny)/(mxy-mny||1)*(h-10),x2=5+(q[3]-mnx)/(mxx-mnx||1)*(w-10),y2=5+(q[4]-mny)/(mxy-mny||1)*(h-10);smc.beginPath();smc.moveTo(x1,y1);smc.lineTo(x2,y2);smc.stroke()}}

/* ------------------------- edge inspector / raw synapses ---------------- */
async function selectEdge(e){S.selectedEdge=e;rightPane("edgePane");try{const d=await api(`/api/edge-detail?pre=${encodeURIComponent(e.source)}&post=${encodeURIComponent(e.target)}&source=${encodeURIComponent($("source").value)}`);$("ePre").textContent=d.source_id;$("ePost").textContent=d.target_id;$("eWeight").textContent=fmt(d.syn_count);$("eNt").textContent=d.nt_type||"—";$("eRecip").textContent=d.reciprocal?`بله · ${fmt(d.reverse_syn_count)}`:"خیر";$("ePlastic").textContent=(S.sim?.plasticForEdge?.(e)||1).toFixed(3);$("preBtn").onclick=()=>loadNeuron(d.source_id);$("postBtn").onclick=()=>loadNeuron(d.target_id)}catch(err){toast(err.message)}}
$("synBtn").onclick=async()=>{if(!S.selectedEdge)return;const e=S.selectedEdge;try{const d=await api(`/api/synapses?pre=${encodeURIComponent(e.source)}&post=${encodeURIComponent(e.target)}&limit=8000`);S.synPoints=d.points||[];drawSyn();$("synMeta").textContent=`${fmt(S.synPoints.length)} ${T("app.syn_points_suffix")}`}catch(err){toast(err.message)}};
function drawSyn(){const w=syn.clientWidth,h=syn.clientHeight;sc.clearRect(0,0,w,h);if(!S.synPoints.length)return;let mnx=Infinity,mxx=-Infinity,mny=Infinity,mxy=-Infinity;for(const p of S.synPoints){mnx=Math.min(mnx,p.x);mxx=Math.max(mxx,p.x);mny=Math.min(mny,p.y);mxy=Math.max(mxy,p.y)}for(const p of S.synPoints){const x=5+(p.x-mnx)/(mxx-mnx||1)*(w-10),y=5+(p.y-mny)/(mxy-mny||1)*(h-10);sc.fillStyle="#ff56ecaa";sc.beginPath();sc.arc(x,y,1.2,0,Math.PI*2);sc.fill()}}

/* ------------------------- path search ---------------------------------- */
$("findPathBtn").onclick=async()=>{const a=$("pathFrom").value.trim(),b=$("pathTo").value.trim();if(!a||!b)return toast("From/To را وارد کن");try{const q=new URLSearchParams({from:a,to:b,source:$("source").value,max_depth:$("pathDepth").value,branch:$("pathBranch").value,min_syn:$("pathMin").value});const d=await api("/api/path?"+q);S.pathNodes.clear();S.pathEdges.clear();if(!d.found){$("pathResults").innerHTML='<div class="empty">مسیر پیدا نشد.</div>';return}for(const n of d.nodes)S.pathNodes.add(n.id);for(const e of d.edges)S.pathEdges.add(edgeKey(e.source,e.target));$("pathResults").innerHTML=d.nodes.map((n,i)=>`<div class="result"><div class="rid">${i+1}. ${esc(n.id)}</div><div class="rlabel">${esc(n.label||"")}</div>${d.edges[i]?`<div class="rmeta">↓ ${fmt(d.edges[i].weight)} syn · ${esc(d.edges[i].nt_type||"")}</div>`:""}</div>`).join("");ensureActiveAtlas()}catch(e){toast(e.message)}};

/* ------------------------- channel mapping ------------------------------- */
function renderChannels(){$("channels").innerHTML=Object.entries(CHANNELS).map(([k,n])=>`<div class="channel"><div class="channelHead"><b>${n}</b><button class="btn" data-clr="${k}" style="padding:2px 5px">×</button></div><div class="channelIds">${[...S.mapping[k]].map(esc).join("<br>")||"—"}</div></div>`).join("");$$("[data-clr]").forEach(b=>b.onclick=()=>{S.mapping[b.dataset.clr].clear();renderChannels();compileMapping()});$("mapSelect").innerHTML=Object.entries(CHANNELS).map(([k,n])=>`<option value="${k}">${n}</option>`).join("")}
$("mapAddBtn").onclick=()=>{if(!S.selectedNode)return toast("نورون انتخاب نشده");S.mapping[$("mapSelect").value].add(S.selectedNode);renderChannels();compileMapping()};
$("clearMapBtn").onclick=()=>{for(const s of Object.values(S.mapping))s.clear();renderChannels();compileMapping()};
function autoMap(show=true){
  if(!S.nodes.length)return;
  const label=n=>(n.label||"").toLowerCase();
  const find=rx=>S.nodes.filter(n=>rx.test(label(n)));
  const inW=new Map(S.nodes.map(n=>[n.id,0])),outW=new Map(S.nodes.map(n=>[n.id,0]));
  for(const e of S.edges){
    outW.set(e.source,(outW.get(e.source)||0)+e.weight);
    inW.set(e.target,(inW.get(e.target)||0)+e.weight);
  }
  const sources=[...S.nodes].sort((a,b)=>{
    const A=(outW.get(a.id)||0)/(1+(inW.get(a.id)||0));
    const B=(outW.get(b.id)||0)/(1+(inW.get(b.id)||0));
    return B-A;
  });
  const sinks=[...S.nodes].sort((a,b)=>{
    const A=(inW.get(a.id)||0)/(1+(outW.get(a.id)||0));
    const B=(inW.get(b.id)||0)/(1+(outW.get(b.id)||0));
    return B-A;
  });
  const pick=(arr,fallback,i)=>arr[i]?.id||fallback[i%Math.max(1,fallback.length)]?.id;
  const sets={
    visual_left:[find(/visual|optic|photoreceptor|lamina|medulla|lobula/),sources,0],
    visual_right:[find(/visual|optic|photoreceptor|lamina|medulla|lobula/),sources,1],
    odor_a:[find(/olfactory|orn|antennal/),sources,2],
    odor_b:[find(/olfactory|orn|antennal/),sources,3],
    wind:[find(/wind|airflow|mechan|johnston|chordotonal|bristle/),sources,4],
    heat:[find(/thermo|temperature|heat|hot|cold/),sources,5],
    touch:[find(/mechan|touch|bristle|chord/),sources,6],
    reward:[find(/dopamin|pam|ppl|dan|reward/),sources,7],
    punishment:[find(/dopamin|ppl|dan|punish/),sources,8],
    motor_forward:[find(/motor|descending|steering|wing|leg/),sinks,0],
    motor_left:[find(/motor|descending|steering|wing|leg/),sinks,1],
    motor_right:[find(/motor|descending|steering|wing|leg/),sinks,2],
    motor_stop:[find(/motor|descending/),sinks,3]
  };
  for(const [k,[a,f,i]] of Object.entries(sets)){
    if(!S.mapping[k].size){
      const id=pick(a,f,i);
      if(id)S.mapping[k].add(id);
    }
  }
  renderChannels();compileMapping();if(show)toast("Auto-map heuristic انجام شد");
}
$("autoMapBtn").onclick=()=>autoMap(true);renderChannels();

/* ------------------------- simulation engine ----------------------------- */
class SimEngine{
 constructor(){this.ready=false;this.ids=[];this.index=new Map();this.edges=[];this.activity=new Float32Array(0);this.voltage=new Float32Array(0);this.ref=new Float32Array(0);this.incoming=new Float32Array(0);this.external=new Float32Array(0);this.history=[];this.edgeFlowByKey=new Map();this.plasticByKey=new Map();this.topFlows=[];this.mapIdx={};this.rng=123456789}
 rand(){this.rng^=this.rng<<13;this.rng^=this.rng>>>17;this.rng^=this.rng<<5;return((this.rng>>>0)/4294967296)}
 compile(nodes,edges){this.ids=nodes.map(n=>n.id);this.index=new Map(this.ids.map((id,i)=>[id,i]));const max=Math.max(1,...edges.map(e=>Math.log1p(e.weight)));this.edges=[];for(const e of edges){const s=this.index.get(e.source),t=this.index.get(e.target);if(s==null||t==null)continue;let sign=1,nt=String(e.nt_type||"").toUpperCase();if(nt.includes("GABA"))sign=-1;else if(nt.includes("GLUT"))sign=-.45;this.edges.push({s,t,w:Math.log1p(e.weight)/max,raw:e.weight,nt:e.nt_type,sign,key:edgeKey(e.source,e.target),p:1,elig:0})}const N=this.ids.length;this.activity=new Float32Array(N);this.voltage=new Float32Array(N);this.ref=new Float32Array(N);this.incoming=new Float32Array(N);this.external=new Float32Array(N);this.history=[];this.ready=true;this.compileMapping()}
 compileMapping(){this.mapIdx={};for(const[k,set]of Object.entries(S.mapping))this.mapIdx[k]=[...set].map(id=>this.index.get(id)).filter(i=>i!=null)}
 inject(ch,v){const a=this.mapIdx[ch]||[];if(!a.length)return;v/=a.length;for(const i of a)this.external[i]+=v}
 avg(ch){const a=this.mapIdx[ch]||[];if(!a.length)return 0;let s=0;for(const i of a)s+=this.activity[i];return s/a.length}
 activityFor(id){const i=this.index.get(id);return i==null?0:this.activity[i]}
 plasticForEdge(e){const q=this.edges.find(x=>x.key===edgeKey(e.source,e.target));return q?.p||1}
 topActiveIds(n=50){const a=[];for(let i=0;i<this.ids.length;i++)if(this.activity[i]>.03)a.push([this.ids[i],this.activity[i]]);a.sort((x,y)=>y[1]-x[1]);return a.slice(0,n).map(x=>x[0])}
 step(dt,reward,learning){
   if(!this.ready)return;const gain=+$("gain").value,leak=+$("leak").value,thr=+$("thr").value,noise=+$("noise").value,mode=$("simModel").value,lr=+$("learnRate").value,decay=+$("learnDecay").value;
   this.incoming.fill(0);for(let i=0;i<this.external.length;i++){this.incoming[i]+=this.external[i];this.external[i]=0}
   const flows=[];this.edgeFlowByKey.clear();
   for(const e of this.edges){const flow=this.activity[e.s]*e.w*e.p;this.incoming[e.t]+=gain*e.sign*flow;if(flow>.012)flows.push([e,flow]);if(learning){e.elig=e.elig*Math.exp(-dt/.7)+this.activity[e.s]*this.activity[e.t]*dt;e.p=clamp(e.p+lr*reward*e.elig-decay*(e.p-1)*dt,.15,3)}this.plasticByKey.set(e.key,e.p)}
   for(let i=0;i<this.activity.length;i++){const r=(this.rand()*2-1)*noise;if(mode==="rate"){const t=1/(1+Math.exp(-(this.incoming[i]+r-1.0)*2.4));this.activity[i]=clamp(this.activity[i]+dt*(t-this.activity[i])*leak,0,1);this.voltage[i]=this.activity[i]}else{this.ref[i]=Math.max(0,this.ref[i]-dt);let v=this.voltage[i],sp=0;if(this.ref[i]<=0){v+=dt*(-leak*v+this.incoming[i]*2.2+r);if(v>=thr){sp=1;v=0;this.ref[i]=.05}}this.activity[i]=Math.max(sp,this.activity[i]*Math.exp(-dt/.11));this.voltage[i]=v}}if(S.taskState.lesionIdx){for(const i of S.taskState.lesionIdx){this.activity[i]=0;this.voltage[i]=0}}
   flows.sort((a,b)=>b[1]-a[1]);this.topFlows=flows.slice(0,25).map(([e,f])=>({key:e.key,source:this.ids[e.s],target:this.ids[e.t],flow:f,plastic:e.p}));for(const x of this.topFlows)this.edgeFlowByKey.set(x.key,x.flow);
   const sel=S.selectedNode||S.center;this.history.push(this.activityFor(sel));if(this.history.length>420)this.history.shift()
 }
}
S.sim=new SimEngine();
function compileSimulation(){S.sim.compile(S.nodes,S.edges);compileMapping();S.learning={on:false,episode:0,totalReward:0,lastReward:0,manualReward:0};$("episode").textContent="0";$("rewardSum").textContent="0.00";$("plasticCount").textContent="0"}
function compileMapping(){if(S.sim?.ready)S.sim.compileMapping()}

/* ------------------------- arena + sensors + tasks ----------------------- */
function resetFly(random=true){S.fly.x=random?.15+Math.random()*.7:.5;S.fly.y=random?.15+Math.random()*.7:.55;S.fly.a=Math.random()*Math.PI*2;S.fly.collision=false;S.fly.trail=[]}
function sensorStep(){
 const f=S.fly,l=S.arena.light,oa=S.arena.odorA,ob=S.arena.odorB;const dl=Math.hypot(l.x-f.x,l.y-f.y),ang=Math.atan2(l.y-f.y,l.x-f.x),rel=Math.atan2(Math.sin(ang-f.a),Math.cos(ang-f.a)),v=1/(1+dl*3);
 const sensoryBoost=2.6;S.sim.inject("visual_left",sensoryBoost*v*clamp(.65-rel/Math.PI,0,1));S.sim.inject("visual_right",sensoryBoost*v*clamp(.65+rel/Math.PI,0,1));S.sim.inject("odor_a",sensoryBoost*Math.exp(-Math.hypot(oa.x-f.x,oa.y-f.y)*3));S.sim.inject("odor_b",sensoryBoost*Math.exp(-Math.hypot(ob.x-f.x,ob.y-f.y)*3));if(S.arena.touchPulse>0)S.sim.inject("touch",2.2);if(S.learning.manualReward>0)S.sim.inject("reward",S.learning.manualReward);if(S.learning.manualReward<0)S.sim.inject("punishment",-S.learning.manualReward)
}
function angleError(target){const a=Math.atan2(target.y-S.fly.y,target.x-S.fly.x);return Math.atan2(Math.sin(a-S.fly.a),Math.cos(a-S.fly.a))}
function teacherCommand(task){
 let target=S.arena.light,forward=.62,left=0,right=0,stop=0;
 const kind=task?.kind||"light_seek",t=S.simTime||0;
 if(["odor_seek","cue_punish","odor_discrimination","landmark"].includes(kind))target=S.arena.odorA;
 if(kind==="reversal"&&t>(task?.duration||30)/2)target=S.arena.odorB;
 if(kind==="context_switch"&&Math.floor(t/6)%2)target=S.arena.odorA;
 if(kind==="mission"&&Math.floor(t/10)%3===2)target=S.arena.odorA;
 if(kind==="competing_rewards")target=S.arena.odorA;
 let err=angleError(target),turn=clamp(err/1.15,-1,1);forward=clamp(Math.cos(err),.15,1)*.78;left=clamp(-turn,0,1);right=clamp(turn,0,1);
 if(kind==="go_nogo"&&Math.floor(t/3)%2===1){forward=0;left=0;right=0;stop=1}
 if(kind==="avoid_collision"||kind==="detour"||kind==="mission"){for(const o of S.arena.obstacles){const d=Math.hypot(S.fly.x-o.x,S.fly.y-o.y);if(d<o.r+.13){const away=Math.atan2(S.fly.y-o.y,S.fly.x-o.x),ae=Math.atan2(Math.sin(away-S.fly.a),Math.cos(away-S.fly.a));left=clamp(-ae,0,1);right=clamp(ae,0,1);forward=.35}}}
 return{forward,left,right,stop}
}
function currentAssist(){const base=+$('assist').value||0;const decay=S.learning.on?Math.max(.22,1-(S.learning.episode-1)*.08):1;return clamp(base*decay,0,1)}
function injectTeacher(){if(!S.task)return;const a=currentAssist(),c=teacherCommand(S.task);if(a<=0)return;S.sim.inject("motor_forward",c.forward*a*2.4);S.sim.inject("motor_left",c.left*a*2.4);S.sim.inject("motor_right",c.right*a*2.4);S.sim.inject("motor_stop",c.stop*a*2.4)}
function flyStep(dt){
 const nf=S.sim.avg("motor_forward"),nL=S.sim.avg("motor_left"),nR=S.sim.avg("motor_right"),nStop=S.sim.avg("motor_stop"),assist=currentAssist(),tc=S.task?teacherCommand(S.task):{forward:0,left:0,right:0,stop:0};
 const f=clamp((1-assist)*nf+assist*tc.forward,0,1),L=clamp((1-assist)*nL+assist*tc.left,0,1),R=clamp((1-assist)*nR+assist*tc.right,0,1),stop=clamp((1-assist)*nStop+assist*tc.stop,0,1);
 S.fly.turn=(R-L)*3.4;let motorScale=1;if(S.task?.kind==="motor_calibration"&&(S.simTime||0)>S.task.duration*.5)motorScale=.55;S.fly.speed=f*.30*(1-stop*.88)*motorScale;S.fly.a+=S.fly.turn*dt;
 let nx=S.fly.x+Math.cos(S.fly.a)*S.fly.speed*dt,ny=S.fly.y+Math.sin(S.fly.a)*S.fly.speed*dt;S.fly.collision=false;
 for(const o of S.arena.obstacles){if(Math.hypot(nx-o.x,ny-o.y)<o.r+.026){S.fly.collision=true;S.arena.touchPulse=.18;nx=S.fly.x;ny=S.fly.y;S.fly.a+=1.7*dt}}
 S.fly.x=clamp(nx,.03,.97);S.fly.y=clamp(ny,.03,.97);S.arena.touchPulse=Math.max(0,S.arena.touchPulse-dt);S.learning.manualReward*=Math.exp(-dt/.25);
 if(!S.fly.trail.length||Math.hypot(S.fly.x-S.fly.trail[S.fly.trail.length-1].x,S.fly.y-S.fly.trail[S.fly.trail.length-1].y)>.004){S.fly.trail.push({x:S.fly.x,y:S.fly.y,r:S.learning.lastReward||0});if(S.fly.trail.length>900)S.fly.trail.shift()}
 $("motorRead").textContent=`Neural F ${nf.toFixed(2)} L ${nL.toFixed(2)} R ${nR.toFixed(2)} · Assist ${(assist*100).toFixed(0)}%`;
 $("assistRead").textContent=`${(assist*100).toFixed(0)}%`;
}
function distTo(o){return Math.hypot(S.fly.x-o.x,S.fly.y-o.y)}
function taskReward(task,dt){
 const st=S.taskState,t=S.simTime||0;let r=0;const dL=distTo(S.arena.light),dA=distTo(S.arena.odorA),dB=distTo(S.arena.odorB);
 const improve=(key,d,scale=5)=>{const p=st[key];st[key]=d;return p==null?0:clamp((p-d)*scale,-1,1)};
 switch(task.kind){
  case"light_seek":r=improve("dL",dL,6);break;case"odor_seek":r=improve("dA",dA,6);break;case"avoid_collision":r=S.fly.collision?-1:.012;break;
  case"cue_reward":r=improve("dL",dL,4)*(st.rewarded??1);break;case"cue_punish":r=-improve("dA",dA,5);break;
  case"odor_discrimination":r=improve("dA",dA,5)-Math.max(0,improve("dB",dB,3));break;
  case"go_nogo":{const go=Math.floor(t/3)%2===0;r=go?S.fly.speed*.15:-S.fly.speed*.18;break}
  case"delay_response":case"delay_response_long":{const delay=task.kind.endsWith("long")?5:2;const phase=t%8;r=phase>delay&&phase<delay+2?S.fly.speed*.12:-Math.max(0,S.fly.speed-.02)*.05;break}
  case"alternation":{if(S.fly.x<.15||S.fly.x>.85){const side=S.fly.x<.5?-1:1;if(st.lastSide&&side!==st.lastSide)r=.8;else if(st.lastSide)r=-.4;st.lastSide=side;S.fly.x=.5;S.fly.y=.5}break}
  case"reversal":{const rev=t>task.duration/2;r=rev?improve("dB",dB,5):improve("dA",dA,5);break}
  case"extinction":r=t<task.duration/2?improve("dA",dA,5):0;break;case"reacquisition":{const q=t/task.duration;r=q<.33?improve("dA",dA,5):q<.66?0:improve("dA",dA,5);break}
  case"habituation":r=S.fly.collision?-Math.max(.05,1-t/task.duration):.005;break;case"sensitization":r=S.fly.collision?-(.3+.7*t/task.duration):.004;break;
  case"cue_conflict":r=improve("dA",dA,4)-.25*improve("dL",dL,2);break;case"multisensory":r=(dL<.28&&dA<.28)?.8:-.002;break;
  case"sequence":case"sequence_reverse":{const phase=Math.floor(t/3)%3;if(phase===0)S.arena.cue=task.kind==="sequence"?"A":"B";else if(phase===1)S.arena.cue=task.kind==="sequence"?"B":"A";else r=S.fly.speed*.08;break}
  case"context_switch":{const ctx=Math.floor(t/6)%2;r=ctx?improve("dA",dA,4):improve("dL",dL,4);break}
  case"sparse_reward":r=dL<.08?1:0;break;case"delayed_reward":{if(dL<.1)st.hitAt=t;if(st.hitAt&&t-st.hitAt>2&&t-st.hitAt<2.1)r=1;break}
  case"noise_robust":r=improve("dL",dL,4);break;case"lesion_recovery":{if(!st.lesionIdx&&t>task.duration*.35){const n=Math.max(1,Math.floor(S.sim.ids.length*.10));st.lesionIdx=[];for(let i=0;i<n;i++)st.lesionIdx.push(Math.floor(hash01("lesion"+i)*S.sim.ids.length));toast(`Lesion آزمایشی: ${n} نورون خاموش شد`)}r=improve("dL",dL,3);break}case"detour":r=improve("dL",dL,4)-(S.fly.collision?.5:0);break;
  case"landmark":r=improve("dA",dA,4);break;case"working_memory":{const phase=t%8;r=phase>4?improve("dL",dL,3):0;break}
  case"motor_calibration":r=improve("dL",dL,4);break;case"competing_rewards":{const near=dL,far=dA;r=(far<.09?1.2:0)+(near<.09?.3:0);break}
  case"mission":{const phase=Math.floor(t/10)%3;r=phase===0?improve("dL",dL,4):phase===1?(S.fly.collision?-.5:.01):improve("dA",dA,4);break}
  default:r=improve("dL",dL,4)
 }
 return clamp(r*(task.reward_scale||1),-1.5,1.5)+S.learning.manualReward
}
function startTask(task){if(!S.sim?.ready||!S.nodes.length)return toast("ابتدا صبر کن تا زیرگراف لود شود");S.task=task;S.taskState={};S.simTime=0;S.learning.episode++;resetFly(true);S.learning.totalReward=0;autoMap(false);compileMapping();$("taskTitle").textContent=task.title;$("taskDesc").textContent=task.description||task.goal;$("liveTaskName").textContent=task.title;$("episode").textContent=S.learning.episode;$("taskPhase").textContent="در حال اجرا";$("taskProgress").value=0;setMode("learn");S.learning.on=true;S.simRunning=true;$("simPlayBtn").textContent="⏸ توقف";toast("تسک شروع شد — مسیر مگس و فعالیت مغز زنده است")}
function finishTask(){S.learning.on=false;S.simRunning=false;$("taskPhase").textContent=T("app.task_finished_phase");$("liveTaskName").textContent="Task Lab";$("simPlayBtn").textContent=T("lab.sim_run_btn");toast(T("app.task_finished_toast"))}
async function loadTasks(){try{S.tasks=await(await fetch("/static/tasks.json")).json();S.tasks=[...S.tasks,...S.customTasks];if(!S.task&&S.tasks.length){S.task=S.tasks[0];const tx=window.I18N?window.I18N.taskText(S.task):S.task;$("taskTitle").textContent=tx.title;$("taskDesc").textContent=tx.goal||S.task.description}renderTasks()}catch(e){toast(T("app.tasks_json_failed"))}}
function renderTasks(){const filter=$("taskFilter").value||"all";const a=S.tasks.filter(t=>filter==="all"||t.difficulty===filter);$("taskList").innerHTML=a.map(t=>`<div class="taskCard ${S.task?.id===t.id?"active":""}" data-task="${esc(t.id)}"><div><b>${esc(t.id)} · ${esc(t.title)}</b> <span class="difficulty">${esc(t.difficulty)}</span></div><p>${esc(t.goal)}</p><div class="rmeta">${esc(t.learning_focus||"")}</div></div>`).join("");$$("[data-task]").forEach(x=>x.onclick=()=>{const t=S.tasks.find(q=>q.id===x.dataset.task);if(t){S.task=t;$("taskTitle").textContent=t.title;$("taskDesc").textContent=t.description||t.goal;renderTasks()}})}
$("taskFilter").onchange=renderTasks;$("startTaskBtn").onclick=()=>S.task?startTask(S.task):toast("یک تسک انتخاب کن");$("stopTaskBtn").onclick=finishTask;
$("rewardBtn").onclick=()=>S.learning.manualReward=1;$("punishBtn").onclick=()=>S.learning.manualReward=-1;
$("saveCustomBtn").onclick=()=>{const typed=$("customWaypoints").value.trim(),waypoints=typed?typed.split(/[|;\n]+/).map(s=>{const [x,y,hold]=s.split(",").map(Number);return{x,y,hold}}):undefined,raw={id:"C"+Date.now(),title:$("customTitle").value||"تسک سفارشی",pattern:$("customKind").value,target:$("customTarget").value,goal:$("customGoal").value||"مسیر تعریف‌شده را کامل کن.",description:$("customDesc").value||"",duration:+$("customDuration").value||45,reward_scale:+$("customScale").value||1,waypoints},t=window.FlightLab?.compileTask?window.FlightLab.compileTask(raw):raw;if(typed&&(!t.waypoints||!t.waypoints.length))return toast("نقاط معتبر نیستند؛ نمونه: 0.15,0.80 | 0.50,0.25");S.customTasks.push(t);localStorage.setItem("flybrain_custom_tasks",JSON.stringify(S.customTasks));S.tasks.push(t);S.task=t;renderTasks();toast("تسک ذخیره و برای اجرا انتخاب شد")};

/* ------------------------- render arena/chart/trace ---------------------- */
function drawFly(c,x,y,a,s){c.save();c.translate(x,y);c.rotate(a);c.globalAlpha=.5;c.fillStyle="#fad0ee";c.beginPath();c.ellipse(-s*.15,-s*.55,s*.65,s*.30,-.45,0,Math.PI*2);c.fill();c.beginPath();c.ellipse(-s*.15,s*.55,s*.65,s*.30,.45,0,Math.PI*2);c.fill();c.globalAlpha=1;c.fillStyle="#2e252b";c.beginPath();c.ellipse(0,0,s*.62,s*.32,0,0,Math.PI*2);c.fill();c.fillStyle="#4e3d49";c.beginPath();c.arc(s*.48,0,s*.27,0,Math.PI*2);c.fill();c.fillStyle="#57e944";c.beginPath();c.arc(s*.57,-s*.11,s*.085,0,Math.PI*2);c.arc(s*.57,s*.11,s*.085,0,Math.PI*2);c.fill();c.strokeStyle="#e2b6d6";for(const k of[-1,0,1]){c.beginPath();c.moveTo(0,k*s*.18);c.lineTo(-s*.7,k*s*.56);c.stroke();c.beginPath();c.moveTo(.1*s,k*s*.18);c.lineTo(s*.66,k*s*.58);c.stroke()}c.restore()}
function drawArena(){const w=arena.clientWidth,h=arena.clientHeight;ac.clearRect(0,0,w,h);const X=x=>x*w,Y=y=>y*h;ac.fillStyle="#1e0616";ac.fillRect(0,0,w,h);ac.strokeStyle="#491034";for(let x=0;x<w;x+=35){ac.beginPath();ac.moveTo(x,0);ac.lineTo(x,h);ac.stroke()}for(let y=0;y<h;y+=35){ac.beginPath();ac.moveTo(0,y);ac.lineTo(w,y);ac.stroke()}const glow=(o,col,r)=>{const g=ac.createRadialGradient(X(o.x),Y(o.y),2,X(o.x),Y(o.y),r);g.addColorStop(0,col+"bb");g.addColorStop(1,col+"00");ac.fillStyle=g;ac.beginPath();ac.arc(X(o.x),Y(o.y),r,0,Math.PI*2);ac.fill()};glow(S.arena.light,"#9affee",70);glow(S.arena.odorA,"#ff9782",75);glow(S.arena.odorB,"#d4ff78",75);if(S.fly.trail.length>1){ac.lineWidth=2.2;ac.beginPath();for(let i=0;i<S.fly.trail.length;i++){const p=S.fly.trail[i];if(i===0)ac.moveTo(X(p.x),Y(p.y));else ac.lineTo(X(p.x),Y(p.y))}ac.strokeStyle="#ff56ec99";ac.shadowColor="#ff56ec";ac.shadowBlur=6;ac.stroke();ac.shadowBlur=0;const p=S.fly.trail[S.fly.trail.length-1];ac.fillStyle="#ffd8fc";ac.font="9px Vazirmatn,Tahoma";ac.fillText("مسیر حرکت",X(p.x)+8,Y(p.y)-8)}for(const o of S.arena.obstacles){ac.fillStyle="#47243a";ac.strokeStyle="#7b4a6a";ac.beginPath();ac.arc(X(o.x),Y(o.y),o.r*Math.min(w,h),0,Math.PI*2);ac.fill();ac.stroke()}drawFly(ac,X(S.fly.x),Y(S.fly.y),S.fly.a,Math.min(w,h)*.045);$("flyHud").textContent=`x ${S.fly.x.toFixed(2)} y ${S.fly.y.toFixed(2)} · ${S.fly.collision?"COLLISION":""}`}
arena.onclick=e=>{const r=arena.getBoundingClientRect(),x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height;if(e.shiftKey){S.arena.odorA.x=x;S.arena.odorA.y=y}else{S.arena.light.x=x;S.arena.light.y=y}};
function drawChart(){const w=chart.clientWidth,h=chart.clientHeight;cc.clearRect(0,0,w,h);cc.strokeStyle="#491234";for(let y=18;y<h;y+=22){cc.beginPath();cc.moveTo(0,y);cc.lineTo(w,y);cc.stroke()}const a=S.sim.history;if(a.length>1){cc.strokeStyle="#ff56ec";cc.lineWidth=1.7;cc.beginPath();a.forEach((v,i)=>{const x=i/(a.length-1)*w,y=h-6-v*(h-12);i?cc.lineTo(x,y):cc.moveTo(x,y)});cc.stroke()}}
function renderTrace(){$("traceDock").innerHTML=S.sim.topFlows.length?S.sim.topFlows.slice(0,15).map(x=>`<div class="trace" data-tr="${esc(x.source+"|"+x.target)}"><span>${esc(nodeLabel(x.source))} → ${esc(nodeLabel(x.target))}</span><b>${x.flow.toFixed(3)} ×${x.plastic.toFixed(2)}</b></div>`).join(""):'<div class="empty">فعالیتی نیست.</div>';$$("[data-tr]").forEach(x=>x.onclick=()=>{const[a,b]=x.dataset.tr.split("|");const e=S.edges.find(e=>e.source===a&&e.target===b);if(e)selectEdge(e)})}
function renderPlastic(){const a=S.sim.edges.filter(e=>Math.abs(e.p-1)>.03).sort((x,y)=>Math.abs(y.p-1)-Math.abs(x.p-1)).slice(0,50);$("plasticList").innerHTML=a.length?a.map(e=>`<div class="edge"><span class="id">${esc(S.sim.ids[e.s])}→${esc(S.sim.ids[e.t])}</span><span class="n">×${e.p.toFixed(2)}</span></div>`).join(""):`<div class="empty">${T("app.no_plastic_changes")}</div>`;$("plasticCount").textContent=fmt(a.length)}
function activityObject(){const o={};for(const id of S.sim.topActiveIds(100))o[id]=S.sim.activityFor(id);return o}

/* ------------------------- controls / diagnostics ------------------------ */

$("quickRunBtn").onclick=()=>{if(!S.task&&S.tasks.length)S.task=S.tasks[0];S.task?startTask(S.task):toast("تسک هنوز لود نشده")};
$("advancedBtn").onclick=()=>{$("mainToolbar").classList.toggle("advancedOpen")};
$("assist").oninput=()=>{$("assistBase").textContent=`${Math.round(+$('assist').value*100)}%`};
$("simPlayBtn").onclick=()=>{S.simRunning=!S.simRunning;$("simPlayBtn").textContent=S.simRunning?"⏸ توقف":"▶ اجرا";if(S.simRunning)setMode("sim")};
$("stimNodeBtn").onclick=()=>{const id=S.selectedNode||S.center,i=S.sim.index.get(id);if(i==null)return;S.sim.external[i]+=2;S.sim.activity[i]=1;toast("نورون تحریک شد")};
$("lightBtn").onclick=()=>{S.sim.inject("visual_left",1.2);S.sim.inject("visual_right",1.2)};$("odorBtn").onclick=()=>S.sim.inject("odor_a",1.4);$("touchBtn").onclick=()=>S.arena.touchPulse=.3;
$("resetSimBtn").onclick=()=>compileSimulation();$("autoMapBtn2").onclick=()=>autoMap(true);
$("source").onchange=()=>S.center&&loadGraph();$("topk").onchange=()=>S.center&&loadGraph();$("depth").onchange=()=>S.center&&loadGraph();$("maxNodes").onchange=()=>S.center&&loadGraph();$("reloadBtn").onclick=loadGraph;
$("pngBtn").onclick=()=>{const a=document.createElement("a");a.href=brain.toDataURL("image/png");a.download=`flybrain_${S.center||"view"}.png`;a.click()};
$("diagBtn").onclick=async()=>{try{const h=await api("/api/health"),a=await api("/api/atlas/status");$("diagText").textContent=JSON.stringify({health:h,atlas:a},null,2)}catch(e){$("diagText").textContent=e.message}};
["gain","leak","thr","noise","speed","learnRate","learnDecay"].forEach(id=>{$(id).oninput=()=>{const o=$(id+"V");if(o)o.textContent=(+$(id).value).toFixed(id==="noise"||id==="learnRate"||id==="learnDecay"?3:id==="speed"?1:2)+(id==="speed"?"×":"")}});

/* ------------------------- fixed-step main loop -------------------------- */
let lastActiveFetch=0,lastTrace=0,lastPlastic=0;
function frame(now){
 const realDt=Math.min(.1,(now-S.lastFrame)/1000);S.lastFrame=now;S.acc+=realDt*(+$("speed").value);
 if(S.simRunning&&S.sim.ready){
  let steps=0;
  while(S.acc>=S.fixedDt&&steps<24){
   if(flightLab){flightLab.sensorStep()}else{sensorStep();injectTeacher()}
   const reward=flightLab?flightLab.taskReward():(S.task?taskReward(S.task,S.fixedDt):S.learning.manualReward);
   if(reward>0)S.sim.inject("reward",Math.min(1.5,reward));else if(reward<0)S.sim.inject("punishment",Math.min(1.5,-reward));
   S.sim.step(S.fixedDt,reward,S.learning.on);
   if(flightLab)flightLab.flyStep(S.fixedDt);else flyStep(S.fixedDt);
   S.simTime=(S.simTime||0)+S.fixedDt;S.learning.lastReward=reward;S.learning.totalReward+=reward*S.fixedDt;S.acc-=S.fixedDt;steps++;
   if(!flightLab&&S.task&&S.learning.on&&S.simTime>=S.task.duration){finishTask();break}
  }
 }
 drawGraph();if(flightLab)flightLab.drawArena();else drawArena();drawChart();atlas.render(activityObject(),S.selectedNode,S.pathNodes);
 if(now-lastActiveFetch>600){lastActiveFetch=now;ensureActiveAtlas()}if(now-lastTrace>250){lastTrace=now;renderTrace();$("rewardNow").textContent=(S.learning.lastReward||0).toFixed(3);$("rewardSum").textContent=S.learning.totalReward.toFixed(2);if(S.task){$("taskProgress").value=clamp((S.simTime||0)/Math.max(1,S.task.duration)*100,0,100);$("taskClock").textContent=`${(S.simTime||0).toFixed(1)} / ${S.task.duration}s`;$("activePathCount").textContent=String(S.sim.topFlows.length)}}if(now-lastPlastic>800){lastPlastic=now;renderPlastic()}
 requestAnimationFrame(frame)
}
requestAnimationFrame(frame);


$("exportSessionBtn").onclick=()=>{
  const session={version:"3.0",center:S.center,source:$("source").value,task:S.task,
    mapping:Object.fromEntries(Object.entries(S.mapping).map(([k,v])=>[k,[...v]])),
    plastic:Object.fromEntries(S.sim.edges.map(e=>[e.key,e.p])),
    parameters:{gain:+$("gain").value,leak:+$("leak").value,threshold:+$("thr").value,noise:+$("noise").value,learnRate:+$("learnRate").value,learnDecay:+$("learnDecay").value}};
  const blob=new Blob([JSON.stringify(session,null,2)],{type:"application/json"}),a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="flybrain_research_session.json";a.click();URL.revokeObjectURL(a.href)
};
$("importSessionFile").onchange=async e=>{
  const f=e.target.files[0];
  if(!f)return;
  try{
    const o=JSON.parse(await f.text());
    if(o.mapping){
      for(const [k,v] of Object.entries(o.mapping)){
        if(S.mapping[k])S.mapping[k]=new Set(v);
      }
    }
    renderChannels();
    compileMapping();
    if(o.plastic){
      for(const ed of S.sim.edges){
        if(o.plastic[ed.key]!=null)ed.p=+o.plastic[ed.key];
      }
    }
    toast("Session وارد شد");
  }catch(err){
    toast("Import نامعتبر: "+err.message);
  }
};

/* ------------------------- initialization ------------------------------- */
async function init(){
 try{
  if(!flightLab&&typeof window.installFlightLab==="function"){
   flightLab=window.installFlightLab({S,api,toast,atlas,autoMap,compileMapping,setMode,renderChannels});
  }
  const st=await api("/api/status");$("apiChip").textContent="API READY";$("apiChip").classList.add("ok");$("source").innerHTML=(st.sources||[]).map(x=>`<option value="${esc(x)}">${esc(x.replace("connections_",""))}</option>`).join("");$("sourceChip").textContent=`${st.sources?.length||0} sources`;
  await atlasStatus();
  if(flightLab)await flightLab.loadTasks();else await loadTasks();
  await search();const sm=await api("/api/sample?source="+encodeURIComponent($("source").value));await loadNeuron(sm.root_id);renderChannels();
  const fb=$("flightFeedback");if(fb)fb.textContent=S.sim.ready?T("app.ready_pick_task"):T("app.brain_not_loaded");
 }catch(e){$("apiChip").textContent="API ERROR";const fb=$("flightFeedback");if(fb)fb.textContent=T("app.connect_failed_prefix")+e.message;toast(e.message)}
}
window.addEventListener("DOMContentLoaded",init);
})();
