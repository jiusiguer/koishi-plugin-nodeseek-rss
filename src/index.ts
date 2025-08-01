import { Context, Schema, h, Logger, $ } from 'koishi'
import { XMLParser } from 'fast-xml-parser'
import {} from '@koishijs/plugin-help'

export const name = 'nodeseek-rss'
export const inject = ['database', 'http']

export interface Config {
  rssUrl: string
  updateInterval: number
  proxyUrl?: string
  maxCacheSize: number
  categoryCacheSize: Record<string, number>
  enableAutoUpdate: boolean
  pushEnabled: boolean
  maxSubscriptionsPerUser: number
  pushInterval: number
  pushBatchSize: number
}

export const Config: Schema<Config> = Schema.object({
  rssUrl: Schema.string().default('https://rss.nodeseek.com/').description('NodeSeek RSS源地址'),
  updateInterval: Schema.number().default(10).min(1).max(3600).description('更新间隔（秒）'),
  proxyUrl: Schema.string().description('代理地址（可选，格式：http://127.0.0.1:2080）'),
  maxCacheSize: Schema.number().default(500).min(100).max(1000).description('总缓存上限'),
  categoryCacheSize: Schema.object({
    daily: Schema.number().default(50).min(10).max(100).description('日常分类缓存数'),
    tech: Schema.number().default(50).min(10).max(100).description('技术分类缓存数'),
    info: Schema.number().default(50).min(10).max(100).description('情报分类缓存数'),
    review: Schema.number().default(50).min(10).max(100).description('测评分类缓存数'),
    trade: Schema.number().default(50).min(10).max(100).description('交易分类缓存数'),
    carpool: Schema.number().default(50).min(10).max(100).description('拼车分类缓存数'),
    promotion: Schema.number().default(30).min(10).max(100).description('推广分类缓存数'),
    dev: Schema.number().default(50).min(10).max(100).description('Dev分类缓存数'),
    'photo-share': Schema.number().default(30).min(10).max(100).description('贴图分类缓存数'),
    expose: Schema.number().default(30).min(10).max(100).description('曝光分类缓存数')
  }).description('各分类缓存大小设置'),
  enableAutoUpdate: Schema.boolean().default(true).description('启用自动更新'),
  pushEnabled: Schema.boolean().default(true).description('启用关键词推送功能'),
  maxSubscriptionsPerUser: Schema.number().default(10).min(1).max(50).description('每用户最大订阅数'),
  pushInterval: Schema.number().default(1000).min(500).max(5000).description('推送间隔（毫秒）'),
  pushBatchSize: Schema.number().default(5).min(1).max(20).description('每次推送最大帖子数')
})

// 声明数据库表结构
declare module 'koishi' {
  interface Tables {
    nodeseek_posts: NodeSeekPost
    nodeseek_subscriptions: NodeSeekSubscription
    nodeseek_push_records: NodeSeekPushRecord
  }
}

export interface NodeSeekPost {
  id: number
  postId: string
  title: string
  description: string
  link: string
  category: string
  author: string
  pubDate: Date
  guid: string
  createdAt: Date
  updatedAt: Date
}

export interface NodeSeekSubscription {
  id: number
  platformId: string  // platform:selfId 格式，如 "discord:123456"
  userId: string
  keywords: string[]  // 关键词数组
  categories: string[]  // 订阅的分类
  createdAt: Date
  updatedAt: Date
}

export interface NodeSeekPushRecord {
  id: number
  platformId: string  // platform:selfId 格式
  userId: string
  postId: string
  pushedAt: Date
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger(name)

  // 扩展数据库表
  ctx.model.extend('nodeseek_posts', {
    id: 'unsigned',
    postId: 'string',
    title: 'text',
    description: 'text',
    link: 'string',
    category: 'string',
    author: 'string',
    pubDate: 'timestamp',
    guid: 'string',
    createdAt: 'timestamp',
    updatedAt: 'timestamp'
  }, {
    primary: 'id',
    autoInc: true,
    unique: ['postId']
  })

  // 扩展订阅表
  ctx.model.extend('nodeseek_subscriptions', {
    id: 'unsigned',
    platformId: 'string',
    userId: 'string',
    keywords: 'json',
    categories: 'json',
    createdAt: 'timestamp',
    updatedAt: 'timestamp'
  }, {
    primary: 'id',
    autoInc: true,
    unique: ['platformId', 'userId']
  })

  // 扩展推送记录表
  ctx.model.extend('nodeseek_push_records', {
    id: 'unsigned',
    platformId: 'string',
    userId: 'string',
    postId: 'string',
    pushedAt: 'timestamp'
  }, {
    primary: 'id',
    autoInc: true,
    unique: [['platformId', 'userId', 'postId']]  // 复合唯一约束
  })

