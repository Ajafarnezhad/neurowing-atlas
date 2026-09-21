'use strict';
const assert=require('node:assert/strict');
const F=require('../static/flight.js');
function environment(task){return {light:{x:.78,y:.22,on:true},food:{x:.82,y:.3,on:true},odorA:{x:.22,y:.72,on:true},odorB:{x:.82,y:.75,on:true},heat:{x:.5,y:.45,on:task.id==='heat',power:.8},wind:{angle:0,power:task.id==='wind'?.55:0},touchPulse:0,obstacles:task.id==='slalom'?[{x:.52,y:.31,r:.07},{x:.66,y:.64,r:.065},{x:.30,y:.43,r:.055}]:[]};}
function episode(task,model,training,assist){
 const env=environment(task),route=F.route(task,env),resolve=p=>typeof p==='string'?env[p]:p,writing=['letter','message','heart','eight'].includes(task.id);
 let index=writing?1:0,first=resolve(route[0]);const f={x:writing?first.x:.15,y:writing?first.y:.8,a:-.6,turn:0,speed:0};
 let loss=0,n=0,time=0,touched=false,collisions=0;
 while(time<task.duration&&index<route.length){
  const target={...resolve(route[index]),hold:task.id==='stop'&&time%8>3&&time%8<5};
  if(task.id==='touch'&&time>1&&!touched){env.touchPulse=.35;touched=true;}
  const r=F.step(f,target,env,model,1/120,training,assist);loss+=r.loss;n++;time+=1/120;
  assert.ok(Number.isFinite(f.x+f.y+f.a+f.speed));assert.ok(f.x>=.025&&f.x<=.975&&f.y>=.025&&f.y<=.975);assert.ok(Math.abs(f.turn)<=3.20001);
  if(f.collision)collisions++;
  if(r.distance<(writing?.012:.04)&&!target.hold)index++;
 }
 return {success:index===route.length,error:Math.sqrt(loss/Math.max(1,n)),time,progress:index/route.length,collisions};
}
assert.equal(F.tasks.length,18);let improved=0;
for(const task of F.tasks){
 const m=new F.Learner(),baseline=episode(task,m,false,0);let train={error:1};
 for(let i=0;i<5;i++)train=episode(task,m,true,i===0?.8:F.clamp(train.error*.35,.08,.8));
 const before=JSON.stringify(m),result=episode(task,m,false,0);assert.equal(JSON.stringify(m),before,'evaluation must freeze weights and samples');
 console.log(task.id,JSON.stringify({baseline:baseline.progress,test:result.progress,error:result.error,time:result.time}));
 assert.ok(result.success,task.id+' must complete after training');if(result.error<baseline.error)improved++;
 const restored=new F.Learner(JSON.parse(JSON.stringify(m)));assert.deepEqual(restored.w,m.w);
}
assert.ok(improved>=14,'measured improvement across tasks');
const env=environment(F.tasks[0]),f={x:.5,y:.5,a:0,speed:0,turn:0},m=new F.Learner();
const noWind={...f};F.step(noWind,{x:.8,y:.5},env,m,.05,false,1);env.wind.power=1;const withWind={...f};F.step(withWind,{x:.8,y:.5},env,m,.05,false,1);assert.ok(withWind.x>noWind.x,'wind changes physical position');
const text=F.textPath('love you Ali');assert.ok(text.filter(p=>!p.pen).length>=10,'pen lifts separate letters');assert.ok(text.every(p=>p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1));
const custom=F.compileTask({id:'custom-drive',pattern:'drive',waypoints:[{x:2,y:-1},{x:.5,y:.5,hold:1}],duration:999});assert.equal(custom.kind,'flight');assert.equal(custom.waypoints.length,2);assert.deepEqual(custom.waypoints[0],{x:.97,y:.03,hold:0,pen:true});assert.equal(custom.duration,600);assert.ok(F.route(custom,env).length===2);
const customRun=F.compileTask({id:'custom-zigzag',pattern:'zigzag',duration:80}),customModel=new F.Learner();for(let i=0;i<3;i++)episode(customRun,customModel,true,.8);assert.ok(episode(customRun,customModel,false,0).success,'custom task must execute through the learned controller');
console.log('PASS: 18 tasks, executable custom tasks, frozen evaluation, persistent weights, bounded dynamics, wind and writing.');
