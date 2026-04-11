export { zh } from './zh';
export { en } from './en';

export type Language = 'zh' | 'en';
export type Translations = typeof import('./zh').zh;
