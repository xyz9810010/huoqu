import { router } from '@kit.ArkUI';
import { SessionStore } from '../store/SessionStore';
import { EmployeeApi } from '../api/EmployeeApi';
import { ApiError } from '../api/ApiClient';
import { UiUtil } from '../common/UiUtil';
import { Employee, EmployeeSaveRequest } from '../model/Models';
import { normalizeRole, homePageForRole } from '../common/Constants';
import { MobileHeader, MobileDrawer } from '../components/AppShell';
import { LoadingState, EmptyState, MobileField } from '../components/PageComponents';

@Entry
@Component
struct EmployeesPage {
  @State menuOpen: boolean = false;
  @State list: Employee[] = [];
  @State role: string = '';
  @State loading: boolean = false;
  @State saving: boolean = false;
  @State formVisible: boolean = false;
  @State editId: string = '';
  @State username: string = '';
  @State password: string = '';
  @State name: string = '';
  @State phone: string = '';
  @State employeeNo: string = '';
  @State formRole: string = 'cs';

  aboutToAppear(): void { if (!SessionStore.isLoggedIn()) { router.replaceUrl({ url: 'pages/LoginPage' }); return; } if (normalizeRole(SessionStore.role()) !== 'admin') { router.replaceUrl({ url: homePageForRole(SessionStore.role()) }); return; } this.load(); }
  async load(): Promise<void> { this.loading = true; try { this.list = await EmployeeApi.list(this.role); } catch (e) { UiUtil.toast((e as ApiError).message); } finally { this.loading = false; } }
  roleLabel(value: string): string { const r = normalizeRole(value); if (r === 'boss') return '老板'; if (r === 'admin') return '管理员'; if (r === 'cs') return '客服'; if (r === 'worker') return '取件员'; return r; }
  openCreate(): void { this.editId = ''; this.username = ''; this.password = ''; this.name = ''; this.phone = ''; this.employeeNo = ''; this.formRole = 'cs'; this.formVisible = true; }
  openEdit(e: Employee): void { this.editId = e.id; this.username = e.username; this.password = ''; this.name = e.name; this.phone = e.phone; this.employeeNo = e.employeeNo; this.formRole = normalizeRole(e.role); this.formVisible = true; }

  async save(): Promise<void> {
    if (this.username.trim() === '' || this.name.trim() === '' || (this.editId === '' && this.password === '')) { UiUtil.toast('请完整填写必填项'); return; }
    this.saving = true;
    const body: EmployeeSaveRequest = { username: this.username.trim(), password: this.password, name: this.name.trim(), phone: this.phone.trim(), employeeNo: this.employeeNo.trim(), role: this.formRole };
    try { if (this.editId === '') await EmployeeApi.create(body); else await EmployeeApi.update(this.editId, body); this.formVisible = false; UiUtil.toast('已保存'); await this.load(); }
    catch (e) { UiUtil.toast((e as ApiError).message); }
    finally { this.saving = false; }
  }

  async toggleStatus(e: Employee): Promise<void> {
    try { await EmployeeApi.setStatus(e.id, e.status === 'active' ? 'disabled' : 'active'); await this.load(); }
    catch (error) { UiUtil.toast((error as ApiError).message); }
  }

  @Builder RoleButtons(form: boolean) {
    Scroll() { Row({ space: 8 }) { ForEach(form ? ['boss', 'cs', 'worker', 'admin'] : ['', 'boss', 'cs', 'worker', 'admin'], (value: string) => { Button(value === '' ? '全部' : this.roleLabel(value)).fontSize(12).height(36).backgroundColor((form ? this.formRole : this.role) === value ? '#0A59F7' : '#FFFFFF').fontColor((form ? this.formRole : this.role) === value ? '#FFFFFF' : '#4E5969').border({ width: 1, color: '#C9CDD4' }).onClick(() => { if (form) this.formRole = value; else { this.role = value; this.load(); } }) }, (value: string) => value) } }.width('100%').scrollable(ScrollDirection.Horizontal)
  }

