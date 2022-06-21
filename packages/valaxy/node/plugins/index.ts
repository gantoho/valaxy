import fs from 'fs'

import { join, relative } from 'path'
import type { Plugin, ResolvedConfig } from 'vite'
// import consola from 'consola'
import { resolveConfig } from '../config'
import type { ResolvedValaxyOptions, ValaxyServerOptions } from '../options'
import { resolveImportPath, slash, toAtFS } from '../utils'
import { createMarkdownToVueRenderFn } from '../markdown/markdownToVue'
import type { PageDataPayload } from '../../types'
import { checkMd } from '../markdown/check'
import { VALAXY_CONFIG_ID } from './valaxy'

/**
 * for /@valaxyjs/styles
 * @param roots
 * @returns
 */
function generateStyles(roots: string[], options: ResolvedValaxyOptions) {
  const imports: string[] = []

  // katex
  if (options.config.features.katex) {
    imports.push(`import "${toAtFS(resolveImportPath('katex/dist/katex.min.css', true))}"`)
    imports.push(`import "${join(options.clientRoot, 'styles/third/katex.scss')}"`)
  }

  for (const root of roots) {
    const styles: string[] = []

    const autoloadNames = ['index', 'css-vars']
    autoloadNames.forEach((name) => {
      styles.push(join(root, 'styles', `${name}.css`))
      styles.push(join(root, 'styles', `${name}.scss`))
    })

    for (const style of styles) {
      if (fs.existsSync(style))
        imports.push(`import "${toAtFS(style)}"`)
    }
  }

  return imports.join('\n')
}

function generateLocales(roots: string[]) {
  const imports: string[] = [
    'const messages = { "zh-CN": {}, en: {} }',
  ]
  const languages = ['zh-CN', 'en']

  roots.forEach((root, i) => {
    languages.forEach((lang) => {
      const langYml = `${root}/locales/${lang}.yml`
      if (fs.existsSync(langYml) && fs.readFileSync(langYml, 'utf-8')) {
        const varName = lang.replace('-', '') + i
        imports.push(`import ${varName} from "${toAtFS(langYml)}"`)
        imports.push(`Object.assign(messages['${lang}'], ${varName})`)
      }
    })
  })

  imports.push('export default messages')
  return imports.join('\n')
}

export function createValaxyPlugin(options: ResolvedValaxyOptions, serverOptions: ValaxyServerOptions = {}): Plugin {
  const valaxyPrefix = '/@valaxy'

  let valaxyConfig = options.config

  const roots = [options.clientRoot, options.themeRoot, options.userRoot]

  let markdownToVue: Awaited<ReturnType<typeof createMarkdownToVueRenderFn>>
  let hasDeadLinks = false
  let config: ResolvedConfig

  return {
    name: 'valaxy',
    enforce: 'pre',

    async configResolved(resolvedConfig) {
      config = resolvedConfig
      markdownToVue = await createMarkdownToVueRenderFn(
        options.userRoot,
        options.config.markdownIt,
        options.pages,
        config.define,
        config.command === 'build',
        config.base,
        options.config.lastUpdated,
      )
    },

    configureServer(server) {
      server.watcher.add([
        options.configFile,
        options.userRoot,
        options.themeRoot,
      ])
    },

    resolveId(id) {
      if (id.startsWith(valaxyPrefix))
        return id
      return null
    },

    load(id) {
      if (id === `/${VALAXY_CONFIG_ID}`)
        // stringify twice for \"
        return `export default ${JSON.stringify(JSON.stringify(valaxyConfig))}`

      if (id === '/@valaxyjs/context') {
        return `export default ${JSON.stringify(JSON.stringify({
          userRoot: options.userRoot,
          // clientRoot: options.clientRoot,
        }))}`
      }

      // generate styles
      if (id === '/@valaxyjs/styles')
        return generateStyles(roots, options)

      if (id === '/@valaxyjs/locales')
        return generateLocales(roots)

      if (id.startsWith(valaxyPrefix))
        return ''
    },

    async transform(code, id) {
      if (id.endsWith('.md')) {
        checkMd(code, id)
        code.replace('{%', '\{\%')
        code.replace('%}', '\%\}')

        // const scripts = [
        // '<script setup>',
        // 'import { useRoute } from "vue-router"',
        // 'const route = useRoute()',
        // `route.meta.headers = ${JSON.stringify(_md.__data)}`,
        // `export const data = JSON.parse(${JSON.stringify(JSON.stringify(pageData))})`,
        // `frontmatter.data = JSON.parse(${JSON.stringify(JSON.stringify(pageData))})`,
        // '</script>',
        // ]

        // const li = code.lastIndexOf('</script>')
        // code = code.slice(0, li) + scripts.join('\n') + code.slice(li + 9)

        // transform .md files into vueSrc so plugin-vue can handle it
        const { vueSrc, deadLinks, includes } = await markdownToVue(
          code,
          id,
          config.publicDir,
        )
        if (deadLinks.length)
          hasDeadLinks = true

        if (includes.length) {
          includes.forEach((i) => {
            this.addWatchFile(i)
          })
        }

        return vueSrc
      }
    },

    renderStart() {
      if (hasDeadLinks)
        throw new Error('One or more pages contain dead links.')
    },

    async handleHotUpdate(ctx) {
      // handle valaxy.config.ts hmr
      const { file, server, read } = ctx
      if (file !== options.configFile)
        return

      // send headers
      if (file.endsWith('.md')) {
        const content = await read()
        const { pageData, vueSrc } = await markdownToVue(
          content,
          file,
          join(options.userRoot, 'public'),
        )

        const path = `/${slash(relative(`${options.userRoot}/pages`, file))}`
        const payload: PageDataPayload = {
          // path: `/${slash(relative(srcDir, file))}`,
          path,
          pageData,
        }

        server.ws.send({
          type: 'custom',
          event: 'valaxy:pageData',
          data: payload,
        })

        // overwrite src so vue plugin can handle the HMR
        ctx.read = () => vueSrc
      }

      const { config } = await resolveConfig()

      serverOptions.onConfigReload?.(config, options.config)
      Object.assign(options.config, config)

      // if (config.base !== options.config.base)
      //   consola.warn('[valaxy]: config.base has changed. Please restart the dev server.')
      valaxyConfig = config

      const moduleIds = [`/${VALAXY_CONFIG_ID}`, '/@valaxyjs/context']
      const moduleEntries = [
        ...Array.from(moduleIds).map(id => server.moduleGraph.getModuleById(id)),
      ].filter(<T>(item: T): item is NonNullable<T> => !!item)

      return moduleEntries
    },
  }
}