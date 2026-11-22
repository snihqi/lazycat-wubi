/**
 * types.ts — 全站对外类型定义（唯一一份）。
 *
 * 负责：内核所有模块之间、以及内核与界面之间的**结构约定**。
 * 不负责：任何实现、任何默认值、任何 DOM / 框架类型。
 * 调用方：src/core/* 与界面层（界面只应 `import type` 这里的东西 + index.ts 的函数）。
 *
 * 约定：所有时间字段都是**毫秒时间戳**（`Date.now()` 口径），所有字数都是**有效字数**
 * （见 wordcount.ts），所有货币都是**单一整数、单位铜**（见 currency.ts）。
 */

/* ============================ 卡片与题库 ============================ */

/** 卡片类型。字根 / 单字 / 二字词 / 三字词 / 四字词。 */
export type CardKind = 'roots' | 'chars' | 'word2' | 'word3' | 'idiom';

/**
 * 练习模式：strict = 打错不前进（界面当前全部使用）；
 * follow = 打错前进，留给长文本 / 未来的多字目标（内核算得出来，界面暂不接）。
 */
export type PracticeMode = 'strict' | 'follow';

/** 字根卡的一个条目：303 个字根 + 25 个一级简码。 */
export interface RootItem {
  /** 稳定 ID，如 `root:e001` / `shortcode:g`。存档只存这个。 */
  id: string;
  kind: 'root' | 'shortcode';
  /** 键位字母（大写），如 `G`。 */
  key: string;
  /** 字根字形或简码字，如 `一`。界面用它显示。 */
  glyph: string;
  /** 字根名（只有主字根有，变体为空串）。 */
  name: string;
  /** 说话/口诀用的区号 1–5，0 表示未知。 */
  zone: number;
  /** 字根字形 SVG 的 path d 指令；简码条目为空串（用系统字体渲染）。 */
  path: string;
}

/** 3000 字表的单条记录。 */
export interface CharRecord {
  ch: string;
  /** 全码候选，如 `['r','rqy','rqyy']`。 */
  codes: string[];
  /** 拆解（字根 gid 串，非人类可读），原样保留。 */
  units: string;
  /** 结构/区位标记，原样保留。 */
  xy: string;
  /**
   * 取码类别的原始标记（数据源原样保留，**不要改数据**）：
   *   `k` = **键名字**（王 `gggg` / 土 `ffff` / 大 `dddd` —— 四码相同，连打四次）；
   *   `r` = **成字字根**（一 `g` / `ggl` / `ggll` —— 报户口 + 首笔 + 次笔 + 末笔）；
   *   空串 = 普通字（拆字根 + 末笔字型识别码）。
   *
   * 两者容易写反：`k` 是「这个字就是键名」，`r` 是「这个字本身是个字根、但不是键名」。
   */
  kind: string;
  /** 拼音，多个读音用 ` / ` 分隔。 */
  py: string;
  /** 笔画数（原样字符串）。 */
  strokes: string;
  /** 部首。 */
  radical: string;
  /** 字频排名，从 1 起。 */
  freqRank: number;
}

/** 卡片索引里的一条：主页的每张卡都对应一条。 */
export interface CardBase {
  /** 稳定 ID（不是数组下标），如 `chars:1-500`。 */
  id: string;
  kind: CardKind;
  title: string;
  /** 数据出处，便于核对与致谢。 */
  source: string;
  /** 有效字数（字根卡 = 题数）。这是全站唯一口径：经验/速度/任务都用它。 */
  charCount: number;
  /**
   * 纯汉字数（不含英文、数字）。**只用于核对设计稿上的"字数"**，不要拿它算速度。
   * 例：`冰灯` 设计稿写 935 字（汉字），实际有效字数 945（多出 10 个数字）。
   */
  hanCount?: number;
}

/** 逐条出题的卡（字根 / 单字 / 词组）：题目以稳定 ID 引用。 */
export interface ItemCard extends CardBase {
  /** 题目数量。 */
  count: number;
  /** 稳定题目 ID 列表；内容本身在 roots.json / chars.json / words.json 里。 */
  items: string[];
}


export type Card = ItemCard;

/* ============================ 逐字比对 ============================ */

