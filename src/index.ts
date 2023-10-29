import { Context, Dict, h, Logger, Quester, Session } from 'koishi'
import { Config, parseForbidden, parseInput } from './config'
import { ImageData } from './types'
import { download, getImageSize, NetworkError, Size } from './utils'
import { } from '@koishijs/translator'
import { } from '@koishijs/plugin-help'


export * from './config'

export const reactive = true
export const name = 'rryth'

const logger = new Logger(name)

function handleError(session: Session, err: Error) {
  if (Quester.isAxiosError(err)) {
    if (err.response?.data) {
      logger.error(err.response.data)
      return session.text(err.response.data.message)
    }
    if (err.response?.status === 402) {
      return session.text('.unauthorized')
    } else if (err.response?.status) {
      return session.text('.response-error', [err.response.status])
    } else if (err.code === 'ETIMEDOUT') {
      return session.text('.request-timeout')
    } else if (err.code) {
      return session.text('.request-failed', [err.code])
    }
  }
  logger.error(err)
  return session.text('.unknown-error')
}

interface Forbidden {
  pattern: string
  strict: boolean
}

export function apply(ctx: Context, config: Config) {
  ctx.i18n.define('zh', require('./locales/zh'))

  let forbidden: Forbidden[]
  const tasks: Dict<Set<string>> = Object.create(null)
  const globalTasks = new Set<string>()

  ctx.accept(['forbidden'], (config) => {
    forbidden = parseForbidden(config.forbidden)
  }, { immediate: true })


  const resolution = (source: string): Size => {
    const cap = source.match(/^(\d*\.?\d+)[x×](\d*\.?\d+)$/)
    if (!cap) throw new Error()
    const width = +cap[1]
    const height = +cap[2]
    return { width, height }
  }

  const cmd = ctx.command(`${name} <prompts:text>`)
    .alias('sai', 'rr')
    .userFields(['authority'])
    .option('resolution', '-r <resolution>', { type: resolution })
    .option('override', '-O')
    .option('seed', '-x <seed:number>')
    .option('scale', '-c <scale:number>')
    .option('strength', '-N <strength:number>')
    .option('undesired', '-u <undesired>')
    .action(async ({ session, options }, input) => {

      if (!input?.trim()) return session.execute(`help ${name}`)

      let imgUrl: string, image: ImageData
      input = h.transform(input, {
        image(attrs) {
          imgUrl = attrs.url
          return ''
        },
      })

      if (!input.trim() && !config.basePrompt) {
        return session.text('.expect-prompt')
      }

      const { errPath, positive, uc } = parseInput(input, config, forbidden, options.override)
      let prompt = positive.join(', ')
      if (errPath) return session.text(errPath)

      if (config.translator && ctx.translator) {
        const zhPromptMap: string[] = prompt.match(/[\u4e00-\u9fa5]+/g)
        if (zhPromptMap?.length > 0) {
          try {
            const translatedMap = (await ctx.translator.translate({ input: zhPromptMap.join(','), target: 'en' })).toLocaleLowerCase().split(',')
            zhPromptMap.forEach((t, i) => {
              prompt = prompt.replace(t, translatedMap[i]).replace('，', ',')
            })
          } catch (err) {
            logger.warn(err)
          }
        }
      }

      const seed = options.seed || Math.floor(Math.random() * Math.pow(2, 32))

      const parameters: Dict = {
        seed,
        prompt,
        uc,
        scale: options.scale ?? config.scale ?? 11,
        steps: imgUrl ? 50 : 28,
      }

      if (imgUrl) {
        try {
          image = await download(ctx, imgUrl)
        } catch (err) {
          if (err instanceof NetworkError) {
            return session.text(err.message, err.params)
          }
          logger.error(err)
          return session.text('.download-error')
        }

        options.resolution ||= getImageSize(image.buffer)
        Object.assign(parameters, {
          height: options.resolution.height,
          width: options.resolution.width,
          strength: options.strength ?? config.strength ?? 0.3,
        })

      } else {
        options.resolution ||= { height: config.hight, width: config.weigh }
        Object.assign(parameters, {
          height: options.resolution.height,
          width: options.resolution.width,
        })
      }

      const id = Math.random().toString(36).slice(2)
      if (config.maxConcurrency) {
        const store = tasks[session.cid] ||= new Set()
        if (store.size >= config.maxConcurrency) {
          return session.text('.concurrent-jobs')
        } else {
          store.add(id)
        }
      }

      session.send(globalTasks.size
        ? session.text('.pending', [globalTasks.size])
        : session.text('.waiting'))

      globalTasks.add(id)
      const cleanUp = () => {
        tasks[session.cid]?.delete(id)
        globalTasks.delete(id)
      }
      const data = (() => {
        const body = {
          init_images: image && [image.dataUrl],
          prompt: parameters.prompt,
          seed: parameters.seed,
          negative_prompt: parameters.uc,
          cfg_scale: parameters.scale,
          width: parameters.width,
          height: parameters.height,
          denoising_strength: parameters.strength,
          steps: parameters.steps,
        }
        return body
      })()
      const request = () => ctx.http.axios('https://api.draw.t4wefan.pub/', {
        method: 'POST',
        timeout: config.requestTimeout,
        headers: {
          ...config.headers,
        },
        data,
      }).then((res) => {
        return res.data.images
      })

      let ret: string[]
      while (true) {
        try {
          ret = await request()
          cleanUp()
          break
        } catch (err) {
          cleanUp()
          return handleError(session, err)
        }
      }

      async function getContent() {
        const safeImg = config.censor
          ? h('censor', h('image', { url: 'data:image/png;base64,' + ret[0] }))
          : h('image', { url: 'data:image/png;base64,' + ret[0] })
        const attrs: Dict<any, string> = {
          userId: session.userId,
          nickname: session.author?.nickname || session.username,
        }
        if (config.output === 'minimal') {
          return safeImg
        }
        const result = h('figure')
        const lines = [`种子 = ${seed}`]
        if (config.output === 'verbose') {
          lines.push(`模型 = Anything 3.0`)
          lines.push(`提示词相关度 = ${parameters.scale}`)
          if (parameters.image) lines.push(`图转图强度 = ${parameters.strength}`)
        }
        result.children.push(h('message', attrs, lines.join('\n')))
        result.children.push(h('message', attrs, `关键词 = ${prompt}`))
        if (config.output === 'verbose') {
          result.children.push(h('message', attrs, `排除关键词 = ${uc}`))
        }
        result.children.push(safeImg)
        if (config.output === 'verbose') result.children.push(h('message', attrs, `工作站名称 = 42`))
        return result
      }

      const ids = await session.send(await getContent())

      if (config.recallTimeout) {
        ctx.setTimeout(() => {
          for (const id of ids) {
            session.bot.deleteMessage(session.channelId, id)
          }
        }, config.recallTimeout)
      }
    })
}
