import { router } from '@kit.ArkUI';
import { SessionStore } from '../store/SessionStore';
import { AreaApi } from '../api/AreaApi';
import { EmployeeApi } from '../api/EmployeeApi';
import { ApiError } from '../api/ApiClient';
import { UiUtil } from '../common/UiUtil';
import { Area, AreaSaveRequest, AreaWorkersRequest, WorkerOption, TaskWorker } from '../model/Models';
import { MobileHeader, MobileDrawer } from '../components/AppShell';
import { LoadingState, EmptyState, MobileField } from '../components/PageComponents';
import { normalizeRole, homePageForRole } from '../common/Constants';

@Entry
@Component
struct AreasPage {
  @State menuOpen: boolean = false;
  @State list: Area[] = [];
  @State workers: WorkerOption[] = [];
  @State loading: boolean = false;
  @State saving: boolean = false;
  @State formVisible: boolean = false;
  @State assignVisible: boolean = false;
  @State editId: string = '';
  @State name: string = '';
  @State code: string = '';
  @State defaultWorkerId: string = '';
  @State defaultIds: string[] = [];
  @State backupIds: string[] = [];

  aboutToAppear(): void {
    if (!SessionStore.isLoggedIn()) { router.replaceUrl({ url: 'pages/LoginPage' }); return; }
    if (normalizeRole(SessionStore.role()) !== 'admin') { router.replaceUrl({ url: homePageForRole(SessionStore.role()) }); return; }
    this.load();
  }

  async load(): Promise<void> {
    this.loading = true;
    try { this.list = await AreaApi.list(); this.workers = await EmployeeApi.workers(); }
    catch (e) { UiUtil.toast((e as ApiError).message); }
    finally { this.loading = false; }
  }

  openCreate(): void { this.editId = ''; this.name = ''; this.code = ''; this.defaultWorkerId = ''; this.formVisible = true; }
  openEdit(a: Area): void { this.editId = a.id; this.name = a.name; this.code = a.code; this.defaultWorkerId = a.defaultWorkerId; this.formVisible = true; }

  async save(): Promise<void> {
    if (this.name.trim() === '') { UiUtil.toast('请输入区域名称'); return; }
    this.saving = true;
    const body: AreaSaveRequest = { name: this.name.trim(), code: this.code.trim(), defaultWorkerId: this.defaultWorkerId };
    try { if (this.editId === '') await AreaApi.create(body); else await AreaApi.update(this.editId, body); this.formVisible = false; UiUtil.toast('已保存'); await this.load(); }
    catch (e) { UiUtil.toast((e as ApiError).message); }
    finally { this.saving = false; }
  }

  workerIds(items: TaskWorker[]): string[] { const ids: string[] = []; for (let i = 0; i < items.length; i++) ids.push(items[i].userId); return ids; }
  workerNames(items: TaskWorker[]): string { let value = ''; for (let i = 0; i < items.length; i++) value += (i === 0 ? '' : '、') + items[i].name; return value === '' ? '未设置' : value; }
  openAssign(a: Area): void { this.editId = a.id; this.defaultIds = this.workerIds(a.defaultWorkers); this.backupIds = this.workerIds(a.backupWorkers); this.assignVisible = true; }
  contains(values: string[], id: string): boolean { return values.indexOf(id) >= 0; }
  toggle(values: string[], id: string): string[] { const copy = values.slice(); const index = copy.indexOf(id); if (index >= 0) copy.splice(index, 1); else copy.push(id); return copy; }
  async saveWorkers(): Promise<void> {
    this.saving = true; const body: AreaWorkersRequest = { defaultWorkerIds: this.defaultIds, backupWorkerIds: this.backupIds };
    try { await AreaApi.assignWorkers(this.editId, body); this.assignVisible = false; UiUtil.toast('已保存'); await this.load(); }
    catch (e) { UiUtil.toast((e as ApiError).message); }
    finally { this.saving = false; }
  }

  @Builder WorkerOptions(multiple: boolean) {
    Flex({ wrap: FlexWrap.Wrap }) {
      ForEach(this.workers, (w: WorkerOption) => {
        Button(w.name).fontSize(12).height(34).margin({ right: 7, bottom: 7 })
          .backgroundColor(multiple ? (this.contains(this.defaultIds, w.id) ? '#0A59F7' : '#FFFFFF') : (this.defaultWorkerId === w.id ? '#0A59F7' : '#FFFFFF'))
          .fontColor(multiple ? (this.contains(this.defaultIds, w.id) ? '#FFFFFF' : '#4E5969') : (this.defaultWorkerId === w.id ? '#FFFFFF' : '#4E5969'))
          .border({ width: 1, color: '#C9CDD4' })
          .onClick(() => { if (multiple) this.defaultIds = this.toggle(this.defaultIds, w.id); else this.defaultWorkerId = this.defaultWorkerId === w.id ? '' : w.id; })
      }, (w: WorkerOption) => w.id)
    }.width('100%')
  }

