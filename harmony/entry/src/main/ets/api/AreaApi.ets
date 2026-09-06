import { ApiClient } from './ApiClient';
import { Area, AreaSaveRequest, AreaWorkersRequest } from '../model/Models';

export class AreaApi {
  static async list(): Promise<Area[]> {
    const text = await ApiClient.get('/api/areas');
    return JSON.parse(text) as Area[];
  }

  static async create(body: AreaSaveRequest): Promise<Area> {
    const text = await ApiClient.post('/api/areas', body);
    return JSON.parse(text) as Area;
  }

  static async update(id: string, body: AreaSaveRequest): Promise<Area> {
    const text = await ApiClient.put('/api/areas/' + id, body);
    return JSON.parse(text) as Area;
  }

  static async assignWorkers(id: string, body: AreaWorkersRequest): Promise<void> {
    await ApiClient.put('/api/areas/' + id + '/workers', body);
  }
}
