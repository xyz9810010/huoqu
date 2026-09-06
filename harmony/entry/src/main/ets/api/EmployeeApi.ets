import { ApiClient } from './ApiClient';
import { Employee, WorkerOption, EmployeeSaveRequest } from '../model/Models';

export class EmployeeApi {
  static async list(role: string = ''): Promise<Employee[]> {
    const text = await ApiClient.get('/api/employees' + (role === '' ? '' : '?role=' + encodeURIComponent(role)));
    return JSON.parse(text) as Employee[];
  }

  static async workers(): Promise<WorkerOption[]> {
    const text = await ApiClient.get('/api/employees/workers');
    return JSON.parse(text) as WorkerOption[];
  }

  static async create(body: EmployeeSaveRequest): Promise<Employee> {
    const text = await ApiClient.post('/api/employees', body);
    return JSON.parse(text) as Employee;
  }

  static async update(id: string, body: EmployeeSaveRequest): Promise<Employee> {
    const text = await ApiClient.put('/api/employees/' + id, body);
    return JSON.parse(text) as Employee;
  }

  static async setStatus(id: string, status: string): Promise<void> {
    await ApiClient.patch('/api/employees/' + id + '/status?status=' + encodeURIComponent(status), undefined);
  }
}