  const xmlParser = new XMLParser({
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true
  })

  // 订阅服务类
  class SubscriptionService {
    constructor(private ctx: Context) {}

    // 获取平台ID
    private getPlatformId(session: any): string {
      return `${session.platform}:${session.selfId}`
    }

    // 添加订阅
    async addSubscription(session: any, keywords: string[], categories: string[] = []): Promise<{ success: boolean; message: string }> {
      const platformId = this.getPlatformId(session)
      const userId = session.userId

      try {
        // 检查是否已存在订阅
        const existing = await this.ctx.database.get('nodeseek_subscriptions', { platformId, userId })
        
        if (existing.length > 0) {
          // 合并关键词和分类
          const existingKeywords = existing[0].keywords || []
          const existingCategories = existing[0].categories || []
          
          const newKeywords = [...new Set([...existingKeywords, ...keywords])]
          const newCategories = [...new Set([...existingCategories, ...categories])]
          
          // 检查订阅数量限制
          if (newKeywords.length > config.maxSubscriptionsPerUser) {
            return { 
              success: false, 
              message: `订阅关键词数量超限，最多允许 ${config.maxSubscriptionsPerUser} 个关键词` 
            }
          }

          await this.ctx.database.set('nodeseek_subscriptions', { platformId, userId }, {
            keywords: newKeywords,
            categories: newCategories,
            updatedAt: new Date()
          })

          return { 
            success: true, 
            message: `✅ 订阅更新成功！当前关键词：${newKeywords.join(', ')}` 
          }
        } else {
          // 检查订阅数量限制
          if (keywords.length > config.maxSubscriptionsPerUser) {
            return { 
              success: false, 
              message: `订阅关键词数量超限，最多允许 ${config.maxSubscriptionsPerUser} 个关键词` 
            }
          }

          await this.ctx.database.create('nodeseek_subscriptions', {
            platformId,
            userId,
            keywords,
            categories,
            createdAt: new Date(),
            updatedAt: new Date()
          })

          return { 
            success: true, 
            message: `✅ 订阅创建成功！关键词：${keywords.join(', ')}` 
          }
        }
      } catch (error) {
        logger.error('添加订阅失败:', error)
        return { success: false, message: '❌ 添加订阅失败，请稍后重试' }
      }
    }

    // 删除订阅
    async removeSubscription(session: any, keywords?: string[]): Promise<{ success: boolean; message: string }> {
      const platformId = this.getPlatformId(session)
      const userId = session.userId

      try {
        const existing = await this.ctx.database.get('nodeseek_subscriptions', { platformId, userId })
        
        if (existing.length === 0) {
          return { success: false, message: '❌ 您还没有任何订阅' }
        }

        if (!keywords || keywords.length === 0) {
          // 删除所有订阅
          await this.ctx.database.remove('nodeseek_subscriptions', { platformId, userId })
          return { success: true, message: '✅ 已清空所有订阅' }
        } else {
          // 删除指定关键词
          const existingKeywords = existing[0].keywords || []
          const newKeywords = existingKeywords.filter(k => !keywords.includes(k))
          
          if (newKeywords.length === existingKeywords.length) {
            return { success: false, message: '❌ 指定的关键词不在订阅列表中' }
          }

          if (newKeywords.length === 0) {
            await this.ctx.database.remove('nodeseek_subscriptions', { platformId, userId })
            return { success: true, message: '✅ 已删除所有关键词，订阅已清空' }
          } else {
            await this.ctx.database.set('nodeseek_subscriptions', { platformId, userId }, {
              keywords: newKeywords,
              updatedAt: new Date()
            })
            return { 
              success: true, 
              message: `✅ 删除成功！当前关键词：${newKeywords.join(', ')}` 
            }
          }
        }
      } catch (error) {
        logger.error('删除订阅失败:', error)
        return { success: false, message: '❌ 删除订阅失败，请稍后重试' }
      }
    }

    // 获取用户订阅
    async getUserSubscription(session: any): Promise<NodeSeekSubscription | null> {
      const platformId = this.getPlatformId(session)
      const userId = session.userId

      try {
        const results = await this.ctx.database.get('nodeseek_subscriptions', { platformId, userId })
        return results.length > 0 ? results[0] : null
      } catch (error) {
        logger.error('获取用户订阅失败:', error)
        return null
      }
    }

