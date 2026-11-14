import { readFile, stat } from 'node:fs/promises'
import console from 'node:console'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

const frontendDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)))
const distributionDirectory = resolve(frontendDirectory, 'dist')
const licensePath = resolve(distributionDirectory, 'licenses.md')
const projectLicensePath = resolve(distributionDirectory, 'LICENSE')
const provenancePath = resolve(distributionDirectory, 'ASSET_PROVENANCE.md')
const publicFiles = [projectLicensePath, licensePath, provenancePath]
const lockPath = resolve(frontendDirectory, 'package-lock.json')
const sourceLicensePath = resolve(frontendDirectory, '../LICENSE')

function fail(message) {
  console.error(`Production license check failed: ${message}`)
  process.exitCode = 1
}

const [licenseText, projectLicenseText, sourceLicenseText, provenanceText, lockText] =
  await Promise.all([
    readFile(licensePath, 'utf8').catch(() => null),
    readFile(projectLicensePath, 'utf8').catch(() => null),
    readFile(sourceLicensePath, 'utf8'),
    readFile(provenancePath, 'utf8').catch(() => null),
    readFile(lockPath, 'utf8'),
  ])

if (!licenseText) fail('dist/licenses.md is missing or unreadable')
if (!projectLicenseText) fail('dist/LICENSE is missing or unreadable')
if (projectLicenseText && projectLicenseText !== sourceLicenseText) {
  fail('dist/LICENSE does not exactly match the repository LICENSE')
}
if (!provenanceText) fail('dist/ASSET_PROVENANCE.md is missing or unreadable')
for (const path of publicFiles) {
  const details = await stat(path).catch(() => null)
  if (details && (details.mode & 0o004) === 0) {
    fail(`${path.split('/').at(-1)} is not readable by the production web server user`)
  }
}
if (licenseText && provenanceText && !licenseText.includes('## ')) {
  fail('the Vite license registry contains no bundled dependency entries')
}

if (!licenseText || !provenanceText) process.exit()

const lock = JSON.parse(lockText)
const entries = [...licenseText.matchAll(/^## (.+?) - (\S+)(?: \((.+?)\))?\s*$/gm)]
if (entries.length === 0) fail('no dependency sections found in dist/licenses.md')

const seen = new Set()
for (const [, name, version, identifier] of entries) {
  const key = `${name}@${version}`
  if (seen.has(key)) fail(`duplicate dependency entry ${key}`)
  seen.add(key)

  const packagePath = `node_modules/${name}`
  const lockEntry = Object.entries(lock.packages).find(
    ([path, value]) =>
      (path === packagePath || path.endsWith(`/${packagePath}`)) && value.version === version,
  )?.[1]
  if (!lockEntry) {
    fail(`${key} is absent from package-lock.json`)
    continue
  }
  if (lockEntry.dev === true) fail(`${key} is development-only but appears in the registry`)
  if (!identifier) fail(`${key} has no license identifier`)
  if (typeof lockEntry.license === 'string' && identifier !== lockEntry.license) {
    fail(`${key} identifier ${identifier} disagrees with lock metadata ${lockEntry.license}`)
  }

  const sectionStart = licenseText.indexOf(`## ${name} - ${version}`)
  const nextSection = licenseText.indexOf('\n## ', sectionStart + 1)
  const section = licenseText.slice(sectionStart, nextSection < 0 ? undefined : nextSection)
  if (/\bMIT\b/.test(identifier ?? '')) {
    if (!/Copyright/i.test(section) || !section.includes('Permission is hereby granted')) {
      fail(`${key} is missing the MIT copyright notice or permission text`)
    }
    if (!section.includes('THE SOFTWARE IS PROVIDED'))
      fail(`${key} is missing the MIT warranty disclaimer`)
  }
  if (/Apache-2\.0/.test(identifier ?? '')) {
    if (!/Apache License/i.test(section) || !/Version 2\.0/i.test(section)) {
      fail(`${key} is missing the Apache-2.0 license text`)
    }
    if (!section.includes('limitations under the License')) {
      fail(`${key} is missing Apache-2.0 terms`)
    }
  }
  if (/\b(TODO|TBD|YOUR NAME|PLACEHOLDER|20xx)\b/i.test(section)) {
    fail(`${key} contains an unfilled template marker`)
  }
}

if (
  !provenanceText.includes('OpenAI ChatGPT') ||
  !provenanceText.includes('вымышленного университета')
) {
  fail('asset provenance does not record the supplied origin and fictional setting')
}

if (process.exitCode) process.exit(process.exitCode)
console.log(
  `Production license check passed: ${entries.length} bundled dependencies; required license text and notices are present.`,
)