/** 一次 `commit()` 的结果。逐字消费，未消费的留在 `rest` 里。 */
export interface CommitResult {
  /** 本次上屏被消费掉的字符数（含打错的那个字）。 */
  consumed: number;
  /** 未被消费的剩余串，界面应留到下一次上屏后一起提交。 */
  rest: string;
  /**
   * 本次比对是否**没有**被错字挡住（既不是"推进了几步"，也不是"打对了"）。
   *
   * - 跟打模式：消费了字符就是 `true`（打错也照样前进）；
   * - 严格模式：这次上屏里只要有一个错字就是 `false`（见 `blocked`）。**注意错字之前的
   *   正确字已经被消费、`index` 也已经前进了** —— 例如一次上屏 3 个字、第 3 个打错：
   *   `{ index: 2, expecting: '今', advanced: false, blocked: true, consumed: 3 }`。
   *
   * **界面必须用 `index` / `expecting` 定位当前字，不要用 `advanced` 自增。**
   * 把 `advanced` 当成"前进了一格"会在一次上屏多字时把高亮错位（用户会以为是丢了字），
   * 因为它是全串级的是/否，不是位移量。
   */
  advanced: boolean;
  /** 是否因打错停在当前字（严格模式；跟打模式永远 false）。与 `advanced` 互为反面。 */
  blocked: boolean;
  /** 本次比对是否全部正确。 */
  correct: boolean;
  /** 严格模式打错时：界面应该继续等待的那个字（原字，不变）。 */
  expecting: string | null;
  /** 推进后的当前字索引。 */
  index: number;
  /** 是否已打完（剩余目标里没有有效字）。 */
  done: boolean;
  /** 本次上屏里打错的那个字（界面标朱用），没有则 null。 */
  wrong: string | null;
  /** 累计统计快照。 */
  stats: MatchStats;
}

/** 比对累计统计。`correctChars` 只数**有效字**（汉字/英文/数字）。 */
export interface MatchStats {
  correctChars: number;
  wrongChars: number;
  correctPunct: number;
  wrongPunct: number;
  skipped: number;
}

/* ============================ 计时 ============================ */

/** 计时状态机。`ready` 显示 `—`（不是 0）。 */
export type TimerStatus = 'ready' | 'running' | 'paused' | 'finished' | 'exited';

/** 计时快照，供界面一次读取。 */
export interface TimerSnapshot {
  status: TimerStatus;
  /** 已用毫秒（不含暂停）。 */
  elapsedMs: number;
  /** 是否已经开始过（第一次有效击键）。 */
  started: boolean;
}

/* ============================ 经验与等级 ============================ */

/** 等级进度。 */
export interface XpProgress {
  /** 当前等级 1–100。 */
  level: number;
  /** 本级已获得经验。 */
  into: number;
  /** 本级升级所需经验（满级为 0）。 */
  need: number;
  /** 本级进度 0–1（满级恒为 1）。 */
  ratio: number;
  /** 距离下一级还差多少经验（满级为 0）。 */
  toNext: number;
  /** 是否满级。 */
  isMax: boolean;
  /** 总经验（已按上限夹取）。 */
  totalXp: number;
}

/** 经验展示值：达到上限后 `text` 为 `'∞'`。 */
export interface XpDisplay {
  capped: boolean;
  value: number;
  text: string;
}

/** 加经验的结果。 */
export interface XpGrant {
  total: number;
  gained: number;
  levelBefore: number;
  levelAfter: number;
  levelUp: boolean;
  capped: boolean;
}

/* ============================ 间隔重复队列 ============================ */

/** 队列里的一题。`count` 从 -1 起算（-1 = 从没答对过）。 */
export interface QueueItem {
  /** 稳定题目 ID。 */
  id: string;
  count: number;
  /** 这一轮是否答错过（界面据此展开拆解）。 */
  failed: boolean;
}

/** 队列进度。 */
export interface QueueProgress {
  /** 总题数。 */
  total: number;
  /**
   * 练过的题数（至少答对过一次，`count >= 0`）。
   *
   * 为什么要这一档：「已熟」的门槛是答对 8 次，一张 500 字的单字卡要 4000 次作答
   * 才会出现第一个熟字 —— 界面上永远是「已熟 0/500」，看起来像坏了。
   * 练过是能真实增长的进度，熟是长期目标，两个数一起显示才有意义。
   */
  seen: number;
  /** 已熟题数。 */
  mastered: number;
  /** 0–1。 */
  ratio: number;
  /** 已答对的总次数（含重复）。 */
  answers: number;
}

/** 队列序列化快照。**不存数组下标**，存身份 + 熟练度。 */
export interface QueueSnapshot {
  v: 1;
  /** RNG 状态，保证恢复后仍可复现。 */
  seedState: number;
  jitter: boolean;
  ids: string[];
  counts: number[];
  failed: boolean[];
  /** 已答对总次数。可选：旧档没有就按 0 起算，不影响顺序与熟练度。 */
  answers?: number;
}
