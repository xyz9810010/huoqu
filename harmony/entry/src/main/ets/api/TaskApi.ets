import { ApiClient } from './ApiClient';
import { PickupTask, TaskListResponse, NoteRequest, AddItemRequest, ExceptionRequest, EmptyRequest, CreateTaskRequest } from '../model/Models';

export class TaskApi {
  static async list(status: string, page: number, size: number, taskType: string = '', keyword: string = ''): Promise<TaskListResponse> {
    let path = '/api/tasks?page=' + page + '&size=' + size;
    if (status !== '') {
      path = path + '&status=' + status;
    }
    if (taskType !== '') {
      path = path + '&taskType=' + encodeURIComponent(taskType);
    }
    if (keyword !== '') {
      path = path + '&keyword=' + encodeURIComponent(keyword);
    }
    const text = await ApiClient.get(path);
    return JSON.parse(text) as TaskListResponse;
  }

  static async listAll(status: string): Promise<PickupTask[]> {
    const path = '/api/worker/tasks' + (status === '' ? '' : '?status=' + status);
    const text = await ApiClient.get(path);
    return JSON.parse(text) as PickupTask[];
  }

  static async detail(id: string): Promise<PickupTask> {
    const text = await ApiClient.get('/api/tasks/' + id);
    return JSON.parse(text) as PickupTask;
  }

  static async start(id: string): Promise<PickupTask> {
    const body: EmptyRequest = {};
    const text = await ApiClient.post('/api/tasks/' + id + '/start', body);
    return JSON.parse(text) as PickupTask;
  }

  static async complete(id: string, note: string): Promise<PickupTask> {
    const body: NoteRequest = { note: note };
    const text = await ApiClient.post('/api/tasks/' + id + '/complete', body);
    return JSON.parse(text) as PickupTask;
  }

  static async cancel(id: string, note: string): Promise<PickupTask> {
    const body: NoteRequest = { note: note };
    const text = await ApiClient.post('/api/tasks/' + id + '/cancel', body);
    return JSON.parse(text) as PickupTask;
  }

  static async addItem(id: string, waybillNo: string, goodsName: string, pieces: number): Promise<PickupTask> {
    const body: AddItemRequest = {
      waybillNo: waybillNo,
      goodsName: goodsName,
      pieces: pieces,
      entryMethod: waybillNo === '' ? 'no_waybill' : 'manual'
    };
    const text = await ApiClient.post('/api/tasks/' + id + '/items', body);
    return JSON.parse(text) as PickupTask;
  }

  static async reportException(id: string, type: string, description: string): Promise<PickupTask> {
    const body: ExceptionRequest = { type: type, description: description };
    const text = await ApiClient.post('/api/tasks/' + id + '/exceptions', body);
    return JSON.parse(text) as PickupTask;
  }

  static async updateItem(id: string, itemId: string, waybillNo: string, goodsName: string, pieces: number): Promise<PickupTask> {
    const body: AddItemRequest = { waybillNo: waybillNo, goodsName: goodsName, pieces: pieces,
      entryMethod: waybillNo === '' ? 'no_waybill' : 'manual' };
    const text = await ApiClient.put('/api/tasks/' + id + '/items/' + itemId, body);
    return JSON.parse(text) as PickupTask;
  }

  static async uploadPhotos(id: string, uris: string[]): Promise<PickupTask> {
    const text = await ApiClient.upload('/api/tasks/' + id + '/photos', uris);
    return JSON.parse(text) as PickupTask;
  }

  static async create(body: CreateTaskRequest): Promise<PickupTask> {
    const text = await ApiClient.post('/api/tasks', body);
    return JSON.parse(text) as PickupTask;
  }
}
