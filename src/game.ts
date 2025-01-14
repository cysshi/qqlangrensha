import { Context } from 'koishi'
import { WerewolfGame, WerewolfPlayer } from './index'

export class GameManager {
  private games: Map<number, GameState> = new Map()
  private ctx: Context

  constructor(ctx: Context) {
    this.ctx = ctx
  }

  // 游戏状态
  async startGame(gameId: number, session: any) {
    const game = await this.ctx.database.get('werewolf_games', gameId) as WerewolfGame[]
    if (game.length === 0) return '找不到游戏'

    const gameState = new GameState(this.ctx, game[0], session)
    this.games.set(gameId, gameState)
    await gameState.start()
    return null // 不返回消息，避免重复发送
  }

  // 获取游戏状态
  getGameState(gameId: number): GameState | undefined {
    return this.games.get(gameId)
  }

  // 移除游戏
  removeGame(gameId: number) {
    this.games.delete(gameId)
  }
}

export class GameState {
  private ctx: Context
  private game: WerewolfGame
  private phase: 'prepare' | 'night' | 'day' | 'vote' | 'ended' = 'prepare'
  private guildSessions: {
    session: any,
    lastUseTime: number
  }[] = []
  private playerSessions: Map<string, any> = new Map()
  private timer: NodeJS.Timeout | null = null
  private prepareTimer: NodeJS.Timeout | null = null
  private dayCount: number = 0
  private readonly SESSION_EXPIRE_TIME = 5 * 60 * 1000 // 5分钟
  private readonly PREPARE_TIMEOUT = 300 * 1000 // 300秒
  private readonly MAX_DAYS = 10 // 最大游戏天数

  constructor(ctx: Context, game: WerewolfGame, session: any) {
    this.ctx = ctx
    this.game = game
    this.addGuildSession(session)
    // 设置准备阶段超时
    this.startPrepareTimeout()
  }

  private addGuildSession(session: any) {
    if (!session) return
    this.guildSessions.push({
      session,
      lastUseTime: Date.now()
    })
  }

  updateGuildSession(session: any) {
    if (!session) return

    // 清理过期的session
    const now = Date.now()
    this.guildSessions = this.guildSessions.filter(s => 
      now - s.lastUseTime < this.SESSION_EXPIRE_TIME
    )

    // 检查是否已存在相同的session
    const existingIndex = this.guildSessions.findIndex(s => s.session === session)
    if (existingIndex !== -1) {
      // 用新的session覆盖旧的并更新时间戳
      this.guildSessions[existingIndex] = {
        session,
        lastUseTime: now
      }
      return
    }

    // 添加新session
    this.addGuildSession(session)
  }

  updatePlayerSession(userId: string, session: any) {
    this.playerSessions.set(userId, session)
  }

  async broadcast(message: string, isPrivate: boolean = false, targetUserId?: string): Promise<void> {
    try {
      if (isPrivate) {
        if (!targetUserId) return
        const session = this.playerSessions.get(targetUserId)
        if (session) {
          await session.send(message)
        }
      } else {
        // 获取可用的session
        const now = Date.now()
        const availableSession = this.guildSessions.find(s => 
          now - s.lastUseTime < this.SESSION_EXPIRE_TIME
        )

        if (availableSession) {
          await availableSession.session.send(message)
          // 不更新lastUseTime，保持第一次使用时的时间戳
        } else {
          console.error('No available guild session for broadcast')
        }
      }
    } catch (error) {
      console.error('Failed to broadcast message:', error)
    }
  }

  private startPrepareTimeout() {
    // 只在游戏准备阶段设置超时
    if (this.game.status === 1) {
      this.prepareTimer = setTimeout(async () => {
        // 检查游戏是否仍在准备阶段
        const currentGame = await this.ctx.database.get('werewolf_games', this.game.id) as WerewolfGame[]
        if (currentGame.length > 0 && currentGame[0].status === 1) {
          await this.broadcast('游戏准备时间超过5分钟，自动结束游戏')
          await this.endGame()
          // 从游戏管理器中移除游戏
          const gameManager = this.ctx['werewolf.manager'] as GameManager
          if (gameManager) {
            gameManager.removeGame(this.game.id)
          }
        }
      }, this.PREPARE_TIMEOUT)
    }
  }