    // 获取所有订阅（用于推送）
    async getAllSubscriptions(): Promise<NodeSeekSubscription[]> {
      try {
        return await this.ctx.database.get('nodeseek_subscriptions', {})
      } catch (error) {
        logger.error('获取所有订阅失败:', error)
        return []
      }
    }

    // 检查帖子是否已推送给用户
    async isPushed(platformId: string, userId: string, postId: string): Promise<boolean> {
      try {
        const results = await this.ctx.database.get('nodeseek_push_records', { platformId, userId, postId })
        return results.length > 0
      } catch (error) {
        logger.error('检查推送记录失败:', error)
        return false
      }
    }

    // 记录推送
    async recordPush(platformId: string, userId: string, postId: string): Promise<void> {
      try {
        await this.ctx.database.create('nodeseek_push_records', {
          platformId,
          userId,
          postId,
          pushedAt: new Date()
        })
      } catch (error) {
        logger.error('记录推送失败:', error)
      }
    }

    // 匹配关键词
    matchKeywords(post: NodeSeekPost, keywords: string[]): boolean {
      if (!keywords || keywords.length === 0) return false
      
      // 特殊关键词 "*" 匹配所有帖子
      if (keywords.includes('*')) return true
      
      const searchText = `${post.title} ${post.description}`.toLowerCase()
      return keywords.some(keyword => searchText.includes(keyword.toLowerCase()))
    }

    // 匹配分类
    matchCategories(post: NodeSeekPost, categories: string[]): boolean {
      if (!categories || categories.length === 0) return true
      return categories.includes(post.category)
    }
  }

  const subscriptionService = new SubscriptionService(ctx)

  // 推送管理器类
  class PushManager {
    private pushQueue: Map<string, NodeSeekPost[]> = new Map()
    private isProcessing = false

    constructor(private ctx: Context) {}

    // 检查新帖子并触发推送
    async checkNewPostsForPush(newPosts: NodeSeekPost[]): Promise<void> {
      if (!config.pushEnabled || newPosts.length === 0) return

      try {
        const subscriptions = await subscriptionService.getAllSubscriptions()
        if (subscriptions.length === 0) return

        for (const subscription of subscriptions) {
          const matchedPosts: NodeSeekPost[] = []

          for (const post of newPosts) {
            // 检查是否已推送过
            const isPushed = await subscriptionService.isPushed(
              subscription.platformId, 
              subscription.userId, 
              post.postId
            )
            
            if (isPushed) continue

            // 检查关键词匹配
            const keywordMatched = subscriptionService.matchKeywords(post, subscription.keywords)
            // 检查分类匹配
            const categoryMatched = subscriptionService.matchCategories(post, subscription.categories)

            if (keywordMatched && categoryMatched) {
              matchedPosts.push(post)
            }
          }

          if (matchedPosts.length > 0) {
            const userKey = `${subscription.platformId}:${subscription.userId}`
            const existingPosts = this.pushQueue.get(userKey) || []
            this.pushQueue.set(userKey, [...existingPosts, ...matchedPosts])
          }
        }

        // 启动推送处理
        if (this.pushQueue.size > 0) {
          this.processPushQueue().catch(error => {
            logger.error('处理推送队列失败:', error)
          })
        }
      } catch (error) {
        logger.error('检查推送失败:', error)
      }
    }

    // 处理推送队列
    private async processPushQueue(): Promise<void> {
      if (this.isProcessing) return
      this.isProcessing = true

      try {
        const entries = Array.from(this.pushQueue.entries())
        this.pushQueue.clear()

        for (const [userKey, posts] of entries) {
          try {
            // userKey 格式: "platform:selfId:userId"
            const parts = userKey.split(':')
            const userId = parts[parts.length - 1]  // 最后一部分是真实用户ID
            const platformId = parts.slice(0, -1).join(':')  // 前面部分是 platform:selfId
            await this.sendPushNotification(platformId, userId, posts)
            
            // 等待推送间隔
            if (config.pushInterval > 0) {
              await new Promise(resolve => setTimeout(resolve, config.pushInterval))
            }
          } catch (error) {
            logger.error(`推送给用户 ${userKey} 失败:`, error)
          }
        }
      } finally {
        this.isProcessing = false
      }
    }

