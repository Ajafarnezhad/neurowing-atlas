/* Deterministic flight dynamics and online imitation learning. No biological claims. */
(function(root){
'use strict';
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
const glyphs={
 A:[[[0,1],[.5,0],[1,1]],[[.24,.55],[.76,.55]]],
 l:[[[.15,0],[.15,1],[.8,1]]],
 o:[[[.5,.25],[.1,.35],[0,.65],[.15,1],[.75,1],[1,.65],[.9,.35],[.5,.25]]],
 v:[[[0,.25],[.5,1],[1,.25]]],
 e:[[[0,.6],[1,.6],[.85,.25],[.2,.25],[0,.55],[.15,1],[.9,1]]],
 y:[[[0,.25],[.5,.7],[1,.25]],[[.5,.7],[.25,1.2]]],
 u:[[[0,.25],[0,.8],[.2,1],[.8,1],[1,.8],[1,.25]]],
 i:[[[.5,.3],[.5,1]],[[.5,.08],[.51,.08]]],
 L:[[[0,0],[0,1],[1,1]]],
 h:[[[.12,0],[.12,1]],[[.12,.42],[.22,.28],[.4,.24],[.55,.28],[.6,.42],[.6,1]]],
 m:[[[.04,1],[.04,.32]],[[.04,.42],[.16,.26],[.28,.32],[.28,1]],[[.28,.42],[.4,.26],[.52,.32],[.52,1]]],
 r:[[[.15,1],[.15,.3]],[[.15,.42],[.32,.26],[.55,.28],[.62,.34]]],
 n:[[[.06,1],[.06,.32]],[[.06,.42],[.2,.26],[.38,.3],[.44,.42],[.44,1]]],
 s:[[[.85,.42],[.55,.28],[.22,.34],[.15,.48],[.35,.6],[.65,.66],[.85,.78],[.78,.94],[.45,1],[.12,.9]]]
};
function wrapRows(text,maxLen){
 const words=text.split(' '),rows=[];let cur='';
 words.forEach(w=>{const t=cur?cur+' '+w:w;if(t.length>maxLen&&cur){rows.push(cur);cur=w;}else cur=t;});
 if(cur)rows.push(cur);
 return rows;
}
function textPath(text){
 const rows=text.length<=6?[text]:wrapRows(text,10),points=[];
 rows.forEach((row,ri)=>{const cell=.84/row.length,height=rows.length===1?.65:.27;
  [...row].forEach((ch,ci)=>{if(ch===' ')return;for(const stroke of glyphs[ch]||glyphs[ch.toLowerCase()]||[]){
   stroke.forEach(([x,y],j)=>points.push({x:.08+ci*cell+x*cell*.72,y:(rows.length===1?.18:.18+ri*.44)+y*height,pen:j!==0}));
  }});
 });
 return points;
}
function curve(kind){
 return Array.from({length:65},(_,i)=>{const t=i/64*Math.PI*2;
  return kind==='heart'
   ? {x:.5+Math.pow(Math.sin(t),3)*.29,y:.48-(13*Math.cos(t)-5*Math.cos(2*t)-2*Math.cos(3*t)-Math.cos(4*t))*.021,pen:i>0}
   : {x:.5+.32*Math.sin(t),y:.5+.29*Math.sin(t)*(kind==='eight'?Math.cos(t):1),pen:i>0};
 });
}
class Learner{
 constructor(saved){
  this.w=Array.isArray(saved?.w)&&saved.w.length===8&&saved.w.every(Number.isFinite)?saved.w.slice():Array(8).fill(0);
  this.samples=Number.isFinite(saved?.samples)?saved.samples:0;
  const validCov=Array.isArray(saved?.cov)&&saved.cov.length===64&&saved.cov.every(Number.isFinite);
  this.cov=validCov?saved.cov.slice():Array.from({length:64},(_,k)=>Math.floor(k/8)===k%8?25:0);
 }
 predict(x){return x.reduce((s,v,i)=>s+v*this.w[i],0);}
 update(x,target,dt){
  const prediction=this.predict(x),error=target-prediction;
  const px=x.map((_,i)=>x.reduce((s,v,j)=>s+this.cov[i*8+j]*v,0));
  const den=1/Math.max(.001,dt*120)+x.reduce((s,v,i)=>s+v*px[i],0);
  this.w=this.w.map((w,i)=>w+px[i]*error/den);
  this.cov=this.cov.map((p,k)=>p-px[Math.floor(k/8)]*px[k%8]/den);
  this.samples++;
  return error*error;
 }
 toJSON(){return {w:this.w.slice(),cov:this.cov.slice(),samples:this.samples};}
}
function features(f,target,env){
 const err=wrap(Math.atan2(target.y-f.y,target.x-f.x)-f.a);let avoidance=0;
 for(const o of env.obstacles||[]){const dx=o.x-f.x,dy=o.y-f.y,d=Math.hypot(dx,dy),a=wrap(Math.atan2(dy,dx)-f.a);if(d<o.r+.16&&Math.abs(a)<1.6)avoidance+=(a>=0?-1:1)*(1-clamp((d-o.r)/.16,0,1));}
 const heat=env.heat?.on?Math.exp(-Math.hypot(f.x-env.heat.x,f.y-env.heat.y)*10)*env.heat.power:0;
 const ha=env.heat?wrap(Math.atan2(f.y-env.heat.y,f.x-env.heat.x)-f.a):0;
 const wa=(env.wind?.angle||0)*Math.PI/180,wind=env.wind?.power||0;
 return [clamp(err,-1,1),clamp(err/3,-1,1),avoidance,heat*Math.sin(ha),wind*Math.sin(wa-f.a),f.turn||0,env.touchPulse>0?1:0,1];
}
const teacher=x=>clamp(x[0]*2.6+x[1]*.7+x[2]*3.5+x[3]*2-x[4]*1.8-x[5]*.15+x[6]*2,-3.2,3.2);
const patterns={
 drive:[{x:.14,y:.78},{x:.18,y:.30},{x:.42,y:.16},{x:.76,y:.20},{x:.86,y:.48},{x:.70,y:.76},{x:.32,y:.80},{x:.14,y:.62}],
 parallel_park:[{x:.15,y:.68},{x:.48,y:.68},{x:.67,y:.61},{x:.76,y:.51},{x:.67,y:.43},{x:.51,y:.43}],
 slalom:[{x:.28,y:.72},{x:.43,y:.30},{x:.62,y:.72},{x:.80,y:.25}],
 square:[{x:.20,y:.75},{x:.20,y:.22},{x:.78,y:.22},{x:.78,y:.75},{x:.20,y:.75}],
 zigzag:[{x:.15,y:.75},{x:.32,y:.25},{x:.48,y:.75},{x:.64,y:.25},{x:.82,y:.75}]
};
function normalizeWaypoint(p){
 if(typeof p==='string')return p;
 if(!p||!Number.isFinite(+p.x)||!Number.isFinite(+p.y))return null;
 return {x:clamp(+p.x,.03,.97),y:clamp(+p.y,.03,.97),hold:Math.max(0,+p.hold||0),pen:p.pen!==false};
}
function compileTask(raw={}){
 const preset=patterns[raw.pattern]||null;
 const points=(Array.isArray(raw.waypoints)?raw.waypoints:preset||[]).map(normalizeWaypoint).filter(Boolean);
 const target=['light','food','odorA','odorB'].includes(raw.target)?raw.target:'light';
 return {...raw,id:String(raw.id||('C'+Date.now())),title:String(raw.title||'تسک سفارشی'),goal:String(raw.goal||'مسیر تعریف‌شده را کامل کن.'),description:String(raw.description||raw.goal||''),difficulty:raw.difficulty||'سفارشی',kind:'flight',pattern:raw.pattern||'waypoints',target,duration:clamp(+raw.duration||45,5,600),waypoints:points.length?points:[target],learning_focus:raw.learning_focus||'مسیر سفارشی کاربر'};
}
function step(f,target,env,model,dt,training,assist){
 const x=features(f,target,env),desired=teacher(x),prediction=model.predict(x);
 const loss=training?model.update(x,desired,dt):Math.pow(desired-prediction,2);
 const command=clamp(prediction*(1-assist)+desired*assist,-3.2,3.2);
 const d=Math.hypot(target.x-f.x,target.y-f.y),err=wrap(Math.atan2(target.y-f.y,target.x-f.x)-f.a);
 f.turn+=(command-f.turn)*(1-Math.exp(-dt*10));f.a=wrap(f.a+f.turn*dt);
 const desiredSpeed=target.hold?0:Math.min(.19,d*2.4)*Math.max(.06,Math.cos(err))*Math.max(.2,1-Math.abs(x[2])*.8);
 f.speed+=(desiredSpeed-f.speed)*(1-Math.exp(-dt*8));
 const wind=env.wind?.power||0,wa=(env.wind?.angle||0)*Math.PI/180;
 let nx=f.x+(Math.cos(f.a)*f.speed+wind*.035*Math.cos(wa))*dt,ny=f.y+(Math.sin(f.a)*f.speed+wind*.035*Math.sin(wa))*dt;
 f.collision=false;
 for(const o of env.obstacles||[]){const dx=nx-o.x,dy=ny-o.y,d0=Math.hypot(dx,dy),r=o.r+.016;if(d0<r){f.collision=true;const a=d0>.00001?Math.atan2(dy,dx):f.a+Math.PI;nx=o.x+Math.cos(a)*r;ny=o.y+Math.sin(a)*r;env.touchPulse=Math.max(env.touchPulse,.1);}}
 if(nx<.025||nx>.975||ny<.025||ny>.975)f.collision=true;
 f.x=clamp(nx,.025,.975);f.y=clamp(ny,.025,.975);env.touchPulse=Math.max(0,env.touchPulse-dt);
 return {loss,command,prediction,distance:d,desired};
}
const tasks=[
 ['light','دوستِ روشنایی','به نور برس و کنار آن آرام بگیر.','light',30],
 ['food','وقت غذا','غذای سبز را پیدا کن و روی آن فرود بیا.','food',30],
 ['odor','ردِ عطر','منبع بوی بنفش را پیدا کن.','odorA',30],
 ['wind','پرواز در باد','با وجود باد به غذا برس؛ شدت باد را تغییر بده.','food',40],
 ['heat','جای خنک','از ناحیهٔ گرم فاصله بگیر و به غذا برس.','food',40],
 ['touch','لمس و ادامه','پس از لمس کوتاه، مسیر رسیدن به غذا را ادامه بده.','food',35],
 ['slalom','بین سنگ‌ها','از کنار سه مانع عبور کن و به نور برس.','light',50],
 ['delivery','پیک کوچک','به‌ترتیب بو، نور و غذا را پیدا کن.','food',65],
 ['return','رفت و برگشت','به غذا برو و دوباره به خانه برگرد.','food',60],
 ['switch','هدف تازه','ابتدا نور را پیدا کن؛ بعد به سمت بو برو.','light',55],
 ['stop','ایست و پرواز','وقتی نشان ایست آمد مکث کن، سپس به غذا برس.','food',40],
 ['eight','رقص هشت','مسیر عدد ۸ را با پرواز دنبال کن.','food',100],
 ['heart','یک قلب برای تو','با رد پرواز یک قلب بکش.','food',100],
 ['letter','حرف A','حرف A را با مسیر پرواز بنویس.','food',100],
 ['message','love you','با رد پرواز بنویس: love you','food',180],
 ['hello','hello Amirhossein','با رد پرواز بنویس: hello Amirhossein','food',260],
 ['drive','رانندگی در پیست','یک دور مسیر رانندگی را با کنترل نرم کامل کن.','light',85],
 ['parallel-park','پارک دوبل','از کنار جای پارک عبور کن، با قوس وارد شو و دقیق میان دو مانع توقف کن.','light',70]
].map(([id,title,goal,target,duration],i)=>({id,title,goal,description:goal,target,duration,kind:'flight',difficulty:i<6?'آسان':i<11?'متوسط':'سخت',learning_focus:i>10?'یادگیری دنبال‌کردن مسیر • خط کمرنگ = راهنما':'تمرین هدایت • آزمون بدون کمک مربی'}));
function route(task,env){
 if(Array.isArray(task.waypoints)&&task.waypoints.length)return task.waypoints.map(normalizeWaypoint).filter(Boolean);
 if(patterns[task.pattern])return patterns[task.pattern].map(p=>({...p}));
 switch(task.id){
  case'letter':return textPath('A');
  case'message':return textPath('love you');
  case'hello':return textPath('hello Amirhossein');
  case'heart':return curve('heart');
  case'eight':return curve('eight');
  case'delivery':return ['odorA','light','food'];
  case'return':return ['food',{x:.15,y:.8}];
  case'switch':return ['light','odorA'];
  case'slalom':return [{x:.28,y:.72},{x:.43,y:.3},{x:.62,y:.72},'light'];
  case'drive':return patterns.drive.map(p=>({...p}));
  case'parallel-park':return patterns.parallel_park.map((p,i)=>({...p,hold:i===patterns.parallel_park.length-1?1.2:0}));
  default:return [task.target||'light'];
 }
}
const api={Learner,features,teacher,step,textPath,curve,route,tasks,patterns,compileTask,clamp};
if(typeof module!=='undefined')module.exports=api;
root.FlightLab=api;
})(typeof window!=='undefined'?window:globalThis);
