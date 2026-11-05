import { chromium } from '/home/user/node_modules/playwright/index.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const ROOT_DIR = '/home/user/workspace/pressing-matters-studio';
const APP_DIR = path.join(ROOT_DIR, 'app');
const VIDEO_DIR = path.join(ROOT_DIR, 'video');
const RAW_DIR = path.join(VIDEO_DIR, 'raw_scenes');
fs.mkdirSync(RAW_DIR, { recursive: true });

const scenesMeta = JSON.parse(
  fs.readFileSync(path.join(VIDEO_DIR, 'audio', 'scenes_meta.json'), 'utf8')
);

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
      // Reserve bottom 64px for the dedicated high-contrast closed-caption bar so nothing in the app is ever covered
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
    console.log(`Rendering ${sceneId} (${durationSec.toFixed(2)}s, ${totalFrames} frames)...`);

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

    let ffErr = '';
    ff.stderr.on('data', (d) => {
      ffErr += d.toString();
    });

    for (let f = 0; f < totalFrames; f++) {
      const t = f / 30;
      const dirty = await stepFn(f, t, totalFrames, durationSec);
      if (dirty || !this.lastBuffer) {
        this.lastBuffer = await this.page.screenshot({ type: 'jpeg', quality: 94 });
      }
      const ok = ff.stdin.write(this.lastBuffer);
      if (!ok) {
        await new Promise((r) => ff.stdin.once('drain', r));
      }
    }
    ff.stdin.end();
    await new Promise((resolve, reject) => {
      ff.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${ffErr.slice(-400)}`));
      });
    });
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
  // Wait until initial reveal animation finishes (REVEAL_MS = 2000ms)
  await page.waitForTimeout(2400);

  const rec = new SceneRecorder(page);
  await rec.initCursorAndViewport();
  await page.waitForTimeout(200);

  const durMap = Object.fromEntries(scenesMeta.map((s) => [s.id, s.scene_dur]));

  // Ensure initial clean state at 88:11 (Period 2, frame 64794), 2D view, Shape off, Control on
  await page.evaluate(async () => {
    document.querySelector('[data-view="2d"]').click();
    document.querySelector('[data-mode="control"]').click();
    await window.__studio.clearWhatIf();
    await window.__studio.seek(2, 64794);
    const shapeBtn = document.getElementById('toggleShape');
    if (shapeBtn.classList.contains('on')) shapeBtn.click();
  });
  await page.waitForTimeout(250);

  const gnabryPos = await getPitchCoords(page, -26.82, -31.76);
  const canceloPos = await getPitchCoords(page, -40.26, -15.32);
  const musialaPos = await getPitchCoords(page, -33.76, -11.34);
  const MARTEL_ID = 'DFL-OBJ-002GKO';

  // =========================================================================
  // SCENE 1 (s01): 1.0x Wide Establishing Shot at 88:11
  // =========================================================================
  await rec.setCameraTransform(1.0);
  await rec.renderScene('s01', durMap.s01, async (f, t) => {
    if (f === 0) {
      await rec.setCursor(740, 480, false);
      return true;
    }
    if (t >= 2.2 && t <= 4.4) {
      const p = easeInOutCubic((t - 2.2) / 2.2);
      await rec.setCursor(lerp(740, gnabryPos.x, p), lerp(480, gnabryPos.y, p));
      return true;
    }
    if (t > 4.4 && t <= 6.8) {
      const p = easeInOutCubic((t - 4.4) / 2.4);
      await rec.setCursor(lerp(gnabryPos.x, musialaPos.x, p), lerp(gnabryPos.y, musialaPos.y, p));
      return true;
    }
    return false;
  });

  // =========================================================================
  // SCENE 2 (s02): Continuous 25 Hz Playback from 88:04 (f 64620) to 88:11 (f 64794)
  // =========================================================================
  const playBtn = await getCenterOfSelector(page, '#playBtn');
  await page.evaluate(() => window.__studio.seek(2, 64620));
  await page.waitForTimeout(200);
  await rec.renderScene('s02', durMap.s02, async (f, t) => {
    if (f === 0) {
      await rec.setCursor(playBtn.x + 80, playBtn.y - 40, false);
      return true;
    }
    if (t >= 0.3 && t <= 1.0) {
      const p = easeInOutCubic((t - 0.3) / 0.7);
      await rec.setCursor(lerp(playBtn.x + 80, playBtn.x, p), lerp(playBtn.y - 40, playBtn.y, p), t > 0.85);
      return true;
    }
    // Step tracking frames every 2 video frames (15 steps/sec) so surface worker stays 100% synced
    if (t > 1.0 && t <= 8.0 && f % 2 === 0) {
      const p = (t - 1.0) / 7.0;
      const curFrame = Math.min(64794, Math.round(64620 + p * (64794 - 64620)));
      await page.evaluate((cf) => window.__studio.seek(2, cf), curFrame);
      await rec.setCursor(playBtn.x + 40, playBtn.y - 30, false);
      return true;
    }
    if (f === Math.round(8.05 * 30)) {
      await page.evaluate(() => window.__studio.seek(2, 64794));
      return true;
    }
    return false;
  });

  // =========================================================================
  // SCENE 3 (s03): Pause at 88:11 Decision Frame (f 64794) & Trace Left-Wing Geometry
  // =========================================================================
  const bm8811 = await page.evaluate(() => {
    const pills = [...document.querySelectorAll('#bookmarks button')];
    const target = pills.find((el) => el.textContent.includes('88:14') || el.textContent.includes('88:'));
    if (!target) return { x: 640, y: 950 };
    const r = target.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await rec.renderScene('s03', durMap.s03, async (f, t) => {
    if (f === 0) {
      await page.evaluate(() => window.__studio.seek(2, 64794));
      await rec.setCursor(bm8811.x, bm8811.y, true);
      return true;
    }
    if (f === 8) {
      await rec.setCursor(bm8811.x, bm8811.y, false);
      return true;
    }
    if (t >= 1.2 && t <= 3.2) {
      const p = easeInOutCubic((t - 1.2) / 2.0);
      await rec.setCursor(lerp(bm8811.x, gnabryPos.x, p), lerp(bm8811.y, gnabryPos.y, p));
      return true;
    }
    if (t > 3.2 && t <= 5.4) {
      const p = easeInOutCubic((t - 3.2) / 2.2);
      await rec.setCursor(lerp(gnabryPos.x, canceloPos.x, p), lerp(gnabryPos.y, canceloPos.y, p));
      return true;
    }
    if (t > 5.4 && t <= 7.2) {
      const p = easeInOutCubic((t - 5.4) / 1.8);
      await rec.setCursor(lerp(canceloPos.x, musialaPos.x, p), lerp(canceloPos.y, musialaPos.y, p));
      return true;
    }
    return false;
  });

  // =========================================================================
  // SCENE 4 (s04): Medium Push-In (1.25x) on Pass Lanes + Ranked Pass Options Table
  // =========================================================================
  const row1Pos = await getCenterOfSelector(page, '#optionsTable tbody tr:nth-child(1)');
  const row2Pos = await getCenterOfSelector(page, '#optionsTable tbody tr:nth-child(2)');
  await rec.renderScene('s04', durMap.s04, async (f, t) => {
    if (t <= 1.2) {
      const p = easeInOutCubic(t / 1.2);
      await rec.setCameraTransform(lerp(1.0, 1.25, p), lerp(960, 1280, p), lerp(508, 430, p));
      await rec.setCursor(lerp(musialaPos.x, row1Pos.x, p), lerp(musialaPos.y, row1Pos.y, p));
      return true;
    }
    if (t >= 2.8 && t <= 4.6) {
      const p = easeInOutCubic((t - 2.8) / 1.8);
      await rec.setCursor(lerp(row1Pos.x, row2Pos.x, p), lerp(row1Pos.y, row2Pos.y, p));
      return true;
    }
    if (t >= durMap.s04 - 1.1) {
      const p = easeInOutCubic((t - (durMap.s04 - 1.1)) / 1.1);
      await rec.setCameraTransform(lerp(1.25, 1.0, p), lerp(1280, 960, p), lerp(430, 508, p));
      return true;
    }
    return f === 0;
  });
  await rec.setCameraTransform(1.0);

  // =========================================================================
  // SCENE 5 (s05): 1.0x Full Screen — Toggle Synchronized Split 2D + 3D View
  // =========================================================================
  const splitBtnPos = await getCenterOfSelector(page, '[data-view="split"]');
  await rec.renderScene('s05', durMap.s05, async (f, t) => {
    if (f === 0) {
      await rec.setCameraTransform(1.0);
      await rec.setCursor(row2Pos.x, row2Pos.y, false);
      return true;
    }
    if (t >= 0.4 && t <= 1.5) {
      const p = easeInOutCubic((t - 0.4) / 1.1);
      await rec.setCursor(lerp(row2Pos.x, splitBtnPos.x, p), lerp(row2Pos.y, splitBtnPos.y, p), t > 1.35);
      return true;
    }
    if (f === Math.round(1.55 * 30)) {
      await page.evaluate(() => document.querySelector('[data-view="split"]').click());
      await rec.setCursor(splitBtnPos.x, splitBtnPos.y, false);
      return true;
    }
    if (t >= 2.4 && t <= 5.2) {
      const p = easeInOutCubic((t - 2.4) / 2.8);
      await rec.setCursor(lerp(splitBtnPos.x, 1080, p), lerp(splitBtnPos.y, 480, p), false);
      return true;
    }
    return false;
  });

  // =========================================================================
  // SCENE 6 (s06): 1.0x Full Screen — 3D Broadcast Mode (Spidercam -> TV Broadcast)
  // =========================================================================
  const btn3dPos = await getCenterOfSelector(page, '[data-view="3d"]');
  await rec.renderScene('s06', durMap.s06, async (f, t) => {
    if (t <= 1.0) {
      const p = easeInOutCubic(t / 1.0);
      await rec.setCursor(lerp(1080, btn3dPos.x, p), lerp(480, btn3dPos.y, p), t > 0.85);
      return true;
    }
    if (f === Math.round(1.05 * 30)) {
      await page.evaluate(() => document.querySelector('[data-view="3d"]').click());
      await rec.setCursor(btn3dPos.x, btn3dPos.y, false);
      return true;
    }
    const camBroadcastPos = await getCenterOfSelector(page, '[data-cam="broadcast"]');
    if (t >= 3.2 && t <= 4.3) {
      const p = easeInOutCubic((t - 3.2) / 1.1);
      await rec.setCursor(
        lerp(btn3dPos.x, camBroadcastPos.x, p),
        lerp(btn3dPos.y, camBroadcastPos.y, p),
        t > 4.15
      );
      return true;
    }
    if (f === Math.round(4.35 * 30)) {
      await page.evaluate(() => document.querySelector('[data-cam="broadcast"]').click());
      await rec.setCursor(camBroadcastPos.x, camBroadcastPos.y, false);
      return true;
    }
    return false;
  });

  // =========================================================================
  // SCENE 7 (s07): 1.0x Full Screen — 3D Carrier POV Camera Behind #7 Serge Gnabry
  // =========================================================================
  const camPovPos = await getCenterOfSelector(page, '[data-cam="carrier"]');
  const camBroadcastPos = await getCenterOfSelector(page, '[data-cam="broadcast"]');
  await rec.renderScene('s07', durMap.s07, async (f, t) => {
    if (t <= 1.1) {
      const p = easeInOutCubic(t / 1.1);
      await rec.setCursor(
        lerp(camBroadcastPos.x, camPovPos.x, p),
        lerp(camBroadcastPos.y, camPovPos.y, p),
        t > 0.95
      );
      return true;
    }
    if (f === Math.round(1.15 * 30)) {
      await page.evaluate(() => document.querySelector('[data-cam="carrier"]').click());
      await rec.setCursor(camPovPos.x, camPovPos.y, false);
      return true;
    }
    if (t >= 2.2 && t <= 5.5) {
      const p = easeInOutCubic((t - 2.2) / 3.3);
      await rec.setCursor(lerp(camPovPos.x, 680, p), lerp(camPovPos.y, 430, p), false);
      return true;
    }
    return false;
  });

  // =========================================================================
  // SCENE 8 (s08): 1.0x Full Screen — Deliberate 3.2-Second Counterfactual Drag of #6 Martel
  // =========================================================================
  await page.evaluate(() => document.querySelector('[data-view="2d"]').click());
  await page.waitForTimeout(180);
  const mStart2D = await getPitchCoords(page, -37.37, -15.80);
  const mEnd2D = await getPitchCoords(page, -32.09, -23.78);

  await rec.renderScene('s08', durMap.s08, async (f, t) => {
    if (f === 0) {
      await rec.setCursor(mStart2D.x + 90, mStart2D.y - 70, false);
      return true;
    }
    // Glide cursor to #6 Martel (t = 0.2 -> 1.3s)
    if (t >= 0.2 && t <= 1.3) {
      const p = easeInOutCubic((t - 0.2) / 1.1);
      await rec.setCursor(
        lerp(mStart2D.x + 90, mStart2D.x, p),
        lerp(mStart2D.y - 70, mStart2D.y, p),
        false
      );
      return true;
    }
    // Deliberate, unhurried 3.2-second drag from t = 1.35s to t = 4.55s
    if (t >= 1.35 && t <= 4.55) {
      const p = easeInOutCubic((t - 1.35) / 3.2);
      const wx = lerp(-37.37, -32.09, p);
      const wy = lerp(-15.80, -23.78, p);
      const cx = lerp(mStart2D.x, mEnd2D.x, p);
      const cy = lerp(mStart2D.y, mEnd2D.y, p);
      if (f % 2 === 0 || t >= 4.50) {
        await page.evaluate(({ pid, wx, wy }) => window.__studio.setWhatIf(pid, wx, wy), {
          pid: MARTEL_ID,
          wx,
          wy,
        });
      }
      await rec.setCursor(cx, cy, true);
      return true;
    }
    if (f === Math.round(4.6 * 30)) {
      await page.evaluate(({ pid }) => window.__studio.setWhatIf(pid, -32.09, -23.78), {
        pid: MARTEL_ID,
      });
      await rec.setCursor(mEnd2D.x, mEnd2D.y, false);
      return true;
    }
    return false;
  });

  // =========================================================================
  // SCENE 9 (s09): 1.34x Medium Framing on the 2D Counterfactual Ghost Trail & Blocked Lane
  // =========================================================================
  await rec.renderScene('s09', durMap.s09, async (f, t) => {
    if (t <= 1.2) {
      const p = easeInOutCubic(t / 1.2);
      await rec.setCameraTransform(
        lerp(1.0, 1.34, p),
        lerp(960, mEnd2D.x + 40, p),
        lerp(508, mEnd2D.y - 30, p)
      );
      return true;
    }
    if (t >= 2.0 && t <= 4.4) {
      const p = easeInOutCubic((t - 2.0) / 2.4);
      await rec.setCursor(lerp(mEnd2D.x, canceloPos.x, p), lerp(mEnd2D.y, canceloPos.y, p), false);
      return true;
    }
    if (t > 4.4 && t <= 6.8) {
      const p = easeInOutCubic((t - 4.4) / 2.4);
      await rec.setCursor(lerp(canceloPos.x, musialaPos.x, p), lerp(canceloPos.y, musialaPos.y, p), false);
      return true;
    }
    return f === 0;
  });

  // =========================================================================
  // SCENE 10 (s10): 1.32x Medium Framing on the Right-Rail Counterfactual Audit Panel
  // =========================================================================
  const cfRow1Pos = await getCenterOfSelector(page, '#optionsTable tbody tr:nth-child(1)');
  const cfRow7Pos = await getCenterOfSelector(page, '#optionsTable tbody tr:nth-child(7)');
  await rec.renderScene('s10', durMap.s10, async (f, t) => {
    if (t <= 1.2) {
      const p = easeInOutCubic(t / 1.2);
      await rec.setCameraTransform(
        lerp(1.34, 1.32, p),
        lerp(mEnd2D.x + 40, 1540, p),
        lerp(mEnd2D.y - 30, 440, p)
      );
      await rec.setCursor(lerp(musialaPos.x, cfRow1Pos.x, p), lerp(musialaPos.y, cfRow1Pos.y, p), false);
      return true;
    }
    if (f === Math.round(2.0 * 30)) {
      await page.evaluate(() => {
        const firstRow = document.querySelector('#optionsTable tbody tr:nth-child(1)');
        if (firstRow) firstRow.click();
      });
      return true;
    }
    if (t >= 3.2 && t <= 5.4) {
      const p = easeInOutCubic((t - 3.2) / 2.2);
      await rec.setCursor(lerp(cfRow1Pos.x, cfRow7Pos.x, p), lerp(cfRow1Pos.y, cfRow7Pos.y, p), false);
      return true;
    }
    if (t >= durMap.s10 - 1.1) {
      const p = easeInOutCubic((t - (durMap.s10 - 1.1)) / 1.1);
      await rec.setCameraTransform(lerp(1.32, 1.0, p), lerp(1540, 960, p), lerp(440, 508, p));
      return true;
    }
    return f === 0;
  });
  await rec.setCameraTransform(1.0);

  // =========================================================================
  // SCENE 11 (s11): 1.0x Full Screen — Synchronized Split 2D + 3D Counterfactual Drag
  // =========================================================================
  await page.evaluate(async () => {
    await window.__studio.clearWhatIf();
    document.querySelector('[data-view="split"]').click();
    document.querySelector('[data-cam="carrier"]').click();
  });
  await page.waitForTimeout(200);
  const mStartSplit = await getPitchCoords(page, -37.37, -15.80);
  const mEndSplit = await getPitchCoords(page, -32.09, -23.78);

  await rec.renderScene('s11', durMap.s11, async (f, t) => {
    if (f === 0) {
      await rec.setCursor(mStartSplit.x, mStartSplit.y, false);
      return true;
    }
    if (t >= 1.0 && t <= 4.0) {
      const p = easeInOutCubic((t - 1.0) / 3.0);
      const wx = lerp(-37.37, -32.09, p);
      const wy = lerp(-15.80, -23.78, p);
      const cx = lerp(mStartSplit.x, mEndSplit.x, p);
      const cy = lerp(mStartSplit.y, mEndSplit.y, p);
      if (f % 2 === 0 || t >= 3.95) {
        await page.evaluate(({ pid, wx, wy }) => window.__studio.setWhatIf(pid, wx, wy), {
          pid: MARTEL_ID,
          wx,
          wy,
        });
      }
      await rec.setCursor(cx, cy, true);
      return true;
    }
    if (f === Math.round(4.05 * 30)) {
      await page.evaluate(({ pid }) => window.__studio.setWhatIf(pid, -32.09, -23.78), {
        pid: MARTEL_ID,
      });
      await rec.setCursor(mEndSplit.x, mEndSplit.y, false);
      return true;
    }
    return false;
  });

  // =========================================================================
  // SCENE 12 (s12): 1.0x Full Screen — Second Counterfactual Preset "What-if: Open Musiala"
  // =========================================================================
  await page.evaluate(() => document.querySelector('[data-cam="spidercam"]').click());
  const btnOpenMusiala = await getCenterOfSelector(page, '#whatIfPocketBtn');
  await rec.renderScene('s12', durMap.s12, async (f, t) => {
    if (t <= 1.2) {
      const p = easeInOutCubic(t / 1.2);
      await rec.setCursor(
        lerp(mEndSplit.x, btnOpenMusiala.x, p),
        lerp(mEndSplit.y, btnOpenMusiala.y, p),
        t > 1.05
      );
      return true;
    }
    // Smooth 2.0-second counterfactual shift to Open Musiala pocket (x = -27.37, y = -15.80)
    if (t >= 1.25 && t <= 3.25) {
      const p = easeInOutCubic((t - 1.25) / 2.0);
      const wx = lerp(-32.09, -27.37, p);
      const wy = lerp(-23.78, -15.80, p);
      if (f % 2 === 0 || t >= 3.20) {
        await page.evaluate(({ pid, wx, wy }) => window.__studio.setWhatIf(pid, wx, wy), {
          pid: MARTEL_ID,
          wx,
          wy,
        });
      }
      await rec.setCursor(btnOpenMusiala.x, btnOpenMusiala.y, false);
      return true;
    }
    const btnResetPos = await getCenterOfSelector(page, '#resetWhatIf');
    if (t >= 5.2 && t <= 6.2) {
      const p = easeInOutCubic((t - 5.2) / 1.0);
      await rec.setCursor(
        lerp(btnOpenMusiala.x, btnResetPos.x, p),
        lerp(btnOpenMusiala.y, btnResetPos.y, p),
        t > 6.05
      );
      return true;
    }
    if (f === Math.round(6.25 * 30)) {
      await page.evaluate(() => window.__studio.clearWhatIf());
      await rec.setCursor(btnResetPos.x, btnResetPos.y, false);
      return true;
    }
    return false;
  });

  // =========================================================================
  // SCENE 13 (s13): 1.0x Full Screen — Team Convex Hulls (Shape) & Expected Threat (Pass Value)
  // =========================================================================
  await page.evaluate(() => document.querySelector('[data-view="2d"]').click());
  await page.waitForTimeout(150);
  const btnShapePos = await getCenterOfSelector(page, '#toggleShape');
  const btnXtPos = await getCenterOfSelector(page, '[data-mode="value"]');
  await rec.renderScene('s13', durMap.s13, async (f, t) => {
    if (t <= 1.1) {
      const p = easeInOutCubic(t / 1.1);
      await rec.setCursor(
        lerp(520, btnShapePos.x, p),
        lerp(80, btnShapePos.y, p),
        t > 0.95
      );
      return true;
    }
    if (f === Math.round(1.15 * 30)) {
      await page.evaluate(() => document.getElementById('toggleShape').click());
      await rec.setCursor(btnShapePos.x, btnShapePos.y, false);
      return true;
    }
    if (t >= 3.2 && t <= 4.2) {
      const p = easeInOutCubic((t - 3.2) / 1.0);
      await rec.setCursor(
        lerp(btnShapePos.x, btnXtPos.x, p),
        lerp(btnShapePos.y, btnXtPos.y, p),
        t > 4.05
      );
      return true;
    }
    if (f === Math.round(4.25 * 30)) {
      await page.evaluate(() => {
        document.querySelector('[data-mode="value"]').click();
        window.__studio.seek(2, 64794);
      });
      await rec.setCursor(btnXtPos.x, btnXtPos.y, false);
      return true;
    }
    return false;
  });

  // =========================================================================
  // SCENE 14 (s14): 1.0x Full Screen — Play 88:11 -> 88:16 Title-Winning Goal Sequence in Split 2D+3D
  // =========================================================================
  await page.evaluate(async () => {
    const shapeBtn = document.getElementById('toggleShape');
    if (shapeBtn.classList.contains('on')) shapeBtn.click();
    document.querySelector('[data-mode="control"]').click();
    document.querySelector('[data-view="split"]').click();
    document.querySelector('[data-cam="spidercam"]').click();
    await window.__studio.seek(2, 64794);
  });
  await page.waitForTimeout(200);

  await rec.renderScene('s14', durMap.s14, async (f, t) => {
    if (f === 0) {
      await rec.setCursor(playBtn.x, playBtn.y, true);
      return true;
    }
    if (f === 6) {
      await rec.setCursor(playBtn.x + 50, playBtn.y - 40, false);
      return true;
    }
    // Advance smoothly from 64794 (88:11.0) to 64935 (88:16.6) over t = 0.5..7.5s
    if (t >= 0.5 && t <= 7.5 && f % 2 === 0) {
      const p = (t - 0.5) / 7.0;
      const curFrame = Math.min(64935, Math.round(64794 + p * (64935 - 64794)));
      await page.evaluate((cf) => window.__studio.seek(2, cf), curFrame);
      return true;
    }
    return false;
  });

  // =========================================================================
  // SCENE 15 (s15): 1.0x Full Screen — Models & Data Verification Drawer
  // =========================================================================
  await page.evaluate(async () => {
    await window.__studio.seek(2, 64794);
    await window.__studio.setWhatIf('DFL-OBJ-002GKO', -32.09, -23.78);
  });
  await page.waitForTimeout(200);
  const btnAboutPos = await getCenterOfSelector(page, '#infoBtn');
  await rec.renderScene('s15', durMap.s15, async (f, t) => {
    if (t <= 1.2) {
      const p = easeInOutCubic(t / 1.2);
      await rec.setCursor(
        lerp(960, btnAboutPos.x, p),
        lerp(500, btnAboutPos.y, p),
        t > 1.05
      );
      return true;
    }
    if (f === Math.round(1.25 * 30)) {
      await page.evaluate(() => document.getElementById('infoBtn').click());
      await rec.setCursor(btnAboutPos.x, btnAboutPos.y, false);
      return true;
    }
    if (t >= 2.2 && t <= 6.2) {
      const p = easeInOutCubic((t - 2.2) / 4.0);
      await rec.setCursor(lerp(btnAboutPos.x, 1480, p), lerp(btnAboutPos.y, 480, p), false);
      return true;
    }
    if (f === Math.round(7.4 * 30)) {
      await page.evaluate(() => document.getElementById('drawerClose').click());
      return true;
    }
    return false;
  });

  // =========================================================================
  // SCENE 16 (s16): 1.0x Full Screen — Closing Hero View in Split 2D+3D
  // =========================================================================
  await page.evaluate(async () => {
    document.querySelector('[data-view="split"]').click();
    document.querySelector('[data-cam="spidercam"]').click();
    await window.__studio.setWhatIf('DFL-OBJ-002GKO', -32.09, -23.78);
  });
  await page.waitForTimeout(200);
  await rec.renderScene('s16', durMap.s16, async (f, t) => {
    if (f === 0) {
      await rec.setCursor(740, 480, false);
      return true;
    }
    if (t >= 1.5 && t <= 5.5) {
      const p = easeInOutCubic((t - 1.5) / 4.0);
      await rec.setCursor(lerp(740, 1080, p), lerp(480, 440, p), false);
      return true;
    }
    return false;
  });

  await browser.close();
  server.close();
  console.log('All 16 raw scenes captured successfully.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
