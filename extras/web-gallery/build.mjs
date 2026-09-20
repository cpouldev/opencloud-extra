import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { applyGallery, readSourcePin, verifyCheckout } from './apply.mjs'

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, CI: 'true' } })
}

try {
  const [operation, directory] = process.argv.slice(2)
  if (!['fetch', 'install', 'build'].includes(operation) || !directory || process.argv.length !== 4) {
    throw new Error('Usage: node extras/web-gallery/build.mjs fetch|install|build WEB_CHECKOUT')
  }
  const source = resolve(directory)
  const pin = readSourcePin()
  if (operation === 'fetch') {
    if (existsSync(source)) throw new Error(`Refusing to replace existing Web checkout: ${source}`)
    mkdirSync(dirname(source), { recursive: true })
    run('git', ['clone', '--depth=1', '--branch', pin.version, pin.repository, source])
    verifyCheckout(source, pin)
  } else {
    verifyCheckout(source, pin)
    const pnpmVersion = execFileSync('pnpm', ['--version'], { cwd: source, encoding: 'utf8' }).trim()
    if (`pnpm@${pnpmVersion}` !== pin.packageManager) {
      throw new Error(`Native Web requires ${pin.packageManager}; found pnpm@${pnpmVersion}`)
    }
    if (operation === 'install') {
      const store = process.env.OPENCLOUD_EXTRA_PNPM_STORE
      run('pnpm', ['install', '--frozen-lockfile', ...(store ? ['--store-dir', store] : [])], source)
    } else {
      applyGallery(source)
      run('pnpm', ['exec', 'vue-tsc', '--noEmit', '--pretty', 'false'], source)
      run('pnpm', ['test:unit', '--run', 'packages/web-app-preview/tests/unit'], source)
      run('pnpm', ['build'], source)
      copyFileSync(join(source, 'config/config.json.dist'), join(source, 'dist/config.json.dist'))
      run('pnpm', ['licenses:csv'], source)
      run('pnpm', ['licenses:save'], source)
    }
  }
} catch (error) {
  console.error(error.stderr?.toString().trim() || error.message)
  process.exitCode = 1
}
