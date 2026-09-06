import { ApiClient } from './ApiClient';
import { LoginResponse, User, LoginRequest, PasswordRequest, EmptyRequest } from '../model/Models';

export class AuthApi {
  static async login(username: string, password: string): Promise<LoginResponse> {
    const body: LoginRequest = { username: username, password: password };
    const text = await ApiClient.post('/api/login', body);
    return JSON.parse(text) as LoginResponse;
  }

  static async me(): Promise<User> {
    const text = await ApiClient.get('/api/me');
    return JSON.parse(text) as User;
  }

  static async changePassword(oldPassword: string, newPassword: string): Promise<boolean> {
    const body: PasswordRequest = { oldPassword: oldPassword, newPassword: newPassword };
    await ApiClient.post('/api/password', body);
    return true;
  }

  static async logout(): Promise<void> {
    const body: EmptyRequest = {};
    await ApiClient.post('/api/logout', body);
  }
}
