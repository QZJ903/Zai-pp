import type {
  Automation,
  AutomationCreateInput,
  AutomationRun,
  AutomationStatus,
  AutomationUpdateInput,
} from '../automation/types';
import type { ZaiModelList } from '../zai/models';
import type {
  MessageAction,
} from '../types';
import type {
  UsageSummary,
  UsageTurnRecord,
} from '../usage/types';

type DeclaredRuntimeRequest<TType extends MessageAction['type']> = Extract<
  MessageAction,
  { type: TType }
>;

type Ack = { ok: true };
type DomainFailure = { ok: false; error: string };

export interface BackgroundRuntimeCommandContracts {
  EXPORT_DIAGNOSTIC_LOGS: {
    request: { type: 'EXPORT_DIAGNOSTIC_LOGS' };
    response: { exportedAt: string; extensionVersion: string; entries: readonly unknown[] };
  };
  RECORD_USAGE_TURN: {
    request: DeclaredRuntimeRequest<'RECORD_USAGE_TURN'>;
    response: UsageTurnRecord;
  };
  GET_USAGE_SUMMARY: {
    request: DeclaredRuntimeRequest<'GET_USAGE_SUMMARY'>;
    response: UsageSummary;
  };
  CLEAR_USAGE_STATS: {
    request: DeclaredRuntimeRequest<'CLEAR_USAGE_STATS'>;
    response: Ack;
  };
  GET_AUTOMATIONS: {
    request: { type: 'GET_AUTOMATIONS' };
    response: Automation[];
  };
  GET_AUTOMATION_RUNS: {
    request: {
      type: 'GET_AUTOMATION_RUNS';
      payload: { automationId: string; limit?: number };
    };
    response: AutomationRun[];
  };
  CREATE_AUTOMATION: {
    request: { type: 'CREATE_AUTOMATION'; payload: AutomationCreateInput };
    response: Automation;
  };
  UPDATE_AUTOMATION: {
    request: {
      type: 'UPDATE_AUTOMATION';
      payload: { id: string; patch: AutomationUpdateInput };
    };
    response: Automation | DomainFailure;
  };
  SET_AUTOMATION_STATUS: {
    request: {
      type: 'SET_AUTOMATION_STATUS';
      payload: { id: string; status: AutomationStatus };
    };
    response: Automation | DomainFailure;
  };
  DELETE_AUTOMATION: {
    request: { type: 'DELETE_AUTOMATION'; payload: { id: string } };
    response: Ack;
  };
  CLEAR_AUTOMATION_ERROR: {
    request: { type: 'CLEAR_AUTOMATION_ERROR'; payload: { id: string } };
    response: Ack;
  };
  RUN_AUTOMATION_NOW: {
    request: { type: 'RUN_AUTOMATION_NOW'; payload: { id: string } };
    response: AutomationRun | DomainFailure;
  };
  GET_ZAI_MODELS: {
    request: { type: 'GET_ZAI_MODELS' };
    response: ZaiModelList;
  };
}
