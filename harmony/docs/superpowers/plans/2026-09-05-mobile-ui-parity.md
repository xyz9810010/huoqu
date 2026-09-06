# Huoqu Mobile UI Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild every role-accessible HarmonyOS page so its mobile UI, operations, and interaction states match the reference Vue application at commit `acee27a`.

**Architecture:** Keep the existing ArkTS API, model, session, notification, scan, dial, and navigation layers. Add a focused native ArkUI design-system layer, then migrate pages onto it in role-oriented batches while preserving the reference route and form behavior.

**Tech Stack:** HarmonyOS ArkTS, ArkUI, Hvigor, DevEco Studio 6.x; Vue/Element Plus source is read-only reference material.

**Spec:** `docs/superpowers/specs/2026-09-05-mobile-ui-parity-design.md`

## Global Constraints

- Pure native ArkUI; do not embed the reference application in a WebView.
- Reference source is `xyz9810010/huoqu` commit `acee27a`.
- Match the reference at 360, 390, and 430 vp content widths.
- Preserve existing server API semantics and native capabilities.
- Use UTF-8 Chinese copy and local vector/icon resources; do not use emoji as production icons.
- Keep the role homes: boss/admin dashboard, cs tasks, worker worker-tasks.
- Current workspace is not a Git repository, so commit steps are not available.

---

### Task 1: Shared mobile design system

**Files:**
- Create: `entry/src/main/ets/common/Theme.ets`
- Create: `entry/src/main/ets/components/AppIcon.ets`
- Create: `entry/src/main/ets/components/PageComponents.ets`
- Modify: `entry/src/main/resources/base/element/color.json`
- Modify: `entry/src/main/resources/base/element/string.json`

**Interfaces:**
- Produces: `AppTheme`, `AppIcon`, `PageTitle`, `SurfaceCard`, `StatusPill`, `LoadingState`, `EmptyState`, `MobileField`, and `ActionBar` builders/components.

- [ ] Extract exact color, spacing, radius, font, border, and shadow values from `theme.css` into `AppTheme`.
- [ ] Implement local ArkUI icons with consistent size/color inputs and no emoji glyphs.
- [ ] Implement reusable card, field row, tag, loading, empty, toolbar, and action-row primitives.
- [ ] Replace corrupted shared strings and status labels with valid UTF-8 Chinese.
- [ ] Run the debug build and resolve ArkTS component/type errors.

### Task 2: Application shell and login

**Files:**
- Create: `entry/src/main/ets/components/AppShell.ets`
- Modify: `entry/src/main/ets/pages/LoginPage.ets`
- Modify: `entry/src/main/ets/store/SessionStore.ets`
- Modify: `entry/src/main/ets/pages/SettingsPage.ets`

**Interfaces:**
- Consumes: Task 1 theme and icons.
- Produces: role-filtered drawer navigation, 56 vp header, unread badge, avatar/logout menu, and exact role-home routing.

- [ ] Encode the reference menu table and role visibility rules in one typed source.
- [ ] Build the 264 vp drawer, overlay dismissal, active item styling, bell badge, and avatar/logout interaction.
- [ ] Rebuild login branding, 48 vp inputs/button, password visibility, validation, loading, error feedback, and footer.
- [ ] Make Android-style back behavior close overlays before routing back.
- [ ] Build and manually exercise login and logout for admin/cs/worker role fixtures.

### Task 3: Task and dispatch core flow

**Files:**
- Modify: `entry/src/main/ets/pages/TasksPage.ets`
- Modify: `entry/src/main/ets/pages/DispatchPage.ets`
- Modify: `entry/src/main/ets/pages/TaskDetailPage.ets`
- Modify: `entry/src/main/ets/pages/WorkerTasksPage.ets`
- Modify: `entry/src/main/ets/pages/WorkerTabPage.ets`
- Modify: `entry/src/main/ets/pages/TrackPage.ets`

**Interfaces:**
- Consumes: Task 2 shell; existing `TaskApi`, scan, dial, and navigation services.
- Produces: reference-equivalent task filters/cards, dispatch form, task detail actions, and worker workflow.

- [ ] Port the exact mobile templates, field ordering, status tags, filtering, and action placement from `Tasks.vue` and `WorkerTasks.vue`.
- [ ] Port every `Dispatch.vue` field, conditional section, default, validation rule, disabled state, submission state, and success transition.
- [ ] Port `TaskDetail.vue` sections, cargo rows, scan/manual entry, status actions, confirmation dialogs, and exception feedback.
- [ ] Consolidate the worker entry so the visible screen and navigation do not diverge between `WorkerTabPage` and `WorkerTasksPage`.
- [ ] Verify pending, in-progress, completed, cancelled, scheduled, rush, empty, loading, and failure states.
- [ ] Build after each page conversion and finish with an end-to-end task-flow build.

