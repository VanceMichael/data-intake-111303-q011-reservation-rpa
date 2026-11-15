import { chromium } from 'playwright';

const PANELS = ['boat', 'equipment'];

export class PortalSessionLostError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'PortalSessionLostError';
    this.code = 'PORTAL_SESSION_LOST';
    this.cause = cause;
  }
}

function numericOrNull(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function snapshot(page) {
  return page.evaluate(panels => {
    const view = document.querySelector('#portal-view');
    if (!view) throw new Error('门户页面缺少可核对的业务记录区');
    const panel = target => {
      const row = document.querySelector('#view-' + target);
      if (!row) throw new Error('门户页面缺少对象 ' + target);
      return {
        state: row.dataset.state || 'unknown',
        used: row.dataset.used === 'true',
        requestId: row.dataset.requestId || null,
        receipt: row.dataset.receipt || null,
        expiresAt: row.dataset.expiresAt || null,
      };
    };
    const result = {
      url: location.href,
      title: document.title,
      sequence: Number(view.dataset.sequence ?? 0),
      actionSeq: Number(view.dataset.actionSeq ?? 0),
      requestId: view.dataset.requestId || null,
      duplicateBookings: Number(view.dataset.duplicateBookings ?? 0),
      lastOutcome: view.dataset.lastOutcome || null,
      lastTarget: view.dataset.lastTarget || null,
      lastMessage: view.dataset.lastMessage || '',
      panels: {},
    };
    for (const target of panels) result.panels[target] = panel(target);
    return result;
  }, PANELS);
}

function isClosedError(error, browser, page) {
  if (error instanceof PortalSessionLostError) return true;
  if (browser && !browser.isConnected()) return true;
  if (page && page.isClosed()) return true;
  return /Target page, context or browser has been closed|Browser has been closed|Target closed|Context has been closed|Execution context was destroyed|Protocol error/i.test(error?.message ?? '');
}

export class PortalSession {
  constructor({ url, browser, context, page, timeoutMs }) {
    this.url = url;
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.timeoutMs = timeoutMs;
    this.closed = false;
  }

  static async open({ url, timeoutMs = 8000, requestId }) {
    let browser;
    let context;
    let page;
    try {
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
      context = await browser.newContext({ locale: 'zh-CN' });
      page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);
      page.setDefaultNavigationTimeout(timeoutMs);
      const session = new PortalSession({ url, browser, context, page, timeoutMs });
      await session.prepare(requestId);
      return session;
    } catch (error) {
      await page?.close().catch(() => {});
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
      throw new PortalSessionLostError('无法建立可核对的门户会话：' + error.message, error);
    }
  }

  async prepare(requestId) {
    await this.guard(async () => {
      await this.page.goto(this.url + '/portal', { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
      await this.page.waitForSelector('#portal-view', { state: 'attached', timeout: this.timeoutMs });
      await this.page.fill('#request-id', requestId);
    });
    // 从业务编号核对，而不是假定上一次会话看到的状态。
    await this.guard(() => this.lookup());
  }

  async guard(operation) {
    try {
      return await operation();
    } catch (error) {
      if (isClosedError(error, this.browser, this.page)) {
        throw new PortalSessionLostError('门户浏览器会话已中断：' + error.message, error);
      }
      throw error;
    }
  }

  async read() {
    return this.guard(() => snapshot(this.page));
  }

  async press(selector, beforeActionSeq, settleTimeout = this.timeoutMs) {
    const page = this.page;
    try {
      await page.click(selector, { timeout: settleTimeout });
    } catch (error) {
      if (isClosedError(error, this.browser, page)) throw new PortalSessionLostError('门户动作发送时会话中断：' + error.message, error);
      if (/Timeout/i.test(error?.message ?? '')) {
        // 点击没有在限定时间内完成；动作是否到达门户未知，只能靠回读判断。
        const current = await this.guard(() => snapshot(this.page));
        return { ...current, ambiguity: 'click-not-settled' };
      }
      throw error;
    }
    try {
      await page.waitForFunction(
        previous => Number(document.querySelector('#portal-view')?.dataset.actionSeq ?? 0) > previous,
        beforeActionSeq,
        { timeout: settleTimeout, polling: 40 },
      );
    } catch (error) {
      if (isClosedError(error, this.browser, page)) throw new PortalSessionLostError('门户动作结果读取时会话中断：' + error.message, error);
      // 动作可能已经到达门户但页面没有给出结果；调用方必须通过回读核对，不能把超时当成功。
      const current = await this.guard(() => snapshot(this.page));
      return { ...current, ambiguity: 'no-page-settlement' };
    }
    return this.read();
  }

  async refresh() {
    const before = await this.read();
    return this.press('#refresh', before.actionSeq, this.timeoutMs);
  }

  async lookup() {
    const before = await this.read();
    return this.press('#lookup', before.actionSeq, this.timeoutMs);
  }

  async hold(target) {
    const before = await this.read();
    return this.press(`[data-target="${target}"][data-action="hold"]`, before.actionSeq, this.timeoutMs);
  }

  async confirm(target) {
    const before = await this.read();
    return this.press(`[data-target="${target}"][data-action="confirm"]`, before.actionSeq, this.timeoutMs);
  }

  async release(target) {
    const before = await this.read();
    return this.press(`[data-target="${target}"][data-action="release"]`, before.actionSeq, this.timeoutMs);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.page.close().catch(() => {});
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }
}

export function describeSnapshot(value) {
  if (!value) return null;
  const panel = entry => ({
    state: entry?.state ?? 'unknown',
    used: entry?.used === true,
    requestId: entry?.requestId ?? null,
    receipt: entry?.receipt ?? null,
    expiresAt: numericOrNull(entry?.expiresAt),
  });
  return {
    at: new Date().toISOString(),
    sequence: value.sequence,
    duplicateBookings: value.duplicateBookings,
    requestId: value.requestId,
    lastOutcome: value.lastOutcome,
    lastTarget: value.lastTarget,
    lastMessage: value.lastMessage,
    ambiguity: value.ambiguity ?? null,
    boat: panel(value.panels?.boat),
    equipment: panel(value.panels?.equipment),
  };
}
