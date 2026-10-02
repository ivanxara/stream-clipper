// Run: node tests/editor-alpha.cjs <clip.mp4> [original-alpha.mov]
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');

(async () => {
  const root = path.resolve(__dirname, '..');
  globalThis.self = { location: { href: pathToFileURL(path.join(root, 'lib/core/ffmpeg-core.js')).href } };
  const { default: createCore } = await import(self.location.href);
  const core = await createCore({ wasmBinary: fs.readFileSync(path.join(root, 'lib/core/ffmpeg-core.wasm')) });
  const logs = []; core.setLogger(({message}) => logs.push(message));
  const run = (...args) => { core.reset(); try { assert.equal(core.exec(...args),0,logs.slice(-12).join('\n')); } catch(e) { console.error(args.at(-1),logs.slice(-12).join('\n')); throw e; } };
  const raw = Buffer.alloc(64*32*4*3);
  for (let frame=0;frame<3;frame++) for (let y=0;y<32;y++) for (let x=0;x<64;x++) {
    const pixel=(frame*64*32+y*64+x)*4;
    // Transparent | opaque black | half-transparent red | changing opaque color.
    raw[pixel]=x>=32 && x<48 ? 255 : 0;
    raw[pixel+1]=x>=48 && frame!==1 ? 255 : 0;
    raw[pixel+2]=x>=48 && frame===1 ? 255 : 0;
    raw[pixel+3]=x<16 ? 0 : x<32 ? 255 : x<48 ? 128 : 255;
  }
  core.FS.writeFile('rgba.raw',raw);
  const variants = [
    ['prores.mov',['-c:v','prores_ks','-profile:v','4','-alpha_bits','16','-pix_fmt','yuva444p10le']],
    ['qtrle.mov',['-c:v','qtrle','-pix_fmt','argb']],
    ['png.mov',['-c:v','png','-pix_fmt','rgba']],
    ['ffv1.mkv',['-c:v','ffv1','-pix_fmt','bgra']],
    ['alpha.webm',['-c:v','libvpx-vp9','-threads','1','-cpu-used','8','-lossless','1','-pix_fmt','yuva420p','-auto-alt-ref','0']],
  ];
  const uploads = [];
  for (const [name,codec] of variants) {
    run('-f','rawvideo','-pixel_format','rgba','-video_size','64x32','-framerate','4','-i','rgba.raw',...codec,'-y',name);
    uploads.push({name,mimeType:'',buffer:Buffer.from(core.FS.readFile(name))});
  }
  let originalReference;
  if (process.argv[3]) {
    const file=path.resolve(process.argv[3]);
    uploads.push({name:path.basename(file),mimeType:'video/quicktime',buffer:fs.readFileSync(file)});
    core.FS.writeFile('original.mov',fs.readFileSync(file));
    run('-i','original.mov','-frames:v','1','-pix_fmt','rgba','-f','rawvideo','-y','original.raw');
    originalReference=Buffer.from(core.FS.readFile('original.raw'));
  }
  const server=http.createServer((req,res)=>{
    const file=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
    if (!file.startsWith(root+path.sep)) {res.writeHead(403);res.end();return;}
    res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.css':'text/css','.wasm':'application/wasm'})[path.extname(file)]||'application/octet-stream');
    res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
    fs.readFile(file,(e,b)=>{res.statusCode=e?404:200;res.end(e?'':b);});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1366,height:768}}), errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/editor.html`);
    await page.setInputFiles('#fileInput',path.resolve(process.argv[2]));
    await page.waitForFunction(()=>window.__editor?.st.mp4 && document.querySelector('#src').readyState>=2);
    await page.evaluate(()=>__editor.setLayout('original'));
    await page.click('#addElement');await page.click('#showImages');
    await page.setInputFiles('#imageFiles',uploads);
    await page.waitForFunction(n=>__editor.st.library.length===n,uploads.length,{timeout:120000});
    await page.waitForFunction(()=>!document.querySelector('#uploadImage').disabled);
    const results=await page.evaluate(async ()=>{
      const {openMediaReader}=await import('./media.js');
      const results=[];
      for (const m of __editor.st.library) {
        const reader=await openMediaReader(m), c=new OffscreenCanvas(m.w,m.h),ctx=c.getContext('2d');
        const pixels=[];
        try {
          for (const t of [0,.3,.6,1.05,.1]) {
            const frame=await reader.frameAt(t%reader.duration); ctx.clearRect(0,0,m.w,m.h);ctx.drawImage(frame,0,0);
            pixels.push([8,24,40,56].map(x=>[...ctx.getImageData(x,16,1,1).data]));
          }
          const first=await reader.frameAt(0);ctx.clearRect(0,0,m.w,m.h);ctx.drawImage(first,0,0);
          const alpha=[...ctx.getImageData(0,0,m.w,m.h).data].filter((_,i)=>i%4===3);
          results.push({name:m.name,alphaLayout:m.alphaLayout,w:m.w,h:m.h,dur:m.dur,pixels,alpha,original:m.sourceBlob.size>0});
        } finally {reader.close();}
      }
      return results;
    });
    for (const r of results.slice(0,variants.length)) {
      assert.equal(r.alphaLayout,'side-by-side',r.name);assert.equal(r.w,64);assert.equal(r.h,32);assert(r.original);
      for (let i=0;i<r.pixels.length;i++) {
        const [transparent,black,red,color]=r.pixels[i];
        assert(transparent[3]<=2,`${r.name}: transparent=${transparent}`);
        assert(black[3]>=253 && black[0]<5 && black[1]<5 && black[2]<5,`${r.name}: real black stays opaque`);
        assert(Math.abs(red[3]-128)<=3 && red[0]>245,`${r.name}: semi-transparent red=${red}`);
        assert(color[[0,1,0,1,0][i]?2:1]>245,`${r.name}: animation/loop/seek frame ${i}=${color}`);
      }
    }
    if (originalReference) {
      const actual=results.at(-1).alpha,expected=[...originalReference].filter((_,i)=>i%4===3);
      assert.equal(actual.length,expected.length);
      let maxError=0;for(let i=0;i<actual.length;i++) maxError=Math.max(maxError,Math.abs(actual[i]-expected[i]));
      assert(expected.some(a=>a===0),'actual MOV contains transparent pixels');
      assert(maxError<=3,`actual MOV alpha error ${maxError}`);
      console.log(`Original MOV: ${results.at(-1).w}x${results.at(-1).h}, alpha max error ${maxError}/255.`);
    }
    // Insert and preview against a real clip, then replace without changing element geometry.
    const first=await page.evaluate(()=>__editor.st.library[0].id);
    await page.click(`[data-image-id="${first}"]`);
    await page.waitForFunction(()=>__editor.st.images[0]?._box);
    await page.evaluate(()=>{const e=__editor.st.images[0];e.size=.8;e.x=.5;e.y=.5;e.in=.1;e.out=1.4;document.querySelector('#src').currentTime=.2;});
    await page.waitForFunction(()=>__editor.previewMedia.get('element:'+__editor.st.images[0].id)?.img);
    await page.click('#elementOptions summary');
    const before=await page.evaluate(()=>{const {_box,...e}=__editor.st.images[0];return e;});
    await page.setInputFiles('#replacementFile',uploads[1]);
    await page.waitForFunction(id=>__editor.libItem(id).name==='qtrle',first);
    assert.deepEqual(await page.evaluate(()=>{const {_box,...e}=__editor.st.images[0];return e;}),before);
    // Export: compare transparent/opaque/semi-transparent pixels against the main video.
    const encoded=await page.evaluate(async ()=>{
      const Native=window.VideoEncoder,samples=[],c=new OffscreenCanvas(320,180),ctx=c.getContext('2d');
      __editor.st.parts=[{start:0,end:.5},{start:.75,end:1.5}];
      window.VideoEncoder=class {
        constructor(init){this.encoder=new Native(init);}static isConfigSupported(c){return Native.isConfigSupported(c);}
        configure(c){this.encoder.configure(c);}get encodeQueueSize(){return this.encoder.encodeQueueSize;}
        encode(frame,opts){ctx.drawImage(frame,0,0,320,180);samples.push({t:frame.timestamp/1e6,pixels:[64,128,192,256].map(x=>[...ctx.getImageData(x,90,1,1).data])});this.encoder.encode(frame,opts);}
        flush(){return this.encoder.flush();}close(){this.encoder.close();}
      };
      try {const result=await __editor.encodeVideo(()=>{});return {size:result.h264.size,samples};}finally{window.VideoEncoder=Native;}
    });
    assert(encoded.size>100);
    let checked=0;
    for (const s of encoded.samples) {
      const source=s.t<.5?s.t:s.t+.25;
      if(source<.11||source>1.39)continue;
      assert(s.pixels[0].some((v,i)=>i<3&&v>60),'transparent area reveals source video');
      assert(s.pixels[1].slice(0,3).every(v=>v<5),'opaque black object remains black');
      assert(s.pixels[2][0]>120,'semi-transparent red is composited');checked++;
    }
    assert(checked>15);
    await page.evaluate(()=>{__editor.saveSession();__editor.applyTemplateSnap(__editor.snapshot());});
    await page.reload();await page.waitForFunction(()=>window.__editor?.st.mp4&&__editor.st.images[0]?._box);
    assert.equal(await page.evaluate(()=>__editor.libItem(__editor.st.images[0].mediaId).alphaLayout),'side-by-side');
    assert.deepEqual(errors,[]);
    console.log('PASS: automatic alpha detection for ProRes/QTRLE/PNG/FFV1/VP9, transparency/soft alpha/opaque black, seek/loop, replacement, persistence and H.264 composition across cuts.');
  }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