### Task 4: Dashboard, customers, and matching

**Files:**
- Modify: `entry/src/main/ets/pages/DashboardPage.ets`
- Modify: `entry/src/main/ets/pages/CustomersPage.ets`
- Modify: `entry/src/main/ets/pages/CustomerDetailPage.ets`
- Modify: `entry/src/main/ets/pages/MatchCenterPage.ets`

**Interfaces:**
- Consumes: shared shell/components and existing dashboard/customer/task APIs.

- [ ] Match dashboard range controls, six statistics cards, worker workload list, attention list, icons, spacing, and refresh behavior.
- [ ] Match customer search toolbar, mobile customer cards, empty/loading states, and detail navigation.
- [ ] Match customer detail group structure, field alignment, address states, and actions.
- [ ] Match pending-match filters, cards, input flow, confirmation, loading, and success/error feedback.
- [ ] Build and verify all four pages at narrow widths.

### Task 5: Administration and worker data

**Files:**
- Modify: `entry/src/main/ets/pages/AreasPage.ets`
- Modify: `entry/src/main/ets/pages/EmployeesPage.ets`
- Modify: `entry/src/main/ets/pages/LogsPage.ets`
- Modify: `entry/src/main/ets/pages/MyDataPage.ets`

**Interfaces:**
- Consumes: common page primitives and current API services.

- [ ] Port area list and create/edit/default/backup-worker interactions from `Areas.vue`.
- [ ] Port employee filters, cards, create/edit form, role/status controls, validation, and confirmation from `Employees.vue`.
- [ ] Port log filters and mobile record cards from `Logs.vue`.
- [ ] Port worker date ranges, statistics, and detail list from `MyData.vue`.
- [ ] Verify normal, empty, loading, validation, and API-error states; run debug build.

### Task 6: Notifications and provider configuration

**Files:**
- Modify: `entry/src/main/ets/pages/NotificationsPage.ets`
- Modify: `entry/src/main/ets/pages/NotificationSettingsPage.ets`
- Create: `entry/src/main/ets/pages/PushProvidersPage.ets`
- Modify: `entry/src/main/resources/base/profile/main_pages.json`
- Modify or create: provider API/model files only when missing from current native API coverage.

**Interfaces:**
- Consumes: current notification services and shell unread badge.
- Produces: full notification center/settings/provider routes corresponding to the Vue app.

- [ ] Match notification priority, unread styling, navigation target, mark-read actions, loading, and empty state.
- [ ] Match preference switches, disabled dependencies, save loading, and feedback.
- [ ] Port provider cards, create/edit form, provider-specific fields, secret masking, enable/disable, delete confirmation, and test-send flow.
- [ ] Register the provider page and expose it only to admin in the drawer.
- [ ] Build and verify notification count updates after read operations and realtime events.

### Task 7: Full copy, role, and interaction audit

**Files:**
- Modify: all affected `entry/src/main/ets/**/*.ets` and required resource JSON files.

**Interfaces:**
- Consumes: all previous tasks.

- [ ] Compare every visible Chinese string and field order with each reference `.vue` file.
- [ ] Search for mojibake and emoji ranges; replace every production occurrence.
- [ ] Verify every reference route has a native target or an explicitly internalized native capability.
- [ ] Verify menus and direct-entry guards for boss/admin/cs/worker.
- [ ] Verify overlay dismissal, back behavior, loading locks, repeat-submit protection, destructive confirmations, and failure recovery.
- [ ] Run a clean debug build.

### Task 8: Visual parity pass in DevEco Studio

**Files:**
- Modify: page/component styles based on measured differences.

**Interfaces:**
- Consumes: completed native application and runnable reference web application.
- Produces: accepted 360/390/430 vp visual parity evidence.

- [ ] Start the reference Node/Vue application with controlled fixture data and capture each role/page/state at 360, 390, and 430 px.
- [ ] Build and run the HarmonyOS application using `C:\Program Files\Huawei\DevEco Studio\bin\devecostudio64.exe` and an available phone emulator/device.
- [ ] Capture matching native screens with the same data and state.
- [ ] Compare layout position, spacing, typography, colors, borders, radii, icons, wrapping, and control states; correct differences over 2 vp or visibly different.
- [ ] Repeat the build and screenshot comparison until no known non-platform visual/interaction differences remain.
- [ ] Record any unavoidable system-owned differences in the final handoff.
