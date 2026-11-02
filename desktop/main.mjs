// A desktop window for openmaestri: starts the daemon, shows its page in one window, keeps a tray
// icon, lets the page raise system notifications. The page is the same one the browser gets; this
// file adds no powers to it (no preload, no node integration, sandboxed, only its own origin).
import { app, BrowserWindow, Menu, Tray, session, shell } from 'electron/main';
import { nativeImage } from 'electron/common';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findNode, isExternalHttp, sameOrigin, startDaemon } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
let win = null;
let tray = null;
let daemon = null;
let quitting = false;
let origin = null;
let uiUrl = null;

const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on('second-instance', () => { win?.show(); win?.focus(); });

function iconImage() {
  const png = path.join(root, 'assets', 'icon.png');
  const img = nativeImage.createFromPath(png);
  return img.isEmpty() ? nativeImage.createFromPath(path.join(root, 'assets', 'icon.svg')) : img;
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1400, height: 900, show: false, title: 'openmaestri', backgroundColor: '#14161a', icon: iconImage(),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isExternalHttp(target) && !sameOrigin(target, origin)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => { if (!sameOrigin(target, origin)) { e.preventDefault(); if (isExternalHttp(target)) shell.openExternal(target); } });
  // with a tray, closing the window hides it; the agents keep working
  win.on('close', (e) => { if (!quitting && tray) { e.preventDefault(); win.hide(); } });
  win.loadURL(url);
}

function createTray() {
  try {
    tray = new Tray(iconImage().resize({ width: 22, height: 22 }));
  } catch { tray = null; return; }
  tray.setToolTip('openmaestri');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show openmaestri', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { if (win.isVisible()) win.hide(); else { win.show(); win.focus(); } });
}

app.whenReady().then(async () => {
  if (!primary) return;
  const node = findNode();
  if (!node) { console.error('openmaestri needs Node.js 22 or newer on the PATH (or OPENMAESTRI_NODE).'); app.exit(1); return; }
  try {
    const started = await startDaemon({ node, root });
    daemon = started.child;
    uiUrl = started.url;
    origin = new URL(uiUrl).origin;
  } catch (e) { console.error(e.message); app.exit(1); return; }
  // notifications only for the page we serve; no camera, microphone, location or anything else
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'notifications' && sameOrigin(wc.getURL(), origin)));
  createTray();
  createWindow(uiUrl);
});

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { try { daemon?.kill('SIGTERM'); } catch { /* already gone */ } });
app.on('window-all-closed', () => { if (!tray) app.quit(); });