    // 发送推送通知
    private async sendPushNotification(platformId: string, userId: string, posts: NodeSeekPost[]): Promise<void> {
      try {
        // 沙盒环境特殊处理
        if (platformId === 'sandbox') {
          // 记录推送（沙盒环境也要记录，避免重复推送）
          for (const post of posts.slice(0, config.pushBatchSize)) {
            await subscriptionService.recordPush(platformId, userId, post.postId)
          }
          
          return
        }
        
        const bot = this.ctx.bots[platformId]
        
        if (!bot) {
          logger.warn(`未找到机器人实例: ${platformId}`)
          
          // 尝试按平台查找第一个可用的机器人
          const [platform] = platformId.split(':')
          const availableBot = this.ctx.bots.find(b => b.platform === platform)
          
          if (availableBot) {
            // 检查是否试图给机器人发送消息
            if (userId === availableBot.selfId) {
              logger.warn(`跳过推送：不能给机器人自己发送消息 (userId: ${userId}, botId: ${availableBot.selfId})`)
              return
            }
            
            try {
              // 限制推送数量
              const postsToSend = posts.slice(0, config.pushBatchSize)
              const message = this.formatPushMessage(postsToSend)

              // 发送推送消息
              await availableBot.sendPrivateMessage(userId, message)
              
              // 记录推送
              for (const post of postsToSend) {
                await subscriptionService.recordPush(platformId, userId, post.postId)
              }
              
              // 如果还有更多帖子，提示用户
              if (posts.length > config.pushBatchSize) {
                const remainingCount = posts.length - config.pushBatchSize
                await availableBot.sendPrivateMessage(userId, `📝 还有 ${remainingCount} 条匹配帖子，使用相关命令查看更多`)
              }
            } catch (error) {
              if (error.message && error.message.includes('bots can\'t send messages to bots')) {
                logger.warn(`跳过推送：目标用户 ${userId} 是机器人，无法发送私聊消息`)
              } else {
                throw error // 重新抛出其他错误
              }
            }
          } else {
            logger.warn(`平台 ${platform} 没有可用的机器人实例`)
          }
          return
        }

        // 限制推送数量
        const postsToSend = posts.slice(0, config.pushBatchSize)
        const message = this.formatPushMessage(postsToSend)

        // 发送推送消息
        await bot.sendPrivateMessage(userId, message)
        
        // 记录推送
        for (const post of postsToSend) {
          await subscriptionService.recordPush(platformId, userId, post.postId)
        }
        
        // 如果还有更多帖子，提示用户
        if (posts.length > config.pushBatchSize) {
          const remainingCount = posts.length - config.pushBatchSize
          await bot.sendPrivateMessage(userId, `📝 还有 ${remainingCount} 条匹配帖子，使用相关命令查看更多`)
        }
      } catch (error) {
        logger.error('发送推送通知失败:', error)
        throw error
      }
    }

    // 格式化推送消息
    private formatPushMessage(posts: NodeSeekPost[]): string {
      const categoryNames: Record<string, string> = {
        daily: '日常',
        tech: '技术',
        info: '情报',
        review: '测评',
        trade: '交易',
        carpool: '拼车',
        promotion: '推广',
        dev: 'Dev',
        'photo-share': '贴图',
        expose: '曝光'
      }

      let message = `🔔 NodeSeek 关键词推送 (${posts.length}条)\n\n`

      posts.forEach((post, index) => {
        const timeStr = post.pubDate.toLocaleString('zh-CN', { 
          timeZone: 'Asia/Shanghai',
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        })
        
        message += `${index + 1}. ${post.title}\n`
        message += `👤 ${post.author} | 🏷️ ${categoryNames[post.category] || post.category} | 🕒 ${timeStr}\n`
        
        if (post.description && post.description.trim()) {
          const desc = post.description.length > 100 
            ? post.description.substring(0, 100) + '...' 
            : post.description
          message += `📝 ${desc}\n`
        }
        
        message += `🔗 ${post.link}\n\n`
      })

      message += `💡 使用 ns.push list 查看订阅 | ns.push del 取消订阅`
      return message.trim()
    }
  }

  const pushManager = new PushManager(ctx)

  // RSS数据获取和解析
  async function fetchRSSData(): Promise<any[]> {
    try {
      const httpOptions: any = {
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Koishi NodeSeek RSS Bot)'
        }
      }

      let response: string
      
      // 如果配置了代理，使用代理
      if (config.proxyUrl) {
        try {
          // 使用系统curl命令通过代理获取数据
          const { execSync } = require('child_process')
          response = execSync(`curl -x "${config.proxyUrl}" -s "${config.rssUrl}"`, { 
            encoding: 'utf8',
            timeout: 30000 
          })
        } catch (curlError) {
          logger.warn('代理请求失败，尝试直接请求:', curlError.message)
          response = await ctx.http.get(config.rssUrl, httpOptions)
        }
      } else {
        response = await ctx.http.get(config.rssUrl, httpOptions)
      }
      
