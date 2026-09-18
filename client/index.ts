import { Context } from '@koishijs/client'
import Page from './page.vue'

import 'virtual:uno.css'

export default (ctx: Context) => {
  ctx.page({
    name: 'NodeCDUT',
    path: '/node-cdut',
    component: Page,
  })
}
