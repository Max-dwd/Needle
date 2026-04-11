export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
}

export interface ScreenshotOptions {
  format?: 'png' | 'jpeg';
  quality?: number;
  fullPage?: boolean;
  path?: string;
}

export interface BrowserSessionInfo {
  workspace?: string;
  connected?: boolean;
  [key: string]: unknown;
}

export interface IPage {
  goto(
    url: string,
    options?: {
      waitUntil?: 'load' | 'none' | 'domcontentloaded' | 'networkidle';
      settleMs?: number;
    },
  ): Promise<void>;
  evaluate(js: string): Promise<unknown>;
  getCookies(opts?: {
    domain?: string;
    url?: string;
  }): Promise<BrowserCookie[]>;
  tabs(): Promise<unknown[]>;
  closeTab(index?: number): Promise<void>;
  newTab(): Promise<void>;
  selectTab(index: number): Promise<void>;
  screenshot(options?: ScreenshotOptions): Promise<string>;
  setFileInput?(files: string[], selector?: string): Promise<void>;
  closeWindow?(): Promise<void>;
  getCurrentUrl?(): Promise<string | null>;
}

export interface IBrowserFactory {
  connect(opts?: { timeout?: number; workspace?: string }): Promise<IPage>;
  close(): Promise<void>;
}
