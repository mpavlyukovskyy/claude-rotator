'use strict';
// Runs the status line you had before claude-rotator AND claude-rotator's own, on the same stdin.
// install.sh --chain-statusline saved your old command to $CLAUDE_USAGE_DATA/statusline.prev and pointed
// statusLine at this file; uninstall.sh puts the old command back. Output: your line, then ours.
//   statusLine.command:  "<data>/app/node-run" "<data>/app/statusline-chain.js"
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DATA = process.env.CLAUDE_USAGE_DATA || path.dirname(__dirname);
let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch (_) {}

const out = [];
let prev = '';
try { prev = fs.readFileSync(path.join(DATA, 'statusline.prev'), 'utf8').trim(); } catch (_) {}
if (prev) {
  const r = spawnSync('/bin/sh', ['-c', prev], { input, encoding: 'utf8', timeout: 5000 });
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';
  if (r.stdout && r.stdout.trim()) out.push(r.stdout.replace(/\s+$/, ''));
  if (timedOut) out.push('[prev statusline timed out]');
}
const ours = spawnSync(process.execPath, [path.join(__dirname, 'statusline.js')], { input, encoding: 'utf8', timeout: 5000 });
if (ours.stdout) out.push(ours.stdout.replace(/\s+$/, ''));
process.stdout.write(out.filter(Boolean).join('  ') + '\n');
