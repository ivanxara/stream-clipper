// Run: node tests/editor-media.cjs <clip.mp4> (PLAYWRIGHT_MODULE optional).
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
  const run = (...args) => { core.reset(); assert.equal(core.exec(...args), 0, logs.slice(-10).join('\n')); };
  run('-f','lavfi','-i','color=c=red:s=64x32:r=24:d=0.25','-f','lavfi','-i','color=c=lime:s=64x32:r=24:d=0.25',
    '-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0','-c:v','libx264','-pix_fmt','yuv420p','-y','motion.mp4');
  const mp4 = Buffer.from(core.FS.readFile('motion.mp4'));
  run('-i','motion.mp4','-c:v','mpeg4','-y','motion.mov');
  const mov = Buffer.from(core.FS.readFile('motion.mov'));
  // Two frames, with a transparent left pixel and red/green right pixel; 200/300 ms.
  const gif = Buffer.from([
    ...Buffer.from('GIF89a'),2,0,1,0,0x81,0,0,0,0,0,255,0,0,0,255,0,0,0,255,
    0x21,0xf9,4,9,20,0,0,0,0x2c,0,0,0,0,2,0,1,0,0,2,2,0x44,0x0a,0,
    0x21,0xf9,4,9,30,0,0,0,0x2c,0,0,0,0,2,0,1,0,0,2,2,0x84,0x0a,0,0x3b,
  ]);
  const server = http.createServer((req,res) => {
    const file = path.resolve(root, '.' + new URL(req.url,'http://localhost').pathname);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    res.setHeader('Content-Type', ({'.js':'text/javascript','.html':'text/html','.css':'text/css','.wasm':'application/wasm'})[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cross-Origin-Opener-Policy','same-origin'); res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
    fs.readFile(file,(err,data) => { res.statusCode = err ? 404 : 200; res.end(err ? '' : data); });
  });
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1366,height:768}}), errors = [];
    page.on('pageerror',e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/editor.html`);
    await page.setInputFiles('#fileInput',path.resolve(process.argv[2]));
    await page.waitForFunction(() => window.__editor?.st.mp4 && document.querySelector('#src').readyState >= 2);
    await page.evaluate(() => __editor.setLayout('original'));
    await page.click('#addElement'); await page.getByRole('button',{name:'Ficheiro',exact:true}).click();
    assert.match(await page.locator('#imageFiles').getAttribute('accept'), /video\/\*/);
    await page.setInputFiles('#imageFiles', [
      {name:'motion.gif',mimeType:'',buffer:gif},
      {name:'motion.mp4',mimeType:'video/mp4',buffer:mp4},
      {name:'converted.mov',mimeType:'video/quicktime',buffer:mov},
    ]);
    await page.waitForFunction(() => __editor.st.library.length === 3, null, {timeout:30000});
    await page.waitForFunction(() => !document.querySelector('#uploadImage').disabled);
    assert.equal(await page.locator('.recentImage').count(),3);
    if (process.env.MEDIA_SCREENSHOT) await page.screenshot({path:process.env.MEDIA_SCREENSHOT});
    const items = await page.evaluate(() => __editor.st.library.map(m => ({id:m.id,type:m.type,name:m.name})));
    assert.deepEqual(items.map(m => m.type),['gif','video','video']);
    const imported = await page.evaluate(async () => {
      const {parseMp4} = await import('./mp4.js');
      const {GifTrackReader} = await import('./media.js');
      const m = __editor.st.library[0], reader = await GifTrackReader.open(m.blob,m.frameDurations);
      const canvas = new OffscreenCanvas(2,1), ctx = canvas.getContext('2d'), pixels = [];
      try {
        for (const t of [.1,.3,.6]) { ctx.clearRect(0,0,2,1); ctx.drawImage(await reader.frameAt(t),0,0); pixels.push([...ctx.getImageData(0,0,2,1).data]); }
        return {duration:reader.duration,pixels,codec:parseMp4(await __editor.st.library[2].blob.arrayBuffer()).codec};
      } finally {reader.close();}
    });
    assert.equal(imported.duration,.5);
    assert.deepEqual(imported.pixels,[[0,0,0,0,255,0,0,255],[0,0,0,0,0,255,0,255],[0,0,0,0,255,0,0,255]]);
    assert.match(imported.codec,/^avc1/, 'MOV with MPEG-4 codec is converted to H.264');
    await page.click(`[data-image-id="${items[0].id}"]`);
    await page.waitForFunction(() => __editor.st.images[0]?._box);
    const gifId = await page.evaluate(() => __editor.st.images[0].id);
    await page.evaluate(() => { const e = __editor.st.images[0]; e.in = .1; e.out = 1.1; e.x = .25; });
    for (const [t,green] of [[.2,false],[.4,true],[.7,false]]) {
      await page.evaluate(t => { document.querySelector('#src').currentTime = t; },t);
      await page.waitForFunction(({id,green}) => {
        const p = __editor.previewMedia.get('element:'+id); if (!p?.img) return false;
        const c = new OffscreenCanvas(2,1), ctx = c.getContext('2d'); ctx.drawImage(p.img,0,0);
        const pixel = ctx.getImageData(1,0,1,1).data; return green ? pixel[1] > 200 : pixel[0] > 200;
      },{id:gifId,green});
    }
    await page.click('#addElement'); await page.click('#showImages');
    await page.click(`[data-image-id="${items[1].id}"]`);
    await page.waitForFunction(() => __editor.st.images[1]?._box);
    await page.evaluate(() => {
      Object.assign(__editor.st.images[1],{in:.2,out:1.2,x:.75});
      __editor.elementEditor.duplicate(); Object.assign(__editor.st.images[2],{in:.4,out:1.4,y:.8});
      document.querySelector('#src').currentTime=.55;
    });
    await page.waitForFunction(() => {
      const [a,b] = __editor.st.images.slice(1).map(e => __editor.previewMedia.get('element:'+e.id)?.el);
      return a && b && !a.seeking && !b.seeking && Math.abs(a.currentTime-.35)<.03 && Math.abs(b.currentTime-.15)<.03;
    });
    await page.evaluate(() => document.querySelector('#src').play());
    await page.waitForFunction(() => !__editor.previewMedia.get('element:'+__editor.st.images[1].id).el.paused);
    await page.evaluate(() => { const video=document.querySelector('#src'); video.pause(); video.currentTime=1.6; });
    await page.waitForFunction(() => __editor.st.images.every(e => {
      const p=__editor.previewMedia.get('element:'+e.id); return !p?.el || p.el.paused;
    }));
    assert.equal(await page.evaluate(() => __editor.st.layout),'original');
    await page.evaluate(() => { __editor.saveSession(); __editor.applyTemplateSnap(__editor.snapshot()); });
    await page.reload(); await page.waitForFunction(() => window.__editor?.st.mp4 && __editor.st.images.length === 3);
    assert.deepEqual(await page.evaluate(() => __editor.st.images.map(e => e.in)),[.1,.2,.4]);
    // Observe frames sent to the real H.264 encoder, including a cut and a loop.
    const encoded = await page.evaluate(async () => {
      const Native = window.VideoEncoder, samples = [], canvas = new OffscreenCanvas(320,180), ctx = canvas.getContext('2d');
      const {st} = __editor; st.start=0; st.end=1.25; st.parts=[{start:0,end:.5},{start:.75,end:1.25}];
      st.images[0].size=.4; st.images[1].size=.3; st.images[2].size=.2;
      window.VideoEncoder = class {
        constructor(init) {this.encoder=new Native(init);} static isConfigSupported(c) {return Native.isConfigSupported(c);}
        configure(c) {this.encoder.configure(c);} get encodeQueueSize() {return this.encoder.encodeQueueSize;}
        encode(frame,opts) {ctx.drawImage(frame,0,0,320,180); samples.push({t:frame.timestamp/1e6,gif:[...ctx.getImageData(110,90,1,1).data],video:[...ctx.getImageData(240,90,1,1).data]});this.encoder.encode(frame,opts);}
        flush() {return this.encoder.flush();} close() {this.encoder.close();}
      };
      try {const result=await __editor.encodeVideo(()=>{}); return {bytes:result.h264.size,samples};}
      finally {window.VideoEncoder=Native;}
    });
    assert(encoded.bytes>100);
    let checked=0;
    for (const sample of encoded.samples) {
      const source = sample.t < .5 ? sample.t : sample.t + .25;
      if (source>.11 && source<1.09) {
        const phase=(source-.1)%.5;
        if (Math.abs(phase-.2)>.02) {assert(sample.gif[phase<.2?0:1]>220,'GIF remains animated after cuts'); checked++;}
      }
      if (source>.21 && source<1.19) {
        const phase=(source-.2)%.5;
        if (Math.abs(phase-.25)>.04) assert(sample.video[phase<.25?0:1]>180 && sample.video[phase<.25?1:0]<60,`MP4 frame follows element timing: source=${source}, phase=${phase}, pixel=${sample.video}`);
      }
    }
    assert(checked>10);
    await page.click('#addElement'); await page.click('#showImages');
    assert.equal(await page.locator('#videoFraming p, #elementPicker p').count(),0, 'panels have no explanatory paragraphs');
    const count = await page.evaluate(() => __editor.st.images.length);
    await page.click(`[data-delete-media="${items[0].id}"]`);
    assert.match(await page.locator('#status').innerText(),/Remove primeiro/, 'in-use assets remain available for rendering');
    page.once('dialog',dialog => dialog.dismiss());
    await page.click(`[data-delete-media="${items[2].id}"]`);
    assert.equal(await page.locator('.recentImage').count(),3, 'cancelling preserves the file');
    page.once('dialog',dialog => dialog.accept());
    await page.click(`[data-delete-media="${items[2].id}"]`);
    await page.waitForFunction(() => __editor.st.library.length===2);
    assert.equal(await page.evaluate(() => __editor.st.images.length),count, 'delete button does not insert an element');
    const png = await page.evaluate(() => {
      const c=document.createElement('canvas'); c.width=c.height=8;
      return c.toDataURL().split(',')[1];
    });
    await page.setInputFiles('#imageFiles',{name:'delete-me.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
    await page.waitForFunction(() => __editor.st.library.some(m=>m.name==='delete-me') && !document.querySelector('#uploadImage').disabled);
    const imageId=await page.evaluate(() => __editor.st.library.find(m=>m.name==='delete-me').id);
    if (process.env.MEDIA_SCREENSHOT) await page.screenshot({path:process.env.MEDIA_SCREENSHOT});
    page.once('dialog',dialog => dialog.accept());
    await page.click(`[data-delete-media="${imageId}"]`);
    await page.waitForFunction(() => __editor.st.library.length===2);
    await page.reload(); await page.waitForFunction(() => window.__editor?.st.mp4);
    const remaining=await page.evaluate(async () => (await (await import('./clipstore.js')).listMedia()).map(m=>m.id));
    assert.deepEqual(remaining,items.slice(0,2).map(m=>m.id), 'deleted uploads stay deleted after reload');
    assert.deepEqual(errors,[]);
    console.log('PASS: GIF timing/transparency/loop, MP4 and MOV uploads, codec conversion, independent video instances, preview seeking, session/templates and animated H.264 export across cuts.');
  } finally {await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