      if (!response || response.length < 100) {
        throw new Error('获取到的RSS数据为空或过短')
      }
      
      const parsedData = xmlParser.parse(response)
      const items = parsedData.rss?.channel?.item || []
      
      // 确保items是数组
      const itemArray = Array.isArray(items) ? items : (items ? [items] : [])
      
      return itemArray
    } catch (error) {
      logger.error('获取RSS数据失败:', error)
      throw error
    }
  }

  // 处理RSS数据并存储到数据库
  async function processRSSItems(items: any[]): Promise<void> {
    if (!items || items.length === 0) {
      logger.warn('没有RSS项目需要处理')
      return
    }

    const processedItems: Partial<NodeSeekPost>[] = []
    const newPostIds: string[] = []
    
    for (const item of items) {
      try {
        const postId = item.guid || String(Math.random())
        const title = item.title || ''
        const description = item.description || ''
        const link = item.link || ''
        const category = item.category || 'daily'
        const author = item['dc:creator'] || '未知'
        const pubDate = new Date(item.pubDate || Date.now())

        // 检查必要字段
        if (!postId || !title || !link) {
          logger.warn(`跳过无效RSS项目: ${postId || 'no-id'}`)
          continue
        }

        processedItems.push({
          postId,
          title,
          description,
          link,
          category,
          author,
          pubDate,
          guid: postId,
          createdAt: new Date(),
          updatedAt: new Date()
        })

        newPostIds.push(postId)
      } catch (error) {
        logger.error('处理RSS项目时出错:', error)
        continue
      }
    }

    if (processedItems.length === 0) {
      logger.warn('没有有效的RSS项目可以处理')
      return
    }

    // 检查哪些是真正的新帖子（数据库中不存在的）
    let newPosts: NodeSeekPost[] = []
    try {
      const existingPosts = await ctx.database.get('nodeseek_posts', {
        postId: { $in: newPostIds }
      })
      const existingPostIds = new Set(existingPosts.map(p => p.postId))
      
      // 过滤出真正的新帖子
      const reallyNewItems = processedItems.filter(item => !existingPostIds.has(item.postId!))
      
      // 批量插入或更新数据
      await ctx.database.upsert('nodeseek_posts', processedItems, 'postId')
      
      // 获取新插入的完整帖子数据用于推送
      if (reallyNewItems.length > 0) {
        const newPostIdList = reallyNewItems.map(item => item.postId!)
        newPosts = await ctx.database.get('nodeseek_posts', {
          postId: { $in: newPostIdList }
        })
      }
      
      // 清理超出限制的数据
      await cleanupOldPosts()
      
      // 清理推送记录（保留最近30天）
      await cleanupPushRecords()
      
      // 触发推送检查（异步执行，不阻塞主流程）
      if (newPosts.length > 0) {
        pushManager.checkNewPostsForPush(newPosts).catch(error => {
          logger.error('推送检查失败:', error)
        })
      }
    } catch (error) {
      logger.error('存储RSS数据时出错:', error)
      throw error
    }
  }

  // 清理旧数据，维持缓存限制
  async function cleanupOldPosts(): Promise<void> {
    try {
      // 按分类清理
      for (const [category, maxSize] of Object.entries(config.categoryCacheSize)) {
        const posts = await ctx.database
          .select('nodeseek_posts')
          .where({ category })
          .orderBy('pubDate', 'desc')
          .execute()
        
        if (posts.length > maxSize) {
          const toDelete = posts.slice(maxSize).map(p => p.id)
          await ctx.database.remove('nodeseek_posts', toDelete)
        }
      }

      // 全局清理，确保不超过总上限
      const totalCount = (await ctx.database.eval('nodeseek_posts', row => $.count(row.id)))[0] as number
      if (totalCount > config.maxCacheSize) {
        const oldPosts = await ctx.database
          .select('nodeseek_posts', ['id'])
          .orderBy('pubDate', 'asc')
          .limit(totalCount - config.maxCacheSize)
          .execute()
        
        if (oldPosts.length > 0) {
          const toDelete = oldPosts.map(p => p.id)
          await ctx.database.remove('nodeseek_posts', toDelete)
        }
      }
    } catch (error) {
      logger.error('清理旧数据时出错:', error)
    }
  }

  // 清理推送记录，保留最近30天的记录
  async function cleanupPushRecords(): Promise<void> {
    try {
      const thirtyDaysAgo = new Date()
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
      
      const oldRecords = await ctx.database.get('nodeseek_push_records', {
        pushedAt: { $lt: thirtyDaysAgo }
      })
      
      if (oldRecords.length > 0) {
        await ctx.database.remove('nodeseek_push_records', {
          pushedAt: { $lt: thirtyDaysAgo }
        })
      }
    } catch (error) {
      logger.error('清理推送记录时出错:', error)
    }
  }

  // 按分类获取帖子
  async function getPostsByCategory(category: string, limit: number = 5, keyword?: string): Promise<NodeSeekPost[]> {
    try {
      let query = ctx.database.select('nodeseek_posts')
      
      if (category !== 'all') {
        query = query.where({ category })
      }
      
      if (keyword) {
        // 关键字搜索，不区分大小写
        const posts = await query.execute()
        const filteredPosts = posts.filter(post => 
          post.title.toLowerCase().includes(keyword.toLowerCase()) ||
          post.description.toLowerCase().includes(keyword.toLowerCase())
        )
        return filteredPosts
          .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())
          .slice(0, Math.min(limit, 20))
      } else {
        const posts = await query
          .orderBy('pubDate', 'desc')
          .limit(Math.min(limit, 20))
          .execute()
        return posts
      }
    } catch (error) {
      logger.error(`获取分类 ${category} 的帖子时出错:`, error)
      return []
    }
  }

  // 格式化帖子消息
  function formatPosts(posts: NodeSeekPost[], category: string, keyword?: string): string {
    if (posts.length === 0) {
      if (keyword) {
        return `❌ 分类 "${category}" 中未找到包含关键字 "${keyword}" 的帖子`
      }
      return `❌ 分类 "${category}" 暂无帖子数据`
    }

    const categoryNames: Record<string, string> = {
      daily: '日常',
      tech: '技术',
      info: '情报',
      review: '测评',
      trade: '交易',
      carpool: '拼车',
      promotion: '推广',
      dev: 'Dev',
      'photo-share': '贴图',
      expose: '曝光',
      all: '全部'
    }

    const categoryTitle = categoryNames[category] || category
    let message = `📋 NodeSeek ${categoryTitle}`
    
    if (keyword) {
      message += ` (关键字: ${keyword})`
    }
    
    message += ` 最新帖子：\n\n`

    posts.forEach((post, index) => {
      const timeStr = post.pubDate.toLocaleString('zh-CN', { 
        timeZone: 'Asia/Shanghai',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
      
      message += `${index + 1}. ${post.title}\n`
      message += `👤 ${post.author} | 🏷️ ${categoryNames[post.category] || post.category} | 🕒 ${timeStr}\n`
      if (post.description && post.description.trim()) {
        const desc = post.description.length > 50 
          ? post.description.substring(0, 50) + '...' 
          : post.description
        message += `📝 ${desc}\n`
      }
      message += `🔗 ${post.link}\n\n`
    })

    return message.trim()
  }

  // 注册命令
  const nsCommand = ctx.command('ns', 'NodeSeek RSS订阅功能')
    .usage('NodeSeek RSS订阅插件 - 获取最新帖子信息\n\n' +
           '使用 ns.<分类> [关键字] [-c 数量] 获取帖子\n' +
           '支持分类：日常、技术、情报、测评、交易、拼车、推广、Dev、贴图、曝光、all\n' +
           '管理功能：更新、状态\n' +
           '推送订阅：push')
    .example('ns.交易 -c 10')
    .example('ns.技术 服务器')
    .action(() => {
      // 当直接输入 ns 时，显示自定义帮助信息
      return 'NodeSeek RSS订阅插件 - 获取最新帖子信息\n\n' +
             '使用 ns.<分类> [关键字] [-c 数量] 获取帖子\n' +
             '支持分类：日常、技术、情报、测评、交易、拼车、推广、Dev、贴图、曝光、all\n' +
             '管理功能：更新、状态\n' +
             '推送订阅：push\n\n' +
             '使用示例：\n' +
             '    ns.交易 -c 10\n' +
             '    ns.技术 服务器\n\n' +
             '输入 help ns.<命令> 查看具体命令的帮助'
    })

  // 隐藏子命令列表的显示
  ctx.i18n.define('zh-CN', {
    'commands.help.messages.subcommand-prolog': ''
  })

  // 完全移除子命令列表显示
  ctx.on('help/command', (output, command) => {
    if (command.name === 'ns') {
      // 找到子命令开始的位置并移除所有子命令行
      let startIndex = -1
      for (let i = 0; i < output.length; i++) {
        const line = output[i]
        if (line.includes('ns ') && (line.includes('获取') || line.includes('推送') || line.includes('手动') || line.includes('查看'))) {
          startIndex = i
          break
        }
      }
      
      if (startIndex !== -1) {
        // 移除从找到的位置开始的所有行
        output.splice(startIndex)
      }
    }
  })

  // 各分类命令
  const categories = ['daily', 'tech', 'info', 'review', 'trade', 'carpool', 'promotion', 'dev', 'photo-share', 'expose']
  const categoryCommands: Record<string, string> = {
    daily: '日常',
    tech: '技术', 
    info: '情报',
    review: '测评',
    trade: '交易',
    carpool: '拼车',
    promotion: '推广',
    dev: 'Dev',
    'photo-share': '贴图',
    expose: '曝光'
  }

  // 为每个分类注册子命令
  for (const category of categories) {
    const cmdName = categoryCommands[category] || category
    nsCommand.subcommand(`.${cmdName} [关键字:text]`, `获取${cmdName}分类的最新帖子`)
      .option('count', '-c <数量:posint> 显示帖子数量 (1-20)', { fallback: 5 })
      .option('number', '-n <数量:posint> 显示帖子数量 (1-20)') // -n 别名
      .alias(`${category}`) // 添加英文别名
      .action(async ({ options }, keyword) => {
        const count = Number(options.number || options.count || 5)
        const limit = Math.min(Math.max(1, count), 20)
        const posts = await getPostsByCategory(category, limit, keyword)
        return formatPosts(posts, category, keyword)
      })
  }

  // ns.all 命令 - 显示所有分类的最新帖子
  nsCommand.subcommand('.all [关键字:text]', '获取所有分类的最新帖子')
    .option('count', '-c <数量:posint> 显示帖子数量 (1-20)', { fallback: 5 })
    .option('number', '-n <数量:posint> 显示帖子数量 (1-20)') // -n 别名
    .action(async ({ options }, keyword) => {
      const count = Number(options.number || options.count || 5)
      const limit = Math.min(Math.max(1, count), 20)
      const posts = await getPostsByCategory('all', limit, keyword)
      return formatPosts(posts, 'all', keyword)
    })

  // 手动更新命令
  nsCommand.subcommand('.更新', '手动更新RSS数据')
    .alias('update')
    .action(async () => {
      try {
        await updateRSS()
        return '✅ RSS数据更新完成'
      } catch (error) {
        logger.error('手动更新RSS失败:', error)
        return '❌ RSS数据更新失败，请查看日志'
      }
    })

  // 状态查询命令
  nsCommand.subcommand('.状态', '查看插件状态')
    .action(async () => {
      try {
        const totalCountResult = await ctx.database.eval('nodeseek_posts', row => $.count(row.id))
        const totalCount = (totalCountResult[0] as number) || 0
        const categoryCounts: Record<string, number> = {}
        
        for (const category of categories) {
          const countResult = await ctx.database.eval('nodeseek_posts', 
            row => $.count(row.id), 
            { category }
          )
          categoryCounts[category] = (countResult[0] as number) || 0
        }

        let message = `📊 NodeSeek RSS 插件状态\n\n`
        message += `📈 总帖子数: ${totalCount} / ${config.maxCacheSize}\n`
        message += `🔄 自动更新: ${config.enableAutoUpdate ? '开启' : '关闭'}\n`
        message += `⏱️ 更新间隔: ${config.updateInterval}秒\n`
        message += `📱 推送功能: ${config.pushEnabled ? '开启' : '关闭'}\n\n`
        message += `📋 分类统计:\n`
        
        for (const [category, count] of Object.entries(categoryCounts)) {
          const maxSize = config.categoryCacheSize[category] || 50
          const categoryName = categoryCommands[category] || category
          message += `${categoryName}: ${count} / ${maxSize}\n`
        }

        return message
      } catch (error) {
        logger.error('获取状态信息失败:', error)
        return '❌ 获取状态信息失败'
      }
    })

  // ns.push 命令组
  const pushCommand = nsCommand.subcommand('.push', '推送订阅管理')
    .usage('NodeSeek RSS 推送订阅功能\n\n' +
           '添加订阅：ns.push.add <关键词1> [关键词2] [关键词3]...\n' +
           '删除订阅：ns.push.del [关键词1] [关键词2]... (不指定关键词将删除所有)\n' +
           '查看订阅：ns.push.list\n' +
           '清空订阅：ns.push.clear\n' +
           '订阅全部：ns.push.all (测试用，推送所有新帖子)\n\n' +
           '支持多关键词OR匹配，任意关键词匹配即推送')
    .example('ns.push.add 服务器 VPS')
    .example('ns.push.del 服务器')
    .example('ns.push.list')
    .example('ns.push.all')

  // 添加订阅
  pushCommand.subcommand('.add <keywords...>', '添加关键词订阅')
    .action(async ({ session }, ...keywords) => {
      if (!config.pushEnabled) {
        return '❌ 推送功能已关闭'
      }

      if (!keywords || keywords.length === 0) {
        return '❌ 请指定要订阅的关键词'
      }

      // 过滤空关键词和去重
      const validKeywords = [...new Set(keywords.filter(k => k && k.trim()))]
      if (validKeywords.length === 0) {
        return '❌ 请提供有效的关键词'
      }

      const result = await subscriptionService.addSubscription(session, validKeywords)
      return result.message
    })

  // 删除订阅
  pushCommand.subcommand('.del [keywords...]', '删除指定关键词订阅')
    .alias('delete')
    .alias('remove')
    .action(async ({ session }, ...keywords) => {
      if (!config.pushEnabled) {
        return '❌ 推送功能已关闭'
      }

      const validKeywords = keywords && keywords.length > 0 
        ? [...new Set(keywords.filter(k => k && k.trim()))]
        : undefined

      const result = await subscriptionService.removeSubscription(session, validKeywords)
      return result.message
    })

  // 查看订阅列表
  pushCommand.subcommand('.list', '查看当前订阅列表')
    .alias('ls')
    .action(async ({ session }) => {
      if (!config.pushEnabled) {
        return '❌ 推送功能已关闭'
      }

      const subscription = await subscriptionService.getUserSubscription(session)
      if (!subscription || !subscription.keywords || subscription.keywords.length === 0) {
        return '📭 您还没有订阅任何关键词\n\n使用 ns.push add <关键词> 来添加订阅'
      }

      let message = '📋 您的关键词订阅列表：\n\n'
      subscription.keywords.forEach((keyword, index) => {
        message += `${index + 1}. ${keyword}\n`
      })
      
      message += `\n📊 订阅统计：${subscription.keywords.length} / ${config.maxSubscriptionsPerUser}\n`
      message += `🕒 创建时间：${subscription.createdAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n`
      
      if (subscription.updatedAt.getTime() !== subscription.createdAt.getTime()) {
        message += `📝 更新时间：${subscription.updatedAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
      }

      return message
    })

  // 清空所有订阅
  pushCommand.subcommand('.clear', '清空所有订阅')
    .alias('clean')
    .action(async ({ session }) => {
      if (!config.pushEnabled) {
        return '❌ 推送功能已关闭'
      }

      const result = await subscriptionService.removeSubscription(session)
      return result.message
    })

  // 订阅所有新帖子（测试用）
  pushCommand.subcommand('.all', '订阅所有新帖子（测试功能）')
    .action(async ({ session }) => {
      if (!config.pushEnabled) {
        return '❌ 推送功能已关闭'
      }

      // 使用特殊关键词 "*" 表示匹配所有帖子
      const result = await subscriptionService.addSubscription(session, ['*'])
      
      if (result.success) {
        return '✅ 已开启全帖子推送（测试模式）！所有新帖子都会推送给您\n\n⚠️ 注意：这是测试功能，可能产生大量推送消息\n💡 使用 ns.push.clear 可以取消全部订阅'
      } else {
        return result.message
      }
    })

  // RSS更新函数
  async function updateRSS(): Promise<void> {
    try {
      const items = await fetchRSSData()
      await processRSSItems(items)
    } catch (error) {
      logger.error('RSS更新失败:', error)
      throw error
    }
  }

  // 定时任务
  let updateTimer: NodeJS.Timeout | null = null

  function startAutoUpdate(): void {
    if (!config.enableAutoUpdate) return
    
    if (updateTimer) {
      clearInterval(updateTimer)
    }

    updateTimer = setInterval(async () => {
      try {
        await updateRSS()
      } catch (error) {
        logger.error('定时更新RSS失败:', error)
      }
    }, config.updateInterval * 1000)

    logger.info(`自动更新已启动: ${config.updateInterval}s 间隔`)
  }

  // 插件启动时初始化
  ctx.on('ready', async () => {
    logger.info('NodeSeek RSS插件启动中...')
    
    try {
      // 启动时先更新一次数据
      await updateRSS()
      
      // 启动定时更新
      startAutoUpdate()
      
      logger.info('NodeSeek RSS插件启动完成')
    } catch (error) {
      logger.error('插件启动时初始化失败:', error)
    }
  })

  // 插件销毁时清理
  ctx.on('dispose', () => {
    if (updateTimer) {
      clearInterval(updateTimer)
      updateTimer = null
    }
    logger.info('NodeSeek RSS插件已停止')
  })
}