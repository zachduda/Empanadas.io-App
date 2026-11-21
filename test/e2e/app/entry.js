'use strict';

// Starts the real app (main.js) against the fake site (../fakesite.js), for
// test/e2e/run.js. Only the network is different: empanadas.io and
// api.empanadas.io resolve to the fake site, whose certificate is trusted
// here, and "open the browser" records the address instead of opening one.

const path = require('path');
const { app, shell } = require('electron');

const port = Number(process.env.E2E_PORT);
if (!port) throw new Error('E2E_PORT is not set: run this through test/e2e/run.js');

app.commandLine.appendSwitch('host-resolver-rules',
	'MAP empanadas.io 127.0.0.1:' + port + ', MAP api.empanadas.io 127.0.0.1:' + port + ', MAP * ~NOTFOUND');
app.commandLine.appendSwitch('no-proxy-server');
if (process.env.E2E_USER_DATA) app.setPath('userData', process.env.E2E_USER_DATA);

app.on('session-created', (ses) => {
	ses.setCertificateVerifyProc((request, callback) =>
		callback(/(^|\.)empanadas\.io$/.test(request.hostname) ? 0 : -2));
});

// Chromium's sandbox cannot run as root, and a container runs everything as
// root; there the run's --no-sandbox would be overridden by enableSandbox().
// The app itself always turns it on.
if (typeof process.getuid === 'function' && process.getuid() === 0) app.enableSandbox = () => {};

global.__e2eOpened = [];
shell.openExternal = async (url) => {
	global.__e2eOpened.push(String(url));
};

require(path.join(__dirname, '..', '..', '..', 'main.js'));
