import PromptControlPanel from '../PromptControlPanel';
import { useI18n } from '../../i18n';

/**
 * Prompt sub-page.
 *
 * PromptControlPanel is a self-contained component that already renders its
 * own <section><h2> framing and owns its chrome.runtime state. We render it
 * directly so its header acts as the section title, avoiding the duplicate
 * title that a SettingsSection wrapper would create.
 */
export default function PromptSubPage() {
  const { t } = useI18n();
  void t;
  return (
    <div className="space-y-5">
      <PromptControlPanel />
    </div>
  );
}
