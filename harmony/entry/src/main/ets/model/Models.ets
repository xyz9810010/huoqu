// 与后端 API 字段一一对应的数据模型
export interface User {
  id: string;
  username: string;
  name: string;
  role: string;
  courierId: string;
  phone: string;
  employeeNo: string;
}

export interface WorkerCustomerOption {
  customerId: string;
  customerName: string;
  addressId: string;
  address: string;
  contact: string;
  phone: string;
  areaName: string;
}

export interface PickupItem {
  id: string;
  taskId: string;
  workerId: string;
  workerName: string;
  entryMethod: string;
  waybillNo: string;
  goodsName: string;
  pieces: number;
  sortOrder: number;
  finalWeight: number;
  weightSource: string;
  matchStatus: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskPhoto {
  id: string;
  type: string;
  filename: string;
  filePath: string;
  createdAt: string;
}

export interface TaskException {
  id: string;
  type: string;
  description: string;
  resolved: boolean;
  resolution: string;
  createdAt: string;
  resolvedAt: string;
}

export interface TaskWorker {
  userId: string;
  name: string;
  role: string;
}

export interface PickupTask {
  id: string;
  taskNo: string;
  businessOrderNo: string;
  customerId: string;
  customerName: string;
  address: string;
  contact: string;
  phone: string;
  areaName: string;
  addressPointName: string;
  mainCsId: string;
  mainCsName: string;
  dispatchCsId: string;
  dispatchCsName: string;
  defaultWorkerId: string;
  defaultWorkerName: string;
  taskType: string;
  scheduledKind: string;
  scheduledTime: string;
  rushShipTime: string;
  rushReason: string;
  dispatchAt: string;
  completedAt: string;
  status: string;
  statusLabel: string;
  pickupNote: string;
  internalNote: string;
  volume: number;
  dimensions: string;
  amountReceivable: number;
  amountPayable: number;
  settled: string;
  createdAt: string;
  updatedAt: string;
  items: PickupItem[];
  photos: TaskPhoto[];
  exceptions: TaskException[];
  workers: TaskWorker[];
}

export interface Customer {
  id: string;
  customerNo: string;
  name: string;
  contact: string;
  contactName: string;
  phone: string;
  contactPhone: string;
  address: string;
  note: string;
  legacyCustomerId: string;
  importantNote: string;
  mainCsId: string;
  mainCsName: string;
  status: string;
  addressCount: number;
}

export interface CustomerCreateRequest {
  name: string;
  contactName: string;
  contactPhone: string;
  legacyCustomerId: string;
  importantNote: string;
  remark: string;
}

export interface CustomerDetail extends Customer {
  addresses: CustomerAddress[];
  mainCsName: string;
}

export interface CustomerAddress {
  id: string;
  name: string;
  address: string;
  contactName: string;
  contactPhone: string;
  areaId: string;
  isCommon: boolean;
  isActive: boolean;
  remark: string;
}

export interface Area {
  id: string;
  name: string;
  code: string;
  defaultWorkerId: string;
  defaultWorkerName: string;
  defaultWorkers: TaskWorker[];
  backupWorkers: TaskWorker[];
}

export interface WorkerOption {
  id: string;
  userId: string;
  name: string;
  region: string;
}

export interface Employee {
  id: string;
  username: string;
  name: string;
  phone: string;
  employeeNo: string;
  role: string;
  status: string;
  courierId: string;
  region: string;
}

export interface AreaSaveRequest {
  name: string;
  code: string;
  defaultWorkerId: string;
}

export interface AreaWorkersRequest {
  defaultWorkerIds: string[];
  backupWorkerIds: string[];
}

export interface EmployeeSaveRequest {
  username: string;
  password: string;
  name: string;
  phone: string;
  employeeNo: string;
  role: string;
}

export interface NotificationPreference {
  type: string;
  channel: string;
  enabled: boolean;
}

export interface NotificationSubscription {
  id: string;
  channel: string;
  providerCode: string;
  platform: string;
  deviceLabel: string;
  status: string;
  createdAt: string;
}

export interface NotificationPreferenceRequest {
  type: string;
  channel: string;
  enabled: boolean;
}

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  data: string;
  priority: string;
  read: boolean;
  readAt: string;
  createdAt: string;
}

export interface TaskListResponse {
  list: PickupTask[];
  total: number;
  page: number;
  size: number;
}

export interface LoginResponse {
  token: string;
  user: User;
}

export interface DashboardBoard {
  shipCustomerCount: number;
  finalWeight: number;
  pickupCustomerCount: number;
  pickupCount: number;
  pieces: number;
  pendingCount: number;
}

export interface DashboardMePeriod {
  pickupCount: number;
  customerCount: number;
  pieces: number;
  matchedWeight: number;
}

export interface DashboardMe {
  today: DashboardMePeriod;
  month: DashboardMePeriod;
  assistCount: number;
}

export interface DashboardWorker {
  id: string;
  name: string;
  pickupCount: number;
  customerCount: number;
  pieces: number;
  weight: number;
  assistCount: number;
  pending: number;
}

export interface DashboardAttention {
  rushNearDeadline: number;
  overdue: number;
  unmatchedWaybill: number;
  noWaybill: number;
  unresolvedException: number;
  syncFailed: number;
}

export interface TrackTimelineItem {
  status: string;
  note: string;
  by: string;
  at: string;
}

export interface TrackResult {
  orderNo: string;
  trackingNo: string;
  customer: string;
  pieces: number;
  goods: string;
  status: string;
  timeline: TrackTimelineItem[];
}

// 请求体接口（ArkTS 要求对象字面量有显式类型）
export interface EmptyRequest {
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface PasswordRequest {
  oldPassword: string;
  newPassword: string;
}

export interface NoteRequest {
  note: string;
}

export interface AddItemRequest {
  waybillNo: string;
  goodsName: string;
  pieces: number;
  entryMethod: string;
}

export interface ExceptionRequest {
  type: string;
  description: string;
}

export interface CreateTaskRequest {
  customerName?: string;
  address?: string;
  contact?: string;
  phone?: string;
  items?: AddItemRequest[];
  customerId: string;
  addressId: string;
  workerId: string;
  taskType: string;
  scheduledKind: string;
  scheduledTime: string;
  rushShipTime: string;
  rushReason: string;
  pickupNote: string;
  internalNote: string;
}

export interface SubscriptionRequest {
  channel: string;
  providerCode: string;
  token: string;
  platform: string;
  deviceLabel: string;
  appVersion: string;
}

export interface PushCredentialField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  control: string;
}

export interface PushProviderFieldState {
  configured: boolean;
  value: string;
  masked: string;
}

export interface PushProvider {
  code: string;
  displayName: string;
  platforms: string[];
  credentialSchema: PushCredentialField[];
  fields: Record<string, PushProviderFieldState>;
  configured: boolean;
  enabled: boolean;
  configVersion: number;
  testedVersion: number;
  healthStatus: string;
  lastTestedAt: string;
  lastErrorCode: string;
}

export interface PushProviderCredentialsRequest {
  credentials: Record<string, string>;
}

export interface PushProviderEnableRequest {
  enabled: boolean;
}
