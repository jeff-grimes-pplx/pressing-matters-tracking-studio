import { chromium } from '/home/user/node_modules/playwright/index.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const ROOT_DIR = '/home/user/workspace/pressing-matters-studio';
const APP_DIR = path.join(ROOT_DIR, 'app');
const VIDEO_DIR = path.join(ROOT_DIR, 'video');
const RAW_DIR = path.join(VIDEO_DIR, 'raw_scenes');

const scenesMeta = JSON.parse(
  fs.readFileSync(path.join(VIDEO_DIR, 'audio', 'scenes_meta.json'), 'utf8')
);
const durMap = Object.fromEntries(scenesMeta.map((s) => [s.id, s.scene_dur]));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let reqPath = req.url.split('?')[0];
      if (reqPath === '/') reqPath = '/index.html';
      const fullPath = path.join(APP_DIR, reqPath);
      if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(fullPath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(fullPath).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}

class SceneRecorder {
  constructor(page) {
    this.page = page;
    this.lastBuffer = null;
  }

  async initCursorAndViewport() {
    await this.page.evaluate(() => {
      document.documentElement.style.height = '1016px';
      document.body.style.height = '1016px';
      const app = document.getElementById('app');
      if (app) {
        app.style.height = '1016px';
        app.style.transformOrigin = '0 0';
      }
      let footerBg = document.getElementById('video-caption-gutter');
      if (!footerBg) {
        footerBg = document.createElement('div');
        footerBg.id = 'video-caption-gutter';
        footerBg.style.cssText =
          'position:fixed;left:0;right:0;bottom:0;height:64px;background:#070A0F;border-top:1px solid #1E2938;z-index:9998;pointer-events:none;';
        document.body.appendChild(footerBg);
      }
      let cur = document.getElementById('showcase-cursor');
      if (!cur) {
        cur = document.createElement('div');
        cur.id = 'showcase-cursor';
        cur.style.cssText = [
          'position:fixed',
          'left:960px',
          'top:480px',
          'width:26px',
          'height:26px',
          'margin-left:-13px',
          'margin-top:-13px',
          'border-radius:50%',
          'border:2.5px solid #F4A629',
          'background:rgba(244,166,41,0.22)',
          'box-shadow:0 0 14px rgba(244,166,41,0.55)',
          'pointer-events:none',
          'z-index:9999',
          'display:flex',
          'align-items:center',
          'justify-content:center',
        ].join(';');
        const dot = document.createElement('div');
        dot.style.cssText =
          'width:7px;height:7px;border-radius:50%;background:#FFFFFF;box-shadow:0 0 4px #000;';
        cur.appendChild(dot);
        document.body.appendChild(cur);
      }
      window.dispatchEvent(new Event('resize'));
    });
  }

  async setCursor(x, y, pressed = false) {
    await this.page.evaluate(
      ({ x, y, pressed }) => {
        const cur = document.getElementById('showcase-cursor');
        if (!cur) return;
        cur.style.left = `${x}px`;
        cur.style.top = `${y}px`;
        cur.style.transform = pressed ? 'scale(0.82)' : 'scale(1.0)';
        cur.style.background = pressed
          ? 'rgba(244,166,41,0.52)'
          : 'rgba(244,166,41,0.22)';
      },
      { x, y, pressed }
    );
  }

