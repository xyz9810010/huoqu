import { ApiClient } from './ApiClient';
import { Customer, CustomerCreateRequest, WorkerCustomerOption } from '../model/Models';

export class CustomerApi {
  static async workerOptions(search: string, offset: number = 0): Promise<WorkerCustomerOption[]> {
    const text = await ApiClient.get('/api/worker/customer-options?search=' + encodeURIComponent(search) +
      (offset > 0 ? '&offset=' + offset : ''));
    return JSON.parse(text) as WorkerCustomerOption[];
  }

  static async list(search: string): Promise<Customer[]> {
    let path = '/api/customers';
    if (search !== '') {
      path = path + '?search=' + encodeURIComponent(search);
    }
    const text = await ApiClient.get(path);
    return JSON.parse(text) as Customer[];
  }

  static async detail(id: string): Promise<Customer> {
    const text = await ApiClient.get('/api/customers/' + id);
    return JSON.parse(text) as Customer;
  }

  static async create(body: CustomerCreateRequest): Promise<Customer> {
    const text = await ApiClient.post('/api/customers', body);
    return JSON.parse(text) as Customer;
  }
}
