#!/usr/bin/env node
// Opens the example app's Android project in Android Studio so the Kotlin
// sources can be edited with full indexing. Run `npx expo prebuild` first.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const androidDir = path.join(process.cwd(), 'example', 'android');
if (!fs.existsSync(androidDir)) {
  console.error('example/android does not exist. Run `cd example && npx expo prebuild -p android` first.');
  process.exit(1);
}
const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
spawnSync(command, [androidDir], { stdio: 'inherit', shell: process.platform === 'win32' });
