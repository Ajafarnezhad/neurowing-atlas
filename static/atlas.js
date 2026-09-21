
"use strict";
class SWCAtlasRenderer{
  constructor(canvas){
    this.canvas=canvas;this.gl=canvas.getContext("webgl",{alpha:true,antialias:false,preserveDrawingBuffer:true});
    this.ok=!!this.gl;this.buffers=[];this.active=new Map();this.bbox=null;this.camera={rx:-.25,ry:.45,zoom:1.2,panX:0,panY:0};
    if(this.ok)this._init();
  }
  _shader(type,src){const g=this.gl,s=g.createShader(type);g.shaderSource(s,src);g.compileShader(s);if(!g.getShaderParameter(s,g.COMPILE_STATUS))throw new Error(g.getShaderInfoLog(s));return s}
  _init(){
    const g=this.gl;
    const vs=this._shader(g.VERTEX_SHADER,`
      attribute vec3 p;uniform vec3 center;uniform float scale;uniform vec2 rot;uniform float zoom;uniform vec2 pan;uniform float aspect;
      void main(){vec3 q=(p-center)/scale;float cy=cos(rot.y),sy=sin(rot.y);float cx=cos(rot.x),sx=sin(rot.x);
        vec3 a=vec3(q.x*cy+q.z*sy,q.y,-q.x*sy+q.z*cy);
        vec3 b=vec3(a.x,a.y*cx-a.z*sx,a.y*sx+a.z*cx);
        gl_Position=vec4(b.x*zoom/aspect+pan.x,b.y*zoom+pan.y,clamp(b.z*.12,-.9,.9),1.0);}`);
    const fs=this._shader(g.FRAGMENT_SHADER,`precision mediump float;uniform vec4 color;void main(){gl_FragColor=color;}`);
    this.prog=g.createProgram();g.attachShader(this.prog,vs);g.attachShader(this.prog,fs);g.linkProgram(this.prog);
    this.aPos=g.getAttribLocation(this.prog,"p");this.u={center:g.getUniformLocation(this.prog,"center"),scale:g.getUniformLocation(this.prog,"scale"),rot:g.getUniformLocation(this.prog,"rot"),zoom:g.getUniformLocation(this.prog,"zoom"),pan:g.getUniformLocation(this.prog,"pan"),aspect:g.getUniformLocation(this.prog,"aspect"),color:g.getUniformLocation(this.prog,"color")};
    g.enable(g.BLEND);g.blendFunc(g.SRC_ALPHA,g.ONE_MINUS_SRC_ALPHA);
  }
  setBBox(b){this.bbox=b}
  clear(){const g=this.gl;if(g){for(const x of this.buffers)g.deleteBuffer(x.b);for(const x of this.active.values())g.deleteBuffer(x.b)}this.buffers=[];this.active.clear()}
  addBatch(vertices){
    if(!this.ok||!vertices?.length)return;const g=this.gl,b=g.createBuffer();g.bindBuffer(g.ARRAY_BUFFER,b);g.bufferData(g.ARRAY_BUFFER,new Float32Array(vertices),g.STATIC_DRAW);this.buffers.push({b,count:vertices.length/3})
  }
  addActive(id,vertices){
    if(!this.ok||!vertices?.length||this.active.has(id))return;const g=this.gl,b=g.createBuffer();g.bindBuffer(g.ARRAY_BUFFER,b);g.bufferData(g.ARRAY_BUFFER,new Float32Array(vertices),g.STATIC_DRAW);this.active.set(id,{b,count:vertices.length/3})
  }
  fit(){this.camera={rx:-.25,ry:.45,zoom:1.2,panX:0,panY:0}}
  render(activity={},selected=null,pathNodes=new Set()){
    if(!this.ok)return;const g=this.gl,c=this.canvas,r=c.getBoundingClientRect(),d=Math.min(2,devicePixelRatio||1),W=Math.max(1,Math.floor(r.width*d)),H=Math.max(1,Math.floor(r.height*d));
    if(c.width!==W||c.height!==H){c.width=W;c.height=H}g.viewport(0,0,W,H);g.clearColor(0,0,0,0);g.clear(g.COLOR_BUFFER_BIT);g.useProgram(this.prog);
    const b=this.bbox||[0,0,0,1,1,1],cx=(b[0]+b[3])/2,cy=(b[1]+b[4])/2,cz=(b[2]+b[5])/2,scale=Math.max(1,b[3]-b[0],b[4]-b[1],b[5]-b[2])/2;
    g.uniform3f(this.u.center,cx,cy,cz);g.uniform1f(this.u.scale,scale);g.uniform2f(this.u.rot,this.camera.rx,this.camera.ry);g.uniform1f(this.u.zoom,this.camera.zoom);g.uniform2f(this.u.pan,this.camera.panX,this.camera.panY);g.uniform1f(this.u.aspect,W/H);
    g.enableVertexAttribArray(this.aPos);
    const draw=(x,col)=>{g.bindBuffer(g.ARRAY_BUFFER,x.b);g.vertexAttribPointer(this.aPos,3,g.FLOAT,false,0,0);g.uniform4f(this.u.color,...col);g.drawArrays(g.LINES,0,x.count)};
    for(const x of this.buffers)draw(x,[.34,.48,.56,.055]);
    for(const [id,x] of this.active){
      const a=Math.max(0,Math.min(1,activity[id]||0));let col=[1,.34,.93,.15+a*.8];
      if(pathNodes.has(id))col=[.36,.96,.68,.72];if(id===selected)col=[1,1,1,.95];draw(x,col)
    }
  }
}
window.SWCAtlasRenderer=SWCAtlasRenderer;
