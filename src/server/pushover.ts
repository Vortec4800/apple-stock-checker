import { fetch as undiciFetch } from 'undici';
import type { PushoverEnvStatus, PushoverPriority } from '../shared/types.js';
import type { AppDatabase } from './db.js';

const PUSHOVER_ENDPOINT = 'https://api.pushover.net/1/messages.json';

function maskSecret(val: string | undefined): string | null {
  const trimmed = val?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 6) return `${trimmed[0]}***${trimmed[trimmed.length - 1]}`;
  return `${trimmed.slice(0, 3)}…${trimmed.slice(-4)}`;
}

export interface SendPushoverInput {
  kind: 'restock' | 'repeat' | 'test';
  partNumber: string | null;
  productTitle: string;
  storeName: string;
  title: string;
  message: string;
  buyUrl?: string;
  priority: PushoverPriority;
  sound?: string;
}

export class PushoverService {
  private readonly db: AppDatabase;

  constructor(db: AppDatabase) {
    this.db = db;
  }

  private getCredentials(): {
    userKey: string;
    apiToken: string;
    device: string | null;
  } {
    const userKey = (process.env.PUSHOVER_USER_KEY ?? '').trim();
    const apiToken = (process.env.PUSHOVER_API_TOKEN ?? '').trim();
    const deviceRaw = (process.env.PUSHOVER_DEVICE ?? '').trim();
    return {
      userKey,
      apiToken,
      device: deviceRaw || null,
    };
  }

  public getEnvStatus(): PushoverEnvStatus {
    const { userKey, apiToken, device } = this.getCredentials();
    return {
      configured: Boolean(userKey && apiToken),
      hasUserKey: Boolean(userKey),
      hasApiToken: Boolean(apiToken),
      maskedUserKey: maskSecret(userKey),
      maskedApiToken: maskSecret(apiToken),
      device,
    };
  }

  public async send(input: SendPushoverInput): Promise<{ success: boolean; error?: string }> {
    const { userKey, apiToken, device } = this.getCredentials();
    const now = Date.now();

    if (!userKey || !apiToken) {
      const errDetail =
        'Pushover not configured: set PUSHOVER_USER_KEY and PUSHOVER_API_TOKEN Docker environment variables';
      this.db.insertNotificationLog({
        createdAtMs: now,
        kind: input.kind,
        partNumber: input.partNumber,
        productTitle: input.productTitle,
        storeName: input.storeName,
        message: input.message,
        priority: input.priority,
        success: false,
        errorDetail: errDetail,
      });
      return { success: false, error: errDetail };
    }

    const form = new URLSearchParams();
    form.set('token', apiToken);
    form.set('user', userKey);
    if (device) {
      form.set('device', device);
    }
    form.set('title', input.title);
    form.set('message', input.message);
    form.set('priority', String(input.priority));
    if (input.sound && input.sound !== 'default') {
      form.set('sound', input.sound);
    }
    if (input.buyUrl) {
      form.set('url', input.buyUrl);
      form.set('url_title', 'Buy on Apple.com');
    }
    // Pushover Priority 2 (Emergency) requires `retry` (>=30s) and `expire` (<=10800s)
    if (input.priority === 2) {
      form.set('retry', '60');
      form.set('expire', '1800');
    }

    try {
      const resp = await undiciFetch(PUSHOVER_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(15_000),
      });

      const rawText = await resp.text();
      let ok = resp.ok;
      let errMsg: string | null = null;
      try {
        const parsed = JSON.parse(rawText) as { status?: number; errors?: string[] };
        if (parsed.status !== 1) {
          ok = false;
          errMsg = parsed.errors?.join('; ') || `Pushover HTTP ${resp.status}`;
        }
      } catch {
        if (!resp.ok) {
          errMsg = `HTTP ${resp.status}: ${rawText.slice(0, 200)}`;
        }
      }

      this.db.insertNotificationLog({
        createdAtMs: now,
        kind: input.kind,
        partNumber: input.partNumber,
        productTitle: input.productTitle,
        storeName: input.storeName,
        message: input.message,
        priority: input.priority,
        success: ok,
        errorDetail: errMsg,
      });

      return ok ? { success: true } : { success: false, error: errMsg ?? 'Pushover error' };
    } catch (err) {
      const errMsg = (err as Error).message || 'Network failure contacting Pushover';
      this.db.insertNotificationLog({
        createdAtMs: now,
        kind: input.kind,
        partNumber: input.partNumber,
        productTitle: input.productTitle,
        storeName: input.storeName,
        message: input.message,
        priority: input.priority,
        success: false,
        errorDetail: errMsg,
      });
      return { success: false, error: errMsg };
    }
  }

  public async sendTest(priority: PushoverPriority = 0, sound = 'pushover'): Promise<{
    success: boolean;
    error?: string;
  }> {
    return this.send({
      kind: 'test',
      partNumber: null,
      productTitle: 'Test Notification',
      storeName: 'Apple Stock Checker',
      title: 'Apple Stock Checker — Test Alert',
      message:
        'Pushover notifications are working! You will receive instant alerts here when watched Apple products come in stock in your area.',
      buyUrl: 'https://www.apple.com/retail/',
      priority,
      sound,
    });
  }
}
