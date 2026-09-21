/* Simple workspace adapter; uses the existing dataset, neural engine and inspectors. */
window.installFlightLab=function(B){
'use strict';
const {S,api,toast,autoMap,compileMapping,setMode,renderChannels}=B,F=window.FlightLab;
if(!F)throw new Error('FlightLab engine is not loaded');
const $=id=>document.getElementById(id),c=$('arenaCanvas'),ctx=c.getContext('2d');
const T=k=>(window.I18N?window.I18N.t(k):k);
const TX=t=>(window.I18N?window.I18N.taskText(t):{title:t?.title,goal:t?.goal});
const DIFF=d=>(window.I18N?window.I18N.difficulty(d):d);
let saved={};try{saved=JSON.parse(localStorage.getItem('flybrain_flight_v1')||'{}')}catch{}
const models={},history=Array.isArray(saved.history)?saved.history.slice(-100):[];
for(const t of F.tasks)models[t.id]=new F.Learner(saved.models?.[t.id]);
Object.assign(S.arena,{food:{x:.82,y:.30,on:true},heat:{x:.50,y:.45,on:false,power:.70},wind:{angle:0,power:0}});
let selected='light',dragging=false,run=null,testing=false,repeat=false,completed=0,swcs=[],swcBusy=false,swcLoadedFor='';
const baseObstacles=S.arena.obstacles.map(o=>({...o}));

document.body.classList.add('simpleLab');
document.querySelector('.brand b').setAttribute('data-i18n','lab.brand_title');
document.querySelector('.brand small').setAttribute('data-i18n','lab.brand_sub');
document.querySelector('.left .head b').setAttribute('data-i18n','lab.head_title');
document.querySelector('.left .head small').setAttribute('data-i18n','lab.head_sub');
document.querySelector('.heroTitle').setAttribute('data-i18n','lab.hero_title');
document.querySelector('.heroHint').setAttribute('data-i18n','lab.hero_hint');
document.querySelector('.assistCtrl .detail').setAttribute('data-i18n','lab.assist_note');

const toggle=document.createElement('button');toggle.className='btn';toggle.id='detailsToggle';toggle.setAttribute('data-i18n','lab.detail_view');
toggle.onclick=()=>{document.body.classList.toggle('simpleLab');toggle.setAttribute('data-i18n',document.body.classList.contains('simpleLab')?'lab.detail_view':'lab.simple_view');window.I18N?.refresh?.();dispatchEvent(new Event('resize'));};
document.querySelector('.top').append(toggle);

const panel=document.createElement('div');panel.className='flightPanel';panel.innerHTML=`
 <div class="flightIntro"><span class="eyebrow" data-i18n="lab.env_title">محیط تعاملی</span><b data-i18n="lab.env_heading">بکش، جابه‌جا کن، کشف کن</b><span data-i18n="lab.env_hint">ابزار را انتخاب کن و روی محیط بکش یا کلیک کن.</span></div>
 <div class="stimTools" role="group" data-i18n-aria="lab.env_aria" aria-label="ابزارهای محیط">
  ${[['light','☀','lab.stim_light'],['food','●','lab.stim_food'],['odorA','◉','lab.stim_odorA'],['odorB','◎','lab.stim_odorB'],['heat','♨','lab.stim_heat'],['obstacle','◆','lab.stim_obstacle'],['touch','✦','lab.stim_touch']].map(([id,icon,key])=>`<button class="btn" data-stim="${id}" aria-pressed="${id==='light'}">${icon} <span data-i18n="${key}"></span></button>`).join('')}
  <button class="btn" data-pulse="reward"><span data-i18n="lab.pulse_reward"></span></button><button class="btn" data-pulse="punishment"><span data-i18n="lab.pulse_punish"></span></button>
 </div>
 <div class="environmentSliders">
  <label><span data-i18n="lab.wind_label"></span> <output id="windValue">۰٪</output><input data-i18n-aria="lab.wind_aria" aria-label="شدت باد" id="windPower" type="range" min="0" max="1" step=".05" value="0"></label>
  <label><span data-i18n="lab.wind_dir_label"></span> <select id="windDirection" data-i18n-aria="lab.wind_dir_label" aria-label="جهت باد"><option value="0" data-i18n="lab.wind_right"></option><option value="90" data-i18n="lab.wind_down"></option><option value="180" data-i18n="lab.wind_left"></option><option value="270" data-i18n="lab.wind_up"></option></select></label>
  <label><span data-i18n="lab.heat_label"></span> <output id="heatValue" data-i18n="lab.heat_off"></output><input data-i18n-aria="lab.heat_aria" aria-label="شدت حرارت" id="heatPower" type="range" min="0" max="1" step=".05" value="0"></label>
  <label class="check"><input type="checkbox" id="stimEnabled" checked> <span data-i18n="lab.stim_enabled"></span></label>
 </div>
 <div class="flightActions"><button class="btn green" id="trainFlight" data-i18n="lab.train_btn">▶ تمرین</button><button class="btn" id="testFlight" data-i18n="lab.test_btn">آزمون بدون مربی</button><button class="btn" id="pauseFlight" data-i18n="lab.pause_btn">مکث</button><label><input type="checkbox" id="repeatFlight"> <span data-i18n="lab.repeat_label"></span></label></div>
 <div class="flightFeedback" id="flightFeedback" role="status" aria-live="polite" data-i18n="lab.feedback_default">نور زرد، غذای سبز و بوی بنفش را با کشیدن جابه‌جا کن.</div>`;
$('stage').before(panel);

const report=document.createElement('div');report.className='flightReport';report.innerHTML=`
 <div class="reportHeading"><b data-i18n="lab.report_heading">دفتر پیشرفت</b><button class="btn" id="saveFlight" data-i18n="lab.save_results">دریافت نتیجه‌ها</button></div>
 <div id="flightMetrics" class="flightMetrics"></div><div id="flightHistory"></div>
 <p class="modelNote" data-i18n="lab.model_note">یادگیری محاسباتی با مربی است. شکل SWC از دادهٔ واقعی می‌آید؛ روشن‌شدن نورون‌ها فعالیت مدل است، نه اندازه‌گیری مغز زنده.</p>`;
$('taskList').before(report);

const swcPanel=document.createElement('div');swcPanel.className='liveMorphology';swcPanel.innerHTML='<b data-i18n="lab.morph_title">نورون‌ها هنگام پرواز</b><span id="morphologyStatus" data-i18n="lab.morph_waiting">در انتظار اتصال به داده…</span><canvas id="liveMorphology"></canvas><div id="sensoryLegend"></div>';
$('stage').append(swcPanel);
const mc=$('liveMorphology'),mx=mc.getContext('2d');

window.I18N?.refresh?.();

const persist=()=>{try{localStorage.setItem('flybrain_flight_v1',JSON.stringify({models:Object.fromEntries(Object.entries(models).map(([k,m])=>[k,m.toJSON()])),history}))}catch{toast(T('lab.storage_unavailable'))}};
const taskModel=()=>models[S.task?.id]||(models[S.task?.id]=new F.Learner());
const resolve=p=>typeof p==='string'?S.arena[p]:p;
function drawHistory(){
 const rows=history.filter(h=>h.id===S.task?.id).slice(-5);
 $('flightHistory').innerHTML=rows.length?rows.map(h=>`<div class="historyRow"><span>${h.test?T('lab.hist_test'):T('lab.hist_practice')} ${h.episode}</span><b>${h.success?T('lab.hist_success'):h.cancelled?T('lab.hist_stopped'):Math.round(h.progress*100)+T('lab.hist_progress_suffix')}</b><span>${T('lab.hist_error')} ${h.error.toFixed(2)} · ${h.time.toFixed(1)} ${T('lab.hist_seconds')}</span></div>`).join(''):`<p class="modelNote">${T('lab.hist_empty')}</p>`;
}
function renderTasks(){
 const filter=$('taskFilter').value;$('taskList').replaceChildren();
 for(const t of S.tasks.filter(t=>filter==='all'||filter===t.difficulty)){
  const tx=TX(t);
  const b=document.createElement('button');b.className='taskCard'+(t.id===S.task?.id?' active':'');b.dataset.task=t.id;
  b.innerHTML=`<div><b>${tx.title}</b><span class="difficulty">${DIFF(t.difficulty)}</span></div><p>${tx.goal}</p>`;
  b.onclick=()=>{if(run)finish('cancelled');S.task=t;$('taskTitle').textContent=TX(t).title;$('taskDesc').textContent=TX(t).goal;renderTasks();drawHistory();preview();};
  $('taskList').append(b);
 }
}
function preview(){S.fly.trail=[];run=null;S.previewRoute=S.task?F.route(S.task,S.arena):[];}
function syncControls(){
 $('windPower').value=S.arena.wind.power;$('windValue').textContent=Math.round(S.arena.wind.power*100)+'٪';
 $('windDirection').value=String(S.arena.wind.angle||0);
 $('heatPower').value=S.arena.heat.on?S.arena.heat.power:0;$('heatValue').textContent=S.arena.heat.on?Math.round(S.arena.heat.power*100)+'٪':T('lab.heat_off');
 $('stimEnabled').disabled=selected==='touch';$('stimEnabled').checked=S.arena[selected]?.on??true;
}
function start(task,test=false,continuing=false){
 if(!task)return;if(!S.sim?.ready)return toast(T('lab.brain_not_ready'));
 if(run)finish('cancelled');S.task=task;testing=test;if(!continuing)completed=0;
 S.arena.obstacles=(task.id==='slalom'||task.id==='parallel-park')?baseObstacles.map(o=>({...o})):[];
 if(task.id==='parallel-park')S.arena.obstacles=[{x:.38,y:.43,r:.07},{x:.80,y:.43,r:.07}];
 if(task.id==='wind'&&!continuing)S.arena.wind.power=.55;
 if(task.id==='heat'&&!continuing){S.arena.heat.on=true;S.arena.heat.power=.8;}
 const route=F.route(task,S.arena);S.previewRoute=route;
 if(!route.length)return toast(T('lab.no_route'));
 const first=resolve(route[0]),writing=['letter','message','hello','heart','eight'].includes(task.id);
 Object.assign(S.fly,{x:writing?first.x:.15,y:writing?first.y:.8,a:-.6,turn:0,speed:0,trail:[],collision:false});
 const next=resolve(route[writing?1:0]||route[0]);if(next)S.fly.a=Math.atan2(next.y-S.fly.y,next.x-S.fly.x);
 const prior=history.filter(h=>h.id===task.id&&!h.test&&!h.cancelled);
 run={route,index:writing?1:0,writing,loss:0,samples:0,collisions:0,travel:0,episode:prior.length+1,assist:test?0:(prior.length?F.clamp(prior.at(-1).error*.35,.08,.8):.8),success:false,environment:JSON.parse(JSON.stringify(S.arena))};
 S.simTime=0;S.acc=0;S.taskState={};S.learning.totalReward=0;S.learning.manualReward=0;S.learning.on=!test;S.learning.episode=run.episode;
 S.sim.activity.fill(0);S.sim.voltage.fill(0);S.sim.external.fill(0);autoMap(false);compileMapping();
 const tx=TX(task);
 S.simRunning=true;setMode('learn');syncControls();$('episode').textContent=run.episode;$('taskTitle').textContent=tx.title;$('taskDesc').textContent=tx.goal;
 $('taskPhase').textContent=test?T('lab.phase_test'):T('lab.phase_practice');$('liveTaskName').textContent=tx.title;$('simPlayBtn').textContent=T('lab.sim_pause_btn');$('pauseFlight').textContent=T('lab.pause_btn');
 $('flightFeedback').textContent=(test?T('lab.feedback_test_prefix'):T('lab.feedback_practice_prefix'))+tx.goal;
 renderTasks();drawHistory();loadMorphology(true);
}
function finish(reason='timeout'){
 if(!run){S.simRunning=false;return;}
 const r=run,success=reason==='success';r.success=success;
 history.push({id:S.task.id,test:testing,episode:r.episode,success,cancelled:reason==='cancelled',progress:success?1:r.index/Math.max(1,r.route.length),error:Math.sqrt(r.loss/Math.max(1,r.samples)),collisions:r.collisions,time:S.simTime||0,assist:r.assist,environment:r.environment,environmentEnd:JSON.parse(JSON.stringify(S.arena)),date:new Date().toISOString()});
 if(history.length>100)history.shift();
 run=null;S.learning.on=false;S.simRunning=false;S.acc=0;persist();drawHistory();
 $('taskPhase').textContent=success?T('lab.phase_success'):reason==='cancelled'?T('lab.phase_cancelled'):T('lab.phase_timeout');
 $('flightFeedback').textContent=success?T('lab.feedback_success'):reason==='cancelled'?T('lab.feedback_cancelled'):T('lab.feedback_timeout');
 $('taskProgress').value=success?100:history.at(-1).progress*100;$('simPlayBtn').textContent=T('lab.sim_run_btn');completed++;
 if(repeat&&!testing&&reason!=='cancelled'&&completed<5)setTimeout(()=>start(S.task,false,true),120);
}
function target(){if(!run)return S.arena.light;return resolve(run.route[Math.min(run.index,run.route.length-1)])||S.arena.light;}
function advance(dt){
 if(!run)return;
 const r=run,t=target(),prev={x:S.fly.x,y:S.fly.y};
 const near=Math.hypot(t.x-S.fly.x,t.y-S.fly.y)<(r.writing?.012:.04),parking=t.hold>0&&near;
 const waiting=t.on===false||(S.task.id==='stop'&&S.simTime%8>3&&S.simTime%8<5)||parking;
 if(S.task.id==='touch'&&S.simTime>1&&!r.touched){r.touched=true;S.arena.touchPulse=.35;}
 const assistScale=Math.min(1,(+$('assist').value||0)/.65);
 const result=F.step(S.fly,{...t,hold:waiting},S.arena,taskModel(),dt,!testing,r.assist*assistScale);
 r.loss+=result.loss;r.samples++;r.travel+=Math.hypot(prev.x-S.fly.x,prev.y-S.fly.y);if(S.fly.collision&&!r.wasCollision)r.collisions++;r.wasCollision=S.fly.collision;
 const pen=!r.writing||r.route[r.index]?.pen!==false,trail=S.fly.trail,last=trail.at(-1);
 if(!last||Math.hypot(last.x-S.fly.x,last.y-S.fly.y)>.0018)trail.push({x:S.fly.x,y:S.fly.y,pen});if(trail.length>14000)trail.shift();
 S.learning.manualReward*=Math.exp(-dt/.25);
 const cmd=result.command;S.sim.inject('motor_left',Math.max(0,-cmd)*.8);S.sim.inject('motor_right',Math.max(0,cmd)*.8);S.sim.inject('motor_forward',S.fly.speed*8);
 if(result.distance<(r.writing?.012:.04)&&t.on!==false){if(t.hold>0){r.holdTime=(r.holdTime||0)+dt;if(r.holdTime<t.hold)return;}r.holdTime=0;r.index++;r.hit=true;if(r.index>=r.route.length){finish('success');return;}}else if(t.hold>0)r.holdTime=0;
 if(S.simTime>=S.task.duration){finish();return;}
 if(r.samples%24===0){
  $('taskProgress').value=r.index/Math.max(1,r.route.length)*100;
  $('flightMetrics').innerHTML=`<div><small>${T('lab.metric_stage')}</small><b>${Math.min(r.index+1,r.route.length)} / ${r.route.length}</b></div><div><small>${T('lab.metric_error')}</small><b>${Math.sqrt(r.loss/r.samples).toFixed(2)}</b></div><div><small>${T('lab.metric_collisions')}</small><b>${r.collisions}</b></div>`;
  $('assistRead').textContent=Math.round(r.assist*assistScale*100)+'٪';$('motorRead').textContent=testing?T('lab.motor_test'):T('lab.motor_train');
 }
}
function sensors(){
 const f=S.fly,a=S.arena;
 if(a.light.on){const v=2.6/(1+Math.hypot(f.x-a.light.x,f.y-a.light.y)*3),rel=Math.sin(Math.atan2(a.light.y-f.y,a.light.x-f.x)-f.a);S.sim.inject('visual_left',v*(1-rel)*.5);S.sim.inject('visual_right',v*(1+rel)*.5);}
 for(const [key,ch] of [['odorA','odor_a'],['odorB','odor_b'],['food','odor_b']])if(a[key].on)S.sim.inject(ch,2.6*Math.exp(-Math.hypot(f.x-a[key].x,f.y-a[key].y)*4));
 S.sim.inject('touch',a.touchPulse>0?2.5:0);S.sim.inject('wind',a.wind.power*2);S.sim.inject('heat',a.heat.on?a.heat.power*Math.exp(-Math.hypot(f.x-a.heat.x,f.y-a.heat.y)*8)*3:0);
}
function reward(){
 if(!run)return 0;const t=target(),d=Math.hypot(t.x-S.fly.x,t.y-S.fly.y),previous=run.previousDistance;run.previousDistance=d;const hit=run.hit;run.hit=false;if(hit){run.previousDistance=null;return 1;}
 return F.clamp((previous==null?0:(previous-d)*120)-(S.fly.collision?.3:0),-1,1)+S.learning.manualReward;
}
function draw(){
 const w=c.clientWidth,h=c.clientHeight;ctx.clearRect(0,0,w,h);ctx.fillStyle='#280a1f';ctx.fillRect(0,0,w,h);
 ctx.strokeStyle='#3b1833';ctx.lineWidth=1;for(let x=0;x<w;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke()}for(let y=0;y<h;y+=40){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke()}
 const route=run?.route||S.previewRoute;if(route?.length>1){ctx.setLineDash([4,6]);ctx.strokeStyle='#94618e70';ctx.beginPath();route.forEach((p,i)=>{p=resolve(p);if(!p)return;if(i===0||p.pen===false)ctx.moveTo(p.x*w,p.y*h);else ctx.lineTo(p.x*w,p.y*h)});ctx.stroke();ctx.setLineDash([])}
 for(const [key,label,color] of [['light',T('lab.arena_light'),'#99ffdd'],['food',T('lab.arena_food'),'#a86eea'],['odorA',T('lab.arena_odor'),'#ffb3a0'],['heat',T('lab.arena_heat'),'#6fff91']]){const o=S.arena[key];if(!o.on)continue;const x=o.x*w,y=o.y*h,r=key==='heat'?55:32,g=ctx.createRadialGradient(x,y,3,x,y,r);g.addColorStop(0,color+'66');g.addColorStop(1,color+'00');ctx.fillStyle=g;ctx.fillRect(x-r,y-r,r*2,r*2);ctx.strokeStyle=color;ctx.fillStyle=color;ctx.beginPath();ctx.arc(x,y,8,0,Math.PI*2);ctx.fill();if(key===selected){ctx.beginPath();ctx.arc(x,y,15,0,Math.PI*2);ctx.stroke()}ctx.font='12px Tahoma';ctx.textAlign='center';ctx.fillText(label,x,y+29)}
 if(S.arena.odorB.on){const o=S.arena.odorB,x=o.x*w,y=o.y*h,g=ctx.createRadialGradient(x,y,3,x,y,32);g.addColorStop(0,'#d8ff8b66');g.addColorStop(1,'#d8ff8b00');ctx.fillStyle=g;ctx.fillRect(x-32,y-32,64,64);ctx.fillStyle='#d8ff8b';ctx.beginPath();ctx.arc(x,y,8,0,Math.PI*2);ctx.fill();ctx.font='12px Tahoma';ctx.textAlign='center';ctx.fillText(T('lab.arena_odorB'),x,y+29)}
 for(const o of S.arena.obstacles){ctx.fillStyle='#55334b';ctx.beginPath();ctx.ellipse(o.x*w,o.y*h,(o.r+.003)*w,(o.r+.003)*h,0,0,Math.PI*2);ctx.fill()}
 if(S.arena.wind.power>0){ctx.save();ctx.fillStyle='#db8aca99';ctx.font='20px Tahoma';for(let i=0;i<5;i++){ctx.save();ctx.translate(35+i*w/5,60+((S.simTime||0)*18+i*45)%Math.max(80,h-100));ctx.rotate(S.arena.wind.angle*Math.PI/180);ctx.fillText('→',0,0);ctx.restore()}ctx.restore()}
 ctx.beginPath();S.fly.trail.forEach((p,i)=>{if(i===0||p.pen===false)ctx.moveTo(p.x*w,p.y*h);else ctx.lineTo(p.x*w,p.y*h)});ctx.strokeStyle='#d27aed';ctx.lineWidth=2.5;ctx.shadowColor='#d27aed';ctx.shadowBlur=5;ctx.stroke();ctx.shadowBlur=0;
 const f=S.fly;ctx.save();ctx.translate(f.x*w,f.y*h);ctx.rotate(Math.atan2(Math.sin(f.a)*h,Math.cos(f.a)*w));ctx.fillStyle='#00000044';ctx.beginPath();ctx.ellipse(-2,5,15,8,0,0,Math.PI*2);ctx.fill();const flap=S.simRunning?Math.sin((S.simTime||0)*95)*.3:0;
 for(const side of[-1,1]){ctx.fillStyle='#f3d5fabb';ctx.beginPath();ctx.ellipse(-5,side*(9+flap*6),13,5,side*(.5+flap),0,Math.PI*2);ctx.fill();ctx.strokeStyle='#beadc9';for(let k=-1;k<=1;k++){ctx.beginPath();ctx.moveTo(k*5,side*3);ctx.lineTo(k*7-2,side*12);ctx.stroke()}}
 ctx.fillStyle='#7edbb3';ctx.beginPath();ctx.ellipse(0,0,11,5,0,0,Math.PI*2);ctx.fill();ctx.fillStyle='#2d4134';ctx.beginPath();ctx.ellipse(-4,0,5,5,0,0,Math.PI*2);ctx.fill();ctx.fillStyle='#67f378';ctx.beginPath();ctx.arc(9,-3,3,0,Math.PI*2);ctx.arc(9,3,3,0,Math.PI*2);ctx.fill();ctx.restore();
 if(S.arena.touchPulse>0){ctx.strokeStyle='#92ffcb';ctx.beginPath();ctx.arc(f.x*w,f.y*h,24+S.arena.touchPulse*20,0,Math.PI*2);ctx.stroke()}
 $('flyHud').textContent=run?(S.task.id==='stop'&&S.simTime%8>3&&S.simTime%8<5?T('lab.fly_stop'):testing?T('lab.fly_test'):T('lab.fly_training')):T('lab.fly_ready');drawMorphology();
}
function pointer(e){
 const r=c.getBoundingClientRect(),p={x:F.clamp((e.clientX-r.left)/r.width,.04,.96),y:F.clamp((e.clientY-r.top)/r.height,.05,.94)};
 if(selected==='touch'){if(Math.hypot(p.x-S.fly.x,p.y-S.fly.y)<.12)S.arena.touchPulse=.4;else $('flightFeedback').textContent=T('lab.touch_hint');}
 else if(selected==='obstacle'){S.arena.obstacles.push({...p,r:.055});if(run)run.modified=true}
 else{Object.assign(S.arena[selected],p);if(run){run.previousDistance=null;run.modified=true}}
}
c.onclick=null;c.style.touchAction='none';
c.onpointerdown=e=>{const r=c.getBoundingClientRect(),hit=['light','food','odorA','odorB','heat'].find(k=>S.arena[k].on&&Math.hypot((S.arena[k].x-(e.clientX-r.left)/r.width)*r.width,(S.arena[k].y-(e.clientY-r.top)/r.height)*r.height)<22);if(hit&&selected!=='touch'&&selected!=='obstacle')choose(hit);dragging=true;c.setPointerCapture(e.pointerId);pointer(e)};
c.onpointermove=e=>{if(dragging&&selected!=='touch'&&selected!=='obstacle')pointer(e)};c.onpointerup=c.onpointercancel=()=>dragging=false;
function choose(k){selected=k;document.querySelectorAll('[data-stim]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.stim===k));if(k==='heat')S.arena.heat.on=true;syncControls()}
document.querySelectorAll('[data-stim]').forEach(b=>b.onclick=()=>choose(b.dataset.stim));
document.querySelectorAll('[data-pulse]').forEach(b=>b.onclick=()=>{const positive=b.dataset.pulse==='reward';S.learning.manualReward=positive?1:-1;S.sim.inject(positive?'reward':'punishment',2.5);$('flightFeedback').textContent=positive?T('lab.reward_pulse'):T('lab.punish_pulse')});
$('windPower').oninput=e=>{S.arena.wind.power=+e.target.value;syncControls()};$('windDirection').onchange=e=>S.arena.wind.angle=+e.target.value;
$('heatPower').oninput=e=>{S.arena.heat.power=+e.target.value;S.arena.heat.on=+e.target.value>0;syncControls()};$('stimEnabled').onchange=e=>{if(S.arena[selected])S.arena[selected].on=e.target.checked;syncControls()};
$('trainFlight').onclick=()=>start(S.task);$('testFlight').onclick=()=>start(S.task,true);$('repeatFlight').onchange=e=>repeat=e.target.checked;
$('saveCustomBtn').onclick=()=>{
 const typed=$('customWaypoints').value.trim(),parsed=typed?typed.split(/[|;\n]+/).map(s=>{const [x,y,hold]=s.split(',').map(Number);return{x,y,hold}}):undefined;
 if(parsed&&parsed.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)))return toast(T('lab.invalid_waypoints'));
 const task=F.compileTask({id:'C'+Date.now(),title:$('customTitle').value||T('lab.custom_default_title'),pattern:$('customKind').value,target:$('customTarget').value,goal:$('customGoal').value||T('lab.custom_default_goal'),description:$('customDesc').value||'',duration:+$('customDuration').value||45,reward_scale:+$('customScale').value||1,waypoints:parsed});
 S.customTasks.push(task);localStorage.setItem('flybrain_custom_tasks',JSON.stringify(S.customTasks));S.tasks.push(task);S.task=task;renderTasks();preview();drawHistory();document.querySelector('[data-left="taskPane"]').click();toast(T('lab.custom_saved'));
};
$('pauseFlight').onclick=()=>{if(!run)return;S.simRunning=!S.simRunning;S.acc=0;$('pauseFlight').textContent=S.simRunning?T('lab.pause_btn'):T('lab.resume_btn');$('simPlayBtn').textContent=S.simRunning?T('lab.sim_pause_btn'):T('lab.sim_resume_btn')};
$('simPlayBtn').onclick=()=>run?$('pauseFlight').click():start(S.task);$('startTaskBtn').onclick=$('quickRunBtn').onclick=()=>start(S.task);$('stopTaskBtn').onclick=()=>finish('cancelled');$('taskFilter').onchange=renderTasks;
$('saveFlight').onclick=()=>{const blob=new Blob([JSON.stringify({version:2,models:Object.fromEntries(Object.entries(models).map(([id,m])=>[id,m.toJSON()])),history},null,2)],{type:'application/json'}),a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download='flybrain-learning.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
async function loadTasks(){S.customTasks=(Array.isArray(S.customTasks)?S.customTasks:[]).map(F.compileTask);S.tasks=[...F.tasks,...S.customTasks];S.task=S.tasks[0];const tx=TX(S.task);$('taskTitle').textContent=tx.title;$('taskDesc').textContent=tx.goal;renderTasks();preview();drawHistory();setMode('learn')}
async function loadMorphology(force=false){
 const signature=S.nodes.map(n=>n.id).slice(0,20).join('|');if(swcBusy||(!force&&swcLoadedFor===signature)||!S.nodes.length)return;swcBusy=true;swcs=[];$('morphologyStatus').textContent=T('lab.morph_loading');
 try{const groups=[['visual_left',T('lab.morph_group_visual')],['odor_a',T('lab.morph_group_odorA')],['odor_b',T('lab.morph_group_odorB')],['touch',T('lab.morph_group_touch')],['wind',T('lab.morph_group_wind')],['heat',T('lab.morph_group_heat')],['motor_forward',T('lab.morph_group_motor')]];
  for(const [channel,label] of groups){const ids=[...(S.mapping[channel]||[])].slice(0,2);for(const id of ids){const d=await api('/api/skeleton/'+encodeURIComponent(id)+'?max_segments=1800');if(d.found&&d.segments?.length){swcs.push({id,label,channel,segments:d.segments});break}}}
  swcLoadedFor=signature;$('morphologyStatus').textContent=swcs.length?`${swcs.length} ${T('lab.morph_found_suffix')}`:T('lab.morph_none');
 }catch(e){$('morphologyStatus').textContent=T('lab.morph_error')}finally{swcBusy=false}
}
function drawMorphology(){
 const r=mc.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,2);if(mc.width!==Math.round(r.width*d)||mc.height!==Math.round(r.height*d)){mc.width=Math.max(1,Math.round(r.width*d));mc.height=Math.max(1,Math.round(r.height*d))}mx.setTransform(d,0,0,d,0,0);mx.clearRect(0,0,r.width,r.height);const cols=2,cw=r.width/cols,ch=r.height/Math.max(2,Math.ceil(swcs.length/cols));
 swcs.forEach((n,i)=>{if(!n.bounds){let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity;for(const s of n.segments){x0=Math.min(x0,s[0],s[3]);x1=Math.max(x1,s[0],s[3]);y0=Math.min(y0,s[1],s[4]);y1=Math.max(y1,s[1],s[4])}n.bounds=[x0,x1,y0,y1]}const [x0,x1,y0,y1]=n.bounds,scale=Math.min((cw-24)/(x1-x0||1),(ch-35)/(y1-y0||1)),ox=i%cols*cw+cw/2,oy=Math.floor(i/cols)*ch+ch/2,a=S.sim.activityFor(n.id);mx.strokeStyle=`rgba(${Math.round(110+140*a)},${Math.round(160+90*a)},${Math.round(180-30*a)},${.3+.7*a})`;mx.lineWidth=.7+a*1.6;mx.shadowColor='#d9aaff';mx.shadowBlur=a*9;mx.beginPath();for(const s of n.segments){mx.moveTo(ox+(s[0]-(x0+x1)/2)*scale,oy+(s[1]-(y0+y1)/2)*scale);mx.lineTo(ox+(s[3]-(x0+x1)/2)*scale,oy+(s[4]-(y0+y1)/2)*scale)}mx.stroke();mx.shadowBlur=0;mx.fillStyle='#d4c2d6';mx.font='11px Tahoma';mx.textAlign='center';mx.fillText(n.label+' '+Math.round(a*100)+'٪',ox,Math.floor(i/cols)*ch+ch-6)});
 if(!swcs.length){mx.fillStyle='#cba7c1';mx.textAlign='center';mx.font='12px Tahoma';mx.fillText(T('lab.morph_placeholder'),r.width/2,r.height/2)}
}
document.addEventListener('nw:langchange',()=>{
 renderTasks();
 if(S.task){const tx=TX(S.task);if(!run){$('taskTitle').textContent=tx.title;$('taskDesc').textContent=tx.goal;}$('liveTaskName').textContent=tx.title;}
 drawHistory();
 syncControls();
});
setMode('learn');syncControls();
return {startTask:start,finishTask:()=>finish('cancelled'),loadTasks,renderTasks,flyStep:advance,sensorStep:sensors,taskReward:reward,drawArena:draw,injectTeacher:()=>{},currentAssist:()=>run?.assist||0,loadMorphology};
};