  @Builder FormDialog() {
    if (this.formVisible) {
      Stack() {
        Column().width('100%').height('100%').backgroundColor('#66000000').onClick(() => { this.formVisible = false; })
        Column({ space: 12 }) {
          Text(this.editId === '' ? '新增区域' : '编辑区域').fontSize(18).fontWeight(FontWeight.Bold).width('100%')
          TextInput({ placeholder: '名称（必填）', text: this.name }).height(46).onChange((v: string) => { this.name = v; })
          TextInput({ placeholder: '编码', text: this.code }).height(46).onChange((v: string) => { this.code = v; })
          Text('默认取件员').fontSize(13).fontColor('#4E5969').width('100%'); this.WorkerOptions(false)
          Row({ space: 10 }) { Button('取消').layoutWeight(1).height(44).backgroundColor('#FFFFFF').fontColor('#4E5969').border({ width: 1, color: '#C9CDD4' }).onClick(() => { this.formVisible = false; }); Button(this.saving ? '保存中…' : '保存').layoutWeight(1).height(44).backgroundColor('#0A59F7').enabled(!this.saving).onClick(() => { this.save(); }) }.width('100%')
        }.width('92%').padding(18).backgroundColor('#FFFFFF').borderRadius(10)
      }.width('100%').height('100%')
    }
  }

  @Builder AssignDialog() {
    if (this.assignVisible) {
      Stack() {
        Column().width('100%').height('100%').backgroundColor('#66000000').onClick(() => { this.assignVisible = false; })
        Column({ space: 11 }) {
          Text('设置取件员').fontSize(18).fontWeight(FontWeight.Bold).width('100%')
          Text('主取件员（可多选）').fontSize(13).fontColor('#4E5969').width('100%'); this.WorkerOptions(true)
          Text('备用取件员（可多选）').fontSize(13).fontColor('#4E5969').width('100%')
          Flex({ wrap: FlexWrap.Wrap }) { ForEach(this.workers, (w: WorkerOption) => { Button(w.name).fontSize(12).height(34).margin({ right: 7, bottom: 7 }).backgroundColor(this.contains(this.backupIds, w.id) ? '#0A59F7' : '#FFFFFF').fontColor(this.contains(this.backupIds, w.id) ? '#FFFFFF' : '#4E5969').border({ width: 1, color: '#C9CDD4' }).onClick(() => { this.backupIds = this.toggle(this.backupIds, w.id); }) }, (w: WorkerOption) => w.id) }.width('100%')
          Row({ space: 10 }) { Button('取消').layoutWeight(1).height(44).backgroundColor('#FFFFFF').fontColor('#4E5969').border({ width: 1, color: '#C9CDD4' }).onClick(() => { this.assignVisible = false; }); Button(this.saving ? '保存中…' : '保存').layoutWeight(1).height(44).backgroundColor('#0A59F7').enabled(!this.saving).onClick(() => { this.saveWorkers(); }) }.width('100%')
        }.width('92%').padding(18).backgroundColor('#FFFFFF').borderRadius(10)
      }.width('100%').height('100%')
    }
  }

  build() {
    Stack() {
      Column() {
        MobileHeader({ menuOpen: $menuOpen, title: '区域管理', unreadCount: 0 })
        Scroll() { Column({ space: 10 }) {
          Button('新增区域').width('100%').height(44).backgroundColor('#00B42A').onClick(() => { this.openCreate(); })
          if (this.loading) {
            LoadingState({ label: '正在加载区域' })
          } else if (this.list.length === 0) {
            EmptyState({ title: '暂无区域' })
          } else {
            ForEach(this.list, (a: Area) => {
            Column() { Row() { Column({ space: 3 }) { Text(a.name).fontSize(16).fontWeight(FontWeight.Bold); Text(a.code === '' ? '未设置编码' : a.code).fontSize(12).fontColor('#86909C') }.layoutWeight(1).alignItems(HorizontalAlign.Start) }.width('100%'); MobileField({ label: '默认取件员', value: a.defaultWorkerName === '' ? '未设置' : a.defaultWorkerName }); MobileField({ label: '主取件员', value: this.workerNames(a.defaultWorkers) }); MobileField({ label: '备用取件员', value: this.workerNames(a.backupWorkers) }); Row({ space: 8 }) { Button('编辑').layoutWeight(1).height(42).fontColor('#4E5969').backgroundColor('#FFFFFF').border({ width: 1, color: '#C9CDD4' }).onClick(() => { this.openEdit(a); }); Button('设置取件员').layoutWeight(1).height(42).backgroundColor('#0A59F7').onClick(() => { this.openAssign(a); }) }.padding({ top: 8 }).border({ width: { top: 1 }, color: '#E5E6EB' }) }.width('100%').padding(14).backgroundColor('#FFFFFF').borderRadius(10).border({ width: 1, color: '#E5E6EB' })
            }, (a: Area) => a.id)
          }
        }.width('100%').padding(12) }.layoutWeight(1).width('100%')
      }.width('100%').height('100%').backgroundColor('#F1F2F5')
      MobileDrawer({ open: $menuOpen, activePath: 'pages/AreasPage' }); this.FormDialog(); this.AssignDialog()
    }.width('100%').height('100%')
  }
}
