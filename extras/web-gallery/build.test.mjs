import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { applyGallery, integrationFiles, readSourcePin } from './apply.mjs'

function fixture(context) {
  const temporary = mkdtempSync(join(tmpdir(), 'native-web-build-'))
  context.after(() => rmSync(temporary, { recursive: true, force: true }))
  const repository = join(temporary, 'downstream')
  const source = join(temporary, 'web')
  const write = (path, value) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, value)
  }
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  write(join(source, 'package.json'), JSON.stringify({ version: '8.0.0', packageManager: 'pnpm@11.27.0' }))
  write(join(source, 'packages/web-app-preview/src/App.vue'), 'original gallery\n')
  git('init', '-q')
  git('add', '.')
  git('-c', 'user.name=Build Test', '-c', 'user.email=build-test@example.invalid', 'commit', '-qm', 'fixture')
  git('tag', 'v8.0.0')
  const pin = { repository: 'https://github.com/opencloud-eu/web.git', version: 'v8.0.0', commit: git('rev-parse', 'HEAD'), packageManager: 'pnpm@11.27.0' }
  write(join(repository, 'extras/web-gallery/source.json'), JSON.stringify(pin))
  write(join(repository, 'services/web/Makefile'), 'WEB_ASSETS_VERSION = v8.0.0\n')
  write(join(repository, 'extras/web-gallery/native-gallery.patch'), [
    'diff --git a/packages/web-app-preview/src/App.vue b/packages/web-app-preview/src/App.vue',
    '--- a/packages/web-app-preview/src/App.vue',
    '+++ b/packages/web-app-preview/src/App.vue',
    '@@ -1 +1 @@',
    '-original gallery',
    '+patched gallery',
    'diff --git a/packages/web-app-preview/src/extra/formats.d.ts b/packages/web-app-preview/src/extra/formats.d.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/packages/web-app-preview/src/extra/formats.d.ts',
    '@@ -0,0 +1 @@',
    '+export declare const previewExtensions: string[]',
    ''
  ].join('\n'))
  for (const name of integrationFiles) write(join(repository, 'extras/web-preview/src', name), `module ${name}\n`)
  return { repository, source, pin, write, git }
}

test('applies the native source patch with its integration modules', (context) => {
  const { repository, source } = fixture(context)
  applyGallery(source, repository)
  assert.equal(readFileSync(join(source, 'packages/web-app-preview/src/App.vue'), 'utf8'), 'patched gallery\n')
  for (const name of integrationFiles) {
    assert.equal(readFileSync(join(source, 'packages/web-app-preview/src/extra', name), 'utf8'), `module ${name}\n`)
  }
  assert.equal(readFileSync(join(source, 'packages/web-app-preview/src/extra/formats.d.ts'), 'utf8'),
    'export declare const previewExtensions: string[]\n')
  assert.throws(() => applyGallery(source, repository), /clean pinned Web checkout/)
})

test('rejects an upstream Web version change before patching', (context) => {
  const { repository, source, write } = fixture(context)
  write(join(repository, 'services/web/Makefile'), 'WEB_ASSETS_VERSION = v8.1.0\n')
  assert.throws(() => readSourcePin(repository), /Review the gallery patch/)
  assert.equal(readFileSync(join(source, 'packages/web-app-preview/src/App.vue'), 'utf8'), 'original gallery\n')
})

test('rejects an unexpected source commit', (context) => {
  const { repository, source, git } = fixture(context)
  git('-c', 'user.name=Build Test', '-c', 'user.email=build-test@example.invalid', 'commit', '--allow-empty', '-qm', 'unexpected source')
  assert.throws(() => applyGallery(source, repository), /checkout must be/)
  assert.equal(existsSync(join(source, 'packages/web-app-preview/src/extra')), false)
})

test('rejects a moved source tag', (context) => {
  const { repository, source, pin, git } = fixture(context)
  git('-c', 'user.name=Build Test', '-c', 'user.email=build-test@example.invalid', 'commit', '--allow-empty', '-qm', 'retagged source')
  git('tag', '-f', 'v8.0.0')
  git('checkout', '--detach', pin.commit)
  assert.throws(() => applyGallery(source, repository), /checkout must be/)
})

test('rejects local changes without overwriting them', (context) => {
  const { repository, source, write } = fixture(context)
  const app = join(source, 'packages/web-app-preview/src/App.vue')
  write(app, 'local work\n')
  assert.throws(() => applyGallery(source, repository), /clean pinned Web checkout/)
  assert.equal(readFileSync(app, 'utf8'), 'local work\n')
})

test('rejects an incompatible patch without copying modules', (context) => {
  const { repository, source, write } = fixture(context)
  const patch = join(repository, 'extras/web-gallery/native-gallery.patch')
  write(patch, readFileSync(patch, 'utf8').replace('-original gallery', '-different gallery'))
  assert.throws(() => applyGallery(source, repository), /Command failed/)
  assert.equal(readFileSync(join(source, 'packages/web-app-preview/src/App.vue'), 'utf8'), 'original gallery\n')
  assert.equal(existsSync(join(source, 'packages/web-app-preview/src/extra')), false)
})
