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
  preview: '预览',
  refresh: '刷新',
  remove: '移除',
  save: '保存',
  saveChanges: '保存更改',
  test: '测试',
  update: '更新',
} as const;