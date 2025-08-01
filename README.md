# koishi-plugin-nodeseek-rss

[![npm](https://img.shields.io/npm/v/koishi-plugin-nodeseek-rss?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-nodeseek-rss)

NodeSeek RSS 订阅插件，支持按分类获取帖子、关键词搜索和推送订阅功能。

## 🌟 功能特性

- **📑 分类浏览**：支持10个分类（日常、技术、情报、测评、交易、拼车、推广、Dev、贴图、曝光）
- **🔍 关键词搜索**：支持多关键词、大小写不敏感的搜索
- **🔔 推送订阅**：关键词匹配自动推送，支持多用户隔离
- **⚡ 智能缓存**：分类缓存管理，自动清理旧数据
- **🚀 热更新**：自动更新RSS数据，可配置更新间隔
- **🎛️ 灵活配置**：支持代理、缓存大小、推送设置等丰富配置

## 📦 安装

```bash
# 通过 Koishi 插件市场安装
# 或通过 npm 安装
npm install koishi-plugin-nodeseek-rss
```

## 🚀 快速开始

### 基本命令

```bash
# 获取分类帖子
ns.交易                    # 获取交易分类最新5条帖子
ns.技术 -c 10             # 获取技术分类最新10条帖子
ns.日常 服务器 -c 5        # 在日常分类中搜索"服务器"关键词

# 获取全部分类
ns.all -c 20              # 获取所有分类最新20条帖子

# 管理功能
ns.更新                    # 手动更新RSS数据
ns.状态                    # 查看插件状态和统计
```

### 推送订阅

```bash
# 添加关键词订阅
ns.push.add 服务器 VPS     # 订阅"服务器"和"VPS"关键词
ns.push.add 优惠 促销 折扣  # 订阅多个促销相关关键词

# 管理订阅
ns.push.list              # 查看当前订阅列表
ns.push.del 服务器        # 删除特定关键词
ns.push.clear             # 清空所有订阅

# 测试功能
ns.push.all               # 订阅所有新帖子（测试用）
```

## ⚙️ 配置选项

```yaml
plugins:
  nodeseek-rss:
    rssUrl: https://rss.nodeseek.com/          # RSS源地址
    updateInterval: 10                         # 更新间隔（秒）
    proxyUrl: http://127.0.0.1:2080           # 代理地址（可选）
    maxCacheSize: 500                         # 总缓存上限
    enableAutoUpdate: true                    # 启用自动更新
    pushEnabled: true                         # 启用推送功能
    maxSubscriptionsPerUser: 10               # 每用户最大订阅数
    pushInterval: 1000                        # 推送间隔（毫秒）
    pushBatchSize: 5                          # 每次推送最大帖子数
    categoryCacheSize:                        # 各分类缓存设置
      daily: 50                               # 日常分类缓存数
      tech: 50                                # 技术分类缓存数
      trade: 50                               # 交易分类缓存数
      # ... 其他分类配置
```

## 📝 支持的分类

| 英文标识 | 中文名称 | 命令示例 |
|---------|---------|---------|
| daily | 日常 | `ns.日常` |
| tech | 技术 | `ns.技术` |
| info | 情报 | `ns.情报` |
| review | 测评 | `ns.测评` |
| trade | 交易 | `ns.交易` |
| carpool | 拼车 | `ns.拼车` |
| promotion | 推广 | `ns.推广` |
| dev | Dev | `ns.Dev` |
| photo-share | 贴图 | `ns.贴图` |
| expose | 曝光 | `ns.曝光` |

## 🔧 技术架构

- **数据存储**：SQLite数据库，自动表结构管理
- **RSS解析**：fast-xml-parser，高效XML解析
- **推送系统**：多平台用户隔离，防重复推送
- **缓存策略**：分类缓存 + 全局缓存双重管理
- **网络支持**：内置代理支持，应对网络限制

## 🛠️ 开发

```bash
# 克隆项目
git clone https://github.com/jiusiguer/koishi-plugin-nodeseek-rss.git
cd koishi-plugin-nodeseek-rss

# 安装依赖
npm install

# 构建项目
npx tsc

# 在Koishi开发环境中测试
# 将插件目录软链接到 koishi/external/ 目录
```

## 📄 许可证

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📞 支持

如有问题，请通过以下方式联系：
- GitHub Issues：[提交问题](https://github.com/jiusiguer/koishi-plugin-nodeseek-rss/issues)
- NodeSeek社区：讨论插件使用和改进建议