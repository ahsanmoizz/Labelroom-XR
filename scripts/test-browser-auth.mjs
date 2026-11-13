import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {buildSync} from 'esbuild';
import {chromium} from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2], shots = process.env.LABELXR_AUTH_SCREENSHOTS;
if (!output || !path.isAbsolute(output) || fs.existsSync(output)) throw Error('Pass a new absolute report path.');
if (shots) { assert(path.isAbsolute(shots)); fs.mkdirSync(shots, {recursive: true}); }
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labelxr-auth-'));
const contents = `export {createAccountWorkspace} from ${JSON.stringify(path.join(root, 'src/app/private-scope.ts'))};export {createChallenge} from ${JSON.stringify(path.join(root, 'src/services/captcha.ts'))};export {mountLoginPanel} from ${JSON.stringify(path.join(root, 'src/ui/login.ts'))};`;
buildSync({stdin: {contents, resolveDir: root}, bundle: true, format: 'esm', platform: 'browser', target: 'esnext', outfile: path.join(temp, 'bridge.mjs'), logLevel: 'silent'});
const assets = new Map([
  ['/auth-bridge.mjs', [fs.readFileSync(path.join(temp, 'bridge.mjs')), 'text/javascript']],
  ['/auth-fixture.mjs', [fs.readFileSync(path.join(root, 'tests/integration/auth-browser-fixture.mjs')), 'text/javascript']],
  ['/workspace.css', [fs.readFileSync(path.join(root, 'src/ui/workspace.css')), 'text/css']],
  ['/brand-mark.svg', [fs.readFileSync(path.join(root, 'public/brand-mark.svg')), 'image/svg+xml']],
  ['/review-scene.svg', [fs.readFileSync(path.join(root, 'public/review-scene.svg')), 'image/svg+xml']],
  ['/', [Buffer.from('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Auth layout fixture · no live provider</title><link rel="stylesheet" href="/workspace.css"></head><body><aside id="account-container" aria-label="Account access"></aside><script type="module" src="/auth-fixture.mjs"></script></body></html>'), 'text/html']]
]);
const server = http.createServer((req, res) => { const a = assets.get(req.url); if (req.method !== 'GET' || !a) { res.writeHead(404).end(); return; } res.writeHead(200, {'Content-Type': a[1], 'Cache-Control': 'no-store'}); res.end(a[0]); });
let browser, blocked = 0; const errors = [], cases = [], layouts = [];
let report;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://127.0.0.1:' + server.address().port;
  const explicit = process.env.LABELXR_CHROMIUM_PATH;
  browser = await chromium.launch({headless: true, ...(explicit ? {executablePath: explicit} : {}), args: process.platform === 'linux' ? ['--no-sandbox'] : []});
  const context = await browser.newContext();
  await context.route('**/*', route => { if (new URL(route.request().url()).origin === origin) return route.continue(); blocked++; return route.abort('blockedbyclient'); });
  const open = async (width = 1366, height = 900) => { const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.setViewportSize({width, height}); await page.goto(origin); await page.waitForFunction(() => window.labelxrAuth?.state().challenge === 'waiting'); return page; };
  const close = async page => { await page.evaluate(() => window.labelxrAuth.dispose()); await page.close(); };
  for (const [width, height] of [[1920,1080],[1366,768],[1100,800],[900,900],[768,1024],[640,480],[390,844],[320,800]]) {
    const page = await open(width, height);
    const measured = await page.evaluate(() => {
      const rect = e => { const r = e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; };
      const card = document.querySelector('.account-card'), host = document.querySelector('.captcha-host'), widget = host.querySelector('iframe'), brand = document.querySelector('.account-brand');
      return {width:innerWidth, documentWidth:document.documentElement.clientWidth, scrollWidth:document.documentElement.scrollWidth, card:rect(card), cardClient:card.clientWidth, cardScroll:card.scrollWidth, host:rect(host), widget:rect(widget), wordmark:rect(brand.querySelector('.brand-wordmark')), brand:rect(brand), markLoaded:brand.querySelector('img').complete && brand.querySelector('img').naturalWidth > 0, buttons:[...card.querySelectorAll('button')].filter(b=>b.getClientRects().length).map(rect), fields:[...card.querySelectorAll('input')].filter(b=>b.getClientRects().length).map(rect), sizes:window.labelxrAuth.state().sizes};
    });
    assert(measured.scrollWidth <= measured.documentWidth + 1, 'Entry page scrolls horizontally');
    assert(measured.cardScroll <= measured.cardClient + 1, 'Entry card clips horizontal content');
    assert(measured.widget.x >= measured.host.x - 1 && measured.widget.right <= measured.host.right + 1, 'Security footprint is clipped');
    assert(measured.widget.right <= width && measured.widget.x >= 0, 'Security footprint escapes viewport');
    assert(measured.card.y >= 0 && measured.brand.y >= 0, 'Entry header is scrolled above its initial viewport');
    assert(measured.wordmark.right <= measured.card.right - 12, 'Full wordmark is clipped'); assert(measured.markLoaded);
    assert.equal(measured.sizes.at(-1), measured.host.width < 300 ? 'compact' : 'flexible');
    for (const b of [...measured.buttons, ...measured.fields]) assert(b.height >= 47 && b.width >= 44, 'Entry target is too small');
    assert.equal(await page.getByRole('button', {name:'Send code',exact:true}).isDisabled(), true);
    assert.equal(await page.getByRole('button', {name:'Enter demo',exact:true}).isDisabled(), true);
    if (shots) await page.screenshot({path:path.join(shots, `entry-${width}x${height}.png`), fullPage:true});
    layouts.push({viewport:{width,height},horizontalOverflow:false,securityFootprintFits:true,fullWordmarkFits:true,widgetSize:measured.sizes.at(-1)});
    cases.push({name:`Entry and security footprint at ${width} × ${height}`,passed:true}); await close(page);
  }
  const test = async (name, run) => { const page = await open(); try { await run(page); cases.push({name,passed:true}); } finally { await close(page); } };
  await test('Email-code sign-in preserves leading zeroes and authenticates only after verification', async p => {
    await p.getByLabel('Email address',{exact:true}).fill('reviewer@example.com'); await p.evaluate(()=>window.labelxrAuth.solve()); await p.getByRole('button',{name:'Send code',exact:true}).click();
    await p.getByLabel('Email code',{exact:true}).waitFor(); assert.equal(await p.getByLabel('Email address',{exact:true}).evaluate(e=>e.readOnly),true);
    await p.getByLabel('Email code',{exact:true}).fill('00012345'); await p.getByRole('button',{name:'Verify code',exact:true}).click(); await p.waitForFunction(()=>window.labelxrAuth.state().kind==='member');
    const state=await p.evaluate(()=>window.labelxrAuth.state()); assert.equal(state.calls.filter(c=>c.operation==='requestCode').length,1); assert.equal(state.calls.find(c=>c.operation==='verifyCode').code,'00012345'); assert(state.noTokenInDom); assert.equal(await p.locator('#account-container').getAttribute('data-account-state'),'connected');
  });
  await test('Rejected email code stays recoverable and shows fixed feedback', async p => {
    await p.getByLabel('Email address',{exact:true}).fill('reviewer@example.com'); await p.evaluate(()=>window.labelxrAuth.solve()); await p.getByRole('button',{name:'Send code',exact:true}).click(); await p.getByLabel('Email code',{exact:true}).fill('000000'); await p.getByRole('button',{name:'Verify code',exact:true}).click(); await p.getByRole('alert').filter({hasText:'That code was not accepted.'}).waitFor(); assert.equal(await p.getByLabel('Email code',{exact:true}).inputValue(),''); assert.equal((await p.evaluate(()=>window.labelxrAuth.state())).kind,null);
  });
  await test('Demo entry consumes one challenge and returns to the compact account card', async p => {
    await p.evaluate(()=>window.labelxrAuth.solve()); await p.getByRole('button',{name:'Enter demo',exact:true}).click(); await p.waitForFunction(()=>window.labelxrAuth.state().kind==='guest'); const state=await p.evaluate(()=>window.labelxrAuth.state()); assert.equal(state.calls.filter(c=>c.operation==='enterGuest').length,1); assert.equal(state.challenge,'idle'); assert.equal(await p.locator('.entry-story').isVisible(),false); assert.equal(await p.getByLabel('Email address',{exact:true}).isVisible(),false);
  });
  await test('Sign-out clears private entry values and requires a fresh security challenge', async p => {
    await p.evaluate(()=>window.labelxrAuth.solve()); await p.getByRole('button',{name:'Enter demo',exact:true}).click(); await p.getByRole('button',{name:'Sign out',exact:true}).click(); await p.waitForFunction(()=>window.labelxrAuth.state().phase==='signed-out'&&window.labelxrAuth.state().sizes.length===2); assert.equal(await p.getByLabel('Email address',{exact:true}).inputValue(),''); assert.equal(await p.locator('#account-container').getAttribute('data-account-state'),'entry'); assert.equal(await p.getByRole('button',{name:'Enter demo',exact:true}).isDisabled(),true);
  });
  await test('Narrow resize retires the old challenge and fits compact branding without token reuse', async p => {
    await p.evaluate(()=>window.labelxrAuth.solve()); await p.setViewportSize({width:320,height:800}); await p.waitForFunction(()=>window.labelxrAuth.state().sizes.at(-1)==='compact'); await p.evaluate(()=>window.labelxrAuth.oldCallback()); assert.equal((await p.evaluate(()=>window.labelxrAuth.state())).challenge,'waiting'); assert.equal(await p.getByRole('button',{name:'Enter demo',exact:true}).isDisabled(),true); const fits=await p.locator('.captcha-host iframe').evaluate(e=>e.getBoundingClientRect().right<=innerWidth); assert(fits);
  });
  await test('Expired security remains gated until explicit retry and fresh completion', async p => {
    await p.evaluate(()=>{window.labelxrAuth.solve();window.labelxrAuth.expire();}); assert.equal(await p.getByRole('button',{name:'Send code',exact:true}).isDisabled(),true); await p.getByRole('button',{name:'Retry security check',exact:true}).click(); await p.waitForFunction(()=>window.labelxrAuth.state().sizes.length===2); await p.evaluate(()=>window.labelxrAuth.solve()); assert.equal(await p.getByRole('button',{name:'Enter demo',exact:true}).isDisabled(),false);
  });
  assert.equal(blocked,0); assert.deepEqual(errors,[]);
  report={schema:'labelxr-auth-entry-browser/v1',passed:true,count:cases.length,cases,layouts,browser:browser.version(),actualDomAndCssMeasured:true,actualAuthAndChallengeControllers:true,syntheticProvider:true,providerFootprintFixture:true,liveCloudflareBrandingVerified:false,liveEmailOrGuestAuthVerified:false,blockedExternalRequests:blocked,pageErrors:errors};
} catch (error) { report={schema:'labelxr-auth-entry-browser/v1',passed:false,count:cases.length,cases,error:String(error?.stack??error).slice(0,8000),pageErrors:errors,blockedExternalRequests:blocked,liveEmailOrGuestAuthVerified:false}; process.exitCode=1; }
finally { fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'}); await browser?.close(); await new Promise(r=>server.close(r)); fs.rmSync(temp,{recursive:true,force:true}); console.log(JSON.stringify({passed:report.passed,count:cases.length,error:report.error,report:output})); }
