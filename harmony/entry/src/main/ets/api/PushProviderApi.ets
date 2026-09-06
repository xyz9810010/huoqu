import { ApiClient } from './ApiClient';
import { PushProvider, PushProviderCredentialsRequest, PushProviderEnableRequest, EmptyRequest } from '../model/Models';

export class PushProviderApi {
  private static data(text: string): Object {
    const parsed = JSON.parse(text) as Record<string, Object>;
    return parsed['data'] === undefined ? parsed : parsed['data'];
  }

  static async list(): Promise<PushProvider[]> {
    const text = await ApiClient.get('/api/v1/admin/push-providers');
    return PushProviderApi.data(text) as PushProvider[];
  }

  static async save(code: string, credentials: Record<string, string>): Promise<PushProvider> {
    const body: PushProviderCredentialsRequest = { credentials: credentials };
    const text = await ApiClient.put('/api/v1/admin/push-providers/' + encodeURIComponent(code), body);
    return PushProviderApi.data(text) as PushProvider;
  }

  static async test(code: string): Promise<PushProvider> {
    const body: EmptyRequest = {};
    const text = await ApiClient.post('/api/v1/admin/push-providers/' + encodeURIComponent(code) + '/test', body);
    return PushProviderApi.data(text) as PushProvider;
  }

  static async setEnabled(code: string, enabled: boolean): Promise<void> {
    const body: PushProviderEnableRequest = { enabled: enabled };
    await ApiClient.post('/api/v1/admin/push-providers/' + encodeURIComponent(code) + '/enable', body);
  }
}
