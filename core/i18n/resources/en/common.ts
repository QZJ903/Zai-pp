export const common = {
  add: 'Add',
  all: 'All',
  cancel: 'Cancel',
  close: 'Close',
  confirm: 'Confirm',
  delete: 'Delete',
  deactivate: 'Disable',
  disabled: 'Disabled',
  edit: 'Edit',
  enable: 'Enable',
  enabled: 'Enabled',
  loading: 'Loading...',
  none: 'None',
  /** Sidebar-wide fallback for a bare error code; natural-language messages keep their own text. */
  operationFailedWithCode: 'Operation failed ({code})',
  /**
   * "The tab has no live content script" — the extension was reloaded and the old page's
   * script became an orphan, or the page has not finished loading.
   *
   * ⚠️⚠️ **Lives in `common`, not in a page section** — several chains use this text
   * (automation handshake, saved-item "insert into chat", and any future `tabs.sendMessage`
   * failure), so it belongs to none of them.
   *
   * ⚠️ **The background cannot use it** — `BACKGROUND_LOCALE_SECTIONS` only carries
   * `content` / `background` / `tool` / `prompt` (the rest stay out of the service worker
   * bundle). So the background returns an error **code** and the side panel renders this
   * text — the same shape the automation chain uses.
   */
  pageContentScriptMissing: 'The Zai page has no usable extension script (it may still be loading, or the extension was just reloaded) — reload the page and retry',
  preview: 'Preview',
  refresh: 'Refresh',
  save: 'Save',
  saveChanges: 'Save changes',
  test: 'Test',
  update: 'Update',
} as const;