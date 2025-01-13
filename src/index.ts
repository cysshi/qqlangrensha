import { Context, Schema } from 'koishi'
import { GameManager } from './game'

export const name = 'qqlangrensha'

export interface Config {}

export const Config: Schema<Config> = Schema.object({})

// 定义数据库表结构
declare module 'koishi' {
  interface Tables {
    werewolf_players: WerewolfPlayer
    werewolf_games: WerewolfGame
  }
}

// 玩家表结构
export interface WerewolfPlayer {
  id: number
  user_id: string
  game_id: number
  player_number: number
  nickname: string
  role_id: number // 1:狼人 2:村民 3:预言家
  status: number // 0:死亡 1:存活
  vote_count: number
  wolf_vote_count: number
  has_voted: number // 0:未投票 1:已投票
}

// 游戏表结构
export interface WerewolfGame {
  id: number
  guild_id: string
  status: number // 0:已结束 1:准备中 2:游戏中
  player_count: number
  creator_id: string
  winner_id: number // 0:无 1:狼人胜利 2:好人胜利
}

// 声明插件依赖
export const inject = ['database']

export function apply(ctx: Context) {
  // 创建游戏管理器
  const gameManager = new GameManager(ctx)
  ctx['werewolf.manager'] = gameManager

  // 辅助函数：更新群聊session
  async function updateGuildSession(session: any) {
    if (!session?.event?.guild?.id) return

    const existingGame = await ctx.database.get('werewolf_games', {
      guild_id: session.event.guild.id,
      $or: [{ status: 1 }, { status: 2 }]
    }) as WerewolfGame[]

    if (existingGame.length > 0) {
      const gameState = gameManager.getGameState(existingGame[0].id)
      if (gameState) {
        gameState.updateGuildSession(session)
      }
    }
  }

  // 扩展数据库
  ctx.model.extend('werewolf_players', {
    id: 'unsigned',
    user_id: 'string',
    game_id: 'unsigned',
    player_number: 'unsigned',
    nickname: 'string',
    role_id: 'unsigned',
    status: 'unsigned',
    vote_count: 'unsigned',
    wolf_vote_count: 'unsigned',
    has_voted: 'unsigned'
  }, {
    primary: 'id',
    autoInc: true,
  })

  ctx.model.extend('werewolf_games', {
    id: 'unsigned',
    guild_id: 'string',
    status: 'unsigned',
    player_count: 'unsigned',
    creator_id: 'string',
    winner_id: 'unsigned'
  }, {
    primary: 'id',
    autoInc: true,
  })

  // 创建游戏
  ctx.command('创建狼人杀游戏 <nickname:string>', '创建一局狼人杀游戏')
    .action(async ({ session }, nickname) => {
      if (!session?.event?.guild?.id) {
        return '请在群聊中使用此命令'
      }

      await updateGuildSession(session)

      if (!nickname) {
        return '请输入你的游戏昵称'
      }

      // 检查是否已经在游戏中
      const existingPlayer = await ctx.database.get('werewolf_players', {
        user_id: session.event.user.id,
      }) as WerewolfPlayer[]

      if (existingPlayer.length > 0) {
        return '你已经在一局游戏中了'
      }

      // 创建新游戏
      const game = await ctx.database.create('werewolf_games', {
        guild_id: session.event.guild.id,
        status: 1, // 准备中
        player_count: 1,
        creator_id: session.event.user.id,
        winner_id: 0
      }) as WerewolfGame

      // 创建玩家记录
      await ctx.database.create('werewolf_players', {
        user_id: session.event.user.id,
        game_id: game.id,
        player_number: 1,
        nickname: nickname,
        role_id: 0, // 未分配
        status: 1, // 存活
        vote_count: 0,
        wolf_vote_count: 0,
        has_voted: 0 // 未投票
      })

      return `游戏创建成功！你的昵称是：${nickname}\n等待其他玩家加入...（输入 /加入狼人杀 [昵称] 加入游戏）`
    })

  // 加入游戏
  ctx.command('加入狼人杀 <nickname:string>', '加入一局狼人杀游戏')
    .action(async ({ session }, nickname) => {
      if (!session?.event?.guild?.id) {
        return '请在群聊中使用此命令'
      }

      await updateGuildSession(session)

      if (!nickname) {
        return '请输入你的游戏昵称'
      }

      // 检查是否已经在游戏中
      const existingPlayer = await ctx.database.get('werewolf_players', {
        user_id: session.event.user.id,
      }) as WerewolfPlayer[]

      if (existingPlayer.length > 0) {
        return '你已经在一局游戏中了'
      }

      // 查找当前群的准备中的游戏
      const game = await ctx.database.get('werewolf_games', {
        guild_id: session.event.guild.id,
        status: 1
      }) as WerewolfGame[]

      if (game.length === 0) {
        return '当前没有正在准备中的游戏'
      }

      // 检查游戏人数是否已满
      if (game[0].player_count >= 4) {
        return '当前游戏人数已满'
      }

      // 创建玩家记录
      await ctx.database.create('werewolf_players', {
        user_id: session.event.user.id,
        game_id: game[0].id,
        player_number: game[0].player_count + 1,
        nickname: nickname,
        role_id: 0, // 未分配
        status: 1, // 存活
        vote_count: 0,
        wolf_vote_count: 0,
        has_voted: 0 // 未投票
      })

      // 更新游戏人数
      await ctx.database.set('werewolf_games', game[0].id, {
        player_count: game[0].player_count + 1
      })

      return `加入游戏成功！你的昵称是：${nickname}\n当前玩家数：${game[0].player_count + 1}/4`
    })

  // 开始游戏
  ctx.command('开始狼人杀游戏', '开始一局狼人杀游戏')
    .action(async ({ session }) => {
      if (!session?.event?.guild?.id) {
        return '请在群聊中使用此命令'
      }

      await updateGuildSession(session)

      // 查找当前群的准备中的游戏
      const game = await ctx.database.get('werewolf_games', {
        guild_id: session.event.guild.id,
        status: 1
      }) as WerewolfGame[]

      if (game.length === 0) {
        return '当前没有正在准备中的游戏'
      }

      // 检查是否是创建者
      if (game[0].creator_id !== session.event.user.id) {
        return '只有游戏创建者才能开始游戏'
      }

      // 检查人数是否足够
      if (game[0].player_count < 4) {
        return '人数不足，无法开始游戏'
      }

      // 分配角色
      const players = await ctx.database.get('werewolf_players', {
        game_id: game[0].id
      }) as WerewolfPlayer[]

      // 角色列表：1狼人，2村民，2村民，3预言家
      const roles = [1, 2, 2, 3]
      // 打乱角色顺序
      for (let i = roles.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [roles[i], roles[j]] = [roles[j], roles[i]]
      }

      // 分配角色给玩家
      for (let i = 0; i < players.length; i++) {
        await ctx.database.set('werewolf_players', players[i].id, {
          role_id: roles[i]
        })
      }

      // 更新游戏状态
      await ctx.database.set('werewolf_games', game[0].id, {
        status: 2 // 游戏中
      })

      // 启动游戏管理器
      await gameManager.startGame(game[0].id, session)
      return null // 不返回消息，避免重复发送
    })

  // 查看身份
  ctx.command('查看身份', '查看自己的游戏身份')
    .action(async ({ session }) => {
      // 确保是私聊
      if (session?.event?.guild?.id) {
        return '请在私聊中使用此命令'
      }

      // 获取玩家信息
      const player = await ctx.database.get('werewolf_players', {
        user_id: session.event.user.id,
      }) as WerewolfPlayer[]

      if (player.length === 0) {
        return '你当前不在任何游戏中'
      }

      // 获取游戏状态并保存session
      const gameState = gameManager.getGameState(player[0].game_id)
      if (gameState) {
        gameState.updatePlayerSession(session.event.user.id, session)
      }

      const roleNames = {
        0: '未分配',
        1: '狼人',
        2: '村民',
        3: '预言家'
      }

      // 获取当前游戏阶段
      let phaseMessage = ''
      let commandTip = ''
      if (gameState) {
        const phase = gameState.getPhase()
        const phaseNames = {
          'prepare': '准备阶段',
          'night': '夜晚阶段',
          'day': '白天讨论阶段',
          'vote': '投票阶段',
          'ended': '游戏已结束'
        }
        phaseMessage = `\n当前游戏阶段：${phaseNames[phase]}`

        // 根据身份和阶段添加命令提示
        if (phase === 'night') {
          if (player[0].role_id === 1) {
            commandTip = '\n你可以使用 /刀人 [玩家序号|昵称] 命令刀人'
          } else if (player[0].role_id === 3) {
            commandTip = '\n你可以使用 /验人 [玩家序号|昵称] 命令验人'
          } else {
            commandTip = '\n你是普通村民，夜晚无法行动'
          }
        } else if (phase === 'vote') {
          commandTip = '\n你可以使用 /投票 [玩家序号|昵称] 命令投票'
        }
      }

      // 获取所有玩家列表
      const allPlayers = await ctx.database.get('werewolf_players', {
        game_id: player[0].game_id
      }) as WerewolfPlayer[]

      let playerList = '\n\n当前玩家列表：'
      allPlayers.forEach(p => {
        playerList += `\n${p.player_number}. ${p.nickname}${p.status === 0 ? ' (已死亡)' : ''}`
      })

      return `你的身份是：${roleNames[player[0].role_id]}${phaseMessage}${commandTip}${playerList}`
    })

  // 刀人（狼人）
  ctx.command('刀人 <target:string>', '狼人刀人')
    .action(async ({ session }, target) => {
      if (!target) {
        return '请指定要刀的玩家（序号或昵称）'
      }

      // 获取玩家信息
      const player = await ctx.database.get('werewolf_players', {
        user_id: session.event.user.id,
      }) as WerewolfPlayer[]

      if (player.length === 0) {
        return '你当前不在任何游戏中'
      }

      if (player[0].role_id !== 1) {
        return '你不是狼人，无法使用此命令'
      }

      // 获取游戏状态
      const gameState = gameManager.getGameState(player[0].game_id)
      if (!gameState || gameState.getPhase() !== 'night') {
        return '现在不是狼人行动时间'
      }

      // 更新session
      gameState.updatePlayerSession(session.event.user.id, session)

      // 获取目标玩家
      const targetPlayer = await ctx.database.get('werewolf_players', {
        game_id: player[0].game_id,
        $or: [
          { player_number: parseInt(target) || 0 },
          { nickname: target }
        ]
      }) as WerewolfPlayer[]

      if (targetPlayer.length === 0) {
        return '找不到目标玩家'
      }

      if (targetPlayer[0].status === 0) {
        return '该玩家已经死亡'
      }

      // 更新被刀票数
      await ctx.database.set('werewolf_players', targetPlayer[0].id, {
        wolf_vote_count: targetPlayer[0].wolf_vote_count + 1
      })

      return '投票成功'
    })

  // 验人（预言家）
  ctx.command('验人 <target:string>', '预言家验人')
    .action(async ({ session }, target) => {
      if (!target) {
        return '请指定要验的玩家（序号或昵称）'
      }

      // 获取玩家信息
      const player = await ctx.database.get('werewolf_players', {
        user_id: session.event.user.id,
      }) as WerewolfPlayer[]

      if (player.length === 0) {
        return '你当前不在任何游戏中'
      }

      if (player[0].role_id !== 3) {
        return '你不是预言家，无法使用此命令'
      }

      // 获取游戏状态
      const gameState = gameManager.getGameState(player[0].game_id)
      if (!gameState || gameState.getPhase() !== 'night') {
        return '现在不是预言家行动时间'
      }

      // 更新session
      gameState.updatePlayerSession(session.event.user.id, session)

      // 获取目标玩家
      const targetPlayer = await ctx.database.get('werewolf_players', {
        game_id: player[0].game_id,
        $or: [
          { player_number: parseInt(target) || 0 },
          { nickname: target }
        ]
      }) as WerewolfPlayer[]

      if (targetPlayer.length === 0) {
        return '找不到目标玩家'
      }

      return `${targetPlayer[0].nickname} 是${targetPlayer[0].role_id === 1 ? '狼人' : '好人'}`
    })

  // 投票
  ctx.command('投票 <target:string>', '投票处决玩家')
    .action(async ({ session }, target) => {
      if (!session?.event?.guild?.id) {
        return '请在群聊中使用此命令'
      }

      await updateGuildSession(session)

      if (!target) {
        return '请指定要投票的玩家（序号或昵称）'
      }

      // 获取玩家信息
      const player = await ctx.database.get('werewolf_players', {
        user_id: session.event.user.id,
      }) as WerewolfPlayer[]

      if (player.length === 0) {
        return '你当前不在任何游戏中'
      }

      if (player[0].status === 0) {
        return '你已经死亡，无法投票'
      }

      // 获取游戏状态
      const gameState = gameManager.getGameState(player[0].game_id)
      if (!gameState || gameState.getPhase() !== 'vote') {
        return '现在不是投票时间'
      }

      // 更新session
      gameState.updateGuildSession(session)

      // 获取目标玩家
      const targetPlayer = await ctx.database.get('werewolf_players', {
        game_id: player[0].game_id,
        $or: [
          { player_number: parseInt(target) || 0 },
          { nickname: target }
        ]
      }) as WerewolfPlayer[]

      if (targetPlayer.length === 0) {
        return '找不到目标玩家'
      }

      if (targetPlayer[0].status === 0) {
        return '该玩家已经死亡'
      }

      // 更新投票数
      await ctx.database.set('werewolf_players', targetPlayer[0].id, {
        vote_count: targetPlayer[0].vote_count + 1
      })

      // 标记该玩家已投票
      await ctx.database.set('werewolf_players', player[0].id, {
        has_voted: 1
      })

      return '投票成功'
    })

  // 弃票
  ctx.command('弃票', '放弃本轮投票')
    .action(async ({ session }) => {
      if (!session?.event?.guild?.id) {
        return '请在群聊中使用此命令'
      }

      await updateGuildSession(session)

      // 获取玩家信息
      const player = await ctx.database.get('werewolf_players', {
        user_id: session.event.user.id,
      }) as WerewolfPlayer[]

      if (player.length === 0) {
        return '你当前不在任何游戏中'
      }

      if (player[0].status === 0) {
        return '你已经死亡，无法投票'
      }

      // 获取游戏状态
      const gameState = gameManager.getGameState(player[0].game_id)
      if (!gameState || gameState.getPhase() !== 'vote') {
        return '现在不是投票时间'
      }

      // 更新session
      gameState.updateGuildSession(session)

      // 标记该玩家已投票（弃票）
      await ctx.database.set('werewolf_players', player[0].id, {
        has_voted: 1
      })

      return '弃票成功'
    })

  // 强制结束游戏
  ctx.command('结束狼人杀游戏', '强制结束当前游戏')
    .action(async ({ session }) => {
      if (!session?.event?.guild?.id) {
        return '请在群聊中使用此命令'
      }

      await updateGuildSession(session)

      // 查找当前群的进行中的游戏
      const game = await ctx.database.get('werewolf_games', {
        guild_id: session.event.guild.id,
        $or: [{ status: 1 }, { status: 2 }]
      }) as WerewolfGame[]

      if (game.length === 0) {
        return '当前没有正在进行的游戏'
      }

      // 检查是否是创建者
      if (game[0].creator_id !== session.event.user.id) {
        return '只有游戏创建者才能结束游戏'
      }

      // 获取所有玩家信息
      const players = await ctx.database.get('werewolf_players', {
        game_id: game[0].id
      }) as WerewolfPlayer[]

      // 显示所有玩家身份
      let result = '游戏已被强制结束\n玩家身份：'
      players.forEach(p => {
        const role = p.role_id === 1 ? '狼人' : p.role_id === 2 ? '村民' : '预言家'
        result += `\n${p.nickname}: ${role}`
      })

      // 清理游戏状态
      const gameState = gameManager.getGameState(game[0].id)
      if (gameState) {
        // 更新session以发送最后的消息
        gameState.updateGuildSession(session)
        // 先调用endGame清理计时器和数据
        await gameState.endGame()
        // 然后从游戏管理器中移除游戏
        gameManager.removeGame(game[0].id)
      }

      return result
    })

  // 查看对局信息
  ctx.command('查看对局信息', '查看当前游戏的状态和玩家列表')
    .action(async ({ session }) => {
      if (!session?.event?.guild?.id) {
        return '请在群聊中使用此命令'
      }

      await updateGuildSession(session)

      // 查找当前群的游戏
      const game = await ctx.database.get('werewolf_games', {
        guild_id: session.event.guild.id,
        $or: [{ status: 1 }, { status: 2 }]
      }) as WerewolfGame[]

      if (game.length === 0) {
        return '当前没有正在进行的游戏'
      }

      // 获取所有玩家信息
      const players = await ctx.database.get('werewolf_players', {
        game_id: game[0].id
      }) as WerewolfPlayer[]

      // 获取游戏状态
      const gameState = gameManager.getGameState(game[0].id)
      const phase = gameState ? gameState.getPhase() : 'unknown'
      const phaseNames = {
        'prepare': '准备阶段',
        'night': '夜晚阶段',
        'day': '白天讨论阶段',
        'vote': '投票阶段',
        'ended': '游戏已结束',
        'unknown': '未知状态'
      }

      // 获取创建者信息
      const creator = players.find(p => p.user_id === game[0].creator_id)

      // 构建返回信息
      let result = '当前游戏信息：\n'
      result += `游戏状态：${game[0].status === 1 ? '准备中' : '游戏中'}\n`
      result += `当前阶段：${phaseNames[phase]}\n`
      result += `创建者：${creator?.nickname || '未知'}\n`
      result += `玩家数量：${game[0].player_count}/4\n`
      result += '\n玩家列表：'

      // 添加玩家列表
      players.forEach(p => {
        const status = p.status === 0 ? ' (已死亡)' : ''
        result += `\n${p.player_number}. ${p.nickname}${status}`
      })

      // 添加游戏阶段提示
      if (phase === 'prepare') {
        result += '\n\n等待其他玩家加入，输入 /加入狼人杀 [昵称] 加入游戏'
      } else if (phase === 'night') {
        result += '\n\n当前是夜晚阶段，请等待狼人和预言家行动'
      } else if (phase === 'day') {
        result += '\n\n当前是讨论阶段，请在群里讨论'
      } else if (phase === 'vote') {
        result += '\n\n当前是投票阶段，请使用 /投票 [玩家序号|昵称] 进行投票'
      }

      // 添加命令提示
      result += '\n\n可用命令：'
      result += '\n/查看身份 - 私聊查看自己的身份'
      if (phase === 'vote') {
        result += '\n/投票 [玩家序号|昵称] - 投票处决玩家'
      }
      if (game[0].creator_id === session.event.user.id) {
        if (game[0].status === 1) {
          result += '\n/开始狼人杀游戏 - 开始游戏'
        }
        result += '\n/结束狼人杀游戏 - 强制结束游戏'
      }

      return result
    })
}
