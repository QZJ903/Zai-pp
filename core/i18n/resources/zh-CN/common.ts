export const common = {
  add: '新增',
  all: '全部',
  cancel: '取消',
  close: '关闭',
  confirm: '确认',
  delete: '删除',
  deactivate: '停用',
  disabled: '已停用',
  edit: '编辑',
  enable: '启用',
  enabled: '已启用',
  loading: '加载中...',
  none: '无',
  /**
   * 侧边栏统一的失败兜底：**只有裸错误码时才用它**，把壳留给中文、码放进括号。
   *
   * ⚠️ 自然语言的 `error.message` 不走这条 —— 它本身就有信息量（见 `runtime-response.ts`）。
   */
  operationFailedWithCode: '操作失败（{code}）',
  /**
   * 「标签页里没有活着的内容脚本」—— 扩展刚重载后旧页面成了孤儿、或页面还没加载完。
   *
   * ⚠️⚠️ **放在 `common` 而不是某个页面段**：这条文案会被**多条链**用到
   * （自动化握手、收藏页「插入到对话」、将来任何 `tabs.sendMessage` 失败的地方），
   * 它不属于任何单一页面。
   *
   * ⚠️ **后台用不了它** —— `BACKGROUND_LOCALE_SECTIONS` 只含
   * `content` / `background` / `tool` / `prompt` 四段（把其余段挡在 service worker 包外）。
   * 所以后台侧只能回一个**错误码**，由侧边栏翻成这句 —— 与自动化链同一套做法。
   */
  pageContentScriptMissing: 'Zai 页面里没有可用的扩展脚本（页面可能还没加载完，或扩展刚被重新加载过），请刷新该页面后重试',
  preview: '预览',
  refresh: '刷新',
  save: '保存',
  saveChanges: '保存更改',
  test: '测试',
  update: '更新',
} as const;