  @Builder FormDialog() {
    if (this.formVisible) {
      Stack() {
        Column().width('100%').height('100%').backgroundColor('#66000000').onClick(() => { this.formVisible = false; })
        Scroll() { Column({ space: 11 }) {
          Text(this.editId === '' ? '新增员工' : '编辑员工').fontSize(18).fontWeight(FontWeight.Bold).width('100%')
          TextInput({ placeholder: '用户名（必填）', text: this.username }).height(44).enabled(this.editId === '').onChange((v: string) => { this.username = v; })
          TextInput({ placeholder: this.editId === '' ? '密码（必填）' : '密码（留空不修改）', text: this.password }).height(44).type(InputType.Password).onChange((v: string) => { this.password = v; })
          TextInput({ placeholder: '姓名（必填）', text: this.name }).height(44).onChange((v: string) => { this.name = v; })
          TextInput({ placeholder: '电话', text: this.phone }).height(44).type(InputType.PhoneNumber).onChange((v: string) => { this.phone = v; })
          TextInput({ placeholder: '工号', text: this.employeeNo }).height(44).onChange((v: string) => { this.employeeNo = v; })
          Text('角色').width('100%').fontSize(13).fontColor('#4E5969'); this.RoleButtons(true)
          Row({ space: 10 }) { Button('取消').layoutWeight(1).height(44).backgroundColor('#FFFFFF').fontColor('#4E5969').border({ width: 1, color: '#C9CDD4' }).onClick(() => { this.formVisible = false; }); Button(this.saving ? '保存中…' : '保存').layoutWeight(1).height(44).backgroundColor('#0A59F7').enabled(!this.saving).onClick(() => { this.save(); }) }.width('100%')
        }.width('100%').padding(18).backgroundColor('#FFFFFF').borderRadius(10) }.width('92%').height('76%')
      }.width('100%').height('100%')
    }
  }

  build() {
    Stack() {
      Column() {
        MobileHeader({ menuOpen: $menuOpen, title: '员工管理', unreadCount: 0 })
        Scroll() { Column({ space: 10 }) {
          Row({ space: 8 }) { Column() { this.RoleButtons(false) }.layoutWeight(1); Button('新增员工').height(40).backgroundColor('#00B42A').onClick(() => { this.openCreate(); }) }.width('100%')
          if (this.loading) {
            LoadingState({ label: '正在加载员工' })
          } else if (this.list.length === 0) {
            EmptyState({ title: '暂无员工' })
          } else {
            ForEach(this.list, (e: Employee) => {
            Column() { Row() { Column({ space: 3 }) { Text(e.name === '' ? e.username : e.name).fontSize(16).fontWeight(FontWeight.Bold); Text((e.employeeNo === '' ? '未设置工号' : e.employeeNo) + ' · ' + e.username).fontSize(12).fontColor('#86909C') }.layoutWeight(1).alignItems(HorizontalAlign.Start); Text(e.status === 'active' ? '正常' : '停用').fontSize(12).fontColor(e.status === 'active' ? '#00B42A' : '#86909C').padding({ left: 8, right: 8, top: 3, bottom: 3 }).backgroundColor(e.status === 'active' ? '#E8FFEA' : '#F2F3F5').borderRadius(4) }.width('100%'); MobileField({ label: '角色', value: this.roleLabel(e.role) }); MobileField({ label: '电话', value: e.phone }); Row({ space: 8 }) { Button('编辑').layoutWeight(1).height(42).fontColor('#4E5969').backgroundColor('#FFFFFF').border({ width: 1, color: '#C9CDD4' }).onClick(() => { this.openEdit(e); }); Button(e.status === 'active' ? '停用' : '启用').layoutWeight(1).height(42).fontColor(e.status === 'active' ? '#F53F3F' : '#00B42A').backgroundColor('#FFFFFF').border({ width: 1, color: '#C9CDD4' }).onClick(() => { this.toggleStatus(e); }) }.padding({ top: 8 }).border({ width: { top: 1 }, color: '#E5E6EB' }) }.width('100%').padding(14).backgroundColor('#FFFFFF').borderRadius(10).border({ width: 1, color: '#E5E6EB' })
            }, (e: Employee) => e.id)
          }
        }.width('100%').padding(12) }.layoutWeight(1).width('100%')
      }.width('100%').height('100%').backgroundColor('#F1F2F5')
      MobileDrawer({ open: $menuOpen, activePath: 'pages/EmployeesPage' }); this.FormDialog()
    }.width('100%').height('100%')
  }
}
