#!/usr/bin/env node
// Opens the example app's Xcode workspace so the Swift sources can be edited
// with full indexing. Run `npx expo prebuild` in example/ first.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const iosDir = path.join(process.cwd(), 'example', 'ios');
if (!fs.existsSync(iosDir)) {
  console.error('example/ios does not exist. Run `cd example && npx expo prebuild -p ios` first.');
  process.exit(1);
}
const workspace = fs.readdirSync(iosDir).find((entry) => entry.endsWith('.xcworkspace'));
if (!workspace) {
  console.error('No .xcworkspace in example/ios. Run `npx pod-install` in example/ first.');
  process.exit(1);
}
spawnSync('open', [path.join(iosDir, workspace)], { stdio: 'inherit' });