  async start(): Promise<string> {
    // 清理准备阶段的超时计时器
    if (this.prepareTimer) {
      clearTimeout(this.prepareTimer)
      this.prepareTimer = null
    }
    const message = await this.startPreparePhase()
    return message
  }

  private async startPreparePhase(): Promise<string> {
    this.phase = 'prepare'
    const message = '游戏开始！请在30秒内私聊查看身份\n游戏流程提示：\n1. 每位玩家私聊机器人发送 /查看身份\n2. 30秒后进入夜晚阶段\n3. 狼人可以私聊使用 /刀人 命令\n4. 预言家可以私聊使用 /验人 命令\n5. 白天阶段在群里讨论\n6. 投票阶段使用 /投票 命令'
    await this.broadcast(message)
    this.timer = setTimeout(() => this.startNightPhase(), 30000)
    return message
  }

  private async startNightPhase(): Promise<string> {
    this.phase = 'night'
    this.dayCount++

    // 检查是否达到最大天数
    if (this.dayCount >= this.MAX_DAYS) {
      await this.broadcast('游戏已进行10天，强制结束游戏')
      // 获取所有玩家信息
      const players = await this.ctx.database.get('werewolf_players', { game_id: this.game.id }) as WerewolfPlayer[]
      // 显示所有玩家身份
      const result = '游戏结果：\n' + players.map(p => 
        `${p.nickname}: ${p.role_id === 1 ? '狼人' : p.role_id === 3 ? '预言家' : '村民'}`
      ).join('\n')
      await this.broadcast(result)
      await this.endGame()
      return result
    }

    await this.broadcast('天黑了！狼人和预言家请行动（120秒）')
    await this.broadcast('天黑了！请使用 /查看身份 获取可执行的命令', true)
    
    // 重置投票计数
    const players = await this.ctx.database.get('werewolf_players', { game_id: this.game.id }) as WerewolfPlayer[]
    await Promise.all(players.map(player => 
      this.ctx.database.set('werewolf_players', player.id, {
        vote_count: 0,
        wolf_vote_count: 0,
        has_voted: 0
      })
    ))

    // 120秒后结算夜晚
    this.timer = setTimeout(() => this.nightSettlement(), 120000)
    return '天黑了，狼人请私聊行动'
  }

  private async nightSettlement(): Promise<string> {
    // 获取所有玩家
    const players = await this.ctx.database.get('werewolf_players', { game_id: this.game.id }) as WerewolfPlayer[]
    
    // 找出被刀票数最多的玩家
    let maxVotes = 0
    let victims: WerewolfPlayer[] = []
    players.forEach(player => {
      if (player.wolf_vote_count > maxVotes) {
        maxVotes = player.wolf_vote_count
        victims = [player]
      } else if (player.wolf_vote_count === maxVotes && maxVotes > 0) {
        victims.push(player)
      }
    })

    let message: string
    // 如果有人被刀
    if (victims.length > 0) {
      // 随机选择一个玩家死亡
      const victim = victims[Math.floor(Math.random() * victims.length)]
      await this.ctx.database.set('werewolf_players', victim.id, { status: 0 })
      message = `天亮了！${victim.nickname} 在昨晚死亡了`
      await this.broadcast(message)
    } else {
      message = '天亮了！昨晚是平安夜'
      await this.broadcast(message)
    }

    // 检查游戏是否结束
    if (await this.checkGameEnd()) {
      return message
    }

    // 进入白天讨论阶段
    await this.startDayPhase()
    return message
  }

  private async startDayPhase(): Promise<string> {
    this.phase = 'day'
    const message = `第${this.dayCount}天：进入讨论阶段，120秒后开始投票\n请在群里讨论，注意不要暴露自己的身份！`
    await this.broadcast(message)
    this.timer = setTimeout(() => this.startVotePhase(), 120000)
    return message
  }

