import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { Constants, normalizeBaseUrl } from '../common/Constants';
import { User } from '../model/Models';

// 会话存储：内存缓存 + preferences 持久化（同步 API）
export class SessionStore {
  private static pref: preferences.Preferences | null = null;
  private static tokenCache: string = '';
  private static userCache: User | null = null;
  private static baseUrlCache: string = Constants.DEFAULT_BASE_URL;

  static init(context: common.Context): void {
    SessionStore.pref = preferences.getPreferencesSync(context, { name: 'session' });
    if (SessionStore.pref !== null) {
      const t = SessionStore.pref.getSync(Constants.STORAGE_TOKEN, '');
      SessionStore.tokenCache = t as string;
      const u = SessionStore.pref.getSync(Constants.STORAGE_USER, '');
      const us = u as string;
      if (us !== '') {
        SessionStore.userCache = JSON.parse(us) as User;
      }
      const b = SessionStore.pref.getSync(Constants.STORAGE_BASE_URL, Constants.DEFAULT_BASE_URL);
      SessionStore.baseUrlCache = b as string;
    }
  }

  static getToken(): string {
    return SessionStore.tokenCache;
  }

  static setToken(token: string): void {
    SessionStore.tokenCache = token;
    SessionStore.persist(Constants.STORAGE_TOKEN, token);
  }

  static getBaseUrl(): string {
    if (SessionStore.baseUrlCache === '') {
      return Constants.DEFAULT_BASE_URL;
    }
    return SessionStore.baseUrlCache;
  }

  static setBaseUrl(url: string): void {
    const normalized = normalizeBaseUrl(url);
    SessionStore.baseUrlCache = normalized;
    SessionStore.persist(Constants.STORAGE_BASE_URL, normalized);
  }

  static getUser(): User | null {
    return SessionStore.userCache;
  }

  static setUser(user: User): void {
    SessionStore.userCache = user;
    SessionStore.persist(Constants.STORAGE_USER, JSON.stringify(user));
  }

  static isLoggedIn(): boolean {
    return SessionStore.tokenCache !== '';
  }

  static role(): string {
    const u = SessionStore.userCache;
    return u === null ? '' : u.role;
  }

  static clear(): void {
    SessionStore.tokenCache = '';
    SessionStore.userCache = null;
    SessionStore.persist(Constants.STORAGE_TOKEN, '');
    SessionStore.persist(Constants.STORAGE_USER, '');
  }

  private static persist(key: string, value: string): void {
    const p = SessionStore.pref;
    if (p !== null) {
      p.putSync(key, value);
      p.flush();
    }
  }
}
