# Design QA

Status: PASSED

Compared the supplied refresh artwork with the installed HarmonyOS build on a 1224 × 2776 device capture.

- Refresh control: the supplied circular-arrow image is used directly, contained at 58% inside a 34 vp circular touch target, with continuous rotation during refresh.
- Navigation chooser: one bottom-sheet visual language, clear title/description, official Amap and Petal Maps cover icons, and a cancel action.
- Photo chooser: matching bottom-sheet visual language with camera and local-image choices and distinct source icons.
- Task flow: pending-task action starts the task before opening detail; in-progress detail presents completion/cancellation and no duplicate start action.
- Layout: no clipping or overlap found on the worker list, task detail, navigation chooser, or photo chooser.

Evidence:

- `artifacts/huoqu_after_update.jpeg`
- `artifacts/nav_sheet3.jpeg`
- `artifacts/current.jpeg`
- `artifacts/photo_sheet.jpeg`
