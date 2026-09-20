import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const directory = fileURLToPath(new URL('.', import.meta.url))
const repository = fileURLToPath(new URL('../../', import.meta.url))
const name = `opencloud-extra-browser-${process.pid}`
const image = process.env.OPENCLOUD_EXTRA_TEST_IMAGE || 'opencloud-extra:local'
const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' })
let started = false
let tests

function stop() {
  tests?.kill('SIGTERM')
  if (started) {
    docker('stop', '--time', '15', name)
    started = false
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stop()
    process.exit(1)
  })
}

try {
  const result = docker('run', '--detach', '--rm', '--init', '--name', name,
    '--publish', '127.0.0.1:9200:9200',
    '--mount', `type=bind,source=${repository},target=/src,readonly`,
    '--entrypoint', 'python3', image, '/src/extras/container/preview-smoke.py', '--serve')
  if (result.status !== 0) {
    throw new Error(result.stderr || 'Cannot start browser-test container')
  }
  started = true
  const deadline = Date.now() + 180_000
  let ready = false
  while (Date.now() < deadline) {
    const logs = docker('logs', name)
    if (logs.stdout.includes('BROWSER_TEST_READY')) {
      ready = true
      break
    }
    if (docker('inspect', '--format', '{{.State.Running}}', name).stdout.trim() !== 'true') {
      throw new Error(`Browser-test server stopped:\n${logs.stdout}\n${logs.stderr}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  if (!ready) {
    throw new Error('Browser-test server did not become ready')
  }
  tests = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)], {
    cwd: directory,
    stdio: 'inherit',
    env: process.env
  })
  const status = await new Promise((resolve, reject) => {
    tests.once('error', reject)
    tests.once('exit', (code) => resolve(code ?? 1))
  })
  process.exitCode = status
  if (status !== 0) {
    const logs = docker('logs', name)
    console.error(logs.stdout, logs.stderr)
  }
} catch (error) {
  console.error(error.message)
  if (started) {
    const logs = docker('logs', name)
    console.error(logs.stdout, logs.stderr)
  }
  process.exitCode = 1
} finally {
  stop()
}
