import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const integrationFiles = ['index.ts', 'AssetDetails.vue', 'formats.js', 'metadata.js']

function git(source, ...args) {
  return execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function readSourcePin(repository = repositoryRoot) {
  const pin = JSON.parse(readFileSync(join(repository, 'extras/web-gallery/source.json'), 'utf8'))
  if (pin.repository !== 'https://github.com/opencloud-eu/web.git' ||
      !/^v\d+\.\d+\.\d+$/.test(pin.version) || !/^[a-f0-9]{40}$/.test(pin.commit) ||
      !/^pnpm@\d+\.\d+\.\d+$/.test(pin.packageManager)) {
    throw new Error('Invalid native Web source pin')
  }
  const makefile = readFileSync(join(repository, 'services/web/Makefile'), 'utf8')
  const version = /^WEB_ASSETS_VERSION\s*[:?+]?=\s*(\S+)\s*$/m.exec(makefile)?.[1]
  if (version !== pin.version) {
    throw new Error(`Native gallery requires Web ${pin.version}; services/web/Makefile selects ${version || 'an unknown version'}. Review the gallery patch before updating its source pin.`)
  }
  return pin
}

export function verifyCheckout(source, pin) {
  const commit = git(source, 'rev-parse', 'HEAD')
  if (commit !== pin.commit || git(source, 'rev-parse', `${pin.version}^{commit}`) !== pin.commit) {
    throw new Error(`Native Web checkout must be ${pin.version} at ${pin.commit}; found ${commit}`)
  }
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  if (`v${pkg.version}` !== pin.version || pkg.packageManager !== pin.packageManager) {
    throw new Error('Native Web package version or package manager differs from the source pin')
  }
}

export function applyGallery(source, repository = repositoryRoot) {
  const pin = readSourcePin(repository)
  verifyCheckout(source, pin)
  if (git(source, 'status', '--porcelain', '--untracked-files=normal')) {
    throw new Error('Apply the native gallery patch to a clean pinned Web checkout')
  }
  const patch = join(repository, 'extras/web-gallery/native-gallery.patch')
  if (!readFileSync(patch, 'utf8').trim()) throw new Error('Native gallery patch is empty')
  const files = integrationFiles.map((name) => join(repository, 'extras/web-preview/src', name))
  for (const file of files) {
    if (!statSync(file).isFile()) throw new Error(`Missing native gallery integration module: ${file}`)
  }
  const destination = join(source, 'packages/web-app-preview/src/extra')
  if (existsSync(destination)) throw new Error('Native Web already contains an extra integration directory')
  // Validate every hunk before changing source. A Web update must not silently
  // drop its native gallery integration or fall back to a separate application.
  git(source, 'apply', '--check', patch)
  git(source, 'apply', patch)
  mkdirSync(destination, { recursive: true })
  files.forEach((file, index) => copyFileSync(file, join(destination, integrationFiles[index])))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node extras/web-gallery/apply.mjs WEB_CHECKOUT')
    applyGallery(resolve(process.argv[2]))
  } catch (error) {
    console.error(error.stderr?.toString().trim() || error.message)
    process.exitCode = 1
  }
}
