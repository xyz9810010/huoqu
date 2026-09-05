// echarts 按需装配（静态导入以保留 tree-shaking）；调用方动态 import 本模块。
import { init, use } from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

use([BarChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

export function createChart(el: HTMLElement) {
  return init(el)
}
