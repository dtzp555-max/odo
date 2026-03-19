'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const { fork } = require('child_process');

// ── State ────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;
let serverProcess = null;
let serverPort = 3333;
let isQuitting = false;

// ── Server Management ────────────────────────────────────────
function startServer() {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, 'server', 'openclaw-manager.js');

    serverProcess = fork(serverPath, ['--host', '127.0.0.1'], {
      env: { ...process.env, ELECTRON: '1' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });

    // Listen for server ready message
    serverProcess.on('message', (msg) => {
      if (msg.type === 'server-ready') {
        serverPort = msg.port || 3333;
        console.log(`[ODO] Server ready on port ${serverPort}`);
        resolve(serverPort);
      }
    });

    // Forward server output to console
    serverProcess.stdout.on('data', (data) => {
      process.stdout.write(`[Server] ${data}`);
    });
    serverProcess.stderr.on('data', (data) => {
      process.stderr.write(`[Server] ${data}`);
    });

    serverProcess.on('error', (err) => {
      console.error('[ODO] Server process error:', err);
      reject(err);
    });

    serverProcess.on('exit', (code) => {
      console.log(`[ODO] Server process exited with code ${code}`);
      serverProcess = null;
      if (!isQuitting) {
        // Server crashed — offer to restart
        if (mainWindow) {
          dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'Server Stopped',
            message: 'The OCM server has stopped unexpectedly.',
            buttons: ['Restart Server', 'Quit ODO'],
            defaultId: 0
          }).then(({ response }) => {
            if (response === 0) {
              startServer().then(() => {
                if (mainWindow) mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
              });
            } else {
              app.quit();
            }
          });
        }
      }
    });

    // Timeout: if server doesn't respond in 10 seconds
    setTimeout(() => {
      if (serverProcess && !serverProcess.killed) {
        // Try loading anyway — server might be ready but didn't send IPC
        resolve(serverPort);
      }
    }, 10000);
  });
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}

// ── Window ───────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'ODO',
    backgroundColor: '#0f1117',
    show: false, // Show when ready to avoid flash
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Close → minimize to tray (hide window, keep server running)
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      if (process.platform === 'darwin' && app.dock) {
        app.dock.hide();
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── Tray ─────────────────────────────────────────────────────
function createTray() {
  // Create a simple tray icon (16x16 template image for macOS)
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  let trayIcon;

  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) throw new Error('Icon not found');
  } catch {
    // Fallback: create a simple colored square icon
    trayIcon = nativeImage.createEmpty();
  }

  // On macOS, use a template image for proper dark/light menu bar
  if (process.platform === 'darwin') {
    trayIcon = trayIcon.resize({ width: 16, height: 16 });
    trayIcon.setTemplateImage(true);
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('ODO — OpenClaw Dashboard Orchestrator');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show ODO',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
          if (process.platform === 'darwin' && app.dock) app.dock.show();
        } else {
          createWindow();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Restart Server',
      click: async () => {
        stopServer();
        await startServer();
        if (mainWindow) mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
      }
    },
    { type: 'separator' },
    {
      label: 'Quit ODO',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  // Left-click tray → show window (Windows/Linux; macOS shows context menu by default)
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      if (process.platform === 'darwin' && app.dock) app.dock.show();
    } else {
      createWindow();
    }
  });

  // Double-click tray → show window (Windows/Linux)
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      if (process.platform === 'darwin' && app.dock) app.dock.show();
    }
  });
}

// ── App Lifecycle ────────────────────────────────────────────
app.whenReady().then(async () => {
  try {
    await startServer();
  } catch (err) {
    console.error('[ODO] Failed to start server:', err);
    dialog.showErrorBox('ODO — Startup Error', `Could not start the server:\n${err.message}`);
    app.quit();
    return;
  }

  createTray();
  createWindow();
});

app.on('before-quit', () => {
  isQuitting = true;
  stopServer();
});

app.on('window-all-closed', () => {
  // On macOS, don't quit when all windows close (tray keeps running)
  if (process.platform !== 'darwin') {
    // On Windows/Linux, keep running in tray too
    // User must explicitly quit from tray menu
  }
});

app.on('activate', () => {
  // macOS dock click → show window
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    if (process.platform === 'darwin' && app.dock) app.dock.show();
  } else {
    createWindow();
  }
});
