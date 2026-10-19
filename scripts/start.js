// Launch Electron with ELECTRON_RUN_AS_NODE cleared (VS Code's terminal sets it,
// which would make Electron behave like plain Node).
const { spawn } = require('child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.'], { stdio: 'inherit', env, cwd: require('path').join(__dirname, '..') });
child.on('close', (code) => process.exit(code ?? 0));
