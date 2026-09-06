import { ApiClient } from './ApiClient';
import { DashboardBoard, DashboardWorker, DashboardAttention, DashboardMe } from '../model/Models';

export class DashboardApi {
  static async board(range: string): Promise<DashboardBoard> {
    const text = await ApiClient.get('/api/dashboard/board?range=' + range);
    return JSON.parse(text) as DashboardBoard;
  }

  static async workers(): Promise<DashboardWorker[]> {
    const text = await ApiClient.get('/api/dashboard/workers');
    return JSON.parse(text) as DashboardWorker[];
  }

  static async attention(): Promise<DashboardAttention> {
    const text = await ApiClient.get('/api/dashboard/attention');
    return JSON.parse(text) as DashboardAttention;
  }

  static async me(): Promise<DashboardMe> {
    const text = await ApiClient.get('/api/dashboard/me');
    return JSON.parse(text) as DashboardMe;
  }
}
