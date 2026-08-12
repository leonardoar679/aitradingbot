#!/usr/bin/env node
const { existsSync, readFileSync } = require('fs')
const { join } = require('path')
const { spawnSync } = require('child_process')

const certPath = join(__dirname, '..', 'build', 'cert.pfx')
const passFile = join(__dirname, '..', 'build', 'cert.pass')

const env = { ...process.env }

if (existsSync(certPath)) {
  env.CSC_LINK = certPath
  if (!env.CSC_KEY_PASSWORD && existsSync(passFile)) {
    env.CSC_KEY_PASSWORD = readFileSync(passFile, 'utf8').trim()
  }
  if (!env.CSC_KEY_PASSWORD) {
    console.error(
      'Found build/cert.pfx but no password. Set CSC_KEY_PASSWORD or save it to build/cert.pass (gitignored).'
    )
    process.exit(1)
  }
  console.log('Signing with build/cert.pfx')
} else {
  console.warn('No build/cert.pfx found - building unsigned. Run scripts/create-self-signed-cert.ps1 to sign.')
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: true, env })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run('npx', ['electron-vite', 'build'])
run('npx', ['electron-builder', '--win'])
