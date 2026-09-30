import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface DetectedBuild {
  /** Absolute Dockerfile path; a generated one lives outside the build context. */
  dockerfile: string
  /** Named build contexts (`docker build --build-context name=dir`) the Dockerfile reads from. */
  contexts: Record<string, string>
  /** How we arrived at it, for the build log. */
  reason: string
  generated: boolean
  /** Whether the requested Discord embed tag was wired into the served HTML. */
  embedInjected: boolean
}

interface PackageJson {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  engines?: { node?: string }
}

/** Build-context name a generated Dockerfile uses to reach its companion files. */
const GENERATED_CONTEXT = 'sitedeployer'

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

function nodeTag(pkg: PackageJson, contextDir: string): string {
  const nvmrc = join(contextDir, '.nvmrc')
  if (existsSync(nvmrc)) {
    const major = readFileSync(nvmrc, 'utf8').trim().replace(/^v/, '').split('.')[0]
    if (major && /^\d+$/.test(major)) return `${major}-alpine`
  }
  const engine = pkg.engines?.node
  const major = engine?.match(/(\d+)/)?.[1]
  return major ? `${major}-alpine` : '22-alpine'
}

function packageManager(contextDir: string): { install: string; runner: string } {
  if (existsSync(join(contextDir, 'pnpm-lock.yaml')))
    return { install: 'corepack enable && pnpm install --frozen-lockfile', runner: 'pnpm' }
  if (existsSync(join(contextDir, 'yarn.lock')))
    return { install: 'corepack enable && yarn install --immutable', runner: 'yarn' }
  if (existsSync(join(contextDir, 'package-lock.json'))) return { install: 'npm ci', runner: 'npm' }
  return { install: 'npm install --no-audit --no-fund', runner: 'npm' }
}

/** Where a framework drops its production build, when the app has no server of its own. */
function staticOutputDir(pkg: PackageJson): string {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  if (deps['react-scripts']) return 'build'
  if (deps['@angular/cli']) return 'dist'
  if (deps['vite'] || deps['astro'] || deps['svelte']) return 'dist'
  return 'dist'
}

/** Replaces the contents of genDir so no file from an earlier detection lingers. */
function writeGenerated(genDir: string, files: Record<string, string>): void {
  rmSync(genDir, { recursive: true, force: true })
  mkdirSync(genDir, { recursive: true })
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(genDir, name), body, 'utf8')
  }
}

function generated(genDir: string, reason: string): DetectedBuild {
  return {
    dockerfile: join(genDir, 'Dockerfile'),
    contexts: { [GENERATED_CONTEXT]: genDir },
    reason,
    generated: true,
    embedInjected: false,
  }
}

/** An nginx single-quoted string. The embed tag carries no `$` or `'` (see serializeEmbed). */
function nginxString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/**
 * `embedTag` is spliced in before `</head>` of every HTML response with sub_filter,
 * which the official nginx image is built with. Rewriting at serve time rather than
 * build time keeps the source tree untouched and covers framework output alike.
 */
function nginxConf(port: number, embedTag: string | null): string {
  const inject = embedTag
    ? `
    sub_filter '</head>' ${nginxString(`${embedTag}</head>`)};
    sub_filter_once on;
`
    : ''
  return `server {
    listen ${port};
    server_name _;
    root /usr/share/nginx/html;
    index index.html;
    access_log /dev/stdout;
    error_log  /dev/stderr warn;
${inject}
    location / {
        try_files $uri $uri/ /index.html;
    }
}
`
}

/**
 * Picks the Dockerfile for a source tree, generating one when the project does
 * not ship its own. Generated files land in `opts.genDir`, outside the build
 * context, so the source tree is never written to and can be mounted read-only.
 */
export function detectBuild(
  contextDir: string,
  opts: { dockerfilePath?: string | null; containerPort: number; genDir: string; embedTag?: string | null },
): DetectedBuild {
  const embedTag = opts.embedTag ?? null
  if (opts.dockerfilePath) {
    const abs = join(contextDir, opts.dockerfilePath)
    if (!existsSync(abs)) throw new Error(`Configured dockerfilePath not found: ${opts.dockerfilePath}`)
    return { dockerfile: abs, contexts: {}, reason: 'configured on the site', generated: false, embedInjected: false }
  }

  if (existsSync(join(contextDir, 'Dockerfile'))) {
    return {
      dockerfile: join(contextDir, 'Dockerfile'),
      contexts: {},
      reason: 'repository ships a Dockerfile',
      generated: false,
      embedInjected: false,
    }
  }

  const pkg = readJson<PackageJson>(join(contextDir, 'package.json'))
  if (pkg) {
    const tag = nodeTag(pkg, contextDir)
    const pm = packageManager(contextDir)
    const hasStart = Boolean(pkg.scripts?.start)
    const hasBuild = Boolean(pkg.scripts?.build)

    if (hasStart) {
      const buildStep = hasBuild ? `RUN ${pm.runner} run build\n` : ''
      writeGenerated(opts.genDir, {
        Dockerfile: `# generated by site-deployer
FROM node:${tag}
WORKDIR /app
ENV NODE_ENV=production
COPY . .
RUN ${pm.install}
${buildStep}EXPOSE ${opts.containerPort}
CMD ["${pm.runner}", "start"]
`,
      })
      return generated(opts.genDir, `generated: node ${tag} app with a "start" script`)
    }

    if (hasBuild) {
      const outDir = staticOutputDir(pkg)
      writeGenerated(opts.genDir, {
        Dockerfile: `# generated by site-deployer
FROM node:${tag} AS build
WORKDIR /app
COPY . .
RUN ${pm.install}
RUN ${pm.runner} run build

FROM nginx:alpine
COPY --from=build /app/${outDir} /usr/share/nginx/html
COPY --from=${GENERATED_CONTEXT} nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE ${opts.containerPort}
`,
        'nginx.conf': nginxConf(opts.containerPort, embedTag),
      })
      return { ...generated(opts.genDir, `generated: static build served by nginx from ./${outDir}`), embedInjected: Boolean(embedTag) }
    }
  }

  if (existsSync(join(contextDir, 'index.html'))) {
    writeGenerated(opts.genDir, {
      Dockerfile: `# generated by site-deployer
FROM nginx:alpine
COPY . /usr/share/nginx/html
COPY --from=${GENERATED_CONTEXT} nginx.conf /etc/nginx/conf.d/default.conf
RUN rm -rf /usr/share/nginx/html/.git
EXPOSE ${opts.containerPort}
`,
      'nginx.conf': nginxConf(opts.containerPort, embedTag),
    })
    return { ...generated(opts.genDir, 'generated: plain static site served by nginx'), embedInjected: Boolean(embedTag) }
  }

  throw new Error(
    'Could not determine how to build this project: no Dockerfile, no package.json with a start/build script, and no index.html. Add a Dockerfile or set dockerfilePath.',
  )
}