  private async startVotePhase(): Promise<string> {
    this.phase = 'vote'
    // 重置所有玩家的投票状态
    const players = await this.ctx.database.get('werewolf_players', { game_id: this.game.id }) as WerewolfPlayer[]
    await Promise.all(players.map(player => 
      this.ctx.database.set('werewolf_players', player.id, {
        vote_count: 0,
        has_voted: 0
      })
    ))

    const message = '开始投票！请使用 /投票 [玩家序号|昵称] 进行投票，或使用 /弃票 放弃投票（30秒）\n注意：\n1. 存活玩家必须投票或弃票\n2. 死亡玩家无法投票\n3. 可以通过 /查看身份 查看玩家列表\n4. 时间结束未投票视为弃票'
    await this.broadcast(message)
    this.timer = setTimeout(() => this.voteSettlement(), 30000)
    return message
  }

  private async voteSettlement(): Promise<string> {
    // 获取所有玩家
    const players = await this.ctx.database.get('werewolf_players', { game_id: this.game.id }) as WerewolfPlayer[]
    
    // 标记所有未投票的存活玩家为弃票
    await Promise.all(players
      .filter(p => p.status === 1 && p.has_voted === 0)
      .map(player => 
        this.ctx.database.set('werewolf_players', player.id, {
          has_voted: 1
        })
      )
    )
    
    // 找出票数最多的玩家
    let maxVotes = 0
    let victims: WerewolfPlayer[] = []
    players.forEach(player => {
      if (player.vote_count > maxVotes) {
        maxVotes = player.vote_count
        victims = [player]
      } else if (player.vote_count === maxVotes && maxVotes > 0) {
        victims.push(player)
      }
    })

    let message: string
    // 如果有平票，进入第二轮投票
    if (victims.length > 1) {
      message = '出现平票！进入第二轮投票（30秒）'
      await this.broadcast(message)
      // 重置投票
      await Promise.all(players.map(player => 
        this.ctx.database.set('werewolf_players', player.id, {
          vote_count: 0,
          has_voted: 0
        })
      ))
      this.timer = setTimeout(() => this.voteSettlement(), 30000)
      return message
    }

    // 处决玩家
    if (victims.length === 1) {
      const victim = victims[0]
      await this.ctx.database.set('werewolf_players', victim.id, { status: 0 })
      message = `投票结束！${victim.nickname} 被处决了`
      await this.broadcast(message)
    } else {
      message = '投票结束！没有人被处决'
      await this.broadcast(message)
    }

    // 检查游戏是否结束
    if (await this.checkGameEnd()) {
      return message
    }

    // 进入夜晚
    await this.startNightPhase()
    return message
  }

  private async checkGameEnd(): Promise<boolean> {
    // 获取所有玩家
    const players = await this.ctx.database.get('werewolf_players', { game_id: this.game.id }) as WerewolfPlayer[]
    
    // 统计存活的狼人和好人数量
    let aliveWolves = 0
    let aliveVillagers = 0
    players.forEach(player => {
      if (player.status === 1) {
        if (player.role_id === 1) {
          aliveWolves++
        } else {
          aliveVillagers++
        }
      }
    })

    // 判断游戏是否结束
    if (aliveWolves === 0 || aliveWolves >= aliveVillagers) {
      // 游戏结束，广播结果
      const winner = aliveWolves === 0 ? '好人' : '狼人'
      const message = `游戏结束！${winner}获胜！\n玩家身份：\n${players.map(p => `${p.nickname}: ${p.role_id === 1 ? '狼人' : p.role_id === 3 ? '预言家' : '村民'}`).join('\n')}`
      await this.broadcast(message)
      await this.endGame()
      return true
    }

    return false
  }

  async endGame(): Promise<string> {
    this.phase = 'ended'
    // 清理所有计时器
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.prepareTimer) {
      clearTimeout(this.prepareTimer)
      this.prepareTimer = null
    }

    // 清理游戏数据
    try {
      // 清理所有session
      this.playerSessions.clear()
      this.guildSessions = []

      // 删除玩家数据
      await this.ctx.database.remove('werewolf_players', {
        game_id: this.game.id
      })

      // 删除游戏数据
      await this.ctx.database.remove('werewolf_games', {
        id: this.game.id
      })

      console.log(`游戏 ${this.game.id} 的数据已清理`)
    } catch (err) {
      console.error('清理游戏数据失败:', err)
    }

    const message = '游戏结束'
    await this.broadcast(message)
    return message
  }

  getPhase(): string {
    return this.phase
  }

  getGame(): WerewolfGame {
    return this.game
  }
} 