  async setCameraTransform(scale = 1.0, focusX = 960, focusY = 508) {
    await this.page.evaluate(
      ({ scale, focusX, focusY }) => {
        const app = document.getElementById('app');
        if (!app) return;
        if (Math.abs(scale - 1.0) < 0.002) {
          app.style.transform = 'none';
          return;
        }
        const W = 1920;
        const H = 1016;
        let tx = W / 2 - focusX * scale;
        let ty = H / 2 - focusY * scale;
        const minTx = W - W * scale;
        const minTy = H - H * scale;
        tx = Math.min(0, Math.max(minTx, tx));
        ty = Math.min(0, Math.max(minTy, ty));
        app.style.transformOrigin = '0 0';
        app.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${scale.toFixed(4)})`;
      },
      { scale, focusX, focusY }
    );
  }

  async renderScene(sceneId, durationSec, stepFn) {
    const outPath = path.join(RAW_DIR, `${sceneId}.mp4`);
    const totalFrames = Math.round(durationSec * 30);
    console.log(`Re-rendering ${sceneId} (${durationSec.toFixed(2)}s, ${totalFrames} frames)...`);

    const ff = spawn('ffmpeg', [
      '-y',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-framerate', '30',
      '-i', '-',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '17',
      '-pix_fmt', 'yuv420p',
      outPath,
    ]);

    for (let f = 0; f < totalFrames; f++) {
      const t = f / 30;
      const dirty = await stepFn(f, t, totalFrames, durationSec);
      if (dirty || !this.lastBuffer) {
        this.lastBuffer = await this.page.screenshot({ type: 'jpeg', quality: 94 });
      }
      const ok = ff.stdin.write(this.lastBuffer);
      if (!ok) await new Promise((r) => ff.stdin.once('drain', r));
    }
    ff.stdin.end();
    await new Promise((resolve) => ff.on('close', resolve));
  }
}

async function getPitchCoords(page, xm, ym) {
  return await page.evaluate(({ xm, ym }) => window.__studio.toViewport(xm, ym), { xm, ym });
}

async function getCenterOfSelector(page, selector) {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { x: 960, y: 500 };
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);
}

async function main() {
  const { server, port } = await startServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2400);

  const rec = new SceneRecorder(page);
  await rec.initCursorAndViewport();
  await page.waitForTimeout(200);

  // Set baseline 88:11 state
  await page.evaluate(async () => {
    document.querySelector('[data-view="2d"]').click();
    document.querySelector('[data-mode="control"]').click();
    await window.__studio.clearWhatIf();
    await window.__studio.seek(2, 64794);
  });
  await page.waitForTimeout(200);

  const musialaPos = await getPitchCoords(page, -33.76, -11.34);
  const canceloPos = await getPitchCoords(page, -40.26, -15.32);
  const mEnd2D = await getPitchCoords(page, -32.09, -23.78);
  const row1Pos = await getCenterOfSelector(page, '#optionsTable tbody tr:nth-child(1)');
  const row2Pos = await getCenterOfSelector(page, '#optionsTable tbody tr:nth-child(2)');

  // =========================================================================
  // SCENE 4 (s04): Keep 1.0x full-screen view so BOTH the left-wing pass geometry AND the right-rail PASSING OPTIONS table are 100% visible!
  // =========================================================================
  await rec.setCameraTransform(1.0);
  await rec.renderScene('s04', durMap.s04, async (f, t) => {
    if (f === 0) {
      await rec.setCursor(canceloPos.x, canceloPos.y, false);
      return true;
    }
    if (t >= 0.8 && t <= 2.6) {
      const p = easeInOutCubic((t - 0.8) / 1.8);
      await rec.setCursor(lerp(canceloPos.x, row1Pos.x, p), lerp(canceloPos.y, row1Pos.y, p));
      return true;
    }
    if (f === Math.round(2.65 * 30)) {
      await page.evaluate(() => {
        const r1 = document.querySelector('#optionsTable tbody tr:nth-child(1)');
        if (r1) r1.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      });
      return true;
    }
    if (t >= 4.2 && t <= 5.6) {
      const p = easeInOutCubic((t - 4.2) / 1.4);
      await rec.setCursor(lerp(row1Pos.x, row2Pos.x, p), lerp(row1Pos.y, row2Pos.y, p));
      return true;
    }
    if (f === Math.round(5.65 * 30)) {
      await page.evaluate(() => {
        const r2 = document.querySelector('#optionsTable tbody tr:nth-child(2)');
        if (r2) r2.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      });
      return true;
    }
    return false;
  });

  // =========================================================================
  // SCENE 10 (s10): Right-Rail Counterfactual Audit Panel (Keep Gnabry on the ball so #1 Musiala #2->#1 and #7 Cancelo blocked are displayed!)
  // =========================================================================
  await page.evaluate(async () => {
    await window.__studio.seek(2, 64794);
    await window.__studio.setWhatIf('DFL-OBJ-002GKO', -32.09, -23.78);
  });
  await page.waitForTimeout(200);
  const cfRow1Pos = await getCenterOfSelector(page, '#optionsTable tbody tr:nth-child(1)');
  const cfRow7Pos = await getCenterOfSelector(page, '#optionsTable tbody tr:nth-child(7)');

  await rec.renderScene('s10', durMap.s10, async (f, t) => {
    if (t <= 1.2) {
      const p = easeInOutCubic(t / 1.2);
      await rec.setCameraTransform(
        lerp(1.34, 1.35, p),
        lerp(mEnd2D.x + 40, 1620, p),
        lerp(mEnd2D.y - 30, 380, p)
      );
      await rec.setCursor(lerp(musialaPos.x, cfRow1Pos.x, p), lerp(musialaPos.y, cfRow1Pos.y, p), false);
      return true;
    }
    if (f === Math.round(1.8 * 30)) {
      await page.evaluate(() => {
        const r1 = document.querySelector('#optionsTable tbody tr:nth-child(1)');
        if (r1) r1.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      });
      return true;
    }
    if (t >= 3.4 && t <= 5.2) {
      const p = easeInOutCubic((t - 3.4) / 1.8);
      await rec.setCursor(lerp(cfRow1Pos.x, cfRow7Pos.x, p), lerp(cfRow1Pos.y, cfRow7Pos.y, p), false);
      return true;
    }
    if (f === Math.round(5.25 * 30)) {
      await page.evaluate(() => {
        const r7 = document.querySelector('#optionsTable tbody tr:nth-child(7)');
        if (r7) r7.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      });
      return true;
    }
    if (t >= durMap.s10 - 1.1) {
      const p = easeInOutCubic((t - (durMap.s10 - 1.1)) / 1.1);
      await rec.setCameraTransform(lerp(1.35, 1.0, p), lerp(1620, 960, p), lerp(380, 508, p));
      return true;
    }
    return f === 0;
  });
  await rec.setCameraTransform(1.0);

  // =========================================================================
  // SCENE 15 (s15): Models & Data Verification Drawer with Smooth Scroll through Validation & Counterfactual Receipts
  // =========================================================================
  await page.evaluate(async () => {
    document.querySelector('[data-view="split"]').click();
    document.querySelector('[data-cam="spidercam"]').click();
    await window.__studio.seek(2, 64794);
    await window.__studio.setWhatIf('DFL-OBJ-002GKO', -32.09, -23.78);
  });
  await page.waitForTimeout(200);
  const btnAboutPos = await getCenterOfSelector(page, '#infoBtn');
  await rec.renderScene('s15', durMap.s15, async (f, t) => {
    if (t <= 1.1) {
      const p = easeInOutCubic(t / 1.1);
      await rec.setCursor(
        lerp(960, btnAboutPos.x, p),
        lerp(500, btnAboutPos.y, p),
        t > 0.95
      );
      return true;
    }
    if (f === Math.round(1.15 * 30)) {
      await page.evaluate(() => document.getElementById('infoBtn').click());
      await rec.setCursor(btnAboutPos.x, btnAboutPos.y, false);
      return true;
    }
    if (t >= 2.0 && t <= 6.6) {
      const p = easeInOutCubic((t - 2.0) / 4.6);
      await page.evaluate((prog) => {
        const db = document.getElementById('drawerBody');
        if (db) db.scrollTop = prog * (db.scrollHeight - db.clientHeight);
      }, p);
      await rec.setCursor(lerp(btnAboutPos.x, 960, p), lerp(btnAboutPos.y, 480, p), false);
      return true;
    }
    if (f === Math.round(7.6 * 30)) {
      await page.evaluate(() => document.getElementById('drawerClose').click());
      return true;
    }
    return false;
  });

  await browser.close();
  server.close();
  console.log('Re-rendered s04, s10, s15 successfully.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
