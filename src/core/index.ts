/**
 * index.ts — 内核统一出口。
 *
 * 负责：把 core/* 的公开 API 汇总成**唯一**的 import 入口，并额外提供按模块分组的命名空间。
 * 不负责：任何逻辑（这里只做 re-export）、任何 UI 适配。
 * 调用方：界面层（应当只 `import { ... } from '../core'`）。
 *
 * 用法一（推荐，好搜）：
 *   import { createMatcher, createTimer, levelOf, format } from '../core';
 * 用法二（同名函数多时更清楚）：
 *   import { xp, queue } from '../core';
 *   xp.levelOf(1200);
 *
 * 这里是纯 ESM，没有 DOM、没有 localStorage、没有框架。可以直接被任意打包器吃进去。
 *
 * 这里只放练习本身用得到的东西。存档只有 app/store.ts 一份
 * （`localStorage['lazycat-wubi/v1']`），内核不碰。
 */

export * from './types';
export * from './num';
export * from './rng';
export * from './wordcount';
export * from './matcher';
export * from './timer';
export * from './xp';
export * from './queue';

/* 按模块分组的命名空间（`types` 只有类型，不导出） */
export * as rng from './rng';
export * as wordcount from './wordcount';
export * as matcher from './matcher';
export * as timer from './timer';
export * as xp from './xp';
export * as queue from './queue